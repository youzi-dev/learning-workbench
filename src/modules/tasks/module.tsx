import React from 'react';
import {manifest} from './manifest';
import type {ModuleContext, WorkbenchModule} from '../../workbench/contracts/module';
import type {JsonValue} from '../../workbench/contracts/data';
import {objectInput, parseId, parseTask, parseStatus, parseRef} from './model';
import {TaskService} from './service';
import {TasksPage} from './page';
export function createModule(): WorkbenchModule {
  let context: ModuleContext | undefined, service: TaskService | undefined;
  const ready = () => {if (!service) throw Error('待办模块尚未就绪'); return service;};
  const query = (input: JsonValue) => {const value = objectInput(input); if (value.query !== undefined && typeof value.query !== 'string') throw Error('搜索内容无效'); return value.query as string | undefined;};
  return {manifest, navigation: [{id: 'home', title: manifest.title}], settings: [],
    commands: {
      async create(input) {return await ready().createTask(parseTask(input));},
      async update(input) {const value = objectInput(input); return await ready().updateTask(parseId(value.id), parseTask(value.task));},
      async status(input) {const value = objectInput(input); return await ready().setTaskStatus(parseId(value.id), parseStatus(value.status), parseId(value.operationId));},
      async list(input) {return await ready().list(query(input)) as unknown as JsonValue;},
      async activities() {return await ready().activities() as unknown as JsonValue;},
      async trash(input) {return await ready().trash(query(input)) as unknown as JsonValue;},
      async delete(input) {return await ready().deleteTask(parseId(objectInput(input).id));},
      async restore(input) {return await ready().restoreTask(parseId(objectInput(input).id));},
      async 'attach-asset'(input) {const value = objectInput(input); return await ready().attachAsset(parseId(value.id ?? value.taskId), parseRef(value.asset));},
    },
    async start(next) {context = next; service = new TaskService(next.repository, next.deviceId);},
    async stop() {service = undefined; context = undefined;},
    render(_routeId, entityId) {return context && service ? <TasksPage context={context} service={service} initialSelected={entityId}/> : null;}
  };
}
