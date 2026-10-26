import type {Id} from '../../workbench/contracts/data';
import {createRepository,RepositoryError,type ManagedRepository,type RepositoryDriver,type RepositoryOptions,type RepositoryState} from '../../workbench/storage/repository';
import type {AndroidBridge} from './bridge';
/** Native snapshots and revision checked atomic commits reuse the shared domain repository. */
export async function openRepository(bridge:AndroidBridge,accountId:Id,options:RepositoryOptions={}):Promise<ManagedRepository> {
 if(!accountId)throw new RepositoryError('invalid');
 const descriptor=await bridge.repositoryOpen({accountId});
 if(descriptor.sqliteVersion!=='3.53.4'||(!descriptor.readonly&&descriptor.journalMode.toLowerCase()!=='wal')){await bridge.repositoryClose({handle:descriptor.handle});throw new RepositoryError('unsupported-sqlite','本机数据库版本或持久化模式未通过检查');}
 let queue:Promise<unknown>=Promise.resolve(),closed=false;
 const enqueue=<T>(action:()=>Promise<T>)=>{if(closed)return Promise.reject(new RepositoryError('unavailable'));const result=queue.catch(()=>{}).then(action);queue=result;return result;};
 const driver:RepositoryDriver={readonly:descriptor.readonly,read:action=>enqueue(async()=>{const snapshot=await bridge.repositorySnapshot({handle:descriptor.handle});return action(snapshot.state);}),write:action=>enqueue(async()=>{if(descriptor.readonly)throw new RepositoryError('readonly-schema');const snapshot=await bridge.repositorySnapshot({handle:descriptor.handle});const state:RepositoryState=structuredClone(snapshot.state);const result=action(state);await bridge.repositoryCommit({handle:descriptor.handle,revision:snapshot.revision,state});return result;}),close(){if(closed)return;closed=true;void queue.catch(()=>{}).then(()=>bridge.repositoryClose({handle:descriptor.handle})).catch(()=>{});}};
 try{return await createRepository(driver,options);}catch(cause){driver.close();throw cause;}
}
