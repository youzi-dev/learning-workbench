import type {ModuleManifest, EntitySchema} from '../../workbench/contracts/module';
import {parseActivity} from '../../workbench/activity';
import {taskJson, parseTask, parseStatusOperation} from './model';
const migrate: EntitySchema['migrate'] = (value, from) => {if (from !== 1) throw Error('此数据版本需要更新客户端'); return value;};
const task: EntitySchema = {version: 1, parse: value => taskJson(parseTask(value)), migrate};
export const manifest: ModuleManifest & {title: string} = {id: 'tasks', title: '待办', version: '1.0.0', hostApiVersion: 1, schemas: {'tasks.task': task, 'tasks.activity': {version: 1, parse: parseActivity, migrate}, 'tasks.operation': {version: 1, parse: parseStatusOperation, migrate}}, capabilities: []};
