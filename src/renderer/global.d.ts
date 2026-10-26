import type {ReaderRect,ReaderStatus,ReaderSelection} from '../core/reader';
import type {CourseDirectory,LessonDocument,TutorialStats} from '../core/curriculum';
import type { ContextTurn } from '../core/context-cache';
import type { DesktopRuntime, DesktopSnapshot, DesktopWrite } from '../core/desktop-document';
import type { ChatTurn } from '../core/providers';
import type { ApiProfile } from '../core/model-library';
import type {DailyReminderStatus, LoginStatus, NotificationTestStatus} from '../core/system-controls';
declare global {
  interface Window {
    workbenchV2: import('../platforms/electron/ports').ElectronWorkbenchBridge;
    workbench: {
      readerViewport(rect:ReaderRect|null,visible:boolean):Promise<ReaderStatus>;
      readerNavigate(url:string):Promise<ReaderStatus>;
      readerAction(action:'back'|'forward'|'reload'|'home'):Promise<void>;
      readerCached(url:string):Promise<LessonDocument|null>;
      onReaderUpdate(callback:(data:ReaderStatus)=>void):()=>void;
      onReaderSelection(callback:(data:ReaderSelection)=>void):()=>void;
      onRuntimeUpdate(callback:(data:DesktopRuntime)=>void):()=>void;
      onAgentLog(callback:(log:string[])=>void):()=>void;
      tutorialCourse(url:string,refresh?:boolean):Promise<CourseDirectory>;
      tutorialLesson(url:string,refresh?:boolean):Promise<LessonDocument>;
      tutorialPin(url:string,pinned:boolean):Promise<TutorialStats>;
      tutorialPinned(url:string):Promise<boolean>;
      tutorialStats():Promise<TutorialStats>;
      tutorialClear(includePinned?:boolean):Promise<TutorialStats>;
      tutorialExternal(url:string):Promise<void>;
      quit(): Promise<void>;
      onQuitRequest(callback:(token:string)=>Promise<number>):()=>void;
      onQuitCancelled(callback:(token:string)=>void):()=>void;
      voiceStatus(): Promise<{ ready: boolean; model: string; reason: string }>;
      microphoneAccess(): Promise<boolean>;
      transcribe(id: string, wav: ArrayBuffer): Promise<string>;
      cancelTranscription(id: string): Promise<void>;
      listVoices(): Promise<Array<{ name: string; language: string }>>;
      speak(text: string, name: string, rate: number): Promise<void>;
      stopSpeaking(): Promise<void>;
      load(): Promise<DesktopSnapshot>; save(input: DesktopWrite): Promise<DesktopSnapshot>; exportBackup(generation:number): Promise<boolean>; importBackup(generation:number): Promise<DesktopSnapshot | null>;
      setModelKey(profile: ApiProfile, key: string): Promise<void>;
      modelKeyStatus(profiles: ApiProfile[]): Promise<Record<string, boolean>>;
      forgetModelKey(id: string): Promise<void>;
      testModel(profile: ApiProfile, model: string): Promise<string>;
      chat(system: string, turns: ContextTurn[], profile: ApiProfile, model: string, options:{scope:string;task:string;compactOnly?:boolean;purpose?:'chat'|'side';lesson?:{url:string;version:string;sectionId:string}}): Promise<string>;
      chooseProject(): Promise<{ root: string; entries: string[]; report: { files: number; bytes: number; ignoredDirs: string[]; suspectedSecrets: string[]; tooLarge: boolean } } | null>;
      preflightSelection(entries: string[]): Promise<{ files: number; bytes: number; ignoredDirs: string[]; suspectedSecrets: string[]; tooLarge: boolean }>;
      prepareProject(includeSecrets: boolean, network: boolean, entries: string[]): Promise<{ root: string; copy: string }>;
      files(): Promise<string[]>; readFile(file: string): Promise<string>; saveFile(file: string, text: string): Promise<boolean>;
      diff(): Promise<Array<{ path: string; before: string; after: string; status: 'added' | 'modified' | 'deleted'; conflict: boolean }>>;
      apply(paths: string[]): Promise<string[]>; run(command: string): Promise<{ code: number; output: string }>;
      agent(goal: string, profile: ApiProfile, model: string): Promise<string[]>; preview(command: string, port: number): Promise<string>; openPreview(url: string): Promise<void>;
      loginStatus(): Promise<LoginStatus>; setLogin(enabled: boolean): Promise<LoginStatus>;
      reminderStatus(): Promise<DailyReminderStatus>;
      testNotification(): Promise<NotificationTestStatus>;
      notificationTestStatus(): Promise<NotificationTestStatus | null>;
    }
  }
}
export {};
