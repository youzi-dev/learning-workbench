import type {EntityRef, JsonValue} from '../../workbench/contracts/data';
export type JournalEntry = {title?: string; text: string; tags: string[]; attachments: EntityRef[]};
export function objectInput(input: unknown): Record<string, unknown> {if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('请输入有效内容'); return input as Record<string, unknown>;}
export function parseId(value: unknown): string {if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw Error('条目标识无效'); return value;}
export function parseRef(input: unknown): EntityRef {const value = objectInput(input); if (typeof value.moduleId !== 'string' || !value.moduleId.trim()) throw Error('关联模块无效'); return {moduleId: value.moduleId, entityId: parseId(value.entityId)};}
export function parseJournal(input: unknown): JournalEntry {
  const value = objectInput(input);
  if (typeof value.text !== 'string' || !value.text.trim()) throw Error('请写下记录内容');
  if (value.title !== undefined && typeof value.title !== 'string') throw Error('标题无效');
  const tags = value.tags ?? [], attachments = value.attachments ?? [];
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string') || !Array.isArray(attachments)) throw Error('标签或附件无效');
  return {...(typeof value.title === 'string' && value.title.trim() ? {title: value.title.trim()} : {}), text: value.text.trim(), tags: [...new Set((tags as string[]).map(tag => tag.trim()).filter(Boolean))], attachments: attachments.map(parseRef)};
}
export const journalJson = (value: JournalEntry): JsonValue => value as unknown as JsonValue;
