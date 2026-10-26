import type {EntityRef, JsonValue} from './contracts/data';
import type {ReferencePort} from './contracts/module';
import type {LocalRepository} from './storage/repository';
function title(payload: JsonValue): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const key of ['title', 'name', 'text', 'content']) {const value = payload[key]; if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);}
  }
  return '未命名条目';
}
function contains(value: JsonValue, ref: EntityRef): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && value.moduleId === ref.moduleId && value.entityId === ref.entityId) return true;
  return Object.values(value).some(item => contains(item, ref));
}
export function createReferences(repository: LocalRepository, moduleIds: () => string[], enabled: (id: string) => boolean): ReferencePort {
  return {
    async resolve(ref) {const entity = await repository.get(ref); if (!entity) return null; return {title: entity.deletedAt ? '已删除的条目' : title(entity.payload), deleted: entity.deletedAt !== null, moduleEnabled: enabled(entity.moduleId)};},
    async backlinks(ref) {const entities = (await Promise.all(moduleIds().map(id => repository.list(id)))).flat(); return entities.filter(entity => !entity.deletedAt && contains(entity.payload, ref)).map(entity => ({moduleId: entity.moduleId, entityId: entity.id}));}
  };
}
