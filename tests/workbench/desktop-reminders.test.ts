import {EventEmitter} from 'node:events';
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRepository} from '../../src/platforms/electron/repository';
import {catalogSchemas} from '../../src/workbench/catalog';
import {CalendarService} from '../../src/modules/calendar/service';
import type {CalendarSeries} from '../../src/modules/calendar/model';
import {createDesktopCalendarReminders} from '../../src/platforms/electron/notifications';
import {desktopCalendarHooks} from '../../src/platforms/electron/reminder-hooks';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers();});
const advance = async (ms:number) => {for(let elapsed=0;elapsed<ms;elapsed+=Math.min(30_000,ms-elapsed)){await vi.advanceTimersByTimeAsync(Math.min(30_000,ms-elapsed));for(let i=0;i<20;i++)await new Promise<void>(resolve=>setImmediate(resolve));}};
const meeting = (changes: Partial<CalendarSeries> = {}): CalendarSeries => ({title:'下午会议', kind:'meeting', startLocal:'2026-10-24T14:00',endLocal:'2026-10-24T15:00',timeZone:'Asia/Shanghai',weekly:null,taskId:null,location:'',notes:'',reminderMinutes:10,sourceUid:null,...changes});
async function setup() {
  vi.useFakeTimers({toFake:["Date","setTimeout","clearTimeout"]}); vi.setSystemTime(new Date('2026-10-24T05:49:00Z'));
  const directory=await mkdtemp(join(tmpdir(),'desktop-reminders-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const repository = await openRepository('reminders', {directory,schemas:catalogSchemas}); cleanups.push(() => repository.close());
  const service = new CalendarService(repository,repository.deviceId);
  let enabled = true, current = true, fail = false;
  const shown: {title:string; native: EventEmitter & {show():void; close():void}; closed:boolean}[]=[];
  const reminders = createDesktopCalendarReminders({enabled:async()=>enabled,native:{supported:()=>true,create(payload){const entry={title:payload.body,native:new EventEmitter() as EventEmitter & {show():void;close():void},closed:false};entry.native.show=()=>{shown.push(entry);if(fail)entry.native.emit('failed',{},'PRIVATE');else entry.native.emit('show');};entry.native.close=()=>{entry.closed=true;};return entry.native;}}});
  cleanups.push(()=>reminders.quit());
  const bind=()=>reminders.bind({accountId:'local-device',repository,current:()=>current});
  return {repository,service,reminders,shown,bind,enable:(value:boolean)=>{enabled=value;},current:(value:boolean)=>{current=value;},fail:(value:boolean)=>{fail=value;}};
}
it('calendar_edits_skip_delete_and_time_change_replace_native_schedule',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();expect(e.reminders.status().pending).toBe(1);
 const s=(await e.service.series())[0],occurrence=(await e.service.list({from:'2026-10-24T00:00:00Z',to:'2026-10-25T00:00:00Z'}))[0];
 await e.reminders.mutation(e.repository,()=>e.service.saveOverride({seriesId:s.id,occurrenceKey:occurrence.key,attendance:'skip'}));expect(e.reminders.status().pending).toBe(0);
 await advance(60_000);expect(e.shown).toHaveLength(0);
 await e.reminders.mutation(e.repository,()=>e.service.saveOverride({seriesId:s.id,occurrenceKey:occurrence.key,attendance:'planned',startLocal:'2026-10-24T14:02',endLocal:'2026-10-24T15:02'}));
 expect(e.reminders.status().pending).toBe(1);await advance(120_000);expect(e.shown.map(item=>item.title)).toEqual(['下午会议']);
 await e.reminders.mutation(e.repository,()=>e.service.delete(s.id));expect(e.shown[0].closed).toBe(true);expect(e.reminders.status().pending).toBe(0);
});
it('duplicate_refreshes_do_not_repeat_alerts_and_resume_drops_expired_alerts',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();await e.reminders.rebuild();await advance(60_000);expect(e.shown).toHaveLength(1);
 await e.reminders.rebuild();await advance(120_000);expect(e.shown).toHaveLength(1);
 await e.service.create(meeting({title:'睡眠期间',startLocal:'2026-10-24T14:05',endLocal:'2026-10-24T15:05'}));await e.reminders.rebuild();vi.setSystemTime(new Date('2026-10-24T06:01:00Z'));await e.reminders.resume();await advance(60_000);expect(e.shown).toHaveLength(1);
});
it('a_stale_account_read_cannot_restore_or_deliver_old_notifications',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();
 const original=e.repository.list.bind(e.repository);let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const began=new Promise<void>(resolve=>{entered=resolve;});
 e.repository.list=async id=>{entered();await waiting;return original(id);};const pending=e.reminders.rebuild();await began;e.current(false);const next=await setup();await e.reminders.bind({accountId:'new-account',repository:next.repository,current:()=>true});release();await pending;await advance(60_000);expect(e.reminders.status()).toMatchObject({state:'scheduled',pending:0});expect(e.shown).toHaveLength(0);
});
it('native_failure_is_visible_without_leaking_details_and_retry_recovers_once',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();e.fail(true);await advance(60_000);
 expect(e.reminders.status()).toMatchObject({state:'failed',delivery:'failed',permission:'unknown'});expect(JSON.stringify(e.reminders.status())).not.toContain('PRIVATE');
 await e.reminders.rebuild();expect(e.reminders.status().state).toBe('failed');expect(e.shown).toHaveLength(1);
 e.fail(false);await e.reminders.retry();expect(e.shown).toHaveLength(2);expect(e.reminders.status()).toMatchObject({state:'scheduled',delivery:'shown',error:null});await e.reminders.retry();expect(e.shown).toHaveLength(2);
});
it('native_timer_runs_without_a_renderer_and_module_disable_and_quit_cancel_it',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();await advance(60_000);expect(e.shown).toHaveLength(1);
 e.enable(false);await e.reminders.rebuild();expect(e.shown[0].closed).toBe(true);expect(e.reminders.status()).toMatchObject({state:'disabled',pending:0});
 e.enable(true);await e.service.create(meeting({startLocal:'2026-10-24T14:03',endLocal:'2026-10-24T15:03'}));await e.reminders.rebuild();expect(e.reminders.status().pending).toBe(1);e.reminders.quit();await advance(180_000);expect(e.shown).toHaveLength(1);expect(e.reminders.status().state).toBe('stopped');
});
it('calendar_hooks_compose_learning_hooks_and_stop_mismatched_inactive_scopes',async()=>{
 const calls:string[]=[],handles=new WeakMap<object,{handle:string;accountId:string}>(),repository={} as never;handles.set(repository,{handle:'local-handle',accountId:'local-device'});
 const bridge={async request(operation:string,args:unknown[]=[]){calls.push(`${operation}:${args[0]??''}`);return {ok:true as const,value:null};}};
 const hooks=desktopCalendarHooks(bridge,handles,{async activate(){calls.push('learning-bind');},async deactivate(){calls.push('learning-stop');}});
 await hooks.activate!(null,repository);await hooks.deactivate!('local-device');expect(calls).toEqual(['learning-bind','calendar-bind:local-handle','calendar-stop:local-device','learning-stop']);
 calls.length=0;handles.set(repository,{handle:'account-handle',accountId:'old-account'});await hooks.activate!(null,repository);expect(calls).toEqual(['learning-bind','calendar-stop:old-account']);
});
it('support_probe_failure_preserves_due_reminder_for_an_explicit_retry',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();
 // A system support failure happens before an actual native attempt exists.
 const native={broken:true,shown:0};
 const scheduler=createDesktopCalendarReminders({enabled:async()=>true,native:{supported(){if(native.broken)throw Error('PRIVATE');return true;},create(){const notification=new EventEmitter() as EventEmitter&{show():void;close():void};notification.show=()=>{native.shown++;notification.emit('show');};notification.close=()=>{};return notification;}}});cleanups.push(()=>scheduler.quit());
 await scheduler.bind({accountId:'local-device',repository:e.repository,current:()=>true});await advance(60_000);expect(scheduler.status().state).toBe('failed');native.broken=false;await scheduler.retry();expect(native.shown).toBe(1);
});
it('a_clock_jump_without_resume_does_not_burst_old_alerts_and_a_fresh_bind_skips_past_alerts',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();vi.setSystemTime(new Date('2026-10-24T06:30:00Z'));await advance(60_000);expect(e.shown).toHaveLength(0);
 e.reminders.stop();await e.bind();await advance(60_000);expect(e.shown).toHaveLength(0);
});
it('skip_after_display_closes_the_same_alert_even_after_the_delivery_grace_window',async()=>{
 const e=await setup();await e.service.create(meeting());await e.bind();await advance(60_000);expect(e.shown).toHaveLength(1);await advance(120_000);
 const s=(await e.service.series())[0],occurrence=(await e.service.list({from:'2026-10-24T00:00:00Z',to:'2026-10-25T00:00:00Z'}))[0];await e.reminders.mutation(e.repository,()=>e.service.saveOverride({seriesId:s.id,occurrenceKey:occurrence.key,attendance:'skip'}));expect(e.shown[0].closed).toBe(true);
});
