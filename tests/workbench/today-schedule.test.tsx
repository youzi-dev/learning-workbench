// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {openRepository} from '../../src/platforms/browser/repository';
import {createHost} from '../../src/workbench/host';
import {createModule} from '../../src/modules/calendar/module';
import {manifest} from '../../src/modules/calendar/manifest';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {TodaySchedule} from '../../src/workbench/ui/today-schedule';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
function trackReads(repository: Awaited<ReturnType<typeof openRepository>>) {const reads:Promise<unknown>[]=[];const original=repository.list;repository.list=id=>{const read=original(id);reads.push(read);return read;};return async()=>{await Promise.all(reads);};}
it('shows a task-linked meeting and preserves a skipped instance in the current day',async()=>{
 const repository=await openRepository('today-calendar',{indexedDB:new IDBFactory()});
 cleanup.push(()=>repository.close()); const flush=trackReads(repository);
 const host=createHost([{manifest,load:async()=>createModule()}],createBrowserPorts(),{repository});
 await host.start();cleanup.push(()=>host.stop());
 await host.invoke('calendar','create',{title:'核对资料',kind:'meeting',startLocal:'2026-10-24T14:00',endLocal:'2026-10-24T15:00',timeZone:'Asia/Shanghai',weekly:null,taskId:crypto.randomUUID(),location:'线上',notes:'',reminderMinutes:10,sourceUid:null});
 const occurrences=await host.invoke('calendar','list',{from:'2026-10-23T16:00:00Z',to:'2026-10-24T16:00:00Z'}) as any[];
 await host.invoke('calendar','saveOverride',{seriesId:occurrences[0].seriesId,occurrenceKey:occurrences[0].key,attendance:'skip'});
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element);
 cleanup.push(async()=>{await act(()=>root.unmount());element.remove();});
 await act(async()=>{root.render(<TodaySchedule host={host} date="2026-10-24" timeZone="Asia/Shanghai"/>);});
 await act(flush);expect(element.textContent).toContain('核对资料');expect(element.textContent).toContain('14:00');expect(element.textContent).toContain('本次不参加');
 await act(async()=>{await host.setEnabled('calendar',false);await flush();});
 expect(element.textContent).toContain('核对资料');expect(element.textContent).toContain('已关闭');
});
it('uses the viewing device day for an overnight event rather than the schedule zone',async()=>{
 const repository=await openRepository('today-overnight',{indexedDB:new IDBFactory()});cleanup.push(()=>repository.close()); const flush=trackReads(repository);
 const host=createHost([{manifest,load:async()=>createModule()}],createBrowserPorts(),{repository});await host.start();cleanup.push(()=>host.stop());
 await host.invoke('calendar','create',{title:'跨时区会议',kind:'meeting',startLocal:'2026-10-24T01:00',endLocal:'2026-10-24T02:00',timeZone:'Asia/Shanghai',weekly:null,taskId:null,location:'',notes:'',reminderMinutes:null,sourceUid:null});
 const element=document.createElement('div');document.body.append(element);const root=createRoot(element);cleanup.push(async()=>{await act(()=>root.unmount());element.remove();});
 await act(async()=>{root.render(<TodaySchedule host={host} date="2026-10-23" timeZone="America/New_York"/>);});
 await act(flush);expect(element.textContent).toContain('跨时区会议');expect(element.textContent).toContain('13:00');
 await act(async()=>{root.render(<TodaySchedule host={host} date="2026-10-24" timeZone="America/New_York"/>);});
 await act(flush);expect(element.textContent).not.toContain('跨时区会议');
});
