import {calendarReminders} from '../../modules/calendar/reminders';
import type {CalendarSeries, OccurrenceOverride} from '../../modules/calendar/model';
import type {Entity} from '../../workbench/contracts/data';
import type {Reminder} from '../../workbench/contracts/platform';
import type {LocalRepository} from '../../workbench/storage/repository';

export interface DesktopNativeNotification {
  on(event: string, listener: (...args: any[]) => void): unknown;
  show(): void;
  close(): void;
}
export type DesktopNotificationNative = {supported(): boolean; create(payload: {title: string; body: string}): DesktopNativeNotification};
export type DesktopReminderStatus = {
  state: 'idle' | 'rebuilding' | 'scheduled' | 'disabled' | 'failed' | 'stopped';
  permission: 'unknown' | 'unavailable';
  delivery: 'none' | 'submitted' | 'shown' | 'failed';
  pending: number;
  error: string | null;
  lastRebuiltAt: string | null;
};
type Scope = {accountId: string; repository: LocalRepository; current(): boolean};
type Attempt = {reminder: Reminder; notification?: DesktopNativeNotification; state: 'submitted' | 'shown' | 'failed'};
const graceMs = 60_000, horizonMs = 30 * 86_400_000;
const identity = (reminder: Reminder) => JSON.stringify([reminder.id, reminder.fireAt]);
const failureMessage = '日程提醒未完成，系统可能未显示通知。请检查系统通知设置后重试；本机日程仍保留。';

