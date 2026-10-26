import type {Entity, EntityRef, Id, JsonValue, LocalReceipt, Mutation, MutationBatch} from '../../workbench/contracts/data';
import type {LocalRepository} from '../../workbench/storage/repository';
import {deterministicId} from '../../workbench/storage/repository';
import type {Activity} from '../../workbench/activity';
import {parseTask, parseId, parseStatus, parseRef, taskJson, type Task, type StatusOperation} from './model';
export class TaskService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly retries = new Map<Id, {taskId: Id; status: Task['status']; batch: MutationBatch}>();
  constructor(private readonly repository: LocalRepository, private readonly deviceId: Id | null) {}
  private mutation(id: Id, kind: string, payload: JsonValue | null, current?: Entity, action: Mutation['action'] = 'put', operationId: Id = crypto.randomUUID(), now = new Date().toISOString()): Mutation {
    if (!this.deviceId) throw Error('设备身份尚未就绪，当前只读');
    return {operationId, deviceId: this.deviceId, entityId: id, moduleId: 'tasks', kind, schemaVersion: 1, baseRevision: current?.revision || null, createdAt: current?.createdAt ?? now, updatedAt: now, action, payload};
  }
  private async entry(id: Id, deleted = false): Promise<Entity> {
    const entry = await this.repository.get({moduleId: 'tasks', entityId: parseId(id)});
    if (!entry || entry.kind !== 'tasks.task' || Boolean(entry.deletedAt) !== deleted) throw Error('找不到这条待办');
    if (entry.schemaVersion !== 1) throw Error('此待办需要更新客户端，当前只读');
    return entry;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {const next = this.queue.catch(() => {}).then(action); this.queue = next; return next;}
  async createTask(input: Task): Promise<LocalReceipt> {
    const task = parseTask(input);
    if (task.status !== 'open') throw Error('新待办应为未完成；请通过完成操作记录活动');
    const id = crypto.randomUUID();
    return this.repository.commit({batchId: deterministicId(`${id}:create`), mutations: [this.mutation(id, 'tasks.task', taskJson(task))]});
  }
  async updateTask(id: Id, input: Task): Promise<LocalReceipt> {
    return this.serial(async () => {const entry = await this.entry(id), current = parseTask(entry.payload), task = parseTask(input); if (task.status !== current.status) throw Error('请通过完成或撤销操作修改状态'); return this.repository.commit({batchId: crypto.randomUUID(), mutations: [this.mutation(id, 'tasks.task', taskJson(task), entry)]});});
  }
  setTaskStatus(id: Id, status: Task['status'], operationId: Id): Promise<LocalReceipt> {
    return this.serial(async () => {
      parseId(id); parseStatus(status); parseId(operationId);
      const batchId = deterministicId(`${operationId}:status-batch`), eventId = deterministicId(`${operationId}:activity`);
      const previous = await this.repository.get({moduleId: 'tasks', entityId: eventId});
      if (previous) {
        const activity = previous.payload as unknown as Activity;
        if (activity?.operationId !== operationId || activity.target?.entityId !== id || activity.action !== (status === 'done' ? 'task-completed' : 'task-reopened')) throw Error('此操作标识已经用于另一个操作');
        return {batchId, state: 'saved-local'};
      }
      const noop = await this.repository.get({moduleId: 'tasks', entityId: deterministicId(`${operationId}:noop`)});
      if (noop) {const receipt = noop.payload as unknown as StatusOperation; if (receipt?.target?.entityId !== id || receipt.status !== status || receipt.operationId !== operationId) throw Error('此操作标识已经用于另一个操作'); return {batchId, state: 'saved-local'};}
      const retry = this.retries.get(operationId);
      if (retry) {if (retry.taskId !== id || retry.status !== status) throw Error('此操作标识已经用于另一个操作'); return this.repository.commit(retry.batch);}
      const entry = await this.entry(id), task = parseTask(entry.payload);
      if (task.status === status) {
        const now = new Date().toISOString(), receipt: StatusOperation = {target: {moduleId: 'tasks', entityId: id}, status, operationId, occurredAt: now};
        const batch = {batchId, mutations: [this.mutation(deterministicId(`${operationId}:noop`), 'tasks.operation', receipt as unknown as JsonValue, undefined, 'put', operationId, now)]};
        this.retries.set(operationId, {taskId: id, status, batch});
        return this.repository.commit(batch);
      }
      const now = new Date().toISOString(), activity: Activity = {source: 'system', action: status === 'done' ? 'task-completed' : 'task-reopened', target: {moduleId: 'tasks', entityId: id}, operationId, occurredAt: now};
      const batch: MutationBatch = {batchId, mutations: [this.mutation(id, 'tasks.task', taskJson({...task, status}), entry, 'put', operationId, now), this.mutation(eventId, 'tasks.activity', activity as unknown as JsonValue, undefined, 'put', deterministicId(`${operationId}:activity-mutation`), now)]};
      this.retries.set(operationId, {taskId: id, status, batch});
      return this.repository.commit(batch);
    });
  }
  async list(query = ''): Promise<Entity[]> {const search = query.trim().toLocaleLowerCase(); return (await this.repository.list('tasks')).filter(e => e.kind === 'tasks.task' && !e.deletedAt && (!search || JSON.stringify(e.payload).toLocaleLowerCase().includes(search))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));}
  async activities(): Promise<Entity[]> {return (await this.repository.list('tasks')).filter(e => e.kind === 'tasks.activity' && !e.deletedAt);}
  async trash(query = ''): Promise<Entity[]> {const all = await this.repository.list('tasks'), ids = new Set(all.map(e => e.id)), search = query.trim().toLocaleLowerCase(); return all.filter(e => e.kind === 'tasks.task' && e.deletedAt && !ids.has(deterministicId(`${e.id}:restored`)) && (!search || JSON.stringify(e.payload).toLocaleLowerCase().includes(search))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));}
  async deleteTask(id: Id): Promise<LocalReceipt> {return this.serial(async () => {const entry = await this.entry(id); return this.repository.commit({batchId: crypto.randomUUID(), mutations: [this.mutation(id, 'tasks.task', null, entry, 'delete')]});});}
  async restoreTask(id: Id): Promise<LocalReceipt> {return this.serial(async () => {
    const entry = await this.entry(id, true), restoredId = deterministicId(`${id}:restored`), batchId = deterministicId(`${id}:restore-batch`);
    if (await this.repository.get({moduleId: 'tasks', entityId: restoredId})) return {batchId, state: 'saved-local'};
    return this.repository.commit({batchId, mutations: [this.mutation(restoredId, 'tasks.task', taskJson(parseTask(entry.payload)))]});
  });}
  async attachAsset(id: Id, asset: EntityRef): Promise<LocalReceipt> {return this.serial(async () => {
    const ref = parseRef(asset); if (ref.moduleId !== 'library') throw Error('请选择资料模块中的条目');
    const entry = await this.entry(id), task = parseTask(entry.payload);
    const assets = task.assets.some(a => a.moduleId === ref.moduleId && a.entityId === ref.entityId) ? task.assets : [...task.assets, ref];
    return this.repository.commit({batchId: crypto.randomUUID(), mutations: [this.mutation(id, 'tasks.task', taskJson({...task, assets}), entry)]});
  });}
}
