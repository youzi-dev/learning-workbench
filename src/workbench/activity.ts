import type {Entity, EntityRef, Id, IsoTime, JsonValue} from './contracts/data';
import type {LocalRepository} from './storage/repository';
export type Activity = {source: 'system'; action: 'task-completed' | 'task-reopened'; target: EntityRef; operationId: Id; occurredAt: IsoTime};
export function parseActivity(input: unknown): JsonValue {
  const value = input as Activity;
  const uuid = (input: unknown) => typeof input === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
  if (!value || value.source !== 'system' || !['task-completed', 'task-reopened'].includes(value.action) || value.target?.moduleId !== 'tasks' || !uuid(value.target.entityId) || !uuid(value.operationId) || !Number.isFinite(Date.parse(value.occurredAt))) throw Error('系统活动无效');
  return {source: value.source, action: value.action, target: {moduleId: 'tasks', entityId: value.target.entityId}, operationId: value.operationId, occurredAt: value.occurredAt};
}
export function deviceTimeZone(): string {return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';}
export function dateInZone(iso: IsoTime = new Date().toISOString(), timeZone = deviceTimeZone()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(iso));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function dailySnapshot(journal: Entity[], tasks: Entity[], date: string, timeZone: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || Number.isNaN(Date.parse(date))) throw Error('日期无效');
  const inDay = (iso: IsoTime) => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) && dateInZone(iso, timeZone) === date;
  const alive = (entity: Entity) => entity.deletedAt === null;
  return {
    entries: journal.filter(e => alive(e) && e.kind === 'journal.entry' && inDay(e.createdAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    pending: tasks.filter(e => {if (!alive(e) || e.kind !== 'tasks.task') return false; const p = e.payload as unknown as {status?: string; dueAt?: string | null}; return p?.status !== 'done' && (typeof p?.dueAt !== 'string' || !Number.isFinite(Date.parse(p.dueAt)) || dateInZone(p.dueAt, timeZone) <= date);}).sort((a, b) => {const ap = (a.payload as any)?.dueAt ?? '', bp = (b.payload as any)?.dueAt ?? ''; return ap.localeCompare(bp) || b.createdAt.localeCompare(a.createdAt);}),
    activities: tasks.filter(e => alive(e) && e.kind === 'tasks.activity' && inDay((e.payload as any)?.occurredAt ?? e.createdAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
export async function today(repository: LocalRepository, date?: string, timeZone = deviceTimeZone()) {const [journal, tasks] = await Promise.all([repository.list('journal'), repository.list('tasks')]); return dailySnapshot(journal, tasks, date ?? dateInZone(undefined, timeZone), timeZone);}
