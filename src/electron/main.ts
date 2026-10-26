import {electronSettings} from '../platforms/electron/boot';
import {createDesktopSession, desktopRequest, type DesktopSession} from '../platforms/electron/session';
import {emptyState} from '../core/state';
import {TutorialReader} from './reader';
import {createDesktopSecurity, installShellNavigationGuards} from './security';
import {TutorialStore,tutorialUrl} from '../node/tutorials';
import {sourceMaterial} from '../core/course-learning';
import { ModelOperations, NativeLearningScope } from '../node/model-operations';
import { trackRequest, createIncurredUsageWriter } from '../node/usage-tracker';
import { runProjectAgent } from '../node/project-agent';
import { runConversation } from '../node/conversation';
import { usageRecord, type UsagePurpose } from '../core/usage';
import { boundToolOutput, type ContextTurn, type ConversationContext } from '../core/context-cache';
import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, Tray, Menu, nativeImage, powerMonitor, systemPreferences, shell, safeStorage } from 'electron';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { spawn } from 'node:child_process';
import { type ChatTurn, type ModelReply } from '../core/providers';
import { validateProfile, type ApiProfile } from '../core/model-library';
import { ModelRuntime } from '../node/model-runtime';
import type {DesktopStore} from '../node/desktop-store';
import {createLearningService} from '../modules/learning/compatibility';
import {validateLegacyDocument} from '../modules/learning/compatibility';
import {createLearningDesktopStore} from '../modules/learning/desktop-store';
import { createQuitCoordinator } from '../node/quit-coordinator';
import type { AppState } from '../core/state';
import { personalInstruction } from '../core/preferences';
import { LocalVoiceService } from '../node/voice';
import {desktopAppId, desktopToastClsid} from '../core/system-controls';
import {LoginControls, NotificationControls} from '../node/system-controls';
import { applyDiff, closeProject, copyProject, dockerRun, listFiles, preflight, projectDiff, projectTopEntries, safeProjectPath, type ProjectSession } from '../node/projects';

