// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {emptyBrowserDocument, type BrowserDocument, type BrowserSnapshot} from '../src/core/browser-state';
import {createBrowserController, type BrowserController} from '../src/browser/controller';
import {openBrowserRepository, type BrowserRepository} from '../src/browser/repository';
import {BrowserApp} from '../src/browser/app';
import {createBackup, readBackup} from '../src/core/backup';
import {beginLab, setLabCode} from '../src/core/lab';
import type {PwaReadiness} from '../src/browser/pwa';

const pwaCapture = vi.hoisted(() => ({readiness: null as PwaReadiness | null}));
vi.mock('../src/renderer/lab-client', () => ({executeLab: async () => {throw new Error('本输入回归不执行代码');}}));
vi.mock('../src/browser/pwa', () => ({registerBrowserPwa: async (_base: string, readiness: PwaReadiness) => {pwaCapture.readiness = readiness; return ({
  status: () => ({phase: 'not-ready', install: 'unsupported', message: '测试离线状态'}),
  subscribe: () => () => {}, install: async () => 'unsupported', requestUpdate: async () => false, dispose: () => {},
});}}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{host: HTMLDivElement; root: Root}> = [];
const realControllers: BrowserController[] = [];
const realRepositories: BrowserRepository[] = [];
afterEach(async () => {for (const {host, root} of mounted.splice(0)) {await act(async () => root.unmount()); host.remove();} realControllers.splice(0).forEach(c => c.close()); realRepositories.splice(0).forEach(r => r.close());});

function memoryController(initial = emptyBrowserDocument()) {
  let document = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  const snapshot = (): BrowserSnapshot => ({schemaVersion: 1, revision, updatedAt: '2026-10-05T00:00:00.000Z', document});
  const controller: BrowserController = {
    snapshot, pendingDocument: () => document,
    subscribe: (listener: () => void) => {listeners.add(listener); return () => listeners.delete(listener);},
    change: async (mutator: (latest: BrowserDocument) => BrowserDocument) => {document = mutator(document); revision++; listeners.forEach(fn => fn()); return snapshot();},
    flush: async () => {}, replace: async (next: BrowserDocument) => {document = next; revision++; listeners.forEach(fn => fn()); return snapshot();},
    isBusy: () => false, hasPending: () => false, storageStatus: () => 'saved' as const,
    recoveries: async () => [], reloadLatest: async () => snapshot(), close: () => {},
    acquireUpdateLock: () => () => {},
    documentGeneration: () => 0, messageDraftRevision: () => 0,
    acquireVoiceOperation: () => {throw new Error('Voice input is disabled in this legacy UI fixture.');},
    withOperation: async <T,>(_kind: string, operation: () => Promise<T>) => operation(),
  };
  return controller;
}
async function mount(initial?: BrowserDocument, providedController?: BrowserController) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); mounted.push({host, root});
  const controller = providedController ?? memoryController(initial);
  await act(async () => root.render(<BrowserApp controller={controller}/>));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
    if (!button) throw new Error(`找不到按钮：${label}`);
    await act(async () => button.click());
  };
  return {host, controller, click};
}

it('starts without Electron or Monaco and intro adds no learning evidence', async () => {
  expect((window as any).workbench).toBeUndefined();
  const ui = await mount();
  expect(ui.host.textContent).toContain('先看一个例子');
  await ui.click('开始学习');
  expect(ui.host.textContent).toContain('参数是送进去的材料');
  expect(ui.host.querySelector('[aria-label="你的代码"]')).toBeNull();
  expect(ui.controller.pendingDocument().state.lab.attempts).toEqual([]);
  expect(ui.controller.pendingDocument().state.columns).toEqual([]);
  expect(ui.controller.pendingDocument().state.checkins).toEqual([]);
  expect(ui.host.querySelector('.monaco-editor')).toBeNull();
});

it('keeps real source links and user references separate from verified lessons', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  const ui = await mount(initial);
  await ui.click('资料');
  expect(ui.host.textContent).toContain('菜鸟教程');
  const external = [...ui.host.querySelectorAll<HTMLAnchorElement>('a')].filter(a => a.hostname === 'www.runoob.com');
  expect(external.length).toBeGreaterThan(0);
  expect(external.every(a => a.target === '_blank' && a.rel.includes('noopener'))).toBe(true);
  expect(ui.host.querySelector('iframe')).toBeNull();
  expect(ui.controller.pendingDocument().state.columns).toEqual([]);
});

