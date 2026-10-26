import type {EntityRef, IsoTime, JsonValue} from '../../workbench/contracts/data';
export type Task = {title: string; status: 'open' | 'done'; dueAt: IsoTime | null; priority: 'low' | 'normal' | 'high'; assets: EntityRef[]};
export function objectInput(input: unknown): Record<string, unknown> {if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('请输入有效内容'); return input as Record<string, unknown>;}
export function parseId(value: unknown): string {if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw Error('条目标识无效'); return value;}
export function parseRef(input: unknown): EntityRef {const value = objectInput(input); if (typeof value.moduleId !== 'string' || !value.moduleId.trim()) throw Error('关联模块无效'); return {moduleId: value.moduleId, entityId: parseId(value.entityId)};}
export function parseStatus(input: unknown): Task['status'] {if (input !== 'open' && input !== 'done') throw Error('待办状态无效'); return input;}
export function parseTask(input: unknown): Task {
  const value = objectInput(input);
  if (typeof value.title !== 'string' || !value.title.trim()) throw Error('请填写待办标题');
  const dueAt = value.dueAt ?? null, priority = value.priority ?? 'normal', assets = value.assets ?? [];
  if (dueAt !== null && (typeof dueAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(dueAt) || !Number.isFinite(Date.parse(dueAt)))) throw Error('截止日期无效');
  if (!['low', 'normal', 'high'].includes(priority as string)) throw Error('优先级无效');
  if (!Array.isArray(assets)) throw Error('关联资料无效');
  return {title: value.title.trim(), status: value.status === undefined ? 'open' : parseStatus(value.status), dueAt: dueAt as Task['dueAt'], priority: priority as Task['priority'], assets: assets.map(parseRef)};
}
export const taskJson = (value: Task): JsonValue => value as unknown as JsonValue;

/** An acknowledged same-state request must stay a no-op after later transitions. */
export type StatusOperation = {target: EntityRef; status: Task['status']; operationId: string; occurredAt: IsoTime};
export function parseStatusOperation(input: unknown): JsonValue {
  const value = objectInput(input), target = parseRef(value.target), operationId = parseId(value.operationId), status = parseStatus(value.status);
  if (target.moduleId !== 'tasks' || typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt))) throw Error('待办操作记录无效');
  return {target, status, operationId, occurredAt: value.occurredAt};
}
