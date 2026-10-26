import type {Entity, Id, JsonValue, LocalReceipt, Mutation} from '../../workbench/contracts/data';
import type {LocalRepository} from '../../workbench/storage/repository';
import {deterministicId} from '../../workbench/storage/repository';
import {parseId, parseJournal, journalJson, type JournalEntry} from './model';
export class JournalService {
  constructor(private readonly repository: LocalRepository, private readonly deviceId: Id | null) {}
  private mutation(id: Id, payload: JsonValue | null, current?: Entity, action: Mutation['action'] = 'put'): Mutation {
    if (!this.deviceId) throw Error('设备身份尚未就绪，当前只读');
    const now = new Date().toISOString();
    return {operationId: crypto.randomUUID(), deviceId: this.deviceId, entityId: id, moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, baseRevision: current?.revision || null, createdAt: current?.createdAt ?? now, updatedAt: now, action, payload};
  }
  private async entry(id: Id, deleted = false): Promise<Entity> {
    const entry = await this.repository.get({moduleId: 'journal', entityId: parseId(id)});
    if (!entry || entry.kind !== 'journal.entry' || Boolean(entry.deletedAt) !== deleted) throw Error('找不到这条记录');
    if (entry.schemaVersion !== 1) throw Error('此记录需要更新客户端，当前只读');
    return entry;
  }
  async saveJournal(input: JournalEntry, id?: Id): Promise<LocalReceipt> {
    const payload = journalJson(parseJournal(input)), current = id ? await this.entry(id) : undefined;
    return this.repository.commit({batchId: crypto.randomUUID(), mutations: [this.mutation(current?.id ?? crypto.randomUUID(), payload, current)]});
  }
  async list(query = ''): Promise<Entity[]> {
    const search = query.trim().toLocaleLowerCase();
    return (await this.repository.list('journal')).filter(e => e.kind === 'journal.entry' && !e.deletedAt && (!search || JSON.stringify(e.payload).toLocaleLowerCase().includes(search))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async trash(query = ''): Promise<Entity[]> {
    const all = await this.repository.list('journal'), ids = new Set(all.map(e => e.id)), search = query.trim().toLocaleLowerCase();
    return all.filter(e => e.kind === 'journal.entry' && e.deletedAt && !ids.has(deterministicId(`${e.id}:restored`)) && (!search || JSON.stringify(e.payload).toLocaleLowerCase().includes(search))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async deleteJournal(id: Id): Promise<LocalReceipt> {const entry = await this.entry(id); return this.repository.commit({batchId: crypto.randomUUID(), mutations: [this.mutation(entry.id, null, entry, 'delete')]});}
  async restoreJournal(id: Id): Promise<LocalReceipt> {
    const entry = await this.entry(id, true), restoredId = deterministicId(`${entry.id}:restored`), batchId = deterministicId(`${entry.id}:restore-batch`);
    if (await this.repository.get({moduleId: 'journal', entityId: restoredId})) return {batchId, state: 'saved-local'};
    return this.repository.commit({batchId, mutations: [this.mutation(restoredId, journalJson(parseJournal(entry.payload)))]});
  }
}