it('keeps acknowledged update readiness clean when a course link is dispatched, then resumes after release', async () => {
  const repository = await openBrowserRepository(new IDBFactory()); realRepositories.push(repository);
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  await repository.commit(initial, 0);
  const controller = await createBrowserController(repository); realControllers.push(controller);
  const ui = await mount(undefined, controller); await ui.click('资料');
  const reference = ui.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="选取的片段"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(reference, '已经保存的原文片段');
    reference.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await ui.click('保存参考片段');
  await act(async () => {await controller.flush();});
  const readiness = pwaCapture.readiness!;
  const before = controller.snapshot();
  const url = ui.host.querySelector<HTMLInputElement>('input[aria-label="原文地址"]')!;
  const course = ui.host.querySelector<HTMLAnchorElement>('.browser-courses a')!;
  let release: (() => void) | undefined;
  try {
    await act(async () => {release = readiness.acquireUpdateLock();});
    // The same clean check supplies PREPARE and COMMIT acknowledgements while retaining the lock.
    await readiness.flush(); await readiness.flush();
    expect(readiness.isBusy()).toBe(false); expect(readiness.hasPending()).toBe(false);
    const heldClick = new MouseEvent('click', {bubbles: true, cancelable: true});
    // jsdom's .click() wrongly suppresses anchors in disabled fieldsets; dispatch the actual React path.
    await act(async () => {course.dispatchEvent(heldClick);});
    expect(readiness.hasPending()).toBe(false);
    expect(url.value).toBe(initial.state.reading.url);
    expect(reference.value).toBe('已经保存的原文片段');
    expect(controller.pendingDocument()).toEqual(before.document);
    expect(controller.snapshot()).toEqual(before);
    expect(ui.host.querySelector('[role="alert"]')).toBeNull();
    expect(heldClick.defaultPrevented).toBe(true);
    expect(ui.host.querySelector('.browser-interactive')!.hasAttribute('inert')).toBe(true);
    expect(ui.host.querySelector('.browser-interactive')!.getAttribute('aria-disabled')).toBe('true');
    expect(course.getAttribute('aria-disabled')).toBe('true'); expect(course.tabIndex).toBe(-1);
    const savedLink = ui.host.querySelector<HTMLAnchorElement>('details a')!;
    const heldSavedClick = new MouseEvent('click', {bubbles: true, cancelable: true});
    await act(async () => {savedLink.dispatchEvent(heldSavedClick);});
    expect(heldSavedClick.defaultPrevented).toBe(true);
    expect(savedLink.getAttribute('aria-disabled')).toBe('true'); expect(savedLink.tabIndex).toBe(-1);
    await act(async () => {release!();}); release = undefined;
    expect(ui.host.querySelector('.browser-interactive')!.hasAttribute('inert')).toBe(false);
    expect(ui.host.querySelector('.browser-interactive')!.getAttribute('aria-disabled')).toBeNull();
    expect(course.getAttribute('aria-disabled')).toBeNull(); expect(course.tabIndex).toBe(0);
    expect(savedLink.getAttribute('aria-disabled')).toBeNull(); expect(savedLink.tabIndex).toBe(0);
    const resumedClick = new MouseEvent('click', {bubbles: true, cancelable: true});
    await act(async () => {course.dispatchEvent(resumedClick); await controller.flush();});
    expect(resumedClick.defaultPrevented).toBe(false);
    expect(course.target).toBe('_blank'); expect(course.rel).toContain('noopener');
    expect(url.value).toBe('https://www.runoob.com/python3/python3-tutorial.html');
    expect(controller.pendingDocument().state.reading).toEqual({url: 'https://www.runoob.com/python3/python3-tutorial.html', title: 'Python'});
    expect(readiness.hasPending()).toBe(true);
    expect(controller.pendingDocument().drafts.references).toEqual(before.document.drafts.references);
  } finally {if (release) await act(async () => release!());}
});

it('shows an unsaved status globally and has an export path', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  const controller = memoryController(initial);
  controller.storageStatus = () => 'unsaved'; controller.hasPending = () => true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); mounted.push({host, root});
  await act(async () => root.render(<BrowserApp controller={controller}/>));
  expect(host.querySelector('[role="status"]')!.textContent).toContain('尚未保存');
  const settings = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === '设置')!;
  await act(async () => settings.click());
  expect(host.textContent).toContain('导出待存备份');
});

