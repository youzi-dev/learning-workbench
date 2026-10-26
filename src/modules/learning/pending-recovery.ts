import {emptyBrowserDocument, type BrowserDocument} from '../../core/browser-state';
import type {JsonValue} from '../../workbench/contracts/data';
import {canonical, deterministicId, RepositoryError, type LocalRepository} from '../../workbench/storage/repository';
import {validateLegacyDocument} from './compatibility';
export type PendingLearningCopy = {id:string;createdAt:string;document:BrowserDocument};
export type LearningRecoveryStore = ReturnType<typeof createLearningRecoveryStore>;
/** Explicit export contains learning text/evidence/drafts, never connection/device settings. */
export function safePendingBackup(document:BrowserDocument) {
  const defaults=emptyBrowserDocument().state,copy=validateLegacyDocument(document);
  return {format:'growth-workbench',schemaVersion:1,appVersion:'0.11.0',exportedAt:new Date().toISOString(),state:{...copy.state,settings:defaults.settings,onboarding:defaults.onboarding,activeColumnId:null},browser:{drafts:copy.drafts}};
}
/** Per-account, device-only recovery copies are excluded by the shared backup allowlist. */
export function createLearningRecoveryStore(options:{repository:LocalRepository;preferences:{read():Promise<JsonValue|null>};signal:AbortSignal}) {
  const ensure=()=>options.signal.throwIfAborted();
  const parse=(preferences:JsonValue|null):PendingLearningCopy[]=>{
    if(!preferences||typeof preferences!=='object'||Array.isArray(preferences)||preferences.learningRecoveries===undefined)return [];
    if(!Array.isArray(preferences.learningRecoveries))throw new RepositoryError('readonly-schema','本机待存副本需要更新客户端后读取');
    return preferences.learningRecoveries.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||typeof value.createdAt!=='string')throw new RepositoryError('readonly-schema');return {id:value.id,createdAt:value.createdAt,document:validateLegacyDocument(value.document)};});
  };
  return {async list(){ensure();const preferences=await options.preferences.read();ensure();return parse(preferences);},async archive(document:BrowserDocument){
    ensure();const copy=validateLegacyDocument(document),id=deterministicId(`pending-learning:${canonical(copy)}`);
    for(let attempt=0;attempt<2;attempt++){
      const previous=await options.preferences.read();ensure();const recoveries=parse(previous);if(recoveries.some(item=>item.id===id))return id;
      const base=previous&&typeof previous==='object'&&!Array.isArray(previous)?previous:{};
      const value=JSON.parse(JSON.stringify({...base,learningRecoveries:[...recoveries,{id,createdAt:new Date().toISOString(),document:copy}]})) as JsonValue;
      if(new TextEncoder().encode(canonical(value)).length>50*1024*1024)throw Error('本机待存副本较大，请先下载待存内容，再保留当前页面');
      try{await options.repository.commit({batchId:crypto.randomUUID(),mutations:[]},{learningPreferences:{expected:previous,value}});ensure();return id;}
      catch(cause){if(attempt===0&&cause instanceof RepositoryError&&cause.code==='stale')continue;throw cause;}
    }
    throw new RepositoryError('stale');
  }};
}
