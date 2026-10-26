import type {DesktopStore} from '../../node/desktop-store';
import type {DesktopSnapshot} from '../../core/desktop-document';
import type {LearningService} from './compatibility';
import {validateLegacyDocument} from './compatibility';
import {RepositoryError} from '../../workbench/storage/repository';
import {emptyState} from '../../core/state';
/** Desktop's old controller protocol over v2 records. No legacy path or file writer exists here. */
export async function createLearningDesktopStore(service:LearningService, initialGeneration:number):Promise<DesktopStore> {
  let saved=await service.load(),generation=initialGeneration,revision=0,mutationRevision=0;
  let tail:Promise<unknown>=Promise.resolve(),locked=false;
  const failures=new Map<string,unknown>();
  const serial=<T>(operation:()=>Promise<T>,kind?:'save'|'runtime'):Promise<T>=>{const pending=tail.then(async()=>{try{const value=await operation();if(kind)failures.delete(kind);return value;}catch(cause){if(kind)failures.set(kind,cause);throw cause;}});tail=pending.catch(()=>{});return pending;};
  const check=(expected:number)=>{if(expected!==generation)throw new RepositoryError('stale','学习页面或账户已改变');};
  const snapshot=():DesktopSnapshot=>({document:structuredClone(saved.document),generation,revision,mutationRevision});
  const refresh=async()=>{saved=await service.load();return snapshot();};
  return {snapshot,load:()=>serial(refresh),flush:async()=>{await tail;if(failures.size)throw failures.values().next().value;await service.flush();},
    save:input=>serial(async()=>{check(input.generation);if(locked||input.mutationRevision<=mutationRevision)throw new RepositoryError('stale');const next=validateLegacyDocument(input.document);next.state.usageRecords=saved.document.state.usageRecords;next.state.contexts=saved.document.state.contexts;await service.commitLegacyDiff(saved.document,next,saved.expected);mutationRevision=input.mutationRevision;revision++;return refresh();},'save'),
    runtime:(expected,change)=>serial(async()=>{check(expected);if(locked)throw new RepositoryError('locked');await refresh();const document=structuredClone(saved.document),fields=change(document.state);document.state.usageRecords=fields.usageRecords;document.state.contexts=fields.contexts;await service.commitLegacyDiff(saved.document,document,saved.expected);revision++;await refresh();return {generation,revision,usageRecords:saved.document.state.usageRecords,contexts:saved.document.state.contexts};},'runtime'),
    export:(expected,writer)=>serial(async()=>{check(expected);locked=true;try{await refresh();return await writer({format:'growth-workbench',schemaVersion:1,appVersion:'0.11.0',exportedAt:new Date().toISOString(),state:{...saved.document.state,settings:emptyState().settings,onboarding:emptyState().onboarding,activeColumnId:null},browser:{drafts:saved.document.drafts}});}finally{locked=false;}}),
    restore:(expected,reader)=>serial(async()=>{check(expected);locked=true;try{const document=await reader();if(!document)return null;await refresh();const restored=validateLegacyDocument(document);restored.state.settings=saved.document.state.settings;restored.state.onboarding=saved.document.state.onboarding;restored.state.activeColumnId=saved.document.state.activeColumnId;await service.commitLegacyDiff(saved.document,restored,saved.expected);generation++;revision++;mutationRevision=0;return refresh();}finally{locked=false;}}),
  };
}