it('labels phone project and system limits and preserves imported records', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  initial.state.checkins = [{date: '2026-10-04', columnId: 'old', note: '原始备份记录'}];
  const ui = await mount(initial);
  await ui.click('记录');
  expect(ui.host.textContent).toContain('原始备份记录');
  await ui.click('设置');
  expect(ui.host.textContent).toContain('Docker');
  expect(ui.host.textContent).toContain('桌面');
  expect(ui.host.textContent).not.toContain('已连接模型');
});

async function chooseFile(host: HTMLElement, contents: unknown, size?: number) {
  const file = new File(['fixture'], 'learning-backup.json', {type: 'application/json'});
  Object.defineProperty(file, 'text', {value: async () => JSON.stringify(contents)});
  if (size !== undefined) Object.defineProperty(file, 'size', {value: size});
  const input = host.querySelector<HTMLInputElement>('input[aria-label="选择备份文件"]')!;
  Object.defineProperty(input, 'files', {configurable: true, value: [file]});
  await act(async () => {input.dispatchEvent(new Event('change', {bubbles: true}));});
}

it('rejects future and oversized import files without replacing current learning', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  initial.state.checkins = [{date: '2026-10-04', columnId: 'old', note: '不能丢掉的原记录'}];
  const ui = await mount(initial); await ui.click('设置');
  await chooseFile(ui.host, {format: 'growth-workbench', schemaVersion: 2});
  expect(ui.host.textContent).toContain('未来版本');
  expect(ui.controller.pendingDocument()).toEqual(initial);
  await chooseFile(ui.host, {}, 50 * 1024 * 1024 + 1);
  expect(ui.host.textContent).toContain('超过 50 MiB');
  expect(ui.controller.pendingDocument()).toEqual(initial);
  expect(ui.host.textContent).not.toContain('确认恢复备份');
});

it('previews import and cancellation never writes it into current document', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  const incoming = emptyBrowserDocument(); incoming.state.checkins = [{date: '2026-10-04', columnId: 'fixture', note: '导入文件的记录'}];
  const ui = await mount(initial); await ui.click('设置');
  await chooseFile(ui.host, createBackup(incoming, '0.9.0', '2026-10-05T00:00:00.000Z'));
  expect(ui.host.textContent).toContain('导入预览');
  expect(ui.controller.pendingDocument()).toEqual(initial);
  await ui.click('取消导入');
  expect(ui.host.textContent).not.toContain('确认恢复备份');
  expect(ui.controller.pendingDocument()).toEqual(initial);
});

it('replaces a validated import only after explicit confirmation', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  const incoming = emptyBrowserDocument(); incoming.state.onboarding.introSeen = true;
  incoming.state.checkins = [{date: '2026-10-04', columnId: 'fixture', note: '导入文件的记录'}];
  const ui = await mount(initial); await ui.click('设置');
  await chooseFile(ui.host, createBackup(incoming, '0.9.0', '2026-10-05T00:00:00.000Z'));
  await ui.click('确认恢复备份');
  expect(ui.controller.pendingDocument()).toEqual(incoming);
  await ui.click('记录'); expect(ui.host.textContent).toContain('导入文件的记录');
});

