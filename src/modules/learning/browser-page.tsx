import React, {useEffect, useState} from 'react';
import type {ModuleContext} from '../../workbench/contracts/module';
import {BrowserApp} from '../../browser/app';
import {createBrowserController, type BrowserController} from '../../browser/controller';
import {createLearningService, validateLegacyDocument} from './compatibility';
import {createLearningBrowserRepository} from './service';
import css from '../../browser/app.css?inline';
import {scopedLearningCss} from './scoped-style';
import {UnknownLearningRecords} from './unknown-records';
import {createLearningRecoveryStore,type LearningRecoveryStore} from './pending-recovery';
export function BrowserLearningPage({context,signal}:{context:ModuleContext;signal:AbortSignal}) {
  const [controller,setController]=useState<BrowserController>(),[error,setError]=useState(''),[recovery,setRecovery]=useState<LearningRecoveryStore>();
  useEffect(()=>{let current=true;let active:BrowserController|undefined;const preferences=context.learningPreferences;if(!preferences||!context.deviceId){setError('学习数据尚未接入本机保存');return;}
    const service=createLearningService({repository:context.repository,deviceId:context.deviceId,preferences,signal});
    setRecovery(createLearningRecoveryStore({repository:context.repository,preferences,signal}));
    void createBrowserController(createLearningBrowserRepository(service,context.subscribe),{validate:validateLegacyDocument}).then(value=>{if(!current||signal.aborted)value.close();else{active=value;setController(value);}}).catch(cause=>{if(current)setError(cause instanceof Error?cause.message:String(cause));});
    const stop=()=>{active?.close();};signal.addEventListener('abort',stop,{once:true});return()=>{current=false;signal.removeEventListener('abort',stop);stop();};
  },[context,signal]);
  return <div className="learning-browser"><style>{scopedLearningCss(css,'.learning-browser')}</style><UnknownLearningRecords context={context} signal={signal}/>{error?<p role="alert">{error}</p>:controller?<BrowserApp controller={controller} packagedNative={context.platform.environment==='native'} embedded onOpenBackup={context.openAccount} pendingRecovery={recovery} registerLeaveGuard={context.registerLeaveGuard}/>:<p role="status">正在读取学习历程…</p>}</div>;
}