// Set stable Windows identity before any native notification API or window creation.
if (process.platform === 'win32') {app.setAppUserModelId(desktopAppId); app.setToastActivatorCLSID(desktopToastClsid);}
protocol.registerSchemesAsPrivileged([{ scheme: 'growth', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const desktopSecurity = createDesktopSecurity({isPackaged: app.isPackaged, devServerUrl: process.env.VITE_DEV_SERVER_URL});

// Development QA uses an isolated data folder and Chromium's synthetic audio device.
if (!app.isPackaged && process.env.GROWTH_WORKBENCH_TEST_DATA) app.setPath('userData', path.resolve(process.env.GROWTH_WORKBENCH_TEST_DATA));
const voice = new LocalVoiceService(app.isPackaged ? path.join(process.resourcesPath, 'speech') : path.resolve('resources/speech'));
let store: DesktopStore;
let learningHandle: string | undefined;
const learningScope = new NativeLearningScope();
let learningModuleToken: string | undefined;
let learningGeneration = 0;
let learningEnabled = false;
let incurredUsage: ReturnType<typeof createIncurredUsageWriter> | undefined;
const usageWriters = new Set<ReturnType<typeof createIncurredUsageWriter>>();
async function bindLearning(handle: string) {
  const nativeSession = await ensureWorkbench();
  const repository = nativeSession.learningRepository(handle);
  const moduleToken = learningModuleToken, signal = learningScope.begin();
  learningEnabled = false; modelOperations.invalidate(); models.clearKeys(); voice.cancelAll();
  const service = createLearningService({repository, deviceId: repository.deviceId!, preferences: {read: () => repository.devicePreferences()}, signal});
  learningGeneration = Math.max(learningGeneration, store?.snapshot().generation ?? 0) + 1;
  const candidate = await createLearningDesktopStore(service, learningGeneration);
  await Promise.all([notifications.initialize(), loginControls.initialize()]);
  const enabled = (await v2Settings.get('learning')) !== false;
  if (!learningScope.isCurrent(signal) || moduleToken !== learningModuleToken) throw Error('学习设备范围已改变');
  nativeSession.learningRepository(handle); // Profile may have changed while the store was loading.
  store = candidate; incurredUsage = createIncurredUsageWriter(repository, repository.deviceId!); usageWriters.add(incurredUsage); learningHandle = handle; learningEnabled = enabled;
  if (!enabled) stopLearning();
}
function stopLearning() {learningModuleToken = undefined; learningEnabled = false; learningScope.abort(); modelOperations.invalidate(); models.clearKeys(); voice.cancelAll(); reader?.viewport({x:0,y:0,width:0,height:0},false);}
let window: BrowserWindow | null = null;
let reader:TutorialReader|null=null;
let previewWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let forceQuit = false;
const currentState = () => store?.snapshot().document.state ?? emptyState();
let workbenchSession: DesktopSession | undefined;
let workbenchOpening: Promise<DesktopSession> | undefined;
const v2Settings = electronSettings(path.join(app.getPath('userData'), 'workbench-v2'));
const ensureWorkbench = () => {
  if (!workbenchOpening) workbenchOpening = createDesktopSession({
    directory: app.getPath('userData'),
    calendar: {native:{supported:()=>Notification.isSupported(),create:options=>new Notification(options)},enabled:async()=>await v2Settings.get('calendar')??true,focus:()=>{window?.show();window?.focus();}},
    async saveFile(name) {const result = await dialog.showSaveDialog({title: '保存资料文件', defaultPath: name}); return result.canceled ? null : result.filePath ?? null;},
    async pickFiles() {const result = await dialog.showOpenDialog({title: '导入资料原文件', properties: ['openFile', 'multiSelections']}); return result.canceled ? [] : result.filePaths;},
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: value => safeStorage.encryptString(value),
      decryptString: value => safeStorage.decryptString(Buffer.from(value)),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
    },
  }).then(value => {workbenchSession = value; return value;}).catch(cause => {workbenchOpening = undefined; throw cause;});
  return workbenchOpening;
};
let session: ProjectSession | null = null;
let chosenRoot: string | null = null;
const models = new ModelRuntime();
const modelOperations = new ModelOperations();
const tutorials = new TutorialStore(path.join(app.getPath('userData'),'tutorial-cache'));
let previewContainer: string | null = null;

const reminderFile = () => path.join(app.getPath('userData'), 'reminder.json');
const loginFile = () => path.join(app.getPath('userData'), 'login.json');
const loginControls = new LoginControls({platform: process.platform, isPackaged: app.isPackaged, execPath: process.execPath,
  storage: {read: () => readFile(loginFile(), 'utf8'), write: text => atomicWrite(loginFile(), text)},
  api: {get: options => app.getLoginItemSettings(options), set: options => app.setLoginItemSettings(options)},
});
const notifications = new NotificationControls({
  storage: {read: () => readFile(reminderFile(), 'utf8'), write: text => atomicWrite(reminderFile(), text)},
  native: {supported: () => Notification.isSupported(), create: options => new Notification(options)},
  dailySettings: now => {
    const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const state=currentState();
    return {time: state.settings.reminderTime, enabled: state.settings.reminderEnabled, checkedIn: state.checkins.some(item => item.date === date), startDate: state.settings.reminderDate};
  },
  focus: () => {window?.show(); window?.focus();},
});
async function atomicWrite(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
}
async function persistRuntime(owner:DesktopStore,generation:number, change:(current:AppState)=>AppState) {
  const data=await owner.runtime(generation,change);
  if(store===owner&&learningEnabled)window?.webContents.send('runtime:update',data);
}
const quitCoordinator=createQuitCoordinator({
  requestFlush:token=>{
    if(!learningEnabled){queueMicrotask(()=>quitCoordinator.acknowledge(token));return;}
    if(!window || window.isDestroyed() || window.webContents.isDestroyed())throw Error('学习页面不可用，无法确认草稿已保存。');
    window.webContents.send('app:quit-request',token);
  },
  // Do not discard a model request's eventual runtime record during a clean quit.
  flush:async()=>{modelOperations.invalidate();await modelOperations.drain();for(const writer of usageWriters)await writer.flush();if(learningEnabled)await store.flush();},
  confirmDiscard:async error=>{
    if(window && !window.isDestroyed())window.show();
    const result=await dialog.showMessageBox({type:'warning',title:'尚未完成保存',message:'当前输入尚未确认保存，是否取消退出？',detail:error instanceof Error?error.message:String(error),buttons:['取消退出，继续保存','放弃未保存修改并退出'],defaultId:0,cancelId:0,noLink:true});
    return result.response===1;
  },
  finish:()=>{forceQuit=true;app.quit();},
  release:token=>{if(window && !window.isDestroyed() && !window.webContents.isDestroyed())window.webContents.send('app:quit-cancelled',token);},
  timeoutMs:15000,
});

function requireSession() { if (!session) throw new Error('先选择项目并创建 Docker 工作副本'); return session; }
async function waitForPreview(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(700) });
      await response.body?.cancel();
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw new Error('预览服务未在 3000 端口响应，请检查启动命令和终端输出');
}
function mainWindow() {
  window = new BrowserWindow({ width: 1500, height: 920, minWidth: 1060, minHeight: 650,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  installShellNavigationGuards(window.webContents, desktopSecurity);
  if (desktopSecurity.developmentOrigin) {
    const contents = window.webContents;
    contents.session.webRequest.onHeadersReceived({urls: [`${desktopSecurity.developmentOrigin}/*`]}, (details, callback) => {
      if (details.webContentsId !== contents.id || details.resourceType !== 'mainFrame') { callback({}); return; }
      const headers = {...details.responseHeaders};
      for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-security-policy') delete headers[name];
      headers['Content-Security-Policy'] = [desktopSecurity.contentSecurityPolicy];
      callback({responseHeaders: headers});
    });
  }
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => contents === window?.webContents && permission === 'media' && details.mediaType !== 'video');
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(contents === window?.webContents && permission === 'media' && 'mediaTypes' in details && !!details.mediaTypes?.length && details.mediaTypes.every(type => type === 'audio')));
  reader=new TutorialReader(window,tutorials);
  window.on('hide', () => voice.cancelAll());
  window.loadURL(desktopSecurity.launchUrl);
  window.on('close', event => { if (forceQuit) return; event.preventDefault(); if (currentState().settings.preferences.closeToTray) window?.hide(); else app.quit(); });
}