/** Main-process timer and native delivery. No renderer timer or OS background daemon. */
export function createDesktopCalendarReminders(options: {native: DesktopNotificationNative; enabled(): Promise<boolean>; focus?(): void}) {
  let scope: Scope | undefined, generation = 0, mutations = 0, quitting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Map<string, Reminder>();
  const attempts = new Map<string, Attempt>();
  let state: DesktopReminderStatus = {state:'idle',permission:'unknown',delivery:'none',pending:0,error:null,lastRebuiltAt:null};
  const cancelTimer = () => {clearTimeout(timer); timer=undefined;};
  function close(attempt: Attempt) {try {attempt.notification?.close();} catch {/* Closing an obsolete alert must not prevent account cancellation. */}}
  function clear() {generation++;cancelTimer();pending.clear();for(const attempt of attempts.values())close(attempt);attempts.clear();}
  const failed = () => {state={...state,state:'failed',delivery:'failed',error:failureMessage};};
  function arm() {
    cancelTimer(); if(!scope || quitting || mutations) return;
    const next = Math.min(60_000, ...[...pending.values()].filter(reminder=>Date.parse(reminder.fireAt)>Date.now()).map(reminder=>Math.max(1,Date.parse(reminder.fireAt)-Date.now())));
    timer=setTimeout(()=>{void rebuild();},next);(timer as unknown as {unref?():void}).unref?.();
  }
  function send(reminder: Reminder, owner: Scope) {
    const key=identity(reminder), attempt:Attempt={reminder,state:'submitted'};
    attempts.set(key,attempt);state={...state,delivery:'submitted'};
    const current=()=>scope===owner&&owner.current()&&attempts.get(key)===attempt&&!quitting;
    try {
      const notification=options.native.create({title:'日程提醒',body:reminder.title});attempt.notification=notification;
      notification.on('show',()=>{if(current()){attempt.state='shown';state={...state,delivery:'shown'};}});
      notification.on('failed',()=>{if(current()){attempt.state='failed';failed();}});
      notification.on('click',()=>{if(current())options.focus?.();});
      if(current())notification.show();else close(attempt);
    } catch {if(current()){attempt.state='failed';failed();}}
  }
  async function rebuild(retry=false, resume=false): Promise<void> {
    const owner=scope, own=++generation;cancelTimer();
    if(!owner || quitting || mutations) return;
    const valid=()=>scope===owner&&own===generation&&owner.current()&&!quitting&&!mutations;
    if(!owner.current()){stop(owner.accountId);return;}
    state={...state,state:state.error?'failed':'rebuilding'};
    try {
      const enabled=await options.enabled();if(!valid())return;
      if(!enabled){clear();state={...state,state:'disabled',pending:0,error:null,delivery:'none'};arm();return;}
      const entities=await owner.repository.list('calendar');if(!valid())return;
      const now=Date.now();
      const series=entities.filter(item=>item.kind==='calendar.series') as Entity<CalendarSeries>[];
      const overrides=entities.filter(item=>item.kind==='calendar.override') as Entity<OccurrenceOverride>[];
      const oldestAttempt=Math.min(now-graceMs,...[...attempts.values()].map(attempt=>Date.parse(attempt.reminder.fireAt)));
      const reminders=calendarReminders(series,overrides,{from:new Date(Math.max(now-horizonMs,oldestAttempt)).toISOString(),to:new Date(now+horizonMs).toISOString()});
      const existing=new Set(reminders.map(identity));
      const current=new Map(reminders.filter(reminder=>Date.parse(reminder.fireAt)>now-graceMs&&Date.parse(reminder.fireAt)<now+horizonMs).map(reminder=>[identity(reminder),reminder]));
      // Obsolete alerts (skip/delete/moved occurrence) are also removed from the OS UI.
      for(const [key,attempt] of attempts)if(!existing.has(key)){close(attempt);attempts.delete(key);}
      for(const [key,attempt] of attempts)if(Date.parse(attempt.reminder.fireAt)<now-horizonMs){close(attempt);attempts.delete(key);}
      const due=[...current].filter(([key,reminder])=>Date.parse(reminder.fireAt)<=now&&!resume&&(pending.has(key)||retry&&attempts.get(key)?.state==='failed'));
      pending=new Map([...current].filter(([key,reminder])=>Date.parse(reminder.fireAt)>now&&!attempts.has(key)));
      let supported: boolean | null=null;try {supported=options.native.supported();} catch {/* No OS permission or delivery result can be inferred from a failed probe. */}
      if(!valid())return;
      state={...state,permission:supported===false?'unavailable':'unknown',pending:pending.size,lastRebuiltAt:new Date(now).toISOString()};
      if(!supported){for(const [key,reminder] of due)if(!attempts.has(key))attempts.set(key,{reminder,state:'failed'});failed();arm();return;}
      if(retry){state={...state,error:null,delivery:state.delivery==='failed'?'none':state.delivery};}
      state={...state,state:state.error?'failed':'scheduled'};
      for(const [key,reminder] of due){if(!valid())return;const previous=attempts.get(key);if(previous&&!(retry&&previous.state==='failed'))continue;if(previous)close(previous);send(reminder,owner);}
      arm();
    } catch {if(valid()){failed();arm();}}
  }
  function stop(accountId?: string) {
    if(accountId!==undefined&&scope?.accountId!==accountId)return;
    clear();scope=undefined;state={...state,state:'stopped',pending:0,error:null,delivery:'none'};
  }
  return {
    status: (): DesktopReminderStatus => ({...state}),
    async bind(next: Scope) {
      if(!next.current())throw Error('提醒账户已失效');
      if(scope?.accountId!==next.accountId||scope.repository!==next.repository){clear();state={...state,error:null,delivery:'none'};}
      if(scope?.accountId!==next.accountId||scope.repository!==next.repository)scope=next;
      quitting=false;await rebuild();return {...state};
    },
    stop,
    rebuild: () => rebuild(),
    retry: () => rebuild(true),
    resume: () => rebuild(false,true),
    async mutation<T>(repository: LocalRepository, action: () => Promise<T>): Promise<T> {
      if(scope?.repository!==repository)return action();
      mutations++;generation++;cancelTimer();
      try {return await action();} finally {mutations--;if(!mutations)await rebuild();}
    },
    quit() {quitting=true;stop();},
  };
}
export type DesktopCalendarReminders = ReturnType<typeof createDesktopCalendarReminders>;
