import {emptyBrowserDocument, type BrowserDocument} from '../../core/browser-state';
import type {UsageRecord} from '../../core/usage';
import type {ConversationContext} from '../../core/context-cache';
import type {Entity, Id, JsonValue, LocalReceipt, Mutation, MutationBatch} from '../../workbench/contracts/data';
import {canonical, RepositoryError, type LocalRepository} from '../../workbench/storage/repository';
import {SYNC_MAX_BODY_BYTES, SYNC_MAX_MUTATIONS} from '../../workbench/contracts/sync';
import {manifest} from './manifest';
import {parseV1Document, splitV1} from './migrate-v1';
import type {LearningColumnAggregate} from './model';
const clone = <T>(value:T):T => structuredClone(value);
const asJson = (value:unknown):JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const active = (entity:Entity) => !entity.deletedAt;
export const knownLearningEntity = (entity:Entity) => manifest.schemas[entity.kind]?.version === entity.schemaVersion;
/** Historical evidence is parsed against its saved shape, never today's unit catalog. */
export function validateLegacyDocument(value:unknown): BrowserDocument {
  const result=parseV1Document(value);
  if(result.warnings.length) throw new RepositoryError('readonly-schema',`未识别学习字段，已保留原文：${result.warnings.join(', ')}`);
  return result.document;
}
/** This is a view. Unknown/future records remain in the repository, outside the editable legacy graph. */
function projectUnchecked(entities:Entity[], devicePreferences:JsonValue | null):BrowserDocument {
  const document=emptyBrowserDocument();
  const preferences=devicePreferences && typeof devicePreferences==='object' && !Array.isArray(devicePreferences) ? devicePreferences : {};
  if(preferences.settings) document.state.settings=clone(preferences.settings) as unknown as BrowserDocument['state']['settings'];
  if(preferences.onboarding) document.state.onboarding=clone(preferences.onboarding) as unknown as BrowserDocument['state']['onboarding'];
  if(typeof preferences.activeColumnId==='string'||preferences.activeColumnId===null) document.state.activeColumnId=preferences.activeColumnId;
  for(const entity of entities.filter(active).filter(knownLearningEntity)) {
    const payload=clone(entity.payload) as any;
    switch(entity.kind) {
      case 'learning.column': document.state.columns.push(payload.column); // fall through: aggregate fields
      case 'learning.orphans': {
        const aggregate=payload as Omit<LearningColumnAggregate,'column'>;
        document.state.sideChats.push(...aggregate.sideChats);
        Object.assign(document.state.contexts,aggregate.contexts);
        Object.assign(document.drafts.messages,aggregate.drafts.messages);
        Object.assign(document.drafts.references,aggregate.drafts.references);
        document.state.checkins.push(...aggregate.checkins);
        break;
      }
      case 'learning.practice': document.state.practice.push(payload);break;
      case 'learning.lab-attempt': document.state.lab.attempts.push(payload);break;
      case 'learning.usage': document.state.usageRecords.push(payload);break;
      case 'learning.lab-session': document.state.lab.sessions[payload.key]=payload.session;if(payload.draft)document.drafts.lab[payload.key]=payload.draft;break;
      case 'learning.lab-draft': document.drafts.lab[payload.key]=payload.draft;break;
      case 'learning.reading': document.state.reading=payload;break;
    }
  }
  return document;
}
export function readableLearningEntity(entity:Entity):boolean {
  if(!knownLearningEntity(entity))return false;
  try {
    const document=validateLegacyDocument(projectUnchecked([entity],null));
    const restored=splitV1(document,'learning-compatibility').entities.find(item=>item.id===entity.id&&item.kind===entity.kind);
    return !!restored && canonical(restored.payload)===canonical(entity.payload);
  } catch {return false;}
}
export function projectLegacy(entities:Entity[], devicePreferences:JsonValue | null):BrowserDocument {
  return validateLegacyDocument(projectUnchecked(entities.filter(readableLearningEntity),devicePreferences));
}
export type LearningSnapshot = {document:BrowserDocument;expected:Record<Id,number>;unknown:Entity[]};
export type LearningServiceOptions = {repository:LocalRepository;deviceId:Id;preferences:{read():Promise<JsonValue|null>};signal:AbortSignal};
export type LearningService = ReturnType<typeof createLearningService>;
export function createLearningService(options:LearningServiceOptions) {
  const {repository,deviceId,signal}=options;
  const observed=new WeakMap<BrowserDocument,{entities:Entity[];preferences:JsonValue|null}>();
  const ensure=()=>signal.throwIfAborted();
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(action:()=>Promise<T>):Promise<T>=>{const result=tail.then(action);tail=result.catch(()=>{});return result;};
  async function load():Promise<LearningSnapshot> {
    ensure(); const [entities,preferences]=await Promise.all([repository.list('learning'),options.preferences.read()]);ensure();
    const document=projectLegacy(entities,preferences);
    observed.set(document,{entities,preferences});
    return {document,expected:Object.fromEntries(entities.map(e=>[e.id,e.revision])),unknown:entities.filter(active).filter(e=>!readableLearningEntity(e))};
  }
  async function commitDiff(before:BrowserDocument,after:BrowserDocument,expected:Record<Id,number>):Promise<LocalReceipt> {
    ensure();validateLegacyDocument(before);validateLegacyDocument(after);
    const captured=observed.get(before);
    if(!captured) throw new RepositoryError('stale','学习快照缺少本机读取凭据，请重新读取');
    const oldSplit=splitV1(before,'learning-compatibility'),newSplit=splitV1(after,'learning-compatibility');
    const oldMap=new Map(oldSplit.entities.map(e=>[e.id,e])),newMap=new Map(newSplit.entities.map(e=>[e.id,e]));
    const stored=new Map(captured.entities.map(e=>[e.id,e]));
    const mutations:Mutation[]=[]; const expectedLocal:Record<Id,string|null>={};const now=new Date().toISOString();
    for(const id of new Set([...oldMap.keys(),...newMap.keys()])) {
      const old=oldMap.get(id),next=newMap.get(id);
      if(old&&next&&canonical(old.payload)===canonical(next.payload)&&old.kind===next.kind)continue;
      const current=stored.get(id);
      if(current&&(!readableLearningEntity(current)||current.deletedAt))throw new RepositoryError('readonly-schema','新版或已删除学习记录不可覆盖');
      if(current && expected[id]!==current.revision)throw new RepositoryError('stale');
      // The entire saved payload participates in the precondition, including local revision-0 writes.
      expectedLocal[id]=current?canonical(current):null;
      const target=next??old!;
      mutations.push({operationId:crypto.randomUUID(),deviceId,entityId:id,moduleId:'learning',kind:target.kind,schemaVersion:1,baseRevision:current?.revision||null,createdAt:current?.createdAt??target.createdAt,updatedAt:now,action:next?'put':'delete',payload:next?next.payload:null});
    }
    const previousPrefs=captured.preferences && typeof captured.preferences==='object'&&!Array.isArray(captured.preferences)?captured.preferences:{};
    const preferenceValue={...previousPrefs,...newSplit.devicePreferences as object,migrationWarnings:previousPrefs.migrationWarnings??[]};
    const preferencesChanged=canonical(oldSplit.devicePreferences)!==canonical(newSplit.devicePreferences);
    const batches:MutationBatch[]=[];let part:Mutation[]=[];
    const size=(items:Mutation[])=>new TextEncoder().encode(canonical({batchId:'00000000-0000-4000-8000-000000000000',mutations:items})).length;
    for(const mutation of mutations){if(size([mutation])>SYNC_MAX_BODY_BYTES)throw new RepositoryError('ENTITY_TOO_LARGE');if(part.length>=SYNC_MAX_MUTATIONS||size([...part,mutation])>SYNC_MAX_BODY_BYTES){batches.push({batchId:crypto.randomUUID(),mutations:part});part=[];}part.push(mutation);}
    if(part.length||!batches.length)batches.push({batchId:crypto.randomUUID(),mutations:part});
    const batch=batches[0];
    if(!batch.mutations.length&&!preferencesChanged)return {batchId:batch.batchId,state:'saved-local'};
    ensure();const result=await repository.commit(batch,{expectedLocal,...(batches.length>1?{additionalBatches:batches.slice(1)}:{}),...(preferencesChanged?{learningPreferences:{expected:captured.preferences,value:asJson(preferenceValue)}}:{})});ensure();return result;
  }
  return {load,commitLegacyDiff:(before:BrowserDocument,after:BrowserDocument,expected:Record<Id,number>)=>serial(()=>commitDiff(before,after,expected)),
    appendUsage:(record:UsageRecord)=>serial(async()=>{ensure();const existing=await repository.get({moduleId:'learning',entityId:record.id});ensure();if(existing){if(existing.kind==='learning.usage'&&existing.schemaVersion===1&&!existing.deletedAt&&canonical(existing.payload)===canonical(record))return;if(existing)throw new RepositoryError('stale');}const before=await load(),after=clone(before.document);after.state.usageRecords.push(clone(record));await commitDiff(before.document,after,before.expected);}),
    saveContext:(id:string,context:ConversationContext)=>serial(async()=>{const before=await load(),after=clone(before.document);after.state.contexts[id]=clone(context);await commitDiff(before.document,after,before.expected);}),
    flush:async()=>{await tail;ensure();},
  };
}
