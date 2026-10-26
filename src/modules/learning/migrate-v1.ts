import {emptyState} from '../../core/state';
import type {BrowserDocument, BrowserDrafts} from '../../core/browser-state';
import type {Entity, JsonValue} from '../../workbench/contracts/data';
import {canonical, deterministicId, RepositoryError} from '../../workbench/storage/repository';
import type {LearningColumnAggregate} from './model';

type Parser = (value: unknown, path: string, warnings: string[]) => unknown;
const invalid = (path: string): never => {throw new RepositoryError('invalid', `Invalid legacy field: ${path}`);};
const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  return value as Record<string, unknown>;
};
const string: Parser = (v, p) => typeof v === 'string' ? v : invalid(p);
const boolean: Parser = (v, p) => typeof v === 'boolean' ? v : invalid(p);
const number: Parser = (v, p) => typeof v === 'number' && Number.isFinite(v) ? v : invalid(p);
const integer: Parser = (v, p) => Number.isSafeInteger(v) && (v as number) >= 0 ? v : invalid(p);
const choice = (...options: (string | number)[]): Parser => (v, p) => options.includes(v as string | number) ? v : invalid(p);
const optional = (parse: Parser): Parser => (v, p, w) => v === undefined ? undefined : parse(v, p, w);
const nullable = (parse: Parser): Parser => (v, p, w) => v === null ? null : parse(v, p, w);
const array = (parse: Parser): Parser => (v, p, w) => Array.isArray(v) ? v.map((item, i) => parse(item, `${p}[${i}]`, w)) : invalid(p);
const dictionary = (parse: Parser): Parser => (v, p, w) => Object.fromEntries(Object.entries(record(v, p)).map(([key, item]) => [key, parse(item, `${p}.${key}`, w)]));
const object = (shape: Record<string, Parser>): Parser => (v, p, w) => {
  const source = record(v, p);
  for (const key of Object.keys(source)) if (!Object.hasOwn(shape, key)) w.push(`${p}.${key}`);
  return Object.fromEntries(Object.entries(shape).flatMap(([key, parse]) => {const result = parse(source[key], `${p}.${key}`, w); return result === undefined ? [] : [[key, result]];}));
};
const json: Parser = v => {canonical(v); return structuredClone(v);};
const help = choice('independent', 'hinted', 'explained'), level = choice('待验证', '初步理解', '可独立应用', '稳定掌握'), mode = choice('practice', 'transfer');
const runShape = {code: string, taskId: string, checks: array(object({label: string, passed: boolean, expected: json, actual: optional(json), input: optional(array(json)), error: optional(string)})), logs: array(string), error: string};
const message = object({id: string, role: choice('user', 'assistant'), content: string, createdAt: string, origin: optional(choice('user', 'assistant', 'sandbox')), model: optional(string), apiProfile: optional(string)});
const column = object({id: string, title: string, goal: string, createdAt: string, kind: optional(choice('knowledge', 'project')), phase: choice('planning', 'overview', 'study', 'verify', 'teachback', 'remediate', 'complete'), currentStepIndex: integer, taughtStepIds: array(string), messages: array(message), evidence: array(object({id: string, stepId: string, answer: string, teachback: string, helpLevel: help, level, confirmed: boolean, suggestion: optional(object({level, reason: string})), gap: optional(string), gapAddressed: optional(boolean), createdAt: string})), overview: optional(string), plan: nullable(object({target: string, confirmedAt: optional(string), steps: array(object({id: string, title: string, outcome: string, priority: number, status: choice('未开始', '学习中', '待验证', '已完成')}))})), pendingAnswer: optional(object({text: string, createdAt: string, helpLevel: help})), source: optional(object({course: object({id: string, title: string, description: string, url: string}), url: string, version: string, sectionIds: array(string)}))});
const sideChat = object({id: string, columnId: string, parentMessageId: string, createdAt: string, messages: array(message), context: object({quote: string, sourceMessage: string, goal: string}), source: optional(object({url: string, title: string}))});
const context = object({checkpoint: optional(object({summary: string, throughId: string, createdAt: string})), lastInput: optional(object({profileId: string, model: string, inputTokens: nullable(integer), throughId: nullable(string), compactionBlocked: optional(boolean)}))});
const draftsParser = object({lab: dictionary(object({explanation: string, lastRun: nullable(object(runShape)), updatedAt: string})), messages: dictionary(string), references: dictionary(object({url: string, text: string, providedAt: string}))});
const preferences = object({name: string, goal: string, customInstructions: string, dailyMinutes: choice(30, 60, 90, 120, 150, 180), theme: choice('system', 'light', 'dark'), fontSize: number, codeSize: number, sendKey: choice('enter', 'mod-enter'), closeToTray: boolean, defaultMode: choice('coach', 'study-coach', 'grill'), wordWrap: boolean, lineNumbers: boolean, minimap: boolean, tabSize: choice(2, 4, 8), replyStyle: choice('concise', 'balanced', 'detailed')});
const stateParser = object({
  lab: object({sessions: dictionary(object({unitId: string, mode, learnedAt: string, code: string, hintsSeen: integer, helpLevel: help})), attempts: array(object({...runShape, id: string, unitId: string, mode, helpLevel: help, explanation: string, passed: boolean, createdAt: string}))}),
  reading: object({url: string, title: string}), onboarding: object({introSeen: boolean, demoCompleted: boolean}), columns: array(column), sideChats: array(sideChat), activeColumnId: nullable(string),
  checkins: array(object({id: optional(string), date: string, columnId: string, note: string})), practice: array(object({id: string, columnId: string, stepId: string, kind: choice('code', 'debug'), file: optional(string), content: string, helpLevel: help, createdAt: string})),
  usageRecords: array(object({id: string, createdAt: string, profileId: string, model: string, purpose: choice('chat', 'side', 'summary', 'agent', 'test'), usage: nullable(object({inputTokens: nullable(integer), cachedInputTokens: nullable(integer), uncachedInputTokens: nullable(integer), cacheWriteTokens: nullable(integer), outputTokens: nullable(integer)}))})), contexts: dictionary(context),
  settings: object({provider: choice('openai', 'deepseek', 'custom'), baseUrl: string, model: string, customProtocol: choice('responses', 'chat'), reminderTime: string, reminderDate: string, reminderEnabled: boolean, voice: object({autoRead: boolean, rate: choice(0.75, 1, 1.25, 1.5), voice: string}), preferences,
    modelLibrary: object({profiles: array(object({id: string, name: string, baseUrl: string, protocol: choice('responses', 'chat'), models: array(string), contextWindows: optional(dictionary(integer))})), active: nullable(object({profileId: string, model: string}))})})
});
/** Unknown fields are reported and remain in the immutable local source snapshot. */
export function parseV1Document(value: unknown): {document: BrowserDocument; warnings: string[]} {
  canonical(value);
  const input = record(value, 'document'), raw = record(input.state, 'state'), defaults = emptyState(), settings = record(raw.settings, 'state.settings');
  const merged = {...defaults, ...raw, lab: {...defaults.lab, ...(raw.lab !== undefined ? record(raw.lab, 'state.lab') : {})}, settings: {...defaults.settings, ...settings, preferences: {...defaults.settings.preferences, ...(settings.preferences !== undefined ? record(settings.preferences, 'state.settings.preferences') : {})}, voice: {...defaults.settings.voice, ...(settings.voice !== undefined ? record(settings.voice, 'state.settings.voice') : {})}}};
  const warnings: string[] = Object.keys(input).filter(k => !['state', 'drafts'].includes(k)).map(k => `document.${k}`);
  const state = stateParser(merged, 'state', warnings) as BrowserDocument['state'];
  const drafts = draftsParser(input.drafts === undefined ? {lab: {}, messages: {}, references: {}} : input.drafts, 'drafts', warnings) as BrowserDrafts;
  return {document: {state, drafts}, warnings};
}
/** Deterministic UUID for formerly ID-less local records; no Node dependency. */
export const legacyId = deterministicId;

