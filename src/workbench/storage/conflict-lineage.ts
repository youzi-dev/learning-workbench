import type {Conflict} from '../contracts/data';
export type ConflictParents = Record<string, string[]>;
/** Validate every edge before imports make a durable write. Missing ancestors,
 * duplicate edges and cycles cannot silently turn historical nodes actionable. */
export function validateConflictParents(conflicts: readonly Conflict[], value: unknown): ConflictParents {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('INVALID_CONFLICT_LINEAGE');
  const ids = new Set(conflicts.map(conflict => conflict.id));
  if (ids.size !== conflicts.length) throw new Error('INVALID_CONFLICT_LINEAGE');
  const parents: ConflictParents = Object.create(null), children = new Map<string, string[]>(), remaining = new Map([...ids].map(id => [id, 0]));
  for (const [id, edges] of Object.entries(value)) {
    if (!ids.has(id) || !Array.isArray(edges) || edges.some(parent => typeof parent !== 'string' || !ids.has(parent) || parent === id) || new Set(edges).size !== edges.length) throw new Error('INVALID_CONFLICT_LINEAGE');
    parents[id] = [...edges]; remaining.set(id, edges.length);
    for (const parent of edges) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const ready = [...ids].filter(id => remaining.get(id) === 0); let visited = 0;
  while (ready.length) {
    const id = ready.pop()!; visited++;
    for (const child of children.get(id) ?? []) {const count = remaining.get(child)! - 1; remaining.set(child, count); if (!count) ready.push(child);}
  }
  if (visited !== ids.size) throw new Error('INVALID_CONFLICT_LINEAGE');
  return parents;
}
export function conflictAncestors(parents: ConflictParents, id: string): string[] {
  const found = new Set<string>(), pending = [...(parents[id] ?? [])];
  while (pending.length) {const parent = pending.pop()!; if (!found.has(parent)) {found.add(parent); pending.push(...(parents[parent] ?? []));}}
  return [...found];
}
