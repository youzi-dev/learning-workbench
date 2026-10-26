import {ReadingBrowser,type ReadingRequest} from './reading-browser';
import {readerCourse,type ReaderStatus,type ReaderSelection} from '../core/reader';
import {LessonPanel,TutorialCacheSettings} from './course-home';
import {mergeLessonState,lessonRequest,lessonReady} from '../core/course-learning';
import type {Course} from '../core/curriculum';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { createColumn, confirmPlan, beginStudy, markTaught, beginVerification, recordAnswer, recordTeachback, proposeEvidence, addressGap, confirmEvidence, completeStep, skipStep, type LearningColumn, type Message, type EvidenceLevel, type HelpLevel } from '../core/learning';
import { createSideChat, carrySideChatConclusion,carryToTeachingDraft } from '../core/sidechat';
import type { AppState } from '../core/state';
import { createDesktopDocumentController, type DesktopDocumentController } from './desktop-document';
import { removeProfile, selectModel, upsertProfile, validateProfile, type ApiProfile, type ModelSelection } from '../core/model-library';
import type { ContextTurn } from '../core/context-cache';
import { ContextPanel, UsagePanel } from './cache-panels';
import { ModelSettings } from './model-settings';
import { ModelPicker } from './model-picker';
import {LoginControl, ReminderControls} from './system-controls';
import { policy, learningInstruction, planJsonInstruction, grillInstruction, studyCoachInstruction } from '../core/prompts';
import { VoiceInput, VoiceSettingsPanel, useReadAloud } from './voice';
import { Dock, Settings, Icon, type SettingsSection } from './shell';
import { emptyTabs, openTab, closeTab, reopenTab, moveTab, type TabState, type WorkspaceTab } from '../core/tabs';
import { shouldSend, type Preferences } from '../core/preferences';
import { IntroGuide } from './intro-guide';
import { QuickExperience } from './quick-experience';

self.MonacoEnvironment = { getWorker: () => new editorWorker() };
const DesktopLabPanel = React.lazy(() => import('./desktop-lab-panel').then(module => ({default:module.DesktopLabPanel})));
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const message = (role: 'user' | 'assistant', content: string): Message => ({ id: uid(), role, content, createdAt: now(), origin: role });
type Panel = 'home' | 'chat' | 'ability' | 'project' | 'settings' | 'lab';
type DraftPlan = { target: string; steps: Array<{ id: string; title: string; outcome: string; priority: number }> };

