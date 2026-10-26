import React, {useEffect,useState} from 'react';
import {App} from '../../renderer/legacy-app';
import {createDesktopDocumentController} from '../../renderer/desktop-document';
import type {ModuleContext} from '../../workbench/contracts/module';
import {validateLegacyDocument} from './compatibility';
import {createModule as createLearningModule} from './module';
import {desktopQuit} from '../../renderer/desktop-quit';
import {desktopCall} from '../../platforms/electron/ports';
import base from '../../renderer/style.css?inline';
import shell from '../../renderer/shell.css?inline';
import {scopedLearningCss} from './scoped-style';
import {UnknownLearningRecords} from './unknown-records';
export function DesktopLearningPage({context,signal}:{context:ModuleContext;signal:AbortSignal}) {
  const [controller]=useState(()=>createDesktopDocumentController({
    async load(){signal.throwIfAborted();const value=await window.workbench.load();signal.throwIfAborted();return value;},
    async save(input){signal.throwIfAborted();const value=await window.workbench.save(input);signal.throwIfAborted();await context.invoke('learning','changed',null);return value;},
    exportBackup:generation=>{signal.throwIfAborted();return window.workbench.exportBackup(generation);},
    importBackup:generation=>{signal.throwIfAborted();return window.workbench.importBackup(generation);},
  },{validate:validateLegacyDocument}));
  useEffect(()=>{const stop=()=>controller.close();signal.addEventListener('abort',stop,{once:true});const unsubscribe=window.workbench.onRuntimeUpdate(()=>{if(!signal.aborted)void context.invoke('learning','changed',null).catch(()=>{});});return()=>{stop();unsubscribe();signal.removeEventListener('abort',stop);};},[controller,context,signal]);
  return <div className="learning-desktop"><style>{scopedLearningCss(base+shell,'.learning-desktop')+' .learning-desktop{height:calc(100dvh - 150px);min-height:600px;min-width:0;overflow:hidden}.learning-desktop .app{height:100%;min-height:0}.learning-desktop .settings-overlay,.learning-desktop .modal-shade{position:absolute}.learning-desktop{position:relative}'}</style><UnknownLearningRecords context={context} signal={signal}/><App controller={controller} quit={desktopQuit} embedded onOpenBackup={context.openAccount} registerLeaveGuard={context.registerLeaveGuard}/></div>;
}
export function createModule(){const token=crypto.randomUUID();return createLearningModule({render:(context,signal)=><DesktopLearningPage context={context} signal={signal}/>,start:()=>desktopCall(window.workbenchV2,'learning-start',[token]),stop:()=>desktopCall(window.workbenchV2,'learning-stop',[token])});}