function createTray() {
  const icon = nativeImage.createFromPath(app.isPackaged ? path.join(process.resourcesPath, 'tray.png') : path.resolve('assets/tray.png'));
  if (icon.isEmpty()) throw new Error('菜单栏图标无法读取');
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('学习工作台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开学习工作台', click: () => { window?.show(); window?.focus(); } },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('double-click', () => window?.show());
}

function registerIpc() {
  // Every native operation belongs to the local shell, never the embedded website.
  ipcMain.handle('workbench-v2:request', async (event, operation: string, args: unknown[]) => {
    desktopSecurity.assertTrustedIpc(event, window?.webContents);
    try {
      if(!Array.isArray(args))throw Error('请求格式无效');
      if (operation === 'learning-bind') {await bindLearning(args[0] as string); return {ok:true,value:null};}
      if (operation === 'learning-start') {
        if (typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/i.test(args[0])) throw Error('学习模块标识无效');
        learningModuleToken = args[0];
        if (learningHandle) {let current = true; try {(await ensureWorkbench()).learningRepository(learningHandle);} catch {current = false;} if (current) await bindLearning(learningHandle);}
        return {ok:true,value:null};
      }
      if (operation === 'learning-stop') {if (args[0] === undefined || args[0] === learningModuleToken) stopLearning(); return {ok:true,value:null};}
      if (operation === 'module-enabled') return {ok: true, value: await v2Settings.get(args[0] as string)};
      if (operation === 'set-module-enabled') {
        if (typeof args[0] !== 'string' || typeof args[1] !== 'boolean') throw Error('模块设置无效');
        const set=()=>v2Settings.set(args[0] as string,args[1] as boolean);
        return {ok: true, value: await (args[0]==='calendar'&&workbenchSession?workbenchSession.calendarSettingsChange(set):set())};
      }
      return desktopRequest(await ensureWorkbench(), operation, args);
    } catch {return {ok: false, error: {code: 'STARTUP_FAILED', message: '本机记录需要检查，原文件已保留'}};}
  });
  const handle=(channel:string,handler:(event:Electron.IpcMainInvokeEvent,...args:any[])=>any)=>ipcMain.handle(channel,(event,...args)=>{
    desktopSecurity.assertTrustedIpc(event, window?.webContents);
    if (!store || !learningEnabled) throw Error('学习模块尚未启用');
    return handler(event,...args);
  });
  handle('reader:viewport',(_event,rect,visible)=>reader?.viewport(rect,visible));
  handle('reader:navigate',(_event,url)=>reader?.navigate(url));
  handle('reader:action',(_event,action)=>reader?.action(action));
  handle('reader:cached',(_event,url)=>tutorials.cachedLesson(url));
  const trustedVoice = (event: Electron.IpcMainInvokeEvent) => desktopSecurity.assertTrustedIpc(event, window?.webContents);
  handle('voice:status', event => { trustedVoice(event); return voice.status(); });
  handle('voice:microphone', async event => { trustedVoice(event); const status = await voice.status(); if (!status.ready) throw new Error(status.reason); voice.stopSpeaking(); if (!app.isPackaged && app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return true; return process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true; });
  handle('voice:transcribe', (event, id: string, wav: ArrayBuffer) => { trustedVoice(event); return voice.transcribe(id, wav); });
  handle('voice:cancel', (event, id: string) => { trustedVoice(event); voice.cancel(id); });
  handle('voice:voices', event => { trustedVoice(event); return voice.listVoices(); });
  handle('voice:speak', (event, text: string, name: string, rate: number) => { trustedVoice(event); return voice.speak(text, name, rate); });
  handle('voice:stop', event => { trustedVoice(event); voice.stopSpeaking(); });
  handle('state:load', () => store.load());
  handle('state:save', (_event, input) => store.save(input));
  handle('state:export', (_event,generation:number) => modelOperations.restore(()=>store.export(generation,async backup=>{
    const result=await dialog.showSaveDialog({defaultPath:`学习工作台备份-${new Date().toLocaleDateString('sv-SE')}.json`,filters:[{name:'JSON',extensions:['json']}]});
    if(!result.filePath)return false;
    await atomicWrite(result.filePath,JSON.stringify(backup,null,2));return true;
  })));
  handle('state:import', (_event,generation:number) => modelOperations.restore(async()=>{
    const restored=await store.restore(generation,async()=>{
      const result=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
      if(!result.filePaths[0])return null;
      const raw=JSON.parse(await readFile(result.filePaths[0],'utf8'));
      if(raw.format!=='growth-workbench'||raw.schemaVersion!==1)throw Error('请使用工作台保存与恢复导入此备份');
      return validateLegacyDocument({state:raw.state,drafts:raw.browser?.drafts});
    });
    if(restored)models.clearKeys();
    return restored;
  }));
  // Credentials remain per-profile and in memory; no key is exposed by state or backups.
  const trustedModel = (event: Electron.IpcMainInvokeEvent) => desktopSecurity.assertTrustedIpc(event, window?.webContents);
  handle('tutorial:course',(event,url:string,refresh:boolean)=>{trustedModel(event);return tutorials.course(url,refresh===true);});
  handle('tutorial:lesson',(event,url:string,refresh:boolean)=>{trustedModel(event);return tutorials.lesson(url,refresh===true);});
  handle('tutorial:pin',(event,url:string,pinned:boolean)=>{trustedModel(event);return tutorials.pin(url,pinned);});
  handle('tutorial:status',(event,url:string)=>{trustedModel(event);return tutorials.status(url);});
  handle('tutorial:stats',event=>{trustedModel(event);return tutorials.stats();});
  handle('tutorial:clear',(event,includePinned:boolean)=>{trustedModel(event);return tutorials.clear(includePinned===true);});
  handle('tutorial:external',(event,url:string)=>{trustedModel(event);return shell.openExternal(tutorialUrl(url));});
  const modelSnapshot = (input: ApiProfile, model: string) => {
    const profile = validateProfile(input);
    const selection = { profileId: profile.id, model };
    return models.snapshot({ profiles: [profile], active: selection }, selection);
  };
  handle('model:set-key', (event, profile: ApiProfile, key: string) => { trustedModel(event); models.setKey(validateProfile(profile), key); });
  handle('model:key-status', (event, profiles: ApiProfile[]) => { trustedModel(event); return Object.fromEntries(profiles.map(profile => [profile.id, models.hasKey(validateProfile(profile))])); });
  handle('model:forget-key', (event, id: string) => { trustedModel(event); models.forgetKey(id); });
  const modelSignal=(generation:number)=>{if(!learningEnabled||generation!==store.snapshot().generation)throw Error('学习模块或账户已改变');return modelOperations.signal();};
  const trackedRequest = (generation:number, snapshot: ReturnType<typeof modelSnapshot>, system:string, turns:ChatTurn[], purpose:UsagePurpose, timeout=180000) => {
    const signal=modelSignal(generation), writer=incurredUsage, owner=store;
    if(!writer)throw Error('用量保存目标尚未就绪');
    return trackRequest(snapshot,system,turns,purpose,async record=>{
      await writer(record);
      if(owner===store&&learningEnabled){try{const data=await owner.runtime(generation,current=>current);if(owner===store&&learningEnabled)window?.webContents.send('runtime:update',data);}catch{/* Incurred usage is already durably appended; a retired UI cannot own its ACK. */}}
    },timeout,undefined,signal,true,true);
  };
  handle('model:test' , async (event, profile: ApiProfile, model: string) => modelOperations.run(async () => {
    trustedModel(event);
    const generation=store.snapshot().generation;
    const snapshot = modelSnapshot(profile, model);
    await trackedRequest(generation,snapshot,'这是接口连通性检查。请只回复 OK。', [{ role: 'user', content: 'OK' }],'test',20000);
    return `${snapshot.profile.name} / ${snapshot.settings.model} 已成功返回文本`;
  }));
  handle('model:chat', async (event, system: string, history:ContextTurn[], profile:ApiProfile, model:string, options:{scope:string;task:string;compactOnly?:boolean;purpose?:'chat'|'side';lesson?:{url:string;version:string;sectionId:string}}) => modelOperations.run(async () => {
    trustedModel(event);
    if(!options?.scope || !Array.isArray(history))throw new Error('聊天上下文缺少标识');
    const owner=store,generation=owner.snapshot().generation;
    const snapshot=modelSnapshot(profile,model);
    await owner.flush();
    const state=currentState();
    const bound=state.columns.find(c=>c.id===options.scope)?.source;
    let task=options.task;
    if(bound && !options.compactOnly){
      const request=options.lesson;
      if(!request||request.url!==bound.url||request.version!==bound.version)throw new Error('课程教材与当前栏目不匹配');
      const document=await tutorials.lesson(bound.url);
      task+=`\n${sourceMaterial(bound,request.sectionId,document)}`;
    } else if(options.lesson)throw new Error('课程栏目已改变，请重新打开章节');
    const result=await runConversation({history,system:`${system}\n${personalInstruction(state.settings.preferences)}`,task,context:state.contexts[options.scope]??{},window:snapshot.profile.contextWindows?.[model],profileId:snapshot.profile.id,model,compactOnly:options.compactOnly,purpose:options.purpose},
      (fixed,turns,purpose)=>trackedRequest(generation,snapshot,fixed,turns,purpose),
      context=>persistRuntime(owner,generation,current=>({...current,contexts:{...current.contexts,[options.scope]:context}})));
    return result.reply?.text ?? '较早对话已整理；原聊天和能力证据仍保留。';
  }));
  handle('project:choose', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); if (!result.filePaths[0]) return null; chosenRoot = result.filePaths[0]; return { root: chosenRoot, entries: await projectTopEntries(chosenRoot), report: await preflight(chosenRoot) }; });
  handle('project:preflight-selection', (_event, entries: string[]) => { if (!chosenRoot) throw new Error('先选择项目'); return preflight(chosenRoot, entries); });
  handle('project:prepare', async (_event, includeSecrets: boolean, network: boolean, entries: string[]) => { if (!chosenRoot) throw new Error('先选择项目'); if (session) await closeProject(session); session = await copyProject(chosenRoot, includeSecrets, network, entries); return { root: chosenRoot, copy: session.copy }; });
  handle('project:files', () => listFiles(requireSession().copy));
  handle('project:read', async (_event, relative: string) => (await readFile(await safeProjectPath(requireSession().copy, relative), 'utf8')));
  handle('project:save', async (_event, relative: string, value: string) => { const file = await safeProjectPath(requireSession().copy, relative); if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('文件过大，不能在编辑器中保存'); await writeFile(file, value); return true; });
  handle('project:diff', () => projectDiff(requireSession()));
  handle('project:apply', (_event, paths: string[]) => applyDiff(requireSession(), paths));
  handle('project:run', (_event, command: string) => dockerRun(requireSession(), command));
  handle('project:agent', async (event, goal: string, profile: ApiProfile, model: string) => modelOperations.run(async () => {
    trustedModel(event);
    const generation=store.snapshot().generation;
    const snapshot = modelSnapshot(profile, model);
    const current = requireSession();
    return runProjectAgent(await listFiles(current.copy),goal,
      async (instruction,history)=>(await trackedRequest(generation,snapshot,instruction,history,'agent')).text,
      {read:async relative=>readFile(await safeProjectPath(current.copy,relative),'utf8'),
       write:async (relative,content)=>{const dest=await safeProjectPath(current.copy,relative,true);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,content);},
       run:command=>dockerRun(current,command)},
      log=>window?.webContents.send('agent:log',log));
  }));
  handle('project:preview', async (_event, command: string, port: number) => {
    const current = requireSession();
    if (!current.network) throw new Error('网页预览需先为副本开启联网');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口不正确');
    if (previewContainer) spawn('docker', ['rm', '-f', previewContainer]);
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', ['run', '-d', '--rm', '--cpus=2', '--memory=2g', '--network=bridge', '-p', `127.0.0.1::${port}`, '-v', `${current.copy}:/workspace`, '-w', '/workspace', 'node:22-alpine', 'sh', '-lc', command]);
      let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) { reject(new Error(output)); return; }
        previewContainer = output.trim();
        const probe = spawn('docker', ['port', previewContainer, String(port)]);
        let ports = ''; probe.stdout.on('data', chunk => ports += chunk);
        probe.on('close', async () => {
          const match = ports.match(/127\.0\.0\.1:(\d+)/);
          if (!match) { reject(new Error('无法找到预览端口')); return; }
          const url = `http://127.0.0.1:${match[1]}`;
          try { await waitForPreview(url); resolve(url); }
          catch (error) { spawn('docker', ['rm', '-f', previewContainer!]); previewContainer = null; reject(error); }
        });
      });
    });
  });
  handle('preview:open', (_event, url: string) => { if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('只允许本机预览'); previewWindow?.close(); previewWindow = new BrowserWindow({ width: 1100, height: 750, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } }); previewWindow.loadURL(url); });
  handle('app:quit', () => app.quit());
  handle('app:quit-ready', (_event,input:{token:string;generation?:number;error?:string})=>{
    if(!input || typeof input.token!=='string')throw Error('退出确认格式不正确');
    const error=typeof input.error==='string'?input.error:input.generation===store.snapshot().generation?undefined:'学习文档已改变，请重新保存后退出';
    return quitCoordinator.acknowledge(input.token,error);
  });
  handle('app:login-status', () => loginControls.status());
  handle('app:set-login', (_event, enabled: unknown) => loginControls.set(enabled));
  handle('app:reminder-status', () => notifications.status());
  handle('app:test-notification', () => notifications.test());
  handle('app:notification-test-status', () => notifications.testStatus());
}

