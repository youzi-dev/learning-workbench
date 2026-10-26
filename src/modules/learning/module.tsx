import React, {Suspense} from 'react';
import {manifest} from './manifest';
import type {ModuleContext, WorkbenchModule} from '../../workbench/contracts/module';
const BrowserPage=React.lazy(()=>import('./browser-page').then(module=>({default:module.BrowserLearningPage})));
export function createModule(options:{render?(context:ModuleContext,signal:AbortSignal):React.ReactNode;start?():Promise<void>;stop?():Promise<void>}={}):WorkbenchModule {
  let context:ModuleContext,signal:AbortSignal;
  return {manifest,navigation:[{id:'home',title:'学习'}],commands:{async changed(){return null;}},settings:['教程阅读、可选 AI、侧聊、动手实践与历史证据'],async start(ctx,abort){context=ctx;signal=abort;await options.start?.();},async stop(){await options.stop?.();},render(){return options.render?options.render(context,signal):<Suspense fallback={<p role="status">正在打开学习页面…</p>}><BrowserPage context={context} signal={signal}/></Suspense>;}};
}
