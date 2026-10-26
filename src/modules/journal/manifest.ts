import type {ModuleManifest, EntitySchema} from '../../workbench/contracts/module';
import {journalJson, parseJournal} from './model';
const migrate: EntitySchema['migrate'] = (value, from) => {if (from !== 1) throw Error('此数据版本需要更新客户端'); return value;};
const entry: EntitySchema = {version: 1, parse: value => journalJson(parseJournal(value)), migrate};
export const manifest: ModuleManifest & {title: string} = {id: 'journal', title: '记录', version: '1.0.0', hostApiVersion: 1, schemas: {'journal.entry': entry}, capabilities: []};