app.whenReady().then(async () => {
  console.log('startup ready', app.isPackaged, app.getPath('userData'));
  protocol.handle('growth', async request => {
    if (new URL(request.url).hostname === 'files') return (await ensureWorkbench()).fileResponse(request);
    const root = path.resolve(__dirname, '..', 'dist');
    const file = desktopSecurity.resolveGrowthAsset(request.url, root);
    if (!file) return new Response('Forbidden', { status: 403 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', desktopSecurity.contentSecurityPolicy);
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  });
  // Do not initialize the legacy store: boot snapshots its original bytes into v2.
  powerMonitor.on('resume',()=>{void workbenchSession?.resumeCalendarReminders();});
  app.on('activate',()=>{void workbenchSession?.resumeCalendarReminders();});
  registerIpc(); mainWindow(); console.log('startup window created');
  try { createTray(); } catch (error) { console.error('菜单栏初始化失败', error); }
  console.log('startup tray completed');
  console.log('startup login completed');
  // The legacy reminder loop resumes only when its record-level adapter is ready.
}).catch(async error => { console.error('学习工作台启动失败', error); await dialog.showMessageBox({type:'error',title:'无法启动学习工作台',message:'读取本机资料失败，原文件未被覆盖。',detail:error instanceof Error?error.message:String(error)}); forceQuit=true;app.quit(); });
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if(!forceQuit){
    event.preventDefault();
    void quitCoordinator.request().catch(error=>console.error('退出保存检查失败',error));
    return;
  }
  learningScope.abort(); modelOperations.invalidate(); workbenchSession?.close();
  voice.cancelAll();
  if (previewContainer) spawn('docker', ['rm', '-f', previewContainer]);
  if (session) void closeProject(session);
});