it.each(['conflict', 'versionchange'] as const)('keeps exact typed code through navigation and pending export after %s with real storage', async failure => {
  const factory = new IDBFactory(); const now = '2026-10-05T10:00:00.000Z';
  const repository = await openBrowserRepository(factory, () => now); realRepositories.push(repository);
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  initial.state.lab = setLabCode(beginLab(initial.state.lab, 'functions', 'practice', now), 'functions', 'practice', 'function greeting(name) { return name; }');
  await repository.commit(initial, 0);
  const controller = await createBrowserController(repository); realControllers.push(controller);
  const ui = await mount(undefined, controller);
  if (failure === 'conflict') {
    const remote = await openBrowserRepository(factory, () => now); realRepositories.push(remote);
    let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
    const commit = repository.commit; repository.commit = async (document, revision) => {await gate; return commit(document, revision);};
    let saving!: Promise<BrowserSnapshot>;
    await act(async () => {saving = controller.change(document => ({...document, drafts: {...document.drafts, messages: {main: '待存输入'}}})); void saving.catch(() => {});});
    await act(async () => {
      const latest = (await remote.load()).document;
      await remote.commit({...latest, state: {...latest.state, lab: setLabCode(latest.state.lab, 'functions', 'practice', 'function greeting(name) { return "remote"; }')}}, 1);
      release(); await expect(saving).rejects.toMatchObject({code: 'revision-conflict'});
    });
    expect(controller.storageStatus()).toBe('conflict');
  } else {
    await act(async () => {
      const request = factory.open('growth-workbench', 2);
      await new Promise<void>((resolve, reject) => {request.onsuccess = () => {request.result.close(); resolve();}; request.onerror = () => reject(request.error);});
    });
    expect(controller.storageStatus()).toBe('unavailable');
  }
  const field = ui.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的代码"]')!;
  const text = 'function greeting(name) { return name; }\n// KEEP THIS INPUT  用户继续写出的代码';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {setter.call(field, text); field.dispatchEvent(new Event('input', {bubbles: true}));});
  expect(field.value).toBe(text);
  expect(controller.pendingDocument().state.lab.sessions['functions:practice'].code).toBe(text);
  await ui.click('资料'); await ui.click('学习');
  expect(ui.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="你的代码"]')!.value).toBe(text);
  await ui.click('设置'); expect(ui.host.textContent).toContain('导出待存备份');
  expect(readBackup(createBackup(controller.pendingDocument(), '0.9.0', now)).state.lab.sessions['functions:practice'].code).toBe(text);
  expect(controller.snapshot().document.state.lab.sessions['functions:practice'].code).toBe('function greeting(name) { return name; }');
});