const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const validTime = (value: unknown, fallback: string) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : fallback;
/** This does not consult the current course catalog: historical output is evidence. */
export function splitV1(input: BrowserDocument, fingerprint?: string): {entities: Entity[]; devicePreferences: JsonValue} {
  const {document, warnings} = parseV1Document(input), {state, drafts} = document;
  const source = fingerprint ?? legacyId(canonical(document));
  const epoch = '1970-01-01T00:00:00.000Z', entities: Entity[] = [], ids = new Set<string>();
  const add = (id: string, kind: string, payload: unknown, createdAt = epoch) => {
    if (!id || ids.has(id)) throw new RepositoryError('invalid', `Duplicate legacy ID: ${id}`); ids.add(id);
    const time = validTime(createdAt, epoch);
    entities.push({id, moduleId: 'learning', kind, schemaVersion: 1, revision: 0, createdAt: time, updatedAt: time, deletedAt: null, payload: jsonValue(payload)});
  };
  const claimed = new Set<string>(), knownColumns = new Set(state.columns.map(c => c.id));
  const checkins = state.checkins.map((c, i) => ({...c, id: (c as typeof c & {id?: string}).id ?? legacyId(`${source}:checkins:${i}`)}));
  for (const column of state.columns) {
    const sides = state.sideChats.filter(s => s.columnId === column.id), owners = new Set([column.id, ...sides.map(s => s.id)]);
    owners.forEach(id => claimed.add(id));
    const aggregate: LearningColumnAggregate = {column, sideChats: sides, contexts: Object.fromEntries(Object.entries(state.contexts).filter(([id]) => owners.has(id))), drafts: {lab: {}, messages: Object.fromEntries(Object.entries(drafts.messages).filter(([id]) => owners.has(id))), references: Object.fromEntries(Object.entries(drafts.references).filter(([id]) => owners.has(id)))}, checkins: checkins.filter(c => c.columnId === column.id)};
    add(column.id, 'learning.column', aggregate, column.createdAt);
  }
  state.practice.forEach(p => add(p.id, 'learning.practice', p, p.createdAt));
  state.lab.attempts.forEach(a => add(a.id, 'learning.lab-attempt', a, a.createdAt));
  state.usageRecords.forEach(u => add(u.id, 'learning.usage', u, u.createdAt));
  const claimedLab = new Set<string>();
  for (const [key, session] of Object.entries(state.lab.sessions)) {
    const draft = drafts.lab[key]; if (draft) claimedLab.add(key);
    add(legacyId(`learning.lab-session:${key}`), 'learning.lab-session', {key, session, ...(draft ? {draft} : {})}, session.learnedAt);
  }
  for (const [key, draft] of Object.entries(drafts.lab)) if (!claimedLab.has(key)) add(legacyId(`learning.lab-draft:${key}`), 'learning.lab-draft', {key, draft}, draft.updatedAt);
  add(legacyId('learning.reading'), 'learning.reading', state.reading);
  const orphans = {sideChats: state.sideChats.filter(s => !knownColumns.has(s.columnId)), contexts: Object.fromEntries(Object.entries(state.contexts).filter(([id]) => !claimed.has(id))), drafts: {lab: {}, messages: Object.fromEntries(Object.entries(drafts.messages).filter(([id]) => !claimed.has(id))), references: Object.fromEntries(Object.entries(drafts.references).filter(([id]) => !claimed.has(id)))}, checkins: checkins.filter(c => !knownColumns.has(c.columnId))};
  if (orphans.sideChats.length || Object.keys(orphans.contexts).length || Object.keys(orphans.drafts.messages).length || Object.keys(orphans.drafts.references).length || orphans.checkins.length) add(legacyId('learning.orphans'), 'learning.orphans', orphans);
  return {entities, devicePreferences: jsonValue({activeColumnId: state.activeColumnId, onboarding: state.onboarding, settings: state.settings, migrationWarnings: warnings})};
}
