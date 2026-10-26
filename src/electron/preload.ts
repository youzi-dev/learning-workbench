import { contextBridge, ipcRenderer } from 'electron';

const calls = {
  readerViewport:(rect:unknown,visible:boolean)=>ipcRenderer.invoke('reader:viewport',rect,visible),
  readerNavigate:(url:string)=>ipcRenderer.invoke('reader:navigate',url),
  readerAction:(action:string)=>ipcRenderer.invoke('reader:action',action),
  readerCached:(url:string)=>ipcRenderer.invoke('reader:cached',url),
  onReaderUpdate:(callback:(data:unknown)=>void)=>{const listener=(_event:unknown,data:unknown)=>callback(data);ipcRenderer.on('reader:update',listener);return()=>ipcRenderer.removeListener('reader:update',listener);},
  onReaderSelection:(callback:(data:unknown)=>void)=>{const listener=(_event:unknown,data:unknown)=>callback(data);ipcRenderer.on('reader:selection',listener);return()=>ipcRenderer.removeListener('reader:selection',listener);},
  onRuntimeUpdate: (callback: (data: unknown)=>void) => { const listener=(_event: unknown,data: unknown)=>callback(data); ipcRenderer.on('runtime:update',listener); return ()=>ipcRenderer.removeListener('runtime:update',listener); },
  onAgentLog: (callback:(log:string[])=>void)=>{const listener=(_event:unknown,log:string[])=>callback(log);ipcRenderer.on('agent:log',listener);return ()=>ipcRenderer.removeListener('agent:log',listener);},
  tutorialCourse: (url:string,refresh=false)=>ipcRenderer.invoke('tutorial:course',url,refresh),
  tutorialLesson: (url:string,refresh=false)=>ipcRenderer.invoke('tutorial:lesson',url,refresh),
  tutorialPin: (url:string,pinned:boolean)=>ipcRenderer.invoke('tutorial:pin',url,pinned),
  tutorialPinned: (url:string)=>ipcRenderer.invoke('tutorial:status',url),
  tutorialStats: ()=>ipcRenderer.invoke('tutorial:stats'),
  tutorialClear: (includePinned=false)=>ipcRenderer.invoke('tutorial:clear',includePinned),
  tutorialExternal: (url:string)=>ipcRenderer.invoke('tutorial:external',url),
  quit: () => ipcRenderer.invoke('app:quit'),
  onQuitRequest: (callback: (token:string)=>Promise<number>) => {
    const listener = (_event:unknown, token:string) => {
      void Promise.resolve().then(()=>callback(token)).then(
        generation=>ipcRenderer.invoke('app:quit-ready',{token,generation}),
        error=>ipcRenderer.invoke('app:quit-ready',{token,error:error instanceof Error?error.message:String(error)})
      ).catch(()=>{});
    };
    ipcRenderer.on('app:quit-request',listener);
    return ()=>ipcRenderer.removeListener('app:quit-request',listener);
  },
  onQuitCancelled: (callback:(token:string)=>void) => {
    const listener=(_event:unknown,token:string)=>callback(token);
    ipcRenderer.on('app:quit-cancelled',listener);
    return ()=>ipcRenderer.removeListener('app:quit-cancelled',listener);
  },
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  microphoneAccess: () => ipcRenderer.invoke('voice:microphone'),
  transcribe: (id: string, wav: ArrayBuffer) => ipcRenderer.invoke('voice:transcribe', id, wav),
  cancelTranscription: (id: string) => ipcRenderer.invoke('voice:cancel', id),
  listVoices: () => ipcRenderer.invoke('voice:voices'),
  speak: (text: string, name: string, rate: number) => ipcRenderer.invoke('voice:speak', text, name, rate),
  stopSpeaking: () => ipcRenderer.invoke('voice:stop'),
  load: () => ipcRenderer.invoke('state:load'),
  save: (state: unknown) => ipcRenderer.invoke('state:save', state),
  exportBackup: (generation:number) => ipcRenderer.invoke('state:export',generation),
  importBackup: (generation:number) => ipcRenderer.invoke('state:import',generation),
  setModelKey: (profile: unknown, key: string) => ipcRenderer.invoke('model:set-key', profile, key),
  modelKeyStatus: (profiles: unknown[]) => ipcRenderer.invoke('model:key-status', profiles),
  forgetModelKey: (id: string) => ipcRenderer.invoke('model:forget-key', id),
  testModel: (profile: unknown, model: string) => ipcRenderer.invoke('model:test', profile, model),
  chat: (system: string, turns: unknown[], profile: unknown, model: string, options: unknown) => ipcRenderer.invoke('model:chat', system, turns, profile, model, options),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  preflightSelection: (entries: string[]) => ipcRenderer.invoke('project:preflight-selection', entries),
  prepareProject: (includeSecrets: boolean, network: boolean, entries: string[]) => ipcRenderer.invoke('project:prepare', includeSecrets, network, entries),
  files: () => ipcRenderer.invoke('project:files'),
  readFile: (file: string) => ipcRenderer.invoke('project:read', file),
  saveFile: (file: string, text: string) => ipcRenderer.invoke('project:save', file, text),
  diff: () => ipcRenderer.invoke('project:diff'),
  apply: (paths: string[]) => ipcRenderer.invoke('project:apply', paths),
  run: (command: string) => ipcRenderer.invoke('project:run', command),
  agent: (goal: string, profile: unknown, model: string) => ipcRenderer.invoke('project:agent', goal, profile, model),
  preview: (command: string, port: number) => ipcRenderer.invoke('project:preview', command, port),
  openPreview: (url: string) => ipcRenderer.invoke('preview:open', url),
  loginStatus: () => ipcRenderer.invoke('app:login-status'),
  setLogin: (enabled: boolean) => ipcRenderer.invoke('app:set-login', enabled),
  reminderStatus: () => ipcRenderer.invoke('app:reminder-status'),
  testNotification: () => ipcRenderer.invoke('app:test-notification'),
  notificationTestStatus: () => ipcRenderer.invoke('app:notification-test-status')
};
contextBridge.exposeInMainWorld('workbenchV2', {request: (operation: string, args: unknown[] = []) => ipcRenderer.invoke('workbench-v2:request', operation, args)});

contextBridge.exposeInMainWorld('workbench', calls);

