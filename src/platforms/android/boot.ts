import {catalog} from '../../workbench/catalog-ui';
import {catalogSchemas} from '../../workbench/catalog';
import {createWorkbenchRuntime, type WorkbenchRuntime} from '../../workbench/runtime';
import {androidBridge,type AndroidBridge} from './bridge';
import {openRepository} from './repository';
import {createAndroidPorts,androidSettings} from './ports';
import {androidResources} from './resources';
import {createAndroidConnection} from './session';
import {buildReminders,reminderOperations} from './notifications';
/** Uses only account repositories already on this device; no service worker or browser DB. */
export async function bootAndroidRuntime(bridge:AndroidBridge=androidBridge) {
 const ports=createAndroidPorts(bridge);
 const runtime=await createWorkbenchRuntime({registrations:catalog,ports,settings:androidSettings(bridge),connection:createAndroidConnection(bridge),resources:androidResources(bridge),open:(accountId,deviceId)=>openRepository(bridge,accountId,{schemas:catalogSchemas,deviceId})});
 await attachAndroidReminders(runtime,bridge);
 return runtime;
}
export async function attachAndroidReminders(runtime:WorkbenchRuntime,bridge:AndroidBridge) {
 const operation=reminderOperations(bridge);
 let generation=0,queue:Promise<unknown>=Promise.resolve(),unsubscribe=()=>{};
 const rebuild=()=>{
  const own=++generation;
  const state=runtime.snapshot(),account=state.profile?.accountId??'local-device';
  queue=queue.catch(()=>{}).then(async()=>{
   if(own!==generation||!state.active)return;
   operation.begin();
   try {
    const enabled=state.host.modules().some(module=>module.id==='calendar'&&module.enabled&&module.state==='ready');
    const reminders=enabled?await buildReminders(state.repository,new Date().toISOString(),30):[];
    if(own!==generation||runtime.snapshot().scope!==state.scope)return;
    await bridge.notificationReconcile({accountId:account,reminders,horizonUntil:new Date(Date.now()+30*86400000).toISOString()});
    if(own===generation)operation.success();
   } catch(cause) {if(own===generation)operation.failure();throw cause;}
  });
  return queue;
 };
 const backgroundRebuild=()=>{void rebuild().catch(()=>{/* Operational failure is already observable in operation. */});};
 const unbindRetry=operation.bindRetry(rebuild);
 await runtime.setHooks({
  async activate(){unsubscribe();unsubscribe=runtime.snapshot().host.subscribe(backgroundRebuild);await rebuild();},
  async deactivate(account){generation++;unsubscribe();unsubscribe=()=>{};await queue.catch(()=>{});try{await bridge.notificationReconcile({accountId:account,reminders:[]});}catch(cause){operation.failure();throw cause;}}
 });
 const foreground=await bridge.addListener('foreground',backgroundRebuild);
 const stop=runtime.stop.bind(runtime);
 runtime.stop=async()=>{unbindRetry();await foreground.remove();await stop();};
}