const browserProfile = {id:'phone',name:'手机接口',baseUrl:'https://model.example/v1',protocol:'chat' as const,models:['phone-model']};
async function inputField(field: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field),'value')!.set!.call(field,value);field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));});}
it('browser settings require HTTPS and a new session Key before a tracked explicit test',async()=>{
 const initial=emptyBrowserDocument();initial.state.onboarding.introSeen=true;initial.state.settings.modelLibrary={profiles:[browserProfile],active:{profileId:'phone',model:'phone-model'}};
 const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:3,completion_tokens:1}}),{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetch);
 try{const ui=await mount(initial);await ui.click('设置');expect(ui.host.textContent).toContain('刷新、关闭或恢复备份后需要重新填写');const test=[...ui.host.querySelectorAll('button')].find(b=>b.textContent?.trim()==='测试连接')!;expect(test.disabled).toBe(true);expect(fetch).not.toHaveBeenCalled();await act(async()=>ui.host.querySelector<HTMLButtonElement>('[aria-label="编辑 手机接口"]')!.click());
 const base=ui.host.querySelector<HTMLInputElement>('.api-field input[type="url"]')!;const key=ui.host.querySelector<HTMLInputElement>('input[type="password"]')!;await inputField(base,'http://model.example/v1');await inputField(key,'fixture-secret');await ui.click('保存修改');expect(ui.host.textContent).toContain('HTTPS');expect(ui.controller.pendingDocument().state.settings.modelLibrary.profiles[0].baseUrl).toBe(browserProfile.baseUrl);await inputField(base,browserProfile.baseUrl);await ui.click('保存修改');expect(key.value).toBe('');expect(test.disabled).toBe(false);expect(fetch).not.toHaveBeenCalled();await ui.click('测试连接');expect(fetch).toHaveBeenCalledTimes(1);expect(ui.controller.pendingDocument().state.usageRecords).toHaveLength(1);expect(ui.controller.pendingDocument().state.usageRecords[0].purpose).toBe('test');expect(ui.controller.pendingDocument().state.columns).toEqual([]);expect(ui.controller.pendingDocument().state.contexts).toEqual({});expect(JSON.stringify(createBackup(ui.controller.pendingDocument(),'0.9.0','2026-10-05T00:00:00.000Z'))).not.toContain('fixture-secret');
 const incoming=createBackup(initial,'0.9.0','2026-10-05T00:00:00.000Z');await chooseFile(ui.host,incoming);await ui.click('取消导入');expect(test.disabled).toBe(false);await chooseFile(ui.host,incoming);await ui.click('确认恢复备份');expect(ui.host.querySelector('input[type="password"]')).toBeNull();expect([...ui.host.querySelectorAll('button')].find(b=>b.textContent?.trim()==='测试连接')!.disabled).toBe(true);expect(ui.host.textContent).not.toContain('连接测试通过');expect(fetch).toHaveBeenCalledTimes(1);
 }finally{vi.unstubAllGlobals();}
});
it('stages only a reviewed selected reference excerpt without creating a verified source or sending',async()=>{
 const initial=emptyBrowserDocument();initial.state.onboarding.introSeen=true;initial.state.columns=[{id:'c',title:'本次函数',goal:'运行函数',kind:'knowledge',phase:'planning',plan:null,currentStepIndex:0,taughtStepIds:[],messages:[],evidence:[],createdAt:'2026-10-05T00:00:00.000Z'}];initial.state.activeColumnId='c';initial.drafts.references={'https://www.runoob.com/python3/python3-tutorial.html':{url:'https://www.runoob.com/python3/python3-tutorial.html',text:'完整用户提供材料，不自动发送',providedAt:'2026-10-05T00:00:00.000Z'}};
 const ui=await mount(initial);await ui.click('资料');await ui.click('选取片段用于提问');const excerpt=ui.host.querySelector<HTMLTextAreaElement>('[aria-label="本次要发送的选取片段"]')!;expect(excerpt.value).toBe('');await inputField(excerpt,'只选这一句');expect(ui.controller.pendingDocument().drafts.messages).toEqual({});await ui.click('确认加入材料草稿');const draft=ui.controller.pendingDocument().drafts.messages['material:c'];expect(draft).toContain('只选这一句');expect(draft).toContain('未核验');expect(draft).toContain('2026-10-05');expect(draft).not.toContain('完整用户提供材料');expect(ui.controller.pendingDocument().state.columns[0].source).toBeUndefined();expect(ui.controller.pendingDocument().state.columns[0].plan).toBeNull();expect(ui.controller.pendingDocument().state.usageRecords).toEqual([]);expect(ui.host.querySelector('iframe')).toBeNull();await ui.click('选取片段用于提问');await inputField(ui.host.querySelector<HTMLTextAreaElement>('[aria-label="本次要发送的选取片段"]')!,'x'.repeat(20000));await ui.click('确认加入材料草稿');expect(ui.host.textContent).toContain('20,000');expect(ui.controller.pendingDocument().drafts.messages['material:c']).toBe(draft);expect(ui.controller.pendingDocument().drafts.references).toEqual(initial.drafts.references);
});
it('confirms a manually chosen knowledge block locally with no AI planning request',async()=>{const initial=emptyBrowserDocument();initial.state.onboarding.introSeen=true;const ui=await mount(initial);await ui.click('可选 AI 教学');await inputField(ui.host.querySelector<HTMLInputElement>('[aria-label="新栏目名称"]')!,'函数');await inputField(ui.host.querySelector<HTMLInputElement>('[aria-label="新栏目目标"]')!,'运行函数');await ui.click('创建本次栏目');await inputField(ui.host.querySelector<HTMLInputElement>('[aria-label="本次知识块"]')!,'参数');await inputField(ui.host.querySelector<HTMLInputElement>('[aria-label="学完能做什么"]')!,'运行最小例子');await ui.click('确认本次知识块');await ui.click('开始学习这块');expect(ui.controller.pendingDocument().state.columns[0].phase).toBe('study');expect(ui.controller.pendingDocument().state.columns[0].messages).toEqual([]);expect(ui.controller.pendingDocument().state.columns[0].evidence).toEqual([]);expect(ui.controller.pendingDocument().state.usageRecords).toEqual([]);});
it('retains accepted paid recovery while selecting another teaching column', async () => {
  const {createColumn, confirmPlan, beginStudy} = await import('../src/core/learning');
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  initial.state.settings.modelLibrary = {profiles: [browserProfile], active: {profileId: 'phone', model: 'phone-model'}};
  initial.state.columns = ['c', 'other'].map(id => beginStudy(confirmPlan(createColumn(id, '运行', '2026-10-05T00:00:00.000Z', id), {
    target: '运行', steps: [{id: `step-${id}`, title: '函数', outcome: '运行', priority: 1}],
  })));
  initial.state.activeColumnId = 'c';
  const repository = await openBrowserRepository(new IDBFactory()); realRepositories.push(repository);
  await repository.commit(initial, 0);
  const controller = await createBrowserController(repository); realControllers.push(controller);
  let response!: (reply: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => {response = resolve;})); vi.stubGlobal('fetch', fetch);
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>(resolve => {releaseRetry = resolve;});
  let primaryFailed = false;
  try {
    const ui = await mount(undefined, controller);
    await ui.click('设置');
    await act(async () => ui.host.querySelector<HTMLButtonElement>('[aria-label="编辑 手机接口"]')!.click());
    await inputField(ui.host.querySelector<HTMLInputElement>('input[type="password"]')!, 'fixture-key');
    await ui.click('保存修改'); await act(async () => controller.flush());
    await ui.click('学习'); await ui.click('可选 AI 教学');
    await inputField(ui.host.querySelector<HTMLTextAreaElement>('[aria-label="向 AI 提问"]')!, '问题');
    await act(async () => controller.flush()); await ui.click('发送问题');
    await act(async () => {await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));});
    await inputField(ui.host.querySelector<HTMLSelectElement>('[aria-label="当前教学栏目"]')!, 'other');
    await act(async () => controller.flush());
    const commit = repository.commit;
    let fail = true;
    let retryCommitStarted = false;
    repository.commit = async (document, revision) => {
      if (document.state.usageRecords.length) {
        if (fail) throw Error('空间不足');
        // Recovery must finish its usage/context write before it can append the reply.
        // Hold that real storage boundary so completion cannot depend on machine speed.
        retryCommitStarted = true;
        await retryGate;
      }
      return commit(document, revision);
    };
    await act(async () => {
      response(new Response(JSON.stringify({choices: [{message: {content: '原付费结果'}}], usage: {prompt_tokens: 2, completion_tokens: 1}}), {status: 200}));
      await vi.waitFor(() => expect(controller.isBusy()).toBe(false));
    });
    await inputField(ui.host.querySelector<HTMLSelectElement>('[aria-label="当前教学栏目"]')!, 'c');
    await act(async () => {await vi.waitFor(() => expect(controller.isBusy()).toBe(false));});
    const retry = [...ui.host.querySelectorAll('button')].find(button => button.textContent === '仅重试保存');
    expect(retry).toBeTruthy();
    fail = false;
    await act(async () => {
      retry!.click();
      await vi.waitFor(() => expect(retryCommitStarted).toBe(true));
    });
    expect(controller.pendingDocument().state.columns[0].messages.at(-1)?.content).toBe('问题');
    await act(async () => {
      releaseRetry();
      await vi.waitFor(() => expect(controller.isBusy()).toBe(false));
      await controller.flush();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(controller.pendingDocument().state.columns[0].messages.at(-1)?.content).toBe('原付费结果');
    const saved = (await repository.load()).document;
    expect(saved.state.columns[0].messages.map(message => message.content)).toEqual(['问题', '原付费结果']);
    expect(saved.state.columns[1].messages).toEqual([]);
    expect(saved.state.usageRecords).toHaveLength(1);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      releaseRetry();
      await act(async () => {await vi.waitFor(() => expect(controller.isBusy()).toBe(false));});
    } catch (cleanupError) {
      if (!primaryFailed) throw cleanupError;
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

it('keeps newer column title and goal edits dirty when the earlier create finishes saving', async () => {
  const initial = emptyBrowserDocument(); initial.state.onboarding.introSeen = true;
  const repository = await openBrowserRepository(new IDBFactory()); realRepositories.push(repository);
  await repository.commit(initial, 0);
  const controller = await createBrowserController(repository); realControllers.push(controller);
  const ui = await mount(undefined, controller); await ui.click('可选 AI 教学');
  const title = ui.host.querySelector<HTMLInputElement>('[aria-label="新栏目名称"]')!;
  const goal = ui.host.querySelector<HTMLInputElement>('[aria-label="新栏目目标"]')!;
  await inputField(title, '已提交的栏目'); await inputField(goal, '已提交的目标');
  const commit = repository.commit;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  repository.commit = async (document, revision) => {await gate; return commit(document, revision);};
  await ui.click('创建本次栏目');
  await inputField(title, '后来写的新栏目'); await inputField(goal, '后来写的新目标');
  await act(async () => {release(); await controller.flush();});
  expect(title.value).toBe('后来写的新栏目'); expect(goal.value).toBe('后来写的新目标');
  expect(controller.pendingDocument().state.columns).toHaveLength(1);
  expect(controller.pendingDocument().state.columns[0]).toMatchObject({title: '已提交的栏目', goal: '已提交的目标'});
  expect(pwaCapture.readiness!.hasPending()).toBe(true);
  expect(ui.host.querySelector('.browser-save-state')!.textContent).toContain('尚未保存');
});
