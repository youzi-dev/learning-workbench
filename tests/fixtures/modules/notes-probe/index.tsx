import React from 'react';
import type {ModuleContext, ModuleManifest, ModuleRegistration} from '../../../../src/workbench/contracts/module';
import type {JsonValue, MutationBatch} from '../../../../src/workbench/contracts/data';
export const manifest: ModuleManifest = {id: 'notes-probe', version: '1.0.0', hostApiVersion: 1, capabilities: [], schemas: {'notes-probe.note': {version: 1, parse(value) {if (!value || typeof value !== 'object' || !('title' in value) || typeof value.title !== 'string') throw Error('invalid note'); return value as JsonValue;}, migrate: value => value}}};
export function registration(options: {startFails?: boolean; stopFails?: boolean; renderFails?: boolean; capabilities?: ModuleManifest['capabilities']} = {}): ModuleRegistration {
  const metadata = {...manifest, capabilities: options.capabilities ?? []}; let context: ModuleContext, signal: AbortSignal;
  return {manifest: metadata, async load() {return {manifest: metadata, navigation: [{id: 'notes', title: '便笺'}], settings: ['便笺偏好'], commands: {
    echo: async input => input,
    write: async input => {await context.repository.commit(input as unknown as MutationBatch); return null;},
    foreignRead: async () => {await context.repository.list('tasks'); return null;},
    apply: async () => {await context.repository.apply({changes: [], nextCursor: 0, hasMore: false}); return null;},
    alive: async () => !signal.aborted,
  }, async start(ctx, abort) {context = ctx; signal = abort; if (options.startFails) throw Error('启动失败');}, async stop() {if (options.stopFails) throw Error('停止失败');}, render() {if (options.renderFails) throw Error('页面失败'); return <h2>便笺内容</h2>;}};}};
}
