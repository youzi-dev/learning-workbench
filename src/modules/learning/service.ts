import type {BrowserSnapshot} from '../../core/browser-state';
import type {BrowserRepository} from '../../browser/repository';
import {BrowserStorageError} from '../../browser/repository';
import {canonical} from '../../workbench/storage/repository';
import type {LearningService, LearningSnapshot} from './compatibility';
/** An in-memory view controller. Every durable write is a record mutation in v2. */
export function createLearningBrowserRepository(service:LearningService, subscribe?: (listener:()=>void)=>()=>void):BrowserRepository {
  let saved:LearningSnapshot|undefined,revision=0,closed=false,writing=false,refreshEpoch=0;
  const listeners=new Set<(revision:number)=>void>();
  const ensure=()=>{if(closed)throw new BrowserStorageError('unavailable','学习页面已关闭');};
  const view=():BrowserSnapshot=>({schemaVersion:1,revision,updatedAt:new Date().toISOString(),document:structuredClone(saved!.document)});
  const unsubscribe=subscribe?.(()=>{if(closed||writing)return;const epoch=refreshEpoch;void service.load().then(next=>{if(closed||writing||epoch!==refreshEpoch)return;if(!saved||canonical(next.document)!==canonical(saved.document)){saved=next;revision++;for(const listener of listeners)listener(revision);}}).catch(()=>{if(!closed&&!writing&&epoch===refreshEpoch)for(const listener of listeners)listener(-1);});});
  async function commit(document:BrowserSnapshot['document'],expectedRevision:number) {
    ensure();if(!saved||revision!==expectedRevision)throw new BrowserStorageError('revision-conflict','学习记录已更新，请重新读取');
    writing=true;refreshEpoch++;
    try {await service.commitLegacyDiff(saved.document,document,saved.expected);ensure();saved=await service.load();revision++;return view();}
    catch(cause){if(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='stale')throw new BrowserStorageError('revision-conflict','学习记录已更新，待存输入已保留');throw cause;}
    finally {writing=false;}
  }
  return {async load(){ensure();const epoch=++refreshEpoch;const next=await service.load();ensure();if(epoch===refreshEpoch||!saved)saved=next;return view();},commit,replace:commit,async recoveries(){ensure();return [];},subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},flush:()=>service.flush(),close(){closed=true;unsubscribe?.();listeners.clear();}};
}
