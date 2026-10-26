import type {Entity} from '../../workbench/contracts/data';
import type {Reminder} from '../../workbench/contracts/platform';
import type {CalendarSeries,OccurrenceOverride,CalendarRange} from './model';
import {expandCalendar} from './recurrence';
export function calendarReminders(series:Entity<CalendarSeries>[],overrides:Entity<OccurrenceOverride>[],range:CalendarRange):Reminder[]{return series.flatMap(s=>s.deletedAt||s.schemaVersion!==1||s.payload.reminderMinutes===null?[]:expandCalendar(s,overrides,range).filter(o=>o.attendance!=='skip').map(o=>({id:`calendar:${o.key}`,entity:{moduleId:'calendar',entityId:s.id},occurrenceKey:o.key,fireAt:new Date(Date.parse(o.start)-(s.payload.reminderMinutes??10)*60_000).toISOString(),title:s.payload.title})));}
