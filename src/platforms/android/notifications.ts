import type {IsoTime} from '../../workbench/contracts/data';
import type {NotificationPort, Reminder} from '../../workbench/contracts/platform';
import type {LocalRepository} from '../../workbench/storage/repository';
import {CalendarService} from '../../modules/calendar/service';
import {calendarReminders} from '../../modules/calendar/reminders';
import type {AndroidBridge,NotificationStatus,ReminderOperationStatus} from './bridge';
const operationStores=new WeakMap<AndroidBridge,ReturnType<typeof createOperationStore>>();
function createOperationStore(){
 let state:ReminderOperationStatus={state:'idle',error:null};
 let retry:(()=>Promise<unknown>)|undefined;
 const listeners=new Set<()=>void>();
 const publish=(next:ReminderOperationStatus)=>{state=next;for(const listener of listeners)listener();};
 return {snapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>listeners.delete(listener);},
  begin(){publish({...state,state:'rebuilding'});},
  success(){publish({state:'scheduled',error:null,lastSuccessAt:new Date().toISOString()});},
  failure(){publish({...state,state:'failed',error:'日程提醒排程未完成，部分提醒可能缺失。请重试；本机日程仍保留。'});},
  bindRetry(action:()=>Promise<unknown>){retry=action;return()=>{if(retry===action)retry=undefined;};},
  async retry(){if(!retry)throw Error('提醒服务尚未就绪，请重新打开应用');await retry();}
 };
}
export function reminderOperations(bridge:AndroidBridge){let store=operationStores.get(bridge);if(!store){store=createOperationStore();operationStores.set(bridge,store);}return store;}
export async function buildReminders(repository:LocalRepository,now:IsoTime,horizonDays=30):Promise<Reminder[]> {
 const from=Date.parse(now);if(!Number.isFinite(from)||!Number.isInteger(horizonDays)||horizonDays<1||horizonDays>30)throw Error('提醒范围无效');
 const service=new CalendarService(repository,null), to=new Date(from+horizonDays*86400000).toISOString();
 return calendarReminders(await service.series(),await service.overrides(),{from:now,to}).filter(r=>Date.parse(r.fireAt)>from&&Date.parse(r.fireAt)<Date.parse(to));
}
export function createAndroidNotifications(bridge:AndroidBridge):NotificationPort & {status():Promise<NotificationStatus>;request():Promise<NotificationStatus>;exactSettings():Promise<void>} {
 return {async permission(){return (await bridge.notificationCapabilities()).permission;},status:async()=>({...await bridge.notificationCapabilities(),operation:reminderOperations(bridge).snapshot()}),request:()=>bridge.notificationRequest(),exactSettings:()=>bridge.notificationExactSettings(),async reconcile(accountId,reminders){
  await bridge.notificationCapabilities();
  await bridge.notificationReconcile({accountId,reminders,horizonUntil:new Date(Date.now()+30*86400000).toISOString()});
 }};
}
