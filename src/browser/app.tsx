import React, {useEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';
import type {BrowserController} from './controller';
import {BrowserOnboarding} from './onboarding';
import {BrowserDataPanel} from './data-panel';
import {LearningPendingPanel} from '../modules/learning/pending-panel';
import type {LearningRecoveryStore} from '../modules/learning/pending-recovery';
import {BrowserSources} from './sources';
import {registerBrowserPwa, type PwaController, type PwaStatus} from './pwa';
import {LabPanel} from '../renderer/lab-panel';
import {executeLab} from '../renderer/lab-client';
import {Icon} from '../renderer/icon';
import {ModelSettings} from '../renderer/model-settings';
import {ModelPicker} from '../renderer/model-picker';
import {BrowserModelPort} from './model-port';
import {createModelSession, type ModelTestInput} from '../core/model-session';
import {upsertProfile, removeProfile, selectModel, validateProfile, type ApiProfile, type ModelSelection} from '../core/model-library';
import {createColumn} from '../core/learning';
import {MobileTeaching, stageTeachingMaterial} from './teaching';
import {practiceUnit} from '../data/practice-units';
import type {LabTask} from '../data/practice-units';
import type {LabRun} from '../core/lab';
import {BrowserReadingProvider, BrowserReadingControls, useBrowserReading} from './read-aloud';
import {createBrowserVoiceCoordinator} from './voice/coordinator';
import {BrowserVoiceResources} from './voice/input';

declare const __WB_BROWSER_ASR_ENABLED__: boolean;
declare const __WB_BROWSER_BUILD_ID__: string;

type Page = 'learn' | 'records' | 'sources' | 'settings';
const pages: Array<[Page, string, string]> = [['learn', '学习', 'book'], ['records', '记录', 'history'], ['sources', '资料', 'library'], ['settings', '设置', 'settings-gear']];
const storageLabels = {saved: '已保存到当前浏览器', saving: '正在保存…', unsaved: '尚未保存，内容仍保留在此页面', conflict: '另一页面已更新，待存内容保留在此页面', unavailable: '浏览器存储暂不可用，内容仍保留在此页面'};
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function historicalUnitTitle(id: string): string {try {return practiceUnit(id).title;} catch {return `历史单元 · ${id}`;}}
export function BrowserApp({controller, embedded = false, packagedNative = false, onOpenBackup, pendingRecovery, registerLeaveGuard}: {controller: BrowserController; embedded?: boolean; packagedNative?: boolean; onOpenBackup?: () => void; pendingRecovery?: LearningRecoveryStore; registerLeaveGuard?: (guard:()=>Promise<void>)=>()=>void}) {
  const [, render] = useState(0);
  const [page, setPage] = useState<Page>('learn');
  const [generation, setGeneration] = useState(0);
  const [sourceGeneration, setSourceGeneration] = useState(0);
  const [error, setError] = useState('');
  const [learningView, setLearningView] = useState<'lab'|'teaching'>('lab');
  const [title, setTitle] = useState(''); const [goal, setGoal] = useState('');
  const columnFormRevision = useRef(0);
  const columnCreation = useRef(false);
  const [modelGeneration, setModelGeneration] = useState(0);
  const [modelPort] = useState(() => new BrowserModelPort());
  const [models] = useState(() => createModelSession(modelPort, controller));
  const testRetry = useRef<ModelTestInput | null>(null);
  const [updateHeld, setUpdateHeld] = useState(false);
  const [restoreHeld, setRestoreHeld] = useState(false);
  const [canRefresh, setCanRefresh] = useState(false);
  const [pwaStatus, setPwaStatus] = useState<PwaStatus>({phase: 'not-ready', install: 'unsupported', message: '首次联网下载后可离线学习。'});
  const pwa = useRef<PwaController | null>(null);
  const running = useRef<AbortController | null>(null);
  const dirty = useRef<Record<string, boolean>>({});
  const updateHeldRef = useRef(false);
  const restoreHeldRef = useRef(false);
  const hasUiDraft = () => Object.values(dirty.current).some(Boolean);
  const document = controller.pendingDocument();
  const route = useRef({page, learningView, columnId:document.state.activeColumnId}); route.current = {page, learningView, columnId:document.state.activeColumnId};
  const readingRef = useRef<ReturnType<typeof useBrowserReading> | null>(null);
  const [voice] = useState(()=>createBrowserVoiceCoordinator({
    enabled:typeof __WB_BROWSER_ASR_ENABLED__ !== 'undefined' && __WB_BROWSER_ASR_ENABLED__,
    base:import.meta.env.BASE_URL,buildId:typeof __WB_BROWSER_BUILD_ID__ !== 'undefined'?__WB_BROWSER_BUILD_ID__:'',controller,
    eligible:()=>!updateHeldRef.current && !restoreHeldRef.current && route.current.page==='learn' && route.current.learningView==='teaching' && controller.pendingDocument().state.onboarding.introSeen && route.current.columnId===controller.pendingDocument().state.activeColumnId,
    resourceAllowed:()=>!updateHeldRef.current && !restoreHeldRef.current && route.current.page==='settings',
    stopReading:()=>readingRef.current?.stopAndConfirm() ?? false,
  }));
  const reading = useBrowserReading(scope => {
    if (updateHeldRef.current || restoreHeldRef.current) return false;
    if (!scope || scope === 'preview') return true;
    const current = controller.pendingDocument().state;
    if (!current.onboarding.introSeen) return false;
    if (scope === 'sources') return route.current.page === 'sources';
    return route.current.page === 'learn' && route.current.learningView === 'teaching' && scope === `teaching:${current.activeColumnId}` && scope === `teaching:${route.current.columnId}`;
  }, request => {
    if (request.scope === 'preview') return true;
    const latest = controller.pendingDocument();
    if (request.scope === 'sources') return latest.drafts.references[request.itemId]?.text === request.text;
    const columnId = latest.state.activeColumnId;
    const column = latest.state.columns.find(item => item.id === columnId);
    if (!column || request.scope !== `teaching:${columnId}`) return false;
    const messages = [...column.messages, ...latest.state.sideChats.filter(side => side.columnId === columnId).flatMap(side => side.messages)];
    return messages.some(item => item.id === request.itemId && item.content === request.text);
  },()=>voice.beforeRead());
  readingRef.current=reading;
  useEffect(()=>registerLeaveGuard?.(async()=>{if(hasUiDraft())throw Error('学习页面还有未保存的表单，请先保存或取消后离开。');if(voice.busy()||controller.isBusy())throw Error('请先等待或取消学习操作，再离开。');try{await controller.flush();}catch{throw Error('学习输入尚未保存。请在学习设置中下载待存副本，或保留副本后读取最新，再离开。');}}),[controller,voice,registerLeaveGuard]);
  useEffect(()=>voice.subscribe(()=>render(value=>value+1)),[voice]);
  useEffect(()=>()=>voice.dispose(),[voice]);
  useEffect(() => () => models.dispose(), [models]);
  useEffect(() => controller.subscribe(() => {
    // Cancel against the published document before React hides/replaces its text.
    reading.invalidate();
    voice.invalidate();
    route.current.columnId = controller.pendingDocument().state.activeColumnId;
    render(value => value + 1);
  }), [controller]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {if (controller.hasPending() || controller.isBusy() || hasUiDraft()) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', beforeUnload);
    return () => {window.removeEventListener('beforeunload', beforeUnload); running.current?.abort();};
  }, [controller]);
  useEffect(() => {
    if (packagedNative) {setPwaStatus({phase: 'not-ready', install: 'unsupported', message: '当前使用 Android 安装包，内置页面随应用更新。'}); return;}
    let active = true; let unsubscribe: (() => void) | undefined;
    registerBrowserPwa(import.meta.env.BASE_URL, {
      flush: async () => {if (hasUiDraft()) throw Error('还有未保存的参考片段或导入预览。'); await controller.flush();},
      isBusy: () => voice.busy() || controller.isBusy() && !updateHeldRef.current, hasPending: () => controller.hasPending() || hasUiDraft(),
      acquireUpdateLock: () => {
        if (hasUiDraft()) throw Error('先保存参考片段或取消导入预览。');
        if (voice.busy()) throw Error('请先等待或取消语音资源操作。');
        const release = controller.acquireUpdateLock();
        voice.scope();
        updateHeldRef.current = true;
        reading.stop('update');
        flushSync(() => setUpdateHeld(true));
        return () => {updateHeldRef.current = false; release(); if (active) flushSync(() => setUpdateHeld(false));};
      }
    }).then(value => {if (!active) {value.dispose(); return;} pwa.current = value; setPwaStatus(value.status()); unsubscribe = value.subscribe(() => setPwaStatus(value.status()));}).catch(cause => {if (active) setError(message(cause));});
    return () => {active = false; unsubscribe?.(); pwa.current?.dispose(); pwa.current = null;};
  }, [controller, packagedNative]);
  function markDirty(scope: string, value: boolean) {if(updateHeldRef.current)return;dirty.current[scope] = value; render(previous => previous + 1);}
  function navigate(next: Page) {if(updateHeldRef.current||restoreHeldRef.current)return;voice.scope();reading.stop('scope');route.current.page=next;running.current?.abort(); setPage(next);}
  function switchLearning(next: 'lab'|'teaching') {if(updateHeldRef.current||restoreHeldRef.current)return;voice.scope();reading.stop('scope');route.current.learningView=next;setLearningView(next);}
  function holdRestoreReading() {
    if (restoreHeldRef.current) throw Error('正在恢复记录，请等待完成。');
    voice.scope();
    if (voice.busy()) throw Error('请先等待或取消语音资源操作，再恢复记录。');
    restoreHeldRef.current = true;
    setRestoreHeld(true);
    reading.stop('restore');
    let released = false;
    return () => {if (released) return; released = true; restoreHeldRef.current = false; setRestoreHeld(false);};
  }
  function remountLab() {voice.scope();running.current?.abort(); setGeneration(value => value + 1);}
  function remountLearning() {voice.scope();reading.reset();models.clear();testRetry.current=null;setModelGeneration(value=>value+1);setTitle('');setGoal('');remountLab(); dirty.current = {}; setSourceGeneration(value => value + 1); render(value => value + 1);}
  async function execute(code: string, task: LabTask, signal?: AbortSignal): Promise<LabRun> {
    const abort = new AbortController(); running.current?.abort(); running.current = abort;
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, {once: true}); if (signal?.aborted) abort.abort();
    try {return await controller.withOperation('lab', () => executeLab(code, task, abort.signal));}
    finally {signal?.removeEventListener('abort', cancel); if (running.current === abort) running.current = null;}
  }
  const library = document.state.settings.modelLibrary;
  const keyStatus = Object.fromEntries(library.profiles.map(profile => [profile.id, modelPort.hasKey(profile)]));
  async function saveProfile(input: ApiProfile, key: string) {
    if(updateHeldRef.current) return;
    const profile=validateProfile(input); if(new URL(profile.baseUrl).protocol!=='https:') throw Error('浏览器模型地址必须使用 HTTPS');
    const previous=controller.pendingDocument().state.settings.modelLibrary.profiles.find(item=>item.id===profile.id);
    await controller.change(latest=>({...latest,state:{...latest.state,settings:{...latest.state.settings,modelLibrary:upsertProfile(latest.state.settings.modelLibrary,profile)}}}));
    if(key) modelPort.setKey(profile,key); else if(previous&&(previous.baseUrl!==profile.baseUrl||previous.protocol!==profile.protocol)) modelPort.forgetKey(profile.id);
    render(value=>value+1);
  }
  async function chooseModel(selection:ModelSelection) {if(updateHeldRef.current)return;await controller.change(latest=>({...latest,state:{...latest.state,settings:{...latest.state.settings,modelLibrary:selectModel(latest.state.settings.modelLibrary,selection)}}}));}
  async function deleteProfile(id:string) {if(updateHeldRef.current)return;await controller.change(latest=>({...latest,state:{...latest.state,settings:{...latest.state.settings,modelLibrary:removeProfile(latest.state.settings.modelLibrary,id)}}}));modelPort.forgetKey(id);render(value=>value+1);}
  async function testModel(selection:ModelSelection) {
    if(updateHeldRef.current) throw Error('正在更新，请稍后测试。');
    const retry=testRetry.current;
    const input=retry&&JSON.stringify(retry.selected)===JSON.stringify(selection)?retry:{library:structuredClone(controller.pendingDocument().state.settings.modelLibrary),selected:{...selection},requestId:crypto.randomUUID()};
    try {const response=await models.test(input);if(!response.trim())throw Error('接口未返回文字；已保留提供的用量，请检查记录。');testRetry.current=null;return `连接测试通过：${selection.model}。仅证明这次请求。`;}
    catch(cause){if(controller.storageStatus()!=='saved')testRetry.current=input;throw cause;}
  }
  async function createTeachingColumn() {
    if (updateHeldRef.current || columnCreation.current) return;
    const submittedRevision = columnFormRevision.current;
    columnCreation.current = true;
    try {
      const column = createColumn(title, goal, new Date().toISOString());
      voice.scope();
      reading.stop('scope');
      await controller.change(latest => ({...latest, state: {
        ...latest.state, columns: [...latest.state.columns, column], activeColumnId: column.id,
      }}));
      if (columnFormRevision.current === submittedRevision) {
        setTitle('');
        setGoal('');
        markDirty('new-column', false);
      }
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      columnCreation.current = false;
      render(value => value + 1);
    }
  }
  async function start() {
    try {await controller.change(latest => ({...latest, state: {...latest.state, onboarding: {...latest.state.onboarding, introSeen: true}}})); setError('');}
    catch (cause) {setError(message(cause));}
  }
  async function update() {try {voice.scope();await voice.cancelResources();if (voice.busy()) throw Error('请等待语音资源操作结束。');if (await pwa.current?.requestUpdate()) setCanRefresh(true);} catch (cause) {setError(message(cause));}}
  async function refresh() {try {voice.scope();await voice.cancelResources();if (hasUiDraft()) throw Error('还有未保存的内容。'); if (controller.isBusy()) throw Error('请等待当前操作结束。'); await controller.flush(); window.location.reload();} catch (cause) {setError(message(cause));}}
  const theme = document.state.settings.preferences.theme;
  const showIntro = !document.state.onboarding.introSeen && page !== 'settings';
  return <BrowserReadingProvider value={reading}><div className="browser-app" data-theme={theme}>
    <header className="browser-top" hidden={embedded}><strong><Icon name="book"/>学习工作台</strong><span>手机 / 浏览器版</span></header>
    <p className={`browser-save-state ${controller.storageStatus()}`} role="status">{updateHeld ? '正在安全更新，编辑暂时暂停。' : hasUiDraft() ? '有尚未保存的参考片段或导入预览' : storageLabels[controller.storageStatus()]}</p>
    {error && <p role="alert" className="browser-error browser-global-error">{error}</p>}
    <BrowserReadingControls suspended={updateHeld || restoreHeld}/>
    {voice.busy() && <div className="browser-save-state" role="status">正在处理可选语音资源。<button onClick={()=>void voice.cancelResources()}>取消语音资源操作</button></div>}
    <fieldset className="browser-interactive" disabled={updateHeld||restoreHeld} inert={updateHeld||restoreHeld} aria-disabled={updateHeld||restoreHeld||undefined}>
      <nav className="browser-navigation" aria-label="主要导航">{pages.map(([id, label, icon]) => <button key={id} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon}/>{label}</button>)}</nav>
      {showIntro && <BrowserOnboarding error={error} onStart={() => void start()} onImport={() => navigate('settings')}/>}
      <main>
        <div hidden={page !== 'learn' || showIntro} className="browser-page browser-learning-switch"><div className="browser-actions"><button aria-pressed={learningView==='lab'} onClick={()=>{switchLearning('lab');}}>动手实践</button><button aria-pressed={learningView==='teaching'} onClick={()=>{switchLearning('teaching');}}>可选 AI 教学</button></div></div>
        <div hidden={page !== 'learn' || showIntro || learningView !== 'lab'} onClickCapture={event=>{const target=event.target as HTMLElement;if(target.closest('.lab-units button, .lab-mode button, .lab-review-actions button')){voice.scope();reading.stop('scope');}}}><LabPanel key={`lab:${generation}`} value={document.state.lab} drafts={document.drafts.lab} onChange={next => controller.change(latest => ({...latest, state: {...latest.state, lab: next}})).then(() => {})} onDraftChange={(key, next) => controller.change(latest => ({...latest, drafts: {...latest.drafts, lab: {...latest.drafts.lab, [key]: next}}})).then(() => {})} execute={execute}/></div>
        <div hidden={page !== 'learn' || showIntro || learningView !== 'teaching'}>
          <section className="browser-page"><h2>资料旁的可选帮助</h2><p>在资料页打开原站阅读，自己选择本次知识块。AI 按需解释你的问题。</p><ModelPicker library={library} keyStatus={keyStatus} disabled={updateHeld} readyLabel="Key 已填写，未测试" selectionTitle="用于下一次教学或侧聊请求" onSelect={selection=>void chooseModel(selection).catch(cause=>setError(message(cause)))} onManage={()=>navigate('settings')}/><label>当前栏目<select aria-label="当前教学栏目" value={document.state.activeColumnId??''} onChange={event=>{if(updateHeldRef.current)return;const selected=event.target.value;voice.scope();reading.stop('scope');route.current.columnId=selected||null;void controller.change(latest=>({...latest,state:{...latest.state,activeColumnId:selected||null}})).catch(cause=>setError(message(cause)));}}><option value="">选择本次栏目</option>{document.state.columns.map(column=><option key={column.id} value={column.id}>{column.title}</option>)}</select></label><details className="browser-card" open={!document.state.columns.length}><summary>新建本次栏目</summary><label>名称<input aria-label="新栏目名称" value={title} onChange={event=>{if(updateHeldRef.current)return;columnFormRevision.current++;setTitle(event.target.value);markDirty('new-column',true);}}/></label><label>目标<input aria-label="新栏目目标" value={goal} onChange={event=>{if(updateHeldRef.current)return;columnFormRevision.current++;setGoal(event.target.value);markDirty('new-column',true);}}/></label><button disabled={columnCreation.current} onClick={()=>void createTeachingColumn()}>创建本次栏目</button><button onClick={()=>{if(updateHeldRef.current)return;columnFormRevision.current++;setTitle('');setGoal('');markDirty('new-column',false);}}>取消新栏目编辑</button></details></section>
          {document.state.columns.map(column=><div key={`teaching:${modelGeneration}:${column.id}`} hidden={document.state.activeColumnId!==column.id} data-teaching-column={column.id}><MobileTeaching columnId={column.id} controller={controller} models={models} voice={voice.enabled?voice:undefined} suspended={updateHeld||restoreHeld} readingVisible={page==='learn'&&!showIntro&&learningView==='teaching'&&document.state.activeColumnId===column.id} onReadingScopeChange={()=>reading.stop('scope')} onDirty={value=>markDirty(`teaching:${column.id}`,value)}/></div>)}
        </div>
        <section hidden={page !== 'records' || showIntro} className="browser-page" aria-label="学习记录"><h1>学习记录</h1><p>看自己的代码、解释和实际结果。打卡与阅读次数不表示掌握。</p>
          {document.state.lab.attempts.map(attempt => <details className="browser-card" key={attempt.id}><summary>{historicalUnitTitle(attempt.unitId)} · {attempt.passed ? '当前用例通过' : '本次未通过'}</summary><p>{new Date(attempt.createdAt).toLocaleString('zh-CN')} · {({independent: '独立尝试', hinted: '看过提示', explained: '看过讲解'})[attempt.helpLevel]}</p><pre><code>{attempt.code}</code></pre><p className="browser-reference">{attempt.explanation}</p></details>)}
          {!document.state.lab.attempts.length && <p className="browser-muted">还没有保存实践产出。先读一个例子，再完成一次自己的尝试。</p>}
          {!!document.state.columns.length && <h2>导入的学习栏目</h2>}{document.state.columns.map(column => <details className="browser-card" key={column.id}><summary>{column.title}</summary><p>{column.goal}</p>{column.messages.map(item => <div className="browser-record-message" key={item.id}><strong>{item.origin==='assistant'&&item.role==='user'?'AI 来源材料':item.role === 'user' ? '用户原文（不自动算证据）' : 'AI 内容'}</strong><p className="browser-reference">{item.content}</p></div>)}{!!column.evidence.length && <div>{column.evidence.map(e=><details key={e.id}><summary>{e.level} · {e.helpLevel} · {e.confirmed?'已确认':'未确认'}</summary><pre>{e.answer}</pre><pre>{e.teachback}</pre><p>{e.gap}</p></details>)}</div>}</details>)}
          {document.state.sideChats.map(side=><details className="browser-card" key={side.id}><summary>侧聊 · {side.context.quote}</summary><p>原栏目 {side.columnId} · {side.context.goal}</p><pre>{side.context.sourceMessage}</pre>{side.messages.map(item=><div key={item.id}><strong>{item.role==='assistant'?'AI 内容':'用户提问'}</strong><pre>{item.content}</pre></div>)}</details>)}
          {!!document.state.checkins.length && <h2>已有打卡</h2>}{document.state.checkins.map((item, index) => <p key={index}>{item.date} · {item.note}</p>)}
        </section>
        <div hidden={page !== 'sources' || showIntro}><BrowserSources key={`sources:${sourceGeneration}`} document={document} controller={controller} suspended={updateHeld} onDirty={value => markDirty('sources', value)} onStage={async(columnId,text)=>{if(updateHeldRef.current)return;voice.scope();await controller.change(latest=>stageTeachingMaterial(latest,columnId,text,'material'));}}/></div>
        <section hidden={page !== 'settings'} className="browser-page" aria-label="浏览器设置"><h1>设置</h1>
          <section className="browser-card"><h2>外观</h2><div className="browser-actions">{(['system', 'light', 'dark'] as const).map(value => <button key={value} aria-pressed={theme === value} onClick={() => void controller.change(latest => ({...latest, state: {...latest.state, settings: {...latest.state.settings, preferences: {...latest.state.settings.preferences, theme: value}}}})).catch(cause => setError(message(cause)))}>{({system: '跟随系统', light: '浅色', dark: '深色'})[value]}</button>)}</div><button onClick={() => {navigate('learn'); void controller.change(latest => ({...latest, state: {...latest.state, onboarding: {...latest.state.onboarding, introSeen: false}}})).catch(cause => setError(message(cause)));}}>查看简短介绍</button></section>
          <section className="browser-card"><ModelSettings key={`models:${modelGeneration}`} library={library} keyStatus={keyStatus} busy={updateHeld} httpsOnly sessionNote="配置保存在当前浏览器；API Key 仅在本次网页会话使用，刷新、关闭或恢复备份后需要重新填写，不进入备份。没有 Key 也能继续本地学习。" emptyNote="模型帮助可选。填写自己的 HTTPS 接口、Key 和实际模型后，可以显式测试或提问。" onDirty={value=>markDirty('model-form',value)} onSave={saveProfile} onSelect={chooseModel} onRemove={deleteProfile} onTest={testModel}/></section>
          {voice.enabled&&<BrowserVoiceResources voice={voice}/>}
          {embedded && pendingRecovery && <LearningPendingPanel controller={controller} recovery={pendingRecovery} onRestored={remountLearning} onBeforeReplace={holdRestoreReading} canReadLatest={()=>!hasUiDraft()&&!voice.busy()}/> }
          {embedded ? <section className="browser-card"><h2>保存与恢复</h2><p>请使用日常工作台的“账户与同步 → 备份与恢复”。备份包含学习原文、历史证据、草稿和其他模块，恢复前可预览。模型连接、声音等设备设置留在本机，换设备后需重新配置。</p><button disabled={!onOpenBackup||controller.hasPending()||controller.isBusy()||hasUiDraft()} onClick={onOpenBackup}>打开备份与恢复</button></section> : <BrowserDataPanel controller={controller} onBeforeReplace={holdRestoreReading} onRestored={remountLearning} onRetrySaved={remountLab} onDirty={value => markDirty('import', value)} hasUnsavedReference={() => Object.entries(dirty.current).some(([scope,value])=>scope!=='import'&&value)}/>}
          <section className="browser-card"><h2>安装与离线</h2><p>{pwaStatus.message}</p>{pwaStatus.install !== 'unsupported' && <button onClick={() => void pwa.current?.install()}>{pwaStatus.install === 'prompt' ? '安装到主屏幕' : pwaStatus.install === 'installed' ? '查看安装说明' : '如何添加到主屏幕'}</button>}{pwaStatus.phase === 'update-waiting' && <button onClick={() => void update()}>保存并更新</button>}</section>
          <section className="browser-card"><h2>项目、模型与系统功能</h2><p>Docker 副本、文件编辑和本机项目运行目前在桌面端使用。手机无法直接访问电脑的 localhost。</p><p>手机可选模型帮助需会话 Key 与真实通道测试。已提供浏览器手动朗读；开源语音输入与关闭网页后的系统提醒继续开发中。离线实践与资料入口仍可使用。</p><a href="https://github.com/wondercloud-me/learning-workbench" target="_blank" rel="noopener noreferrer">桌面源码与平台进展 ↗</a></section>
        </section>
      </main>
    </fieldset>
    {canRefresh && <div className="browser-update"><p>新版本已准备好。</p><button onClick={() => void refresh()}>保存并刷新新版本</button></div>}
    <footer className="browser-footer">{pwaStatus.phase === 'offline-ready' ? '离线资源已就绪' : '首次使用需要联网下载离线资源'} · 0.10.0 浏览器版</footer>
  </div></BrowserReadingProvider>;
}
