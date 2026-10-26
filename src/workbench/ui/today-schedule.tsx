import {ReferenceChips} from '../../modules/journal/page';
import React, {useEffect, useState, useSyncExternalStore} from 'react';
import type {Entity} from '../contracts/data';
import type {WorkbenchHost} from '../host';
import {dateInZone} from '../activity';
import {expandCalendar} from '../../modules/calendar/recurrence';
import {parseSeries, parseOverride, type CalendarSeries, type Occurrence, type OccurrenceOverride} from '../../modules/calendar/model';

type Props = {host: WorkbenchHost; date: string; timeZone: string; onNavigate?: (moduleId: string) => void};
const DAY = 86_400_000;

/** A system read view: disabling a module never hides already saved arrangements. */
export function TodaySchedule({host, date, timeZone, onNavigate}: Props) {
  useSyncExternalStore(host.subscribe, host.snapshot, host.snapshot);
  const [events, setEvents] = useState<Occurrence[]>([]);
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const enabled = host.modules().some(module => module.id === 'calendar' && module.enabled && module.state === 'ready');
  useEffect(() => {
    let active = true, sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const records = await host.repository.list('calendar');
        const overrides: Entity<OccurrenceOverride>[] = [];
        let incomplete = false;
        for (const record of records.filter(record => !record.deletedAt && record.kind === 'calendar.override')) {
          try {
            if (record.schemaVersion !== 1) throw Error('Newer schema');
            overrides.push({...record, payload: parseOverride(record.payload)});
          } catch {incomplete = true;}
        }
        // Expand a generous UTC window, then classify actual instants in the device zone.
        // This avoids assuming that a civil day is always exactly 24 hours long.
        const anchor = Date.parse(`${date}T00:00:00Z`);
        const range = {from: new Date(anchor - 2 * DAY).toISOString(), to: new Date(anchor + 2 * DAY).toISOString()};
        const next: Occurrence[] = [];
        for (const record of records.filter(record => !record.deletedAt && record.kind === 'calendar.series')) {
          try {
            if (record.schemaVersion !== 1) throw Error('Newer schema');
            const series: Entity<CalendarSeries> = {...record, payload: parseSeries(record.payload)};
            next.push(...expandCalendar(series, overrides, range).filter(event =>
              dateInZone(event.start, timeZone) <= date &&
              dateInZone(new Date(Date.parse(event.end) - 1).toISOString(), timeZone) >= date));
          } catch {incomplete = true;}
        }
        if (active && request === sequence) {
          setEvents(next.sort((a, b) => a.start.localeCompare(b.start)));
          setNotice(incomplete ? '部分安排暂时无法显示，请更新客户端查看；原记录仍保留。' : '');
          setLoaded(true);
        }
      } catch {
        if (active && request === sequence) {setNotice('日程暂时读取失败，请稍后重试。'); setLoaded(true);}
      }
    };
    void refresh();
    const unsubscribe = host.subscribe(() => {void refresh();});
    return () => {active = false; unsubscribe();};
  }, [host, date, timeZone]);
  const format = (value: string) => new Intl.DateTimeFormat('zh-CN', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(value));
  return <section className="wb-card wb-section-list wb-today-schedule" aria-label="今日安排">
    <div className="wb-card-head"><h2>今日安排</h2>{onNavigate && <button onClick={() => onNavigate('calendar')} disabled={!enabled}>查看日程</button>}</div>
    {!enabled && <p className="wb-hint">日程模块已关闭或暂不可用，已有安排仍可回看。</p>}
    {notice && <p role="status" className="wb-hint">{notice}</p>}
    {loaded && events.length === 0 && <p className="wb-empty-line">今天还没有安排。</p>}
    {events.map(event => <article className={`wb-schedule-summary${event.attendance === 'skip' ? ' wb-schedule-skipped' : ''}`} key={event.key}>
      <time dateTime={event.start}>{dateInZone(event.start, timeZone) < date ? '前日 ' : ''}{format(event.start)}–{dateInZone(event.end, timeZone) > date ? '次日 ' : ''}{format(event.end)}</time>
      <strong>{event.title}</strong>
      {event.taskId && <><small>已关联待办</small><ReferenceChips refs={[{moduleId:'tasks', entityId:event.taskId}]} references={host.references}/></>}
      {event.attendance === 'skip' && <small>本次不参加</small>}
    </article>)}
  </section>;
}