function Editor({ value, file, onSave, jumpLine, preferences, onEdit, dirty }: { value: string; file: string; onSave: (text: string) => Promise<void>; jumpLine: number | null; preferences: Preferences; onEdit: (text: string) => void; dirty: boolean }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const handlers = useRef({ onEdit, onSave }); handlers.current = { onEdit, onSave };
  const [segment, setSegment] = useState(0), [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.create(host.current, { value, language: file.endsWith('.tsx') || file.endsWith('.ts') ? 'typescript' : file.endsWith('.json') ? 'json' : file.endsWith('.css') ? 'css' : file.endsWith('.md') ? 'markdown' : 'javascript', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', wordWrap: 'on', scrollBeyondLastLine: false });
    editor.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void handlers.current.onSave(instance.getValue()).then(()=>setChanged(false)).catch(()=>{}); });
    const subscription = instance.onDidChangeModelContent(() => { setChanged(true); handlers.current.onEdit(instance.getValue()); });
    return () => { subscription.dispose(); instance.dispose(); editor.current = null; };
  }, [file]);
  useEffect(() => { editor.current?.updateOptions({ fontSize: preferences.codeSize, wordWrap: preferences.wordWrap ? 'on' : 'off', lineNumbers: preferences.lineNumbers ? 'on' : 'off', minimap: { enabled: preferences.minimap }, tabSize: preferences.tabSize }); const apply = () => monaco.editor.setTheme(preferences.theme === 'dark' || preferences.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs'); apply(); const media = matchMedia('(prefers-color-scheme: dark)'); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [preferences]);
  useEffect(() => { if (editor.current && !changed && editor.current.getValue() !== value) editor.current.setValue(value); }, [value, changed]);
  useEffect(() => { if (jumpLine && editor.current) { editor.current.revealLineInCenter(jumpLine); editor.current.setPosition({ lineNumber: jumpLine, column: 1 }); setSegment(Math.floor((jumpLine - 1) / 40)); } }, [jumpLine]);
  useEffect(() => { const instance = editor.current; if (!instance) return; const start = segment * 40 + 1, end = Math.min((segment + 1) * 40, instance.getModel()?.getLineCount() || 1); const collection = instance.createDecorationsCollection([{ range: new monaco.Range(start, 1, end, 1), options: { isWholeLine: true, className: 'current-segment' } }]); return () => collection.clear(); }, [segment, file]);
  const count = Math.max(1, Math.ceil(value.split('\n').length / 40));
  return <section className="editor-pane"><div className="editor-toolbar"><strong>{file}</strong><span>当前段 {segment + 1}/{count}</span><button onClick={() => setSegment(Math.max(0, segment - 1))}>上一段</button><button onClick={() => setSegment(Math.min(count - 1, segment + 1))}>下一段</button><button className="accent" disabled={!dirty} onClick={() => { void onSave(editor.current?.getValue() || '').then(()=>setChanged(false)).catch(()=>{}); }}>保存</button></div><div className="editor-host" ref={host}/></section>;
}

export function App({controller: providedController, embedded = false, onOpenBackup, registerLeaveGuard, quit}: {controller?: DesktopDocumentController; embedded?: boolean; onOpenBackup?: () => void; registerLeaveGuard?: (guard:()=>Promise<void>)=>()=>void; quit?:Pick<typeof window.workbench,'onQuitRequest'|'onQuitCancelled'>} = {}) {
  const [controller] = useState(()=>providedController ?? createDesktopDocumentController(window.workbench));
  const [storage,setStorage] = useState(()=>controller.snapshot());
  const state=storage.document.state, loaded=storage.loaded;
  const storageLocked=storage.status==='locked';
  const setState = (change:React.SetStateAction<AppState>):Promise<void> => {
    const pending=controller.change(document=>({...document,state:typeof change==='function'?change(document.state):change}),{generation:storage.generation});
    void pending.catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
    return pending;
  };
  const actionInFlight=useRef(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [onboardingView, setOnboardingView] = useState<'intro'|'demo'|null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<Panel>('home'), [showNew, setShowNew] = useState(false), [newTitle, setNewTitle] = useState(''), [newGoal, setNewGoal] = useState(''), [newKind, setNewKind] = useState<'knowledge' | 'project'>('project');
  const drafts = storage.document.drafts.messages, sideDrafts = drafts;
  const setDrafts = (change: React.SetStateAction<Record<string,string>>) => {void controller.change(document => ({...document,drafts:{...document.drafts,messages:typeof change==='function'?change(document.drafts.messages):change}}), {generation:storage.generation}).catch(cause=>setError(String(cause)));};
  const setSideDrafts = setDrafts;
  const [readingRequest,setReadingRequest]=useState<ReadingRequest|null>(null);
  const [dockStates, setDockStates] = useState<Record<string,TabState>>({}), [dockVisible, setDockVisible] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false), [profileMenu, setProfileMenu] = useState(false), [columnSearch, setColumnSearch] = useState('');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [buffers, setBuffers] = useState<Record<string,{original:string;text:string}>>({});
  const [pendingClose, setPendingClose] = useState<string[] | null>(null);
  const preferences = state.settings.preferences;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; source: Message; selection: string } | null>(null);
  const [planDraft, setPlanDraft] = useState<DraftPlan | null>(null), [help, setHelp] = useState<HelpLevel>('independent'), [scoreMode, setScoreMode] = useState(false), [mode, setMode] = useState<'coach' | 'study-coach' | 'grill'>('coach');
  const [modelKeyStatus, setModelKeyStatus] = useState<Record<string, boolean>>({});
  const modelLibrary = state.settings.modelLibrary;
  const activeSelection = modelLibrary.active;
  const activeProfile = modelLibrary.profiles.find(profile => profile.id === activeSelection?.profileId);
  const modelReady = !!activeProfile && !!modelKeyStatus[activeProfile.id];
  const [projectChoice, setProjectChoice] = useState<Awaited<ReturnType<typeof window.workbench.chooseProject>>>(null), [projectReady, setProjectReady] = useState(false), [includeSecrets, setIncludeSecrets] = useState(false), [network, setNetwork] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]), [file, setFile] = useState(''), [code, setCode] = useState(''), [jumpLine, setJumpLine] = useState<number | null>(null), [terminal, setTerminal] = useState(''), [command, setCommand] = useState(''), [agentGoal, setAgentGoal] = useState('');
  const [diffs, setDiffs] = useState<Awaited<ReturnType<typeof window.workbench.diff>>>([]), [selectedDiffs, setSelectedDiffs] = useState<string[]>([]), [previewCommand, setPreviewCommand] = useState('npm run dev -- --host 0.0.0.0 --port 3000'), [previewUrl, setPreviewUrl] = useState('');
  const selectedColumn = state.columns.find(item => item.id === state.activeColumnId) || null;
  const scope = panel==='home'?'reader':selectedColumn?.id || 'workspace';
  const workspace = dockStates[scope] || emptyTabs();
  const setWorkspace = (change: (previous:TabState)=>TabState) => setDockStates(old => ({...old,[scope]:change(old[scope] || emptyTabs())}));
  const activeTab = workspace.tabs.find(t=>t.id===workspace.activeId);
  const activeSideId = activeTab?.kind === 'side' ? activeTab.resource || null : null;
  const activeSide = state.sideChats.find(item => item.id === activeSideId) || null;
  const column = activeTab?.kind==='teaching'?state.columns.find(c=>c.id===activeTab.resource)||null:selectedColumn;
  const mainDraftScope=column?.id||scope;
  const sideVisible = dockVisible && !!activeSide;
  const setSideVisible = setDockVisible;
  const draft = drafts[mainDraftScope] || '', sideDraft = sideDrafts[activeSideId || ''] || '';
  const setDraft = (value:React.SetStateAction<string>) => setDrafts(old=>({...old,[mainDraftScope]:typeof value==='function'?value(old[mainDraftScope]||''):value}));
  const setSideDraft = (value:React.SetStateAction<string>) => { if(activeSideId) setSideDrafts(old=>({...old,[activeSideId]:typeof value==='function'?value(old[activeSideId]||''):value})); };
  const openWorkspace = (tab:WorkspaceTab) => { setWorkspace(old=>openTab(old,tab));setDockVisible(true); };
  const setActiveSideId = (id:string|null) => { const side=state.sideChats.find(item=>item.id===id); if(side)openWorkspace({id:`side:${side.id}`,kind:'side',title:side.context.quote,resource:side.id}); };
  const readAloud = useReadAloud({ ...state.settings.voice, autoRead: state.settings.voice.autoRead && !voiceActive && (panel==='chat'||panel==='home'&&dockVisible) }, `${panel}:${column?.id || ''}:${sideVisible ? activeSideId || '' : ''}`, sideVisible && activeSide ? activeSide.messages : column?.messages || [], setError);
  const step = column?.plan?.steps[column.currentStepIndex];
  const today = new Date().toLocaleDateString('sv-SE');
  const checkedIn = state.checkins.some(item => item.date === today);
  const latestEvidence = column?.evidence.at(-1);
  const leaveState=useRef({busy,voiceActive,buffers,showNew,newTitle,newGoal,planDraft});leaveState.current={busy,voiceActive,buffers,showNew,newTitle,newGoal,planDraft};
  useEffect(()=>registerLeaveGuard?.(async()=>{const current=leaveState.current;if(current.busy||current.voiceActive)throw Error('请先等待或取消学习操作，再离开。');if(Object.values(current.buffers).some(buffer=>buffer.text!==buffer.original))throw Error('项目代码尚未保存，请先保存文件后离开。');if(current.showNew&&(current.newTitle||current.newGoal)||current.planDraft)throw Error('学习栏目或阶梯草稿尚未确认，请先保存或取消后离开。');await controller.flush();}),[controller,registerLeaveGuard]);

  useEffect(() => {
    const unsubscribe=controller.subscribe(()=>setStorage(controller.snapshot()));
    void controller.start().then(()=>{
      const data=controller.snapshot().document.state;
      setMode(data.settings.preferences.defaultMode);
      if(!data.onboarding.introSeen)setOnboardingView('intro');
    }).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));
    return ()=>{unsubscribe();controller.close();};
  },[controller]);
  useEffect(()=>window.workbench.onRuntimeUpdate(data=>controller.observeRuntime(data)),[controller]);
  useEffect(()=>(quit??window.workbench).onQuitRequest(async token=>{
    readAloud.stop();
    await controller.prepareQuit(token);
    return controller.snapshot().generation;
  }),[controller,quit]);
  useEffect(()=>(quit??window.workbench).onQuitCancelled(token=>controller.cancelQuit(token)),[controller,quit]);
  useEffect(() => window.workbench.onAgentLog(log=>setTerminal(log.join('\n\n'))), []);
  useEffect(() => { let current = true; if (loaded) window.workbench.modelKeyStatus(modelLibrary.profiles).then(status => { if (current) setModelKeyStatus(status); }).catch(err => setError(String(err))); return () => { current = false; }; }, [modelLibrary, loaded]);
  useEffect(() => { if (projectReady) window.workbench.files().then(setFiles).catch(err => setError(String(err))); }, [projectReady]);
  const updateColumn = (next: LearningColumn) => setState(previous => ({ ...previous, columns: previous.columns.map(item => item.id === next.id ? next : item) }));
  const updateActive = (transform: (item: LearningColumn) => LearningColumn) => { if (column) updateColumn(transform(column)); };
  const flash = (text: string) => { setNotice(text); setTimeout(() => setNotice(''), 4500); };
  const runAction = async (action: () => Promise<void>, onFailure?:()=>void) => { if(actionInFlight.current)return;actionInFlight.current=true;setBusy(true); setError(''); try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); onFailure?.(); } finally { actionInFlight.current=false;setBusy(false); } };
  const assistantMessage = (content: string): Message => ({ ...message('assistant', content), model: activeSelection?.model, apiProfile: activeProfile?.name });
  const addAssistant = (current: LearningColumn, content: string) => updateColumn({ ...current, messages: [...current.messages, assistantMessage(content)] });
  const turns = (items: Message[]):ContextTurn[] => items.map(item => ({ id:item.id,role: item.role, content: item.content }));

  function requireModel() {
    if (!activeProfile || !activeSelection) throw new Error('先在“模型与接口”添加一个 API 配置');
    if (!modelReady) throw new Error(`请在“模型与接口”为「${activeProfile.name}」填写 API Key`);
    return { profile: activeProfile, model: activeSelection.model };
  }
  async function chatModel(system: string, messages: ContextTurn[], contextId=column?.id??'workspace', compactOnly=false) {
    const { profile, model } = requireModel();
    const bound=state.columns.find(c=>c.id===contextId);
    const lesson=bound&&!compactOnly?lessonRequest(bound):undefined;
    // Flush the latest renderer identity before main validates authoritative source.
    await controller.flush();
    return window.workbench.chat(policy, messages, profile, model, {scope:contextId,task:system.startsWith(policy)?system.slice(policy.length).trim():system,compactOnly,lesson,purpose:contextId.startsWith('side:')?'side':'chat'});
  }
  function manageModels() { setPanel('settings'); setSettingsSection('model'); }
  async function changeModel(selection: ModelSelection) {
    if (busy || voiceActive) throw new Error('请等当前操作完成后再切换模型');
    await setState(old => ({ ...old, settings: { ...old.settings, modelLibrary: selectModel(old.settings.modelLibrary, selection) } }));
  }
  async function saveModelProfile(input: ApiProfile, key: string) {
    if (busy) throw new Error('请等当前操作完成后再修改 API');
    const profile = validateProfile(input);
    const next = upsertProfile(modelLibrary, profile);
    // Persist metadata before reporting success; credentials are held only by the main process.
    await setState(old => ({...old,settings:{...old.settings,modelLibrary:next}}));
    if (key.trim()) await window.workbench.setModelKey(profile, key);
    const status = await window.workbench.modelKeyStatus(next.profiles);
    setModelKeyStatus(status);
  }
  async function removeModelProfile(id: string) {
    if (busy) throw new Error('请等当前操作完成后再移除 API');
    const next = removeProfile(modelLibrary, id);
    await setState(old => ({...old,settings:{...old.settings,modelLibrary:next}}));
    await window.workbench.forgetModelKey(id);
    setModelKeyStatus(await window.workbench.modelKeyStatus(next.profiles));
  }
  const picker = <ModelPicker library={modelLibrary} keyStatus={modelKeyStatus} disabled={busy || voiceActive} onManage={manageModels} onSelect={selection => { void changeModel(selection).catch(err => setError(String(err))); }}/>;

  function closeGuide() {
    setState(old => ({ ...old, onboarding: { ...old.onboarding, introSeen: true } }));
    setOnboardingView(null);
  }
  function openGuide(view: 'intro'|'demo') {
    if (busy || voiceActive || !loaded) return;
    readAloud.stop(); setProfileMenu(false); setContextMenu(null);
    setOnboardingView(view);
    if (view === 'demo') setState(old => ({ ...old, onboarding: { ...old.onboarding, introSeen: true } }));
  }
  function createFromGuide() { closeGuide(); setPanel('home'); }
  function settingsFromGuide() { closeGuide(); setPanel('settings'); setSettingsSection('model'); }

  function requestPage(url:string){setReadingRequest({url,id:uid()});setPanel('home');}
  function showTeaching(next:LearningColumn){
    setState(old=>({...old,activeColumnId:next.id}));setPanel('home');setMode(preferences.defaultMode);setPlanDraft(null);
    setDockStates(old=>({...old,reader:openTab(old.reader||emptyTabs(),{id:`teaching:${next.id}`,kind:'teaching',title:next.title,resource:next.id})}));setDockVisible(true);
  }
  function resumeLesson(next:LearningColumn) {
    if(busy||voiceActive)return;
    if(next.source){requestPage(next.source.url);showTeaching(next);}
    else{setState(old=>({...old,activeColumnId:next.id}));setPanel('chat');setMode(preferences.defaultMode);setPlanDraft(null);}
  }
  async function ensureTeaching(url:string){
    const document=await window.workbench.readerCached(url)||await window.workbench.tutorialLesson(url);
    const course=readerCourse(url,document.title),id=uid(),openedAt=now();
    const merged=mergeLessonState(controller.snapshot().document.state,course,document,openedAt,id);
    const next=merged.columns.find(c=>c.id===merged.activeColumnId)!;
    setState(current=>mergeLessonState(current,course,document,openedAt,id));showTeaching(next);return next;
  }
  async function openTeaching(url:string){await runAction(async()=>{await ensureTeaching(url);});}
  function readerPage(status:ReaderStatus){
    if(status.loading)return;
    setState(old=>old.reading.url===status.url&&old.reading.title===status.title?old:{...old,reading:{url:status.url,title:status.title}});
  }
  useEffect(()=>window.workbench.onReaderSelection((context:ReaderSelection)=>{
    try{
      const side={...createSideChat({id:uid(),columnId:`reader:${context.url}`,parentMessageId:`page:${context.url}`,selectedText:context.quote,sourceMessage:context.sourceMessage,columnGoal:`理解《${context.title}》中选中的内容`,now:now()}),source:{url:context.url,title:context.title}};
      setState(old=>({...old,sideChats:[...old.sideChats,side]}));
      setDockStates(old=>({...old,reader:openTab(old.reader||emptyTabs(),{id:`side:${side.id}`,kind:'side',title:side.context.quote,resource:side.id})}));setDockVisible(true);setPanel('home');
    }catch(e){setError(String(e));}
  }),[]);
  async function carryConclusion(){
    if(!activeSide)return;const conclusion=activeSide.messages.filter(m=>m.role==='assistant').at(-1)?.content;if(!conclusion)return;
    if(activeSide.source){await runAction(async()=>{const target=await ensureTeaching(activeSide.source!.url);setDrafts(old=>({...old,[target.id]:carrySideChatConclusion(activeSide,conclusion)}));flash('结论已放入对应章节的教学草稿，请检查后自行发送');});}
    else{try{const result=carryToTeachingDraft(activeSide,conclusion,state.columns,drafts);setDrafts(result.drafts);if(result.target.source)showTeaching(result.target);else resumeLesson(result.target);flash('结论已放进原教学栏目草稿，请检查后自行发送');}catch(e){setError(String(e));}}
  }
  async function teachLesson(){
    if(!column?.source)return;
    await runAction(async()=>{const answer=await chatModel(learningInstruction(column),turns(column.messages));addAssistant(markTaught(column),answer);});
  }
  function addColumn() {
    if(newKind==='knowledge'){setShowNew(false);setPanel('home');return;}
    try { const next = createColumn(newTitle, newGoal, now(), uid(), newKind); setState(old => ({ ...old, columns: [...old.columns, next], activeColumnId: next.id })); setShowNew(false); setNewTitle(''); setNewGoal(''); setDraft(''); setSideDraft(''); setPanel('chat'); setPlanDraft(null); }
    catch (err) { setError(String(err)); }
  }
  async function generatePlan() {
    if (!column) return;
    await runAction(async () => {
      const text = await chatModel(`${learningInstruction(column)}\n${planJsonInstruction}\n栏目：${column.title}\n目标：${column.goal}\n请根据前面对话里用户说的时间、材料和经验起草阶梯；缺少的信息按一般情况起草，留给用户修改。`, turns(column.messages));
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as DraftPlan;
      if (!parsed.steps?.length) throw new Error('模型没有生成可用阶梯');
      setPlanDraft({ target: parsed.target, steps: parsed.steps.map((item, index) => ({ id: item.id || uid(), title: item.title, outcome: item.outcome, priority: index + 1 })) });
    });
  }
  async function approvePlan() {
    if (!column || !planDraft) return;
    await runAction(async () => {
      const approved = confirmPlan(column, planDraft);
      const overview = await chatModel(`${learningInstruction(approved)}\n请给简短概览，并指出当前最重要的一步及理由。`, turns(approved.messages));
      updateColumn({ ...approved, overview, messages: [...approved.messages, assistantMessage(overview)] });
      setPlanDraft(null);
    });
  }
  async function startStudy() {
    if (!column) return;
    await runAction(async () => { const next = beginStudy(column); const answer = await chatModel(learningInstruction(next), turns(next.messages)); addAssistant(next, answer); });
  }
  async function finishTeaching() {
    if (!column) return;
    await runAction(async () => { const next = beginVerification(column.source ? column : markTaught(column)); const question = await chatModel(learningInstruction(next), turns(next.messages)); addAssistant(next, question); });
  }
  async function sendMain() {
    if (!column || !draft.trim() || busy || voiceActive) return;
    const input = draft.trim();
    const nextMode = /^(stop grill|退出拷问|停止拷问)$/i.test(input) ? 'coach' : /^(grill|开始拷问|grill-me)$/i.test(input) ? 'grill' : mode;
    if (nextMode !== mode) setMode(nextMode);
    if (/^(stop grill|退出拷问|停止拷问|grill|开始拷问|grill-me)$/i.test(input)) {
      setDraft('');
      updateColumn({ ...column, messages: [...column.messages, message('user', input), message('assistant', nextMode === 'grill' ? '已进入想法拷问。先说你要检验的计划或决定。' : '已退出想法拷问。我们继续当前学习步骤。')] });
      return;
    }
    try { requireModel(); } catch (err) { setError(String(err)); return; }
    await runAction(async () => {
      let succeeded=false;
      try {
      const finishedTeachback = column.phase === 'teachback';
      let next = { ...column, messages: [...column.messages, message('user', input)] };
      if (next.phase === 'verify') next = recordAnswer(next, input, help, now());
      else if (next.phase === 'teachback') next = recordTeachback(next, input, now());
      updateColumn(next);
      if (finishedTeachback) {
        const currentEvidence = next.evidence.at(-1)!;
        const review = await chatModel(`${learningInstruction(next)}\n只输出 JSON：{"level":"待验证 或 初步理解 或 可独立应用 或 稳定掌握","reason":"依据用户回答的简短理由","gap":"用户明确说还缺什么；没有则为空字符串","reply":"指出一个关键遗漏并引导补上"}。仅凭这一次文字回答，最多提议初步理解；有提示或完整解释时不得提议独立掌握。用户说还缺的内容必须放在 gap，补完前不能进入下一块。`, turns(next.messages)); succeeded=true;
        try {
          const parsed = JSON.parse(review.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { level: EvidenceLevel; reason: string; gap: string; reply: string };
          const inferredGap = /(?:还缺|还不会|不清楚|需要补)[^。！？；\n]*/.exec(input)?.[0] || '';
          const proposed = proposeEvidence(next, currentEvidence.id, parsed.level, parsed.reason, parsed.gap || inferredGap);
          addAssistant(proposed, parsed.reply);
          return;
        } catch { addAssistant(next, review); return; }
      }
      const pendingGap = column.phase === 'remediate' ? column.evidence.at(-1) : null;
      if (pendingGap?.gap && !pendingGap.gapAddressed) {
        const review = await chatModel(`${learningInstruction(next)}\n当前待补缺口：${pendingGap.gap}。只输出 JSON：{"resolved":true或false,"reply":"给学生一句具体反馈或继续提示"}。只有学生拿出自己的具体解释、代码或调试结果补上此缺口，才可 resolved=true；只说「懂了」「补好了」要 false。`, turns(next.messages)); succeeded=true;
        try {
          const parsed = JSON.parse(review.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { resolved: boolean; reply: string };
          addAssistant(addressGap(next, pendingGap.id, !!parsed.resolved), parsed.reply);
          return;
        } catch { addAssistant(next, review); return; }
      }
      const system = nextMode === 'grill' ? grillInstruction : nextMode === 'study-coach' ? `${learningInstruction(next)}\n${studyCoachInstruction}` : learningInstruction(next);
      const answer = await chatModel(system, turns(next.messages)); succeeded=true;
      addAssistant(next.source&&next.phase==='study'&&nextMode!=='grill'?markTaught(next):next, answer);
      } finally { if(succeeded)setDrafts(old=>old[column.id]?.trim()===input?{...old,[column.id]:''}:old); }
    },()=>updateColumn(column));
  }
  async function sendSide() {
    if (!activeSide || !sideDraft.trim() || busy || voiceActive) return;
    try { requireModel(); } catch (err) { setError(String(err)); return; }
    const input = sideDraft.trim();
    await runAction(async () => {
      const next = { ...activeSide, messages: [...activeSide.messages, message('user', input)] };
      setState(old => ({ ...old, sideChats: old.sideChats.map(item => item.id === next.id ? next : item) }));
      const answer = await chatModel(`你是辅助对话，只解释选中内容。栏目目标：${next.context.goal}\n选中文字：${next.context.quote}\n所在消息：${next.context.sourceMessage}\n不改变主对话或学习进度。`, turns(next.messages),`side:${next.id}`);
      setState(old => ({ ...old, sideChats: old.sideChats.map(item => item.id === next.id ? { ...next, messages: [...next.messages, assistantMessage(answer)] } : item) }));
      setSideDrafts(old=>old[activeSide.id]?.trim()===input?{...old,[activeSide.id]:''}:old);
    },()=>setState(old=>({...old,sideChats:old.sideChats.map(item=>item.id===activeSide.id?activeSide:item)})));
  }
  function openSide(source: Message, selection: string) {
    if (!column) return;
    try { const side = createSideChat({ id: uid(), columnId: column.id, parentMessageId: source.id, selectedText: selection, sourceMessage: source.content, columnGoal: column.goal, now: now() }); setState(old => ({ ...old, sideChats: [...old.sideChats, side] })); openWorkspace({id:`side:${side.id}`,kind:'side',title:side.context.quote,resource:side.id}); setContextMenu(null); } catch (err) { setError(String(err)); }
  }
  function showSideMenu(event: React.MouseEvent, source: Message) {
    event.preventDefault();
    const selection = window.getSelection()?.toString().trim() || '';
    if (!selection || !source.content.includes(selection)) { flash('先在这条消息中选中要追问的词句'); return; }
    setContextMenu({ x: event.clientX, y: event.clientY, source, selection });
  }
  function renderMessage(item: Message) {
    const parts = item.content.split(/([\w./-]+\.[\w]+):(\d+)/g);
    return <div key={item.id} className={`bubble ${item.role}`} onContextMenu={event => showSideMenu(event, item)}><div className="bubble-label">{item.role === 'assistant' ? '教练' : '我'} · {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}{item.model && <span className="message-model" title={`${item.apiProfile || ''} / ${item.model}`}>{item.apiProfile ? `${item.apiProfile} / ` : ''}{item.model}</span>}{item.role === 'assistant' && <button className='read-aloud' disabled={voiceActive} aria-label={readAloud.speaking === item.id ? '停止朗读' : '朗读这条回复'} onClick={() => void readAloud.read(item.id, item.content)}>{readAloud.speaking === item.id ? <><Icon name="debug-stop"/>停止朗读</> : <><Icon name="unmute"/>朗读</>}</button>}</div><div className="bubble-body">{parts.map((part, index) => index % 3 === 1 && files.some(name => name.endsWith(part)) ? <button key={index} className="line-ref" onClick={async () => { const match = files.find(name => name.endsWith(part)); if (match) { await selectFile(match, Number(parts[index + 1])); } }}>{part}:{parts[index + 1]}</button> : index % 3 === 2 && files.some(name => name.endsWith(parts[index - 1])) ? null : part)}</div></div>;
  }
  async function selectFile(next: string, line: number | null = null) { await runAction(async () => { if (!buffers[next]) { const text = await window.workbench.readFile(next); setBuffers(old=>({...old,[next]:{original:text,text}})); } setJumpLine(line); openWorkspace({id:`file:${next}`,kind:'file',title:next.split('/').at(-1) || next,resource:next}); }); }
  async function refreshDiff() { await runAction(async () => { const next = await window.workbench.diff(); setDiffs(next); openWorkspace({id:'diff',kind:'diff',title:'变更审查'}); setSelectedDiffs(next.filter(item => !item.conflict).map(item => item.path)); }); }
  const dirty = Object.fromEntries(workspace.tabs.filter(t=>t.kind==='file').map(t=>[t.id,!!buffers[t.resource! ] && buffers[t.resource!].text!==buffers[t.resource!].original]));
  const doClose = (ids:string[]) => { setWorkspace(old=>ids.reduce((next,id)=>closeTab(next,id),old)); setPendingClose(null); };
  const requestClose = (ids:string[]) => { if(ids.some(id=>dirty[id])) setPendingClose(ids); else doClose(ids); };
  const saveBuffer = async (name:string,text:string) => {
    try { await window.workbench.saveFile(name,text); setBuffers(old=>({...old,[name]:{text,original:text}})); flash('已保存到工作副本');
      if(column&&step&&text!==buffers[name]?.original) setState(old=>({...old,practice:[...old.practice,{id:uid(),columnId:column.id,stepId:step.id,kind:'code',file:name,content:text.slice(0,5000),helpLevel:help,createdAt:now()}]}));
    } catch(error) { setError(String(error)); throw error; }
  };
  useEffect(()=>{ const media=matchMedia('(prefers-color-scheme: dark)'); const apply=()=>{(embedded?document.querySelector<HTMLElement>('.learning-desktop')??document.documentElement:document.documentElement).dataset.theme=preferences.theme==='system'?(media.matches?'dark':'light'):preferences.theme;(embedded?document.querySelector<HTMLElement>('.learning-desktop')??document.documentElement:document.documentElement).style.setProperty('--ui-font-size',`${preferences.fontSize}px`);(embedded?document.querySelector<HTMLElement>('.learning-desktop')??document.documentElement:document.documentElement).style.setProperty('--code-font-size',`${preferences.codeSize}px`);};apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply); },[preferences.theme,preferences.fontSize,preferences.codeSize,embedded]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(onboardingView)return;if(!(event.metaKey||event.ctrlKey)||event.isComposing)return;const k=event.key.toLowerCase();if(k===','){event.preventDefault();setPanel('settings');}else if(k==='b'){event.preventDefault();event.shiftKey?setDockVisible(v=>!v):setSidebarHidden(v=>!v);}else if(k==='n'){event.preventDefault();setShowNew(true);}else if(k==='w'&&dockVisible&&panel!=='settings'&&workspace.activeId){event.preventDefault();requestClose([workspace.activeId]);}else if(k==='t'&&event.shiftKey){event.preventDefault();setWorkspace(reopenTab);setDockVisible(true);}else if(k==='escape'){setProfileMenu(false);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
  const dockMenu = <>{panel==='home'&&<button disabled={busy||voiceActive} onClick={()=>void openTeaching(state.reading.url)}><Icon name='hubot'/>教我当前网页</button>}{column?.source&&<button onClick={()=>openWorkspace({id:`lesson:${column.id}`,kind:'lesson',title:'原文材料',resource:column.id})}><Icon name='book'/>当前章节原文</button>}<small>打开工作区</small>{(['terminal','diff','preview'] as const).map(kind=><button key={kind} onClick={()=>openWorkspace({id:kind,kind,title:({terminal:'终端',diff:'变更审查',preview:'网页预览'})[kind]})}><Icon name={{terminal:'terminal',diff:'diff',preview:'browser'}[kind]}/>{{terminal:'终端',diff:'变更审查',preview:'网页预览'}[kind]}</button>)}<div className="menu-divider"/><small>项目文件</small>{files.length?files.map(name=><button key={name} onClick={()=>void selectFile(name)}><Icon name="file-code"/>{name}</button>):<button onClick={()=>setPanel('project')}>选择项目并创建工作副本…</button>}<div className="menu-divider"/><small>辅助对话</small>{state.sideChats.filter(s=>panel==='home'?!!s.source||s.columnId===column?.id:s.columnId===column?.id).map(side=><button key={side.id} onClick={()=>setActiveSideId(side.id)}><Icon name="comment-discussion"/>{side.context.quote}</button>)}<small>在主聊天选中文字，右键创建辅助对话。</small></>;
  const renderDock = (tab:WorkspaceTab):React.ReactNode => {
    if(tab.kind==='file') { const buffer=buffers[tab.resource!]; return buffer?<Editor file={tab.resource!} value={buffer.text} dirty={buffer.text!==buffer.original} jumpLine={workspace.activeId===tab.id?jumpLine:null} preferences={preferences} onEdit={text=>setBuffers(old=>({...old,[tab.resource!]:{...old[tab.resource!],text}}))} onSave={text=>saveBuffer(tab.resource!,text)}/>:<div className="dock-empty">请重新打开项目文件。</div>; }
    if(tab.id!==workspace.activeId)return null;
    if(tab.kind==='teaching')return <section className='teaching-pane'><header className='teaching-header'><strong>AI 教学 · {column?.title}</strong><div className='teaching-source'><Icon name='link'/><span title={column?.source?.url}>{column?.source?.url}</span><button onClick={()=>column?.source&&requestPage(column.source.url)}>查看原文</button></div><select aria-label='右侧学习模式' value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value='coach'>学习教练</option><option value='study-coach'>Study Coach</option><option value='grill'>想法拷问</option></select> <small>{column?.phase} · 当前小节：{step?.title||'已完成'}</small></header>{conversation}</section>;
    if(tab.kind==='lesson'){const bound=state.columns.find(c=>c.id===tab.resource);return bound?.source?<LessonPanel key={bound.id} column={bound} onError={setError}/>:<div className='dock-empty'>此章节记录已不存在，请从首页重新打开。</div>;}
    if(tab.kind==='terminal')return <div className="dock-document"><h3>终端输出</h3><small>命令在 Docker 工作副本中执行</small><pre className="terminal">{terminal||'还没有运行输出。到项目工作区运行命令后，会显示在这里。'}</pre><button onClick={()=>setPanel('project')}>前往项目工作区</button></div>;
    if(tab.kind==='diff')return <div className="dock-document"><h3>变更审查</h3><p>关闭此页不会应用或丢弃项目改动。</p>{diffs.map(item=><div className="diff-tab-entry" key={item.path}><strong>{item.path} · {item.status}</strong>{item.conflict&&<p className="error">原文件已变化</p>}<details open><summary>查看差异</summary><pre>{`原来：\n${item.before}\n\n副本：\n${item.after}`}</pre></details></div>)}{!diffs.length&&<p>当前没有已加载的差异。</p>}<button onClick={()=>setPanel('project')}>前往逐项审核与应用</button></div>;
    if(tab.kind==='preview')return previewUrl?<div className="preview-tab"><div className="preview-address"><Icon name="globe"/>{previewUrl}<button onClick={()=>void window.workbench.openPreview(previewUrl)}>独立窗口</button></div><iframe title="本地项目预览" src={previewUrl} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"/></div>:<div className="dock-empty"><h3>网页预览</h3><p>先在项目工作区启动本地预览服务。</p><button onClick={()=>setPanel('project')}>前往项目工作区</button></div>;
    return <aside className="side-chat"><div className="side-chat-head"><div><small>独立上下文</small><h3>辅助对话</h3></div></div>{activeSide ? <><div className="side-context"><small>正在追问</small><blockquote>{activeSide.context.quote}</blockquote></div><ContextPanel state={state} id={`side:${activeSide.id}`} history={turns(activeSide.messages)} busy={busy || voiceActive} onCompact={()=>void runAction(async()=>{await chatModel(`辅助对话目标：${activeSide.context.goal}`,turns(activeSide.messages),`side:${activeSide.id}`,true);flash('较早辅助对话已整理');})}/><div className="side-history">{activeSide.messages.map(item => <div key={item.id} className={`bubble ${item.role}`}><div className="bubble-label">{item.role === 'assistant' ? '辅助教练' : '我'}{item.model && <span className="message-model" title={`${item.apiProfile || ''} / ${item.model}`}>{item.apiProfile ? `${item.apiProfile} / ` : ''}{item.model}</span>}{item.role === 'assistant' && <button className='read-aloud' disabled={voiceActive} aria-label={readAloud.speaking === item.id ? '停止朗读' : '朗读这条回复'} onClick={() => void readAloud.read(item.id, item.content)}>{readAloud.speaking === item.id ? <><Icon name="debug-stop"/>停止朗读</> : <><Icon name="unmute"/>朗读</>}</button>}</div><div className="bubble-body">{item.content}</div></div>)}</div><div className="side-compose">{picker}<button disabled={busy||voiceActive||!activeSide.messages.some(m=>m.role==='assistant')} onClick={()=>void carryConclusion()}>带回教学草稿</button><textarea value={sideDraft} onChange={event => setSideDraft(event.target.value)} placeholder="只问这段不懂的内容…"/><VoiceInput key={`side:${activeSide.id}`} disabled={busy || voiceActive} onText={text => setSideDraft(previous => previous ? `${previous}\n${text}` : text)} onError={setError} onActive={setVoiceActive} stopReading={readAloud.stop}/><button className="primary" disabled={busy || voiceActive || !sideDraft.trim()} onClick={sendSide}>发送</button></div></> : <div className="side-blank">在主聊天选中词句，右键开启新的辅助对话。{state.sideChats.filter(item => item.columnId === column?.id).map(item => <button key={item.id} onClick={() => setActiveSideId(item.id)}>{item.context.quote}</button>)}</div>}</aside>;
  };
  const canSend = !!column && !busy && !voiceActive;
  const conversation = <div className="chat-layout"><section className="conversation">{!column ? <div className="empty"><div className="empty-mark">↗</div><h2>从一个知识点开始</h2><p>从首页选择分类、课程和知识点，跟着当前小节学。项目栏目可以共拟执行步骤。</p><div className="welcome-actions"><button className="primary" disabled={!loaded || busy || voiceActive} onClick={()=>openGuide('demo')}><Icon name="rocket"/>3 分钟快速体验</button><button onClick={() => setShowNew(true)}><Icon name="add"/>新建第一个栏目</button></div><button className="welcome-guide" disabled={!loaded} onClick={()=>openGuide('intro')}>先看使用指南<Icon name="arrow-right"/></button><small>体验无需 API Key，示例内容不计入学习记录。</small></div> : <><div className="conversation-scroll">{!modelReady&&<div className="model-needed"><Icon name="key"/><span>{activeProfile ? `为「${activeProfile.name}」填写 Key 后即可开始 AI 对话` : '先添加一个 API 配置，再开始 AI 对话'}</span><button onClick={manageModels}>配置模型</button></div>}<div className="goal-card"><small>栏目目标</small><strong>{column.goal}</strong>{step && <p>现在最重要：{step.title} · {step.outcome}</p>}</div>{column.phase === 'planning' && <div className="plan-card"><h2>先共拟学习阶梯</h2><p>说说目标、可用时间、已有材料和你的自述。AI 会起草，你可以逐项修改和确认。这里不会先出题。</p><button className="primary" disabled={busy} onClick={generatePlan}>AI 起草阶梯</button>{planDraft && <div className="plan-form"><label>目标能力<input value={planDraft.target} onChange={event => setPlanDraft({ ...planDraft, target: event.target.value })}/></label>{planDraft.steps.map((item, index) => <div className="step-edit" key={item.id}><span>{index + 1}</span><input value={item.title} onChange={event => setPlanDraft({ ...planDraft, steps: planDraft.steps.map((s, i) => i === index ? { ...s, title: event.target.value } : s) })}/><input value={item.outcome} onChange={event => setPlanDraft({ ...planDraft, steps: planDraft.steps.map((s, i) => i === index ? { ...s, outcome: event.target.value } : s) })}/><button onClick={() => setPlanDraft({ ...planDraft, steps: planDraft.steps.filter((_, i) => i !== index) })}>删除</button></div>)}<button onClick={() => setPlanDraft({ ...planDraft, steps: [...planDraft.steps, { id: uid(), title: '', outcome: '', priority: planDraft.steps.length + 1 }] })}>＋ 添加一步</button><button className="primary" disabled={busy} onClick={approvePlan}>确认阶梯并看概览</button></div>}</div>}{column.plan && <div className="ladder"><div className="ladder-head"><span>{column.source?'本章小节':'学习阶梯'}</span><small>{Math.min(column.currentStepIndex + 1,column.plan.steps.length)}/{column.plan.steps.length}</small></div>{column.plan.steps.map((item, index) => <div key={item.id} className={`ladder-step ${index === column.currentStepIndex ? 'active' : ''}`}><span className="step-num">{index + 1}</span><span>{item.title}</span><small>{item.status}</small></div>)}</div>}<ContextPanel state={state} id={column.id} history={turns(column.messages)} busy={busy || voiceActive} onCompact={()=>void runAction(async()=>{await chatModel(learningInstruction(column),turns(column.messages),column.id,true);flash('较早对话已整理');})}/>{column.messages.map(renderMessage)}{column.phase === 'overview' && <button className="primary flow-action" disabled={busy} onClick={startStudy}>开始当前知识块</button>}{column.phase === 'study' && column.source&&!lessonReady(column)&&<button className='primary flow-action' disabled={busy} onClick={teachLesson}><Icon name='play'/>开始当前小节讲解</button>}{column.phase === 'study' && (!column.source||lessonReady(column))&&<button className="primary flow-action" disabled={busy} onClick={finishTeaching}>这块学完了 · 开始学后反问</button>}{column.phase === 'verify' && <div className="flow-hint">一次只回答一个问题。当前提示程度：<select value={help} onChange={event => setHelp(event.target.value as HelpLevel)}><option value="independent">独立回答</option><option value="hinted">得到提示</option><option value="explained">看过完整解释</option></select></div>}{column.phase === 'teachback' && <div className="flow-hint">现在用自己的话说：学到了什么？还缺什么？</div>}{column.phase === 'remediate' && <div className="evidence-review"><h3>这一步的证据判断</h3><p>文字回答最多确认初步理解。独立应用需实际运行，稳定表现需延迟变式；AI 解释、打卡不算掌握。</p>{latestEvidence && <><blockquote>{latestEvidence.answer}<br/>复述：{latestEvidence.teachback}</blockquote><small>提示程度：{latestEvidence.helpLevel}</small>{latestEvidence.suggestion && <p>AI 建议：{latestEvidence.suggestion.level}。依据：{latestEvidence.suggestion.reason}。请你检查后确认。</p>}{latestEvidence.gap && <p>待补缺口：{latestEvidence.gap} · {latestEvidence.gapAddressed ? '已补上' : '请在聊天中用自己的话补上'}</p>}<select value={latestEvidence.level} onChange={event => updateActive(item => ({ ...item, evidence: item.evidence.map(e => e.id === latestEvidence.id ? { ...e, level: event.target.value as EvidenceLevel } : e) }))}><option>待验证</option><option>初步理解</option><option disabled>可独立应用（需运行证据）</option><option disabled>稳定掌握（需延迟变式）</option></select><button onClick={() => updateActive(item => confirmEvidence(item, latestEvidence.id, latestEvidence.level))}>确认判断</button><button className="primary" disabled={busy || !latestEvidence.confirmed || latestEvidence.level === '待验证' || latestEvidence.gapAddressed === false} onClick={() => { try { updateActive(completeStep); } catch (err) { setError(String(err)); } }}>进入下一块</button></>}<button disabled={busy} onClick={() => { try { updateActive(skipStep); } catch (err) { setError(String(err)); } }}>先跳过 · 待验证</button></div>}{column.phase === 'complete' && <div className="completion">这一轮完成。未验证的知识块仍保留在阶梯里，能力页可以查看你的实际证据。</div>}<div className="scroll-end"/></div><div className="composer"><textarea placeholder={column.phase === 'planning' ? '补充你的目标、时间、材料或想法…' : column.phase === 'verify' ? '在这里回答刚学过的问题…' : column.phase === 'teachback' ? '用自己的话复述学会了什么、还缺什么…' : '继续聊当前这一步…'} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (shouldSend({ ...event, isComposing: event.nativeEvent.isComposing }, preferences.sendKey)) { event.preventDefault(); void sendMain(); } }}/><button className="primary" disabled={!canSend || !draft.trim()} onClick={sendMain}>{busy ? '处理中…' : <>发送<Icon name="arrow-up"/></>}</button><VoiceInput key={`main:${column.id}`} disabled={busy || voiceActive} onText={text => { setDraft(previous => previous ? `${previous}\n${text}` : text); flash('识别文字已放入草稿，检查后自行发送'); }} onError={setError} onActive={setVoiceActive} stopReading={readAloud.stop}/>{picker}<small>{preferences.sendKey === 'enter' ? 'Enter 发送 · Shift + Enter 换行' : '⌘ / Ctrl + Enter 发送'} · 右键选中文字可开辅助对话</small></div></>}</section></div>;
  return <><div className={`app ${panel==='home'?'reader-mode':''} ${sidebarHidden ? 'sidebar-hidden' : ''}`} inert={onboardingView !== null || storageLocked}>
    <aside className="sidebar"><div className="brand"><div className="brand-icon">阶</div><div><strong>学习工作台</strong><small>从知道，到能做</small></div></div><button className={panel==='home'?'nav selected':'nav'} onClick={()=>setPanel('home')}><Icon name="home"/> 首页 · 教程阅读</button><button className={panel==='lab'?'nav selected':'nav'} disabled={!loaded} onClick={()=>{setPanel('lab');setDockVisible(false);}}><Icon name="code"/> 动手学习</button><button className="new-button" onClick={() => {setNewKind('project');setShowNew(true);}}><Icon name="add"/> 新建项目栏目</button><div className="sidebar-search"><Icon name="search"/><input aria-label="搜索栏目" placeholder="搜索栏目" value={columnSearch} onChange={e=>setColumnSearch(e.target.value)}/></div><div className="side-title">我的栏目</div><div className="column-list">{state.columns.filter(item=>`${item.title} ${item.goal}`.toLowerCase().includes(columnSearch.toLowerCase())).map(item => <button key={item.id} disabled={busy || voiceActive} className={`column-item ${panel==='chat'&&item.id === column?.id ? 'selected' : ''}`} onClick={() => resumeLesson(item)}><span>{item.title}</span><small>{item.phase === 'planning' ? '共拟阶梯' : item.plan?.steps[item.currentStepIndex]?.title || '已完成'}</small></button>)}</div><div className="side-bottom"><button className="nav" disabled={!loaded || busy || voiceActive} onClick={()=>openGuide('intro')}><Icon name="question"/> 使用指南</button><button className={panel === 'ability' ? 'nav selected' : 'nav'} onClick={() => setPanel('ability')}><Icon name="verified"/> 能力证据</button><button className={panel === 'project' ? 'nav selected' : 'nav'} onClick={() => setPanel('project')}><Icon name="files"/> 项目工作区</button><button className={panel === 'settings' ? 'nav selected' : 'nav'} onClick={() => setPanel('settings')}><Icon name="settings-gear"/> 设置</button><div className="profile-anchor"><button className="profile-button" aria-label="用户菜单" aria-expanded={profileMenu} onClick={()=>setProfileMenu(!profileMenu)}><span className="profile-avatar"><Icon name="account"/></span><span><strong>{preferences.name || '学习者'}</strong><small>本机工作台</small></span><Icon name="chevron-up"/></button>{profileMenu&&<><div className="profile-dismiss" onClick={()=>setProfileMenu(false)}/><div className="profile-menu"><button disabled={busy || voiceActive} onClick={()=>openGuide('intro')}><Icon name="book"/>入门介绍</button><button disabled={busy || voiceActive} onClick={()=>openGuide('demo')}><Icon name="rocket"/>快速体验</button><div className="menu-divider"/><button onClick={()=>{setPanel('settings');setSettingsSection('profile');setProfileMenu(false);}}><Icon name="account"/>个人资料</button><button onClick={()=>{setPanel('settings');setSettingsSection('general');setProfileMenu(false);}}><Icon name="settings-gear"/>设置</button><button onClick={()=>{setPanel('settings');setSettingsSection('shortcuts');setProfileMenu(false);}}><Icon name="keyboard"/>快捷键</button><div className="menu-divider"/><button onClick={()=>void window.workbench.quit()}><Icon name="sign-out"/>退出学习工作台</button></div></>}</div></div></aside>
    <main className="main"><header className="topbar"><button className="icon-button" title="切换侧栏 ⌘B" aria-label="切换侧栏" onClick={()=>setSidebarHidden(!sidebarHidden)}><Icon name="layout-sidebar-left"/></button><div className="topbar-title"><small className="eyebrow">{panel === 'home' ? 'COURSES' : panel === 'lab' ? 'PRACTICE' : panel === 'chat' ? 'LEARNING SESSION' : panel === 'ability' ? 'EVIDENCE' : panel === 'project' ? 'PROJECT AGENT' : 'PREFERENCES'}</small><h1>{panel === 'home' ? '首页' : panel === 'lab' ? '动手学习' : panel === 'chat' ? column?.title || '开始你的第一段学习' : panel === 'ability' ? '能力证据' : panel === 'project' ? '项目工作区' : '设置'}</h1></div><div className="top-actions"><button className="icon-button" aria-label="切换右侧工作区" title="切换工作区 ⌘⇧B" onClick={()=>setDockVisible(!dockVisible)}><Icon name="layout-sidebar-right"/></button>{column && panel === 'chat' && <><span className="phase-pill">{column.phase === 'planning' ? '共拟阶梯' : column.phase === 'overview' ? '概览' : column.phase === 'study' ? '逐块学习' : column.phase === 'verify' ? '学后反问' : column.phase === 'teachback' ? '自己复述' : column.phase === 'remediate' ? '补缺' : '完成'}</span><select aria-label='学习模式' value={mode} onChange={event => setMode(event.target.value as 'coach' | 'study-coach' | 'grill')}><option value='coach'>学习教练</option><option value='study-coach'>Study Coach</option><option value='grill'>想法拷问</option></select><button onClick={() => { setDockVisible(true); setActiveSideId(state.sideChats.filter(item => item.columnId === column.id).at(-1)?.id || null); }}><Icon name="comment-discussion"/> 辅助对话</button></>}{!checkedIn && <button className="checkin" onClick={() => setState(old => ({ ...old, checkins: [...old.checkins, { date: today, columnId: column?.id || '', note: '今日打卡' }] }))}>今日打卡</button>}{checkedIn && <span className="checked">✓ 今日已打卡</span>}</div></header>
      {loaded && <div className={`storage-status ${storage.status}`} role="status"><span>{storage.status==='saved'?'已保存到本机':storage.status==='saving'?'正在保存…':storage.status==='locked'?'正在处理学习文档…':'尚未保存 · 输入仍保留'}</span>{storage.status==='unsaved'&&<button onClick={()=>void controller.flush().catch(cause=>setError(String(cause)))}>重试保存</button>}</div>}
      {error && <div className="alert error">{error}<button onClick={() => setError('')}>×</button></div>}{notice && <div className="alert">{notice}</div>}
      {loaded&&<ReadingBrowser initialUrl={state.reading.url} request={readingRequest} visible={panel==='home'&&!storageLocked} blocked={onboardingView!==null||profileMenu||showNew||!!contextMenu||!!pendingClose} onPage={readerPage} onTeach={url=>void openTeaching(url)}/>}
      {panel === 'chat' && conversation}
      {loaded && <div className='desktop-lab-host' hidden={panel!=='lab'}><React.Suspense fallback={<section className='page'><p>正在打开本机学习单元…</p></section>}><DesktopLabPanel key={storage.generation} controller={controller}/></React.Suspense></div>}
      {panel === 'ability' && <section className="page"><div className="page-head"><div><h2>只看实际产出</h2><p>默认显示回答、代码与调试结果；文字评分最多是初步理解。动手产出可在「动手学习」查看实际运行与隔日变式。</p></div><label className="switch">0–1 评分 <input type="checkbox" checked={scoreMode} onChange={event => setScoreMode(event.target.checked)}/></label></div>{state.columns.flatMap(item => item.evidence.map(evidence => ({ column: item, evidence }))).map(({ column: item, evidence }) => <div className="evidence-card" key={evidence.id}><div><strong>{item.title} · {item.plan?.steps.find(step => step.id === evidence.stepId)?.title}</strong><span className="phase-pill">{scoreMode ? ({ '待验证': '0.0', '初步理解': '0.4', '可独立应用': '0.8', '稳定掌握': '1.0' } as Record<EvidenceLevel, string>)[evidence.level] : evidence.level}{!evidence.confirmed && ' · 待确认'}</span></div><p>回答：{evidence.answer}</p><p>复述：{evidence.teachback}</p><small>提示程度：{evidence.helpLevel} · {new Date(evidence.createdAt).toLocaleString()}</small></div>)}{state.practice.map(item => <div className='evidence-card' key={item.id}><div><strong>{item.kind === 'code' ? '自己编辑的代码' : '自己运行的调试命令'} · {item.file || item.content.split('\n')[0]}</strong><span className='phase-pill'>{item.helpLevel}</span></div><pre className='terminal'>{item.content}</pre><small>{new Date(item.createdAt).toLocaleString()}</small></div>)}{state.columns.every(item => item.evidence.length === 0) && state.practice.length === 0 && <div className="empty-page">学完知识块并用自己的话回答后，这里才会出现能力证据。</div>}</section>}
      {panel === 'project' && <section className="project-page"><div className="project-controls"><div className="panel-card"><h2>1 · 预检与副本</h2><p>先检查体积、疑似密钥与依赖目录，再决定复制范围。AI 和命令只进入 Docker 副本。</p><button onClick={() => void runAction(async () => { if(Object.values(buffers).some(b=>b.text!==b.original)) throw new Error('请先保存或关闭未保存的文件，再切换项目'); const choice = await window.workbench.chooseProject(); if (choice) { setProjectChoice(choice); setSelectedEntries(choice.entries); setProjectReady(false); setFiles([]); setFile(''); setCode(''); setDiffs([]); setSelectedDiffs([]); setTerminal(''); setPreviewUrl(''); } })}>选择本机项目</button>{projectChoice && <><p className="path">{projectChoice.root}</p><p>{projectChoice.report.files} 个文件 · {(projectChoice.report.bytes / 1024 / 1024).toFixed(1)} MB {projectChoice.report.tooLarge && '· 项目过大'}</p><small>忽略目录：{projectChoice.report.ignoredDirs.join('、') || '无'}</small><small>疑似密钥：{projectChoice.report.suspectedSecrets.join('、') || '无'}</small><div className="copy-selection"><strong>选择复制范围</strong>{projectChoice.entries.map(entry => <label key={entry}><input type="checkbox" checked={selectedEntries.includes(entry)} onChange={event => { const next = event.target.checked ? [...selectedEntries, entry] : selectedEntries.filter(name => name !== entry); setSelectedEntries(next); void window.workbench.preflightSelection(next).then(report => setProjectChoice(old => old ? { ...old, report } : old)).catch(err => setError(String(err))); }}/>{entry}</label>)}</div><label><input type="checkbox" checked={includeSecrets} onChange={event => setIncludeSecrets(event.target.checked)}/> 复制疑似密钥文件</label><label><input type="checkbox" checked={network} onChange={event => setNetwork(event.target.checked)}/> 容器联网（默认断网）</label><button className="primary" disabled={projectChoice.report.tooLarge || !selectedEntries.length || busy} onClick={() => void runAction(async () => { if(Object.values(buffers).some(b=>b.text!==b.original)) throw new Error('请先保存或关闭未保存的文件，再创建新副本'); await window.workbench.prepareProject(includeSecrets, network, selectedEntries); setDiffs([]); setSelectedDiffs([]); setTerminal(''); setPreviewUrl(''); setBuffers({}); setDockStates({}); setProjectReady(true); setFiles(await window.workbench.files()); flash('Docker 工作副本已创建'); })}>创建工作副本</button></>}</div>{projectReady && <div className="panel-card"><h2>项目文件</h2><div className="project-files">{files.map(name=><button key={name} onClick={()=>void selectFile(name)}><Icon name="file-code"/>{name}</button>)}</div></div>}{projectReady && <div className="panel-card"><h2>2 · Docker 中运行</h2><input value={command} onChange={event => setCommand(event.target.value)} placeholder="例如 npm test"/><button onClick={() => void runAction(async () => { const result = await window.workbench.run(command); setTerminal(`$ ${command}\n退出码 ${result.code}\n${result.output}`); openWorkspace({id:'terminal',kind:'terminal',title:'终端'}); if (column && step) setState(old => ({ ...old, practice: [...old.practice, { id: uid(), columnId: column.id, stepId: step.id, kind: 'debug', content: `$ ${command}\n退出码 ${result.code}\n${result.output.slice(0, 3000)}`, helpLevel: help, createdAt: now() }] })); })}>运行命令</button>{picker}<textarea value={agentGoal} onChange={event => setAgentGoal(event.target.value)} placeholder="告诉项目 Agent 在副本里要做什么…"/><button className="primary" disabled={!agentGoal.trim() || busy} onClick={() => void runAction(async () => { const request = requireModel(); const log = await window.workbench.agent(agentGoal, request.profile, request.model); setTerminal(log.join('\n\n')); openWorkspace({id:'terminal',kind:'terminal',title:'终端'}); setFiles(await window.workbench.files()); await refreshDiff(); })}>AI 自动读、改、运行</button><button disabled={!terminal} onClick={()=>openWorkspace({id:'terminal',kind:'terminal',title:'终端'})}>在右侧查看终端输出</button></div>}{projectReady && <div className="panel-card"><h2>3 · 审核应用</h2><button onClick={refreshDiff}>检查差异</button>{diffs.map(item => <label key={item.path} className="diff-row"><input type="checkbox" disabled={item.conflict} checked={selectedDiffs.includes(item.path)} onChange={event => setSelectedDiffs(event.target.checked ? [...selectedDiffs, item.path] : selectedDiffs.filter(name => name !== item.path))}/><span>{item.path} · {item.status} {item.conflict && '· 原文件已变化'}</span><details><summary>查看差异</summary><pre>原来：\n{item.before.slice(0, 5000)}\n\n副本：\n{item.after.slice(0, 5000)}</pre></details></label>)}<button className="primary" disabled={!selectedDiffs.length || busy} onClick={() => void runAction(async () => { const applied = await window.workbench.apply(selectedDiffs); flash(`已应用 ${applied.length} 个文件`); await refreshDiff(); })}>应用所选到原项目</button></div>}{projectReady && <div className="panel-card"><h2>本地网页预览</h2><input value={previewCommand} onChange={event => setPreviewCommand(event.target.value)}/><button disabled={!network} onClick={() => void runAction(async () => { const url = await window.workbench.preview(previewCommand, 3000); setPreviewUrl(url); openWorkspace({id:'preview',kind:'preview',title:'网页预览'}); })}>启动并打开预览</button>{!network && <small>创建副本时开启联网才可预览</small>}{previewUrl && <span>{previewUrl}</span>}</div>}</div></section>}
      {panel === 'settings' && <Settings value={preferences} onChange={value=>setState(old=>({...old,settings:{...old.settings,preferences:value}}))} state={state} section={settingsSection} onSection={setSettingsSection} loginControl={<LoginControl/>} sections={{ model: <><UsagePanel state={state}/><ModelSettings library={modelLibrary} keyStatus={modelKeyStatus} busy={busy || voiceActive} onSave={saveModelProfile} onSelect={changeModel} onRemove={removeModelProfile} onTest={async selection => { const profile = modelLibrary.profiles.find(p => p.id === selection.profileId); if (!profile) throw new Error('配置已移除'); return window.workbench.testModel(profile, selection.model); }}/></>, voice: <VoiceSettingsPanel value={state.settings.voice} onChange={voice => setState(old => ({ ...old, settings: { ...old.settings, voice } }))} onError={setError}/>, reminders: <ReminderControls enabled={state.settings.reminderEnabled} date={state.settings.reminderDate} time={state.settings.reminderTime} onChange={change => setState(old => ({...old, settings: {...old.settings, ...change}}))}/>, data: <div className="panel-card"><h2>本地数据</h2><p>栏目、聊天、动手代码、解释草稿、运行反馈、证据和打卡保存在本机。导出的备份不含 API Key，也不含可重新获取的教程正文。</p>{embedded ? <div><p>请使用日常工作台的“账户与同步 → 备份与恢复”，保存所有模块的原始记录、草稿与历史证据。模型连接、声音等设备设置留在本机，换设备后需重新配置。</p><button disabled={!onOpenBackup||storage.status!=='saved'||busy||voiceActive} onClick={onOpenBackup}>打开备份与恢复</button></div> : <div className="button-row"><button disabled={busy || voiceActive || !loaded} onClick={() => void runAction(async () => { if (await controller.exportBackup()) flash('备份已导出'); })}>导出备份</button><button disabled={busy || voiceActive} onClick={() => void runAction(async () => { const restored = await controller.importBackup(); if (restored) { const imported=controller.snapshot().document.state; setReadingRequest({url:imported.reading.url,id:uid()}); setDockStates({}); setDockVisible(false); setMode(imported.settings.preferences.defaultMode); setModelKeyStatus({}); flash('备份已恢复，API Key 需要重新填写'); } })}>恢复备份</button></div>}<TutorialCacheSettings/></div> }}/> }
    </main>{dockVisible&&panel!=='settings'&&<Dock initialWidth={panel==='home'?36:48} state={workspace} onSelect={id=>{setWorkspace(old=>({...old,activeId:id}));const t=workspace.tabs.find(t=>t.id===id);if(t?.kind==='teaching')setState(old=>({...old,activeColumnId:t.resource||null}));}} onClose={requestClose} onMove={(id,before)=>setWorkspace(old=>moveTab(old,id,before))} onReopen={()=>setWorkspace(reopenTab)} onHide={()=>setDockVisible(false)} dirty={dirty} menu={dockMenu}>{renderDock}</Dock>}{pendingClose&&<div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title"><h2 id="unsaved-title">文件尚未保存</h2><p>这些标签包含未保存的代码。保存成功后才会关闭。</p>{pendingClose.filter(id=>dirty[id]).map(id=><p key={id}>{workspace.tabs.find(t=>t.id===id)?.resource}</p>)}<div className="button-row"><button autoFocus onClick={()=>setPendingClose(null)}>取消</button><button onClick={()=>{setBuffers(old=>{const next={...old};for(const id of pendingClose){const name=workspace.tabs.find(t=>t.id===id)?.resource;if(name&&next[name])next[name]={...next[name],text:next[name].original};}return next;});doClose(pendingClose);}}>放弃修改并关闭</button><button className="primary" disabled={busy} onClick={()=>void runAction(async()=>{for(const id of pendingClose){const name=workspace.tabs.find(t=>t.id===id)?.resource;if(name&&dirty[id])await saveBuffer(name,buffers[name].text);}doClose(pendingClose);})}>保存并关闭</button></div></div></div>}{contextMenu && <div className="context-shield" onClick={() => setContextMenu(null)}><button className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={event => { event.stopPropagation(); openSide(contextMenu.source, contextMenu.selection); }}>辅助对话 · 追问选中文字</button></div>}{showNew && <div className="modal-backdrop"><div className="modal"><small className="eyebrow">NEW LEARNING SPACE</small><h2>新建项目栏目</h2><p>从空白开始，先说你想学会或做成什么。</p><label>栏目类型<select value={newKind} onChange={event => setNewKind(event.target.value as 'knowledge' | 'project')}><option value="knowledge">知识学习（进入课程首页）</option><option value="project">项目成长</option></select></label><label>栏目名称<input autoFocus value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="例如：后端接口入门"/></label><label>目标<textarea value={newGoal} onChange={event => setNewGoal(event.target.value)} placeholder="例如：能独立写出并调试一个真实 API"/></label><div className="button-row"><button onClick={() => setShowNew(false)}>取消</button><button className="primary" onClick={addColumn}>创建栏目</button></div></div></div>}</div>{onboardingView==='intro'&&<IntroGuide onClose={closeGuide} onStartDemo={()=>openGuide('demo')} onCreate={createFromGuide} onSettings={settingsFromGuide}/>} {onboardingView==='demo'&&<QuickExperience onClose={closeGuide} onCreate={createFromGuide} onSettings={settingsFromGuide} onComplete={()=>setState(old=>({...old,onboarding:{introSeen:true,demoCompleted:true}}))}/>}</>;
}
