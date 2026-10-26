import React from 'react';
import {manifest} from './manifest';
import type {ModuleContext, WorkbenchModule} from '../../workbench/contracts/module';
import type {JsonValue} from '../../workbench/contracts/data';
import {objectInput, parseId, parseJournal} from './model';
import {JournalService} from './service';
import {JournalPage} from './page';
export function createModule(): WorkbenchModule {
  let context: ModuleContext | undefined, service: JournalService | undefined;
  const ready = () => {if (!service) throw Error('记录模块尚未就绪'); return service;};
  const query = (input: JsonValue) => {const value = objectInput(input); if (value.query !== undefined && typeof value.query !== 'string') throw Error('搜索内容无效'); return value.query as string | undefined;};
  return {manifest, navigation: [{id: 'home', title: manifest.title}], settings: [],
    commands: {
      async save(input) {const value = objectInput(input); return await ready().saveJournal(parseJournal(value.entry ?? value), value.id === undefined ? undefined : parseId(value.id));},
      async list(input) {return await ready().list(query(input)) as unknown as JsonValue;},
      async trash(input) {return await ready().trash(query(input)) as unknown as JsonValue;},
      async delete(input) {return await ready().deleteJournal(parseId(objectInput(input).id));},
      async restore(input) {return await ready().restoreJournal(parseId(objectInput(input).id));},
    },
    async start(next) {context = next; service = new JournalService(next.repository, next.deviceId);},
    async stop() {service = undefined; context = undefined;},
    render() {return context && service ? <JournalPage context={context} service={service}/> : null;}
  };
}
