import React from 'react';
import {manifest} from './manifest';
import type {ModuleContext,WorkbenchModule} from '../../workbench/contracts/module';
import type {JsonValue} from '../../workbench/contracts/data';
import {CalendarService} from './service';
import {CalendarPage} from './page';
import {objectInput,parseSeries,parseOverride,text,type SeriesEditPreview} from './model';
import {calendarReminders} from './reminders';
import type {ImportPreview} from './import';
const json=(value:unknown)=>value as JsonValue;
function range(input:JsonValue){const v=objectInput(input);return {from:text(v.from,'开始范围',false),to:text(v.to,'结束范围',false)};}
export function createModule():WorkbenchModule{let context:ModuleContext|undefined,service:CalendarService|undefined;const ready=()=>{if(!service)throw Error('日程模块尚未就绪');return service;};return {manifest,navigation:[{id:'home',title:manifest.title}],settings:[],commands:{
 async list(input){return json(await ready().list(range(input)));},
 async series(){return json(await ready().series());},
 async create(input){return json(await ready().create(parseSeries(input)));},
 async saveOverride(input){return json(await ready().saveOverride(parseOverride(input)));},
 async previewSeriesEdit(input){const v=objectInput(input);return json(await ready().previewSeriesEdit(text(v.id,'系列',false),parseSeries(v.series)));},
 async saveSeriesEdit(input){const v=objectInput(input);return json(await ready().saveSeriesEdit(text(v.id,'系列',false),parseSeries(v.series),v.preview as SeriesEditPreview|undefined));},
 async previewImport(input){const v=objectInput(input);if(v.format!=='csv'&&v.format!=='ics')throw Error('仅支持 CSV 或 ICS');const options=v.options===undefined?{}:objectInput(v.options);return json(await ready().previewImport(text(v.text,'导入内容',false),v.format,{...(options.sourceId?{sourceId:text(options.sourceId,'来源',false)}:{}),...(options.mapping?{mapping:options.mapping as Record<number,string>}:{})}));},
 async confirmImport(input){return json(await ready().confirmImport(input as unknown as ImportPreview));},
 async reminders(input){return json(calendarReminders(await ready().series(),await ready().overrides(),range(input)));},
 async delete(input){return json(await ready().delete(text(objectInput(input).id,'系列',false)));},
 async restore(input){return json(await ready().restore(text(objectInput(input).id,'系列',false)));}
 },async start(next){context=next;service=new CalendarService(next.repository,next.deviceId);},async stop(){service=undefined;context=undefined;},render(){return service&&context?<CalendarPage context={context} service={service}/>:null;}};}
