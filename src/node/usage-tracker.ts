import {ModelResponseError, type ChatTurn, type ModelReply, type ModelUsage} from '../core/providers';
import {usageRecord, type UsagePurpose, type UsageRecord} from '../core/usage';
import type {ModelSnapshot} from './model-runtime';
import {canonical, deterministicId, RepositoryError, type LocalRepository} from '../workbench/storage/repository';
/** Text extraction and billing are independent; even an empty response can consume tokens. */
export async function trackRequest(snapshot:ModelSnapshot,system:string,turns:ChatTurn[],purpose:UsagePurpose,persist:(record:UsageRecord)=>Promise<void>,timeout=180000,id:()=>string=()=>globalThis.crypto.randomUUID(),signal?:AbortSignal,retryPersistence=false,drainIncurredUsage=false):Promise<ModelReply> {
  signal?.throwIfAborted();
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
  const profileId=snapshot.profile.id;const model=snapshot.settings.model;
  let reply:ModelReply | undefined;let failure:unknown;let failed=false;
  try{reply=await snapshot.chatDetailed(system,turns,requestSignal);}
  catch(error){failure=error;failed=true;}
  const usage:ModelUsage|null=reply?.usage??(failure instanceof ModelResponseError?failure.usage:null);
  const record=usageRecord(profileId,model,purpose,usage,new Date().toISOString(),id());
  try {await persist(record);} catch (cause) {if(!retryPersistence)throw cause; if(!drainIncurredUsage)signal?.throwIfAborted(); await persist(record);}
  if(failed)throw failure;
  signal?.throwIfAborted();
  return reply!;
}

/** Captured before a request starts; only its incurred usage may outlive UI scope. */
export function createIncurredUsageWriter(repository:LocalRepository,deviceId:string) {
  const pending=new Map<string,UsageRecord>();
  async function append(record:UsageRecord):Promise<void> {
    const value=structuredClone(record);canonical(value);pending.set(value.id,value);
    const existing=await repository.get({moduleId:'learning',entityId:value.id});
    if(existing){if(existing.kind==='learning.usage'&&existing.schemaVersion===1&&!existing.deletedAt&&canonical(existing.payload)===canonical(value)){pending.delete(value.id);return;}throw new RepositoryError('stale','用量记录 ID 已存在不同内容');}
    const batchId=deterministicId(`incurred-usage:${deviceId}:${value.id}`);
    try {await repository.commit({batchId,mutations:[{operationId:deterministicId(`${batchId}:append`),deviceId,entityId:value.id,moduleId:'learning',kind:'learning.usage',schemaVersion:1,baseRevision:null,createdAt:value.createdAt,updatedAt:value.createdAt,action:'put',payload:JSON.parse(JSON.stringify(value))}]},{expectedLocal:{[value.id]:null}});pending.delete(value.id);}
    catch(cause){const saved=await repository.get({moduleId:'learning',entityId:value.id});if(saved?.kind==='learning.usage'&&!saved.deletedAt&&canonical(saved.payload)===canonical(value)){pending.delete(value.id);return;}throw cause;}
  }
  return Object.assign(append,{async flush(){for(const record of [...pending.values()])await append(record);},pending:()=>pending.size});
}
