// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {openRepository} from '../../src/platforms/browser/repository';
import {JournalService} from '../../src/modules/journal/service';
import {TaskService} from '../../src/modules/tasks/service';
import {manifest as journalManifest} from '../../src/modules/journal/manifest';
import {manifest as tasksManifest} from '../../src/modules/tasks/manifest';
import {dateInZone, today} from '../../src/workbench/activity';
import {createModule as createJournalModule} from '../../src/modules/journal/module';
import {createModule as createTasksModule} from '../../src/modules/tasks/module';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {createHost} from '../../src/workbench/host';
import {TodayPage} from '../../src/workbench/ui/today';
import type {Entity, MutationBatch} from '../../src/workbench/contracts/data';
const deviceId = '00000000-0000-4000-8000-000000000001';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
async function setup(indexedDB = new IDBFactory()) {
  const repository = await openRepository('daily-test', {indexedDB, deviceId, schemas: {journal: Object.fromEntries(Object.entries(journalManifest.schemas).map(([k, v]) => [k, v.version])), tasks: Object.fromEntries(Object.entries(tasksManifest.schemas).map(([k, v]) => [k, v.version])), library: {'library.asset': 1}}});
  cleanups.push(() => repository.close());
  return {repository, tasks: new TaskService(repository, deviceId), journal: new JournalService(repository, deviceId), indexedDB};
}
const inputTask = (title = '读完章节') => ({title, status: 'open' as const, dueAt: '2026-10-21T10:00:00.000Z', priority: 'normal' as const, assets: []});
async function firstTask(env: Awaited<ReturnType<typeof setup>>) {await env.tasks.createTask(inputTask()); return (await env.tasks.list()).find(e => e.kind === 'tasks.task')!;}
it('complete_retry_creates_one_activity', async () => {
  const env = await setup(), task = await firstTask(env), operationId = crypto.randomUUID();
  const first = await env.tasks.setTaskStatus(task.id, 'done', operationId);
  expect(await env.tasks.setTaskStatus(task.id, 'done', operationId)).toEqual(first);
  await Promise.all([env.tasks.setTaskStatus(task.id, 'done', crypto.randomUUID()), env.tasks.setTaskStatus(task.id, 'done', crypto.randomUUID())]);
  const activities = (await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity');
  expect(activities).toHaveLength(1);
  expect(activities[0].payload).toMatchObject({source: 'system', action: 'task-completed', operationId, target: {moduleId: 'tasks', entityId: task.id}});
  const statusBatch = (await env.repository.pending()).find(b => b.batchId === first.batchId)!;
  expect(statusBatch.mutations.map(m => m.kind).sort()).toEqual(['tasks.activity', 'tasks.task']);
  expect(statusBatch.mutations.every(m => m.baseRevision === null)).toBe(true);
});
it('undo_records_distinct_activity_and_late_retry_does_not_complete_again', async () => {
  const env = await setup(), task = await firstTask(env), completed = crypto.randomUUID(), reopened = crypto.randomUUID();
  await env.tasks.setTaskStatus(task.id, 'done', completed);
  await env.tasks.setTaskStatus(task.id, 'open', reopened);
  await new TaskService(env.repository, deviceId).setTaskStatus(task.id, 'done', completed);
  expect((await env.repository.get({moduleId: 'tasks', entityId: task.id}))?.payload).toMatchObject({status: 'open'});
  expect((await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity').map(e => e.payload)).toEqual(expect.arrayContaining([expect.objectContaining({operationId: completed, action: 'task-completed'}), expect.objectContaining({operationId: reopened, action: 'task-reopened'})]));
  expect((await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity')).toHaveLength(2);
  await expect(env.tasks.setTaskStatus(task.id, 'open', completed)).rejects.toThrow(/操作/);
});
it('failed_status_commit_retries_the_exact_batch_and_is_atomic', async () => {
  const env = await setup(), task = await firstTask(env); let captured: MutationBatch | undefined, failed = false;
  const originalCommit = env.repository.commit;
  env.repository.commit = async batch => {if (batch.mutations.some(m => m.kind === 'tasks.activity') && !failed) {captured = structuredClone(batch); failed = true; throw Error('磁盘暂时不可用');} if (captured) expect(batch).toEqual(captured); return originalCommit(batch);};
  const operation = crypto.randomUUID();
  await expect(env.tasks.setTaskStatus(task.id, 'done', operation)).rejects.toThrow('磁盘暂时不可用');
  expect((await env.repository.get({moduleId: 'tasks', entityId: task.id}))?.payload).toMatchObject({status: 'open'});
  expect((await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity')).toHaveLength(0);
  await env.tasks.setTaskStatus(task.id, 'done', operation);
  expect((await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity')).toHaveLength(1);
});
it('overdue_keeps_original_due_date_and_today_uses_shanghai_boundary', async () => {
  const env = await setup(), task = await firstTask(env);
  await env.journal.saveJournal({text: '晚上记录', tags: [], attachments: []});
  const result = await today(env.repository, '2026-10-23', 'Asia/Shanghai');
  expect(result.pending.map(e => e.id)).toContain(task.id);
  expect((await env.repository.get({moduleId: 'tasks', entityId: task.id}))?.payload).toMatchObject({dueAt: '2026-10-21T10:00:00.000Z'});
  const entry: Entity = {id: crypto.randomUUID(), moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, revision: 1, createdAt: '2026-10-22T16:00:00.000Z', updatedAt: '2026-10-22T16:00:00.000Z', deletedAt: null, payload: {text: '零点', tags: [], attachments: []}};
  await env.repository.apply({changes: [{cursor: 1, batchId: 'remote', entities: [entry]}], nextCursor: 1, hasMore: false});
  expect((await today(env.repository, '2026-10-23', 'Asia/Shanghai')).entries.map(e => e.id)).toContain(entry.id);
  expect((await today(env.repository, '2026-10-22', 'Asia/Shanghai')).entries.map(e => e.id)).not.toContain(entry.id);
});
it('delete_task_keeps_asset_and_restore_keeps_original_tombstone', async () => {
  const env = await setup(), task = await firstTask(env), assetId = crypto.randomUUID();
  await env.repository.commit({batchId: crypto.randomUUID(), mutations: [{operationId: crypto.randomUUID(), deviceId, moduleId: 'library', entityId: assetId, kind: 'library.asset', schemaVersion: 1, baseRevision: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), action: 'put', payload: {title: '资料'}}]});
  await env.tasks.attachAsset(task.id, {moduleId: 'library', entityId: assetId});
  await env.tasks.deleteTask(task.id);
  expect((await env.repository.get({moduleId: 'tasks', entityId: task.id}))?.deletedAt).toBeTruthy();
  expect((await env.repository.get({moduleId: 'library', entityId: assetId}))?.deletedAt).toBeNull();
  const [trash] = await env.tasks.trash(); await env.tasks.restoreTask(trash.id);
  const restored = (await env.tasks.list()).find(e => !e.deletedAt)!;
  expect(restored.id).not.toBe(task.id);
  expect(restored.payload).toMatchObject({title: '读完章节', assets: [{moduleId: 'library', entityId: assetId}]});
  expect(await env.tasks.trash()).toHaveLength(0);
});
it('restart_preserves_journal_and_search_tags_and_trash', async () => {
  const env = await setup(); await env.journal.saveJournal({text: '需要记住的内容', tags: ['灵感'], attachments: []});
  const [entry] = await env.journal.list('灵感'); expect(entry.payload).toMatchObject({text: '需要记住的内容'});
  env.repository.close(); const reopened = await setup(env.indexedDB);
  expect(await reopened.journal.list('需要记住')).toHaveLength(1);
  await reopened.journal.deleteJournal(entry.id); expect(await reopened.journal.list()).toHaveLength(0);
  const [trash] = await reopened.journal.trash(); await reopened.journal.restoreJournal(trash.id);
  expect(await reopened.journal.list()).toHaveLength(1);
});
it('validates_required_fields_and_future_schemas_are_readonly', async () => {
  const env = await setup();
  await expect(env.tasks.createTask({...inputTask(), title: '  '})).rejects.toThrow(/标题/);
  await expect(env.journal.saveJournal({text: ' ', tags: [], attachments: []})).rejects.toThrow(/内容/);
  const future: Entity = {id: crypto.randomUUID(), moduleId: 'tasks', kind: 'tasks.task', schemaVersion: 9, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, payload: {title: '新版本', future: true}};
  await env.repository.apply({changes: [{cursor: 1, batchId: 'future', entities: [future]}], nextCursor: 1, hasMore: false});
  expect(await env.tasks.list()).toHaveLength(1);
  await expect(env.tasks.setTaskStatus(future.id, 'done', crypto.randomUUID())).rejects.toThrow(/更新|只读/);
  expect(await env.repository.get({moduleId: 'tasks', entityId: future.id})).toEqual(future);
  await expect(new TaskService(env.repository, null).createTask(inputTask())).rejects.toThrow(/设备|只读/);
});
it('public_commands_validate_inputs_and_attach_asset_uses_owned_task', async () => {
  const env = await setup(), host = createHost([{manifest: tasksManifest, async load() {return createTasksModule();}}], createBrowserPorts(), {repository: env.repository});
  cleanups.push(() => host.stop()); await host.start();
  await expect(host.invoke('tasks', 'create', {title: ''})).rejects.toThrow(/标题/);
  const receipt = await host.invoke('tasks', 'create', {title: '新待办'}) as {batchId: string}; expect(receipt.batchId).toBeTruthy();
  const task = (await env.tasks.list())[0], asset = {moduleId: 'library', entityId: crypto.randomUUID()};
  await host.invoke('tasks', 'attach-asset', {id: task.id, asset});
  await host.invoke('tasks', 'attach-asset', {id: task.id, asset});
  expect((await env.repository.get({moduleId: 'tasks', entityId: task.id}))?.payload).toMatchObject({assets: [asset]});
  await expect(host.invoke('tasks', 'status', {id: task.id, status: 'unknown', operationId: crypto.randomUUID()})).rejects.toThrow();
});

async function uiSetup() {
  const env = await setup(), host = createHost([{manifest: journalManifest, async load() {return createJournalModule();}}, {manifest: tasksManifest, async load() {return createTasksModule();}}, {manifest: {id: 'library', version: '1.0.0', hostApiVersion: 1, schemas: {}, capabilities: []}, async load() {return {manifest: this.manifest, navigation: [{id: 'home', title: '资料'}], commands: {}, settings: [], async start() {}, async stop() {}, render() {return null;}};}}], createBrowserPorts(), {repository: env.repository});
  await host.start(); cleanups.push(() => host.stop());
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  cleanups.push(async () => {await act(() => root.unmount()); container.remove();});
  await act(async () => {root.render(<TodayPage host={host} onNavigate={id => {container.dataset.navigate = id;}}/>);});
  await until(() => container.textContent!.includes('今天还没写下什么'));
  return {...env, host, container, root};
}
async function until(predicate: () => boolean) {for (let attempt = 0; attempt < 100; attempt++) {if (predicate()) return; await act(() => new Promise(resolve => setTimeout(resolve, 5)));} throw Error('界面未按预期更新');}
const buttonNamed = (container: HTMLElement, text: string) => [...container.querySelectorAll('button')].find(button => button.textContent?.includes(text))!;
async function fill(element: HTMLTextAreaElement | HTMLInputElement, value: string) {await act(async () => {Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', {bubbles: true}));});}
it('today_quick_forms_persist_and_completion_undo_updates_real_history', async () => {
  const env = await uiSetup(); expect(env.container.textContent).toContain('今天还没写下什么');
  await act(async () => buttonNamed(env.container, '记一下').click());
  await fill(env.container.querySelector('textarea')!, '今天真正写下的记录');
  await act(async () => {env.container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
  await until(() => env.container.textContent!.includes('今天真正写下的记录') && !env.container.querySelector('textarea'));
  expect(await env.journal.list()).toHaveLength(1); expect(env.container.querySelector('[aria-label="今天的手写记录"]')!.textContent).toContain('今天真正写下的记录');
  await act(async () => buttonNamed(env.container, '添加待办').click());
  await fill(env.container.querySelector('input[aria-label="待办标题"]')!, '完成一次真实操作');
  await act(async () => {env.container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
  await until(() => !!env.container.querySelector('button[aria-label="完成：完成一次真实操作"]'));
  expect(await env.tasks.list()).toHaveLength(1);
  await act(async () => {env.container.querySelector<HTMLButtonElement>('button[aria-label="完成：完成一次真实操作"]')!.click();});
  await until(() => env.container.querySelector('[aria-label="系统活动"]')!.textContent!.includes('已完成 ·'));
  expect(env.container.querySelector('[aria-label="系统活动"]')!.textContent).toContain('已完成 · 完成一次真实操作');
  expect(env.container.querySelector('[aria-label="今天的手写记录"]')!.textContent).not.toContain('已完成 ·');
  await act(async () => buttonNamed(env.container, '撤销完成').click());
  await until(() => env.container.querySelector('[aria-label="系统活动"]')!.textContent!.includes('撤销完成 ·'));
  expect(env.container.querySelector('[aria-label="系统活动"]')!.textContent).toContain('撤销完成 · 完成一次真实操作');
  expect(env.container.querySelector('[aria-label="待处理事项"]')!.textContent).toContain('完成一次真实操作');
  expect((await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity')).toHaveLength(2);
  await act(async () => buttonNamed(env.container, '收集网址').click()); expect(env.container.dataset.navigate).toBe('library');
});
it('today_handles_remote_updates_disabled_modules_and_newer_activity_schema', async () => {
  const env = await uiSetup(); await act(async () => {await env.host.invoke('tasks', 'create', {title: '关闭后仍可回看'}); await env.host.setEnabled('tasks', false);});
  await until(() => env.container.querySelector('[aria-label="待处理事项"]')!.textContent!.includes('关闭后仍可回看'));
  expect(env.container.querySelector('[aria-label="待处理事项"]')!.textContent).toContain('关闭后仍可回看');
  expect(env.container.querySelector('[aria-label="完成：关闭后仍可回看"]')).toBeNull();
  const entry: Entity = {id: crypto.randomUUID(), moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, payload: {text: '远端同步到达', tags: [], attachments: []}};
  const activity: Entity = {...entry, id: crypto.randomUUID(), moduleId: 'tasks', kind: 'tasks.activity', schemaVersion: 7, payload: {title: '未来活动', occurredAt: new Date().toISOString()}};
  await act(async () => {await env.repository.apply({changes: [{cursor: 1, batchId: 'remote-ui', entities: [entry, activity]}], nextCursor: 1, hasMore: false}); env.host.notifyDataChanged();});
  await until(() => env.container.textContent!.includes('远端同步到达'));
  expect(env.container.textContent).toContain('远端同步到达'); expect(env.container.textContent).toContain('此系统活动需要更新客户端');
});
it('today_save_failure_keeps_draft_and_shows_error', async () => {
  const env = await uiSetup(); await act(async () => buttonNamed(env.container, '记一下').click()); await fill(env.container.querySelector('textarea')!, '不能丢失的草稿');
  env.repository.commit = async () => {throw Error('空间不足，保存失败');};
  await act(async () => {env.container.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));});
  await until(() => !!env.container.querySelector('[role="alert"]'));
  expect(env.container.querySelector('[role="alert"]')!.textContent).toContain('空间不足，保存失败');
  expect(env.container.querySelector('textarea')!.value).toBe('不能丢失的草稿'); expect(await env.journal.list()).toHaveLength(0);
});

it('noop_retry_after_undo_and_restart_stays_a_noop', async () => {
  const env = await setup(), task = await firstTask(env), duplicate = crypto.randomUUID();
  await env.tasks.setTaskStatus(task.id, 'done', crypto.randomUUID());
  await env.tasks.setTaskStatus(task.id, 'done', duplicate);
  await env.tasks.setTaskStatus(task.id, 'open', crypto.randomUUID());
  await new TaskService(env.repository, deviceId).setTaskStatus(task.id, 'done', duplicate);
  expect((await env.repository.get({moduleId: 'tasks', entityId: task.id}))?.payload).toMatchObject({status: 'open'});
  expect((await env.repository.list('tasks')).filter(e => e.kind === 'tasks.activity')).toHaveLength(2);
});
it('manifest_validates_activity_identifiers_and_command_payloads', () => {
  const valid = {source: 'system', action: 'task-completed', target: {moduleId: 'tasks', entityId: crypto.randomUUID()}, operationId: crypto.randomUUID(), occurredAt: new Date().toISOString()};
  expect(() => tasksManifest.schemas['tasks.activity'].parse({...valid, target: {moduleId: 'tasks', entityId: 'wrong-id'}})).toThrow();
  expect(() => tasksManifest.schemas['tasks.activity'].parse({...valid, operationId: 'wrong-id'})).toThrow();
  expect(() => tasksManifest.schemas['tasks.activity'].parse({...valid, source: 'user'})).toThrow();
  expect(() => tasksManifest.schemas['tasks.operation'].parse({target: valid.target, status: 'done', operationId: 'wrong-id', occurredAt: valid.occurredAt})).toThrow();
  expect(journalManifest.schemas['journal.entry'].parse({text: '只写内容'})).toEqual({text: '只写内容', tags: [], attachments: []});
  expect(tasksManifest.schemas['tasks.task'].parse({title: '只写标题'})).toEqual({title: '只写标题', status: 'open', dueAt: null, priority: 'normal', assets: []});
});

function deviceClock(zone: string, now: string) {
  const previous = process.env.TZ; process.env.TZ = zone;
  vi.useFakeTimers({toFake: ['Date', 'setInterval', 'clearInterval']}); vi.setSystemTime(new Date(now));
  cleanups.push(() => {vi.useRealTimers(); if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;});
}
it('today_defaults_to_device_day_and_passes_its_zone_to_entry_and_due_date_cards', async () => {
  deviceClock('America/New_York', '2026-10-23T18:00:00.000Z');
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
  expect(dateInZone()).toBe('2026-10-23');
  const env = await uiSetup();
  const journal = (text: string, createdAt: string): Entity => ({id: crypto.randomUUID(), moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, revision: 1, createdAt, updatedAt: createdAt, deletedAt: null, payload: {text, tags: [], attachments: []}});
  const task: Entity = {id: crypto.randomUUID(), moduleId: 'tasks', kind: 'tasks.task', schemaVersion: 1, revision: 1, createdAt: '2026-10-23T18:00:00.000Z', updatedAt: '2026-10-23T18:00:00.000Z', deletedAt: null, payload: {...inputTask('纽约今天到期'), dueAt: '2026-10-24T01:00:00.000Z'}};
  await act(async () => {await env.repository.apply({changes: [{cursor: 1, batchId: 'device-day', entities: [journal('纽约当日记录', '2026-10-23T18:00:00.000Z'), journal('纽约明日记录', '2026-10-24T04:00:00.000Z'), task]}], nextCursor: 1, hasMore: false}); env.host.notifyDataChanged();});
  await until(() => env.container.textContent!.includes('纽约当日记录'));
  expect(env.container.querySelector('.wb-page-intro .wb-eyebrow')!.textContent).toBe('10月23日星期五');
  expect(env.container.textContent).not.toContain('纽约明日记录');
  expect(env.container.querySelector('[aria-label="今天的手写记录"] time')!.textContent).toContain('14:00');
  expect(env.container.querySelector('[aria-label="待处理事项"]')!.textContent).toContain('截止 2026-10-23');
  const aggregate = await today(env.repository); expect(aggregate.entries.map(e => (e.payload as any).text)).toEqual(['纽约当日记录']);
});
it('explicit_western_zone_keeps_the_selected_calendar_heading_and_card_zone', async () => {
  deviceClock('Asia/Shanghai', '2026-10-24T03:00:00.000Z');
  const env = await uiSetup();
  const journal: Entity = {id: crypto.randomUUID(), moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, revision: 1, createdAt: '2026-10-24T02:00:00.000Z', updatedAt: '2026-10-24T02:00:00.000Z', deletedAt: null, payload: {text: '檀香山的记录', tags: [], attachments: []}};
  const task: Entity = {...journal, id: crypto.randomUUID(), moduleId: 'tasks', kind: 'tasks.task', payload: {...inputTask('檀香山今天到期'), dueAt: '2026-10-24T01:00:00.000Z'}};
  await env.repository.apply({changes: [{cursor: 1, batchId: 'western-zone', entities: [journal, task]}], nextCursor: 1, hasMore: false});
  await act(async () => {env.root.render(<TodayPage host={env.host} date="2026-10-23" timeZone="Pacific/Honolulu"/>);});
  expect(env.container.querySelector('.wb-page-intro .wb-eyebrow')!.textContent).toBe('10月23日星期五');
  await until(() => env.container.textContent!.includes('檀香山的记录'));
  expect(env.container.querySelector('[aria-label="今天的手写记录"] time')!.textContent).toContain('16:00');
  expect(env.container.querySelector('[aria-label="待处理事项"]')!.textContent).toContain('截止 2026-10-23');
  expect((await today(env.repository, undefined, 'Pacific/Honolulu')).entries.map(e => (e.payload as any).text)).toEqual(['檀香山的记录']);
});

it('today_midnight_refresh_uses_the_same_device_zone_for_heading_and_records', async () => {
  deviceClock('America/New_York', '2026-10-24T03:59:50.000Z');
  const env = await uiSetup();
  const journal = (text: string, createdAt: string): Entity => ({id: crypto.randomUUID(), moduleId: 'journal', kind: 'journal.entry', schemaVersion: 1, revision: 1, createdAt, updatedAt: createdAt, deletedAt: null, payload: {text, tags: [], attachments: []}});
  await act(async () => {await env.repository.apply({changes: [{cursor: 1, batchId: 'device-midnight', entities: [journal('纽约午夜前', '2026-10-24T03:30:00.000Z'), journal('纽约午夜后', '2026-10-24T04:00:10.000Z')]}], nextCursor: 1, hasMore: false}); env.host.notifyDataChanged();});
  await until(() => env.container.textContent!.includes('纽约午夜前'));
  expect(env.container.querySelector('.wb-page-intro .wb-eyebrow')!.textContent).toBe('10月23日星期五');
  expect(env.container.textContent).not.toContain('纽约午夜后');
  await act(async () => {await vi.advanceTimersByTimeAsync(30_000);});
  await until(() => env.container.textContent!.includes('纽约午夜后'));
  expect(env.container.querySelector('.wb-page-intro .wb-eyebrow')!.textContent).toBe('10月24日星期六');
  expect(env.container.textContent).not.toContain('纽约午夜前');
});
