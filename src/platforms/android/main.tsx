import React,{useEffect,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {WorkbenchApplication} from '../../workbench/ui/application';
import type {WorkbenchRuntime} from '../../workbench/runtime';
import type {IncomingShare} from '../../workbench/contracts/platform';
import {androidBridge,type NotificationStatus} from './bridge';
import {bootAndroidRuntime} from './boot';
import {createAndroidShares} from './shares';
import {createAndroidNotifications,reminderOperations} from './notifications';
import {publicSourceUrl} from '../../modules/library/model';
import '../../workbench/ui/shell.css';
const root=createRoot(document.getElementById('root')!);
const shares=createAndroidShares(androidBridge),notifications=createAndroidNotifications(androidBridge),reminderOperation=reminderOperations(androidBridge);
function AndroidApplication({runtime}:{runtime:WorkbenchRuntime}) {
 const state=useSyncExternalStore(runtime.subscribe,runtime.snapshot,runtime.snapshot);
 const reminderState=useSyncExternalStore(reminderOperation.subscribe,reminderOperation.snapshot,reminderOperation.snapshot);
 const [pending,setPending]=useState<IncomingShare[]>([]),[ignored,setIgnored]=useState<IncomingShare[]>([]),[showIgnored,setShowIgnored]=useState(false);
 const [status,setStatus]=useState<NotificationStatus>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const accountId=state.profile?.accountId??'local-device';
 const own=(share:IncomingShare)=>!share.accountId||share.accountId===accountId;
 const ignoredHere=ignored.filter(own);
 const refresh=async()=>{const [items,archived,capabilities]=await Promise.all([shares.pending(),shares.ignored(),notifications.status()]);setPending(items);setIgnored(archived);setStatus(capabilities);};
 useEffect(()=>{let live=true;const handles: {remove():Promise<void>}[]=[];const run=()=>{if(live)void refresh().catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));};run();for(const event of ['foreground','inboxChanged'] as const)void androidBridge.addListener(event,run).then(handle=>{if(live)handles.push(handle);else void handle.remove();});return()=>{live=false;for(const handle of handles)void handle.remove();};},[state.scope]);
 async function action(work:()=>Promise<unknown>){setBusy(true);setError('');try{await work();await refresh();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}}
 async function accept(share:IncomingShare){const bound=state;await action(()=>shares.confirm(accountId,share,async input=>{if(runtime.snapshot().scope!==bound.scope||!bound.active)throw Error('账户已切换，请重新确认接收位置');return await bound.host.invoke('library','ingestShare',input as unknown as import('../../workbench/contracts/data').JsonValue) as unknown as import('../../workbench/contracts/data').LocalReceipt;}));}
 return <><aside className="wb-notice" aria-label="设备分享与提醒" style={{padding:'12px 16px',margin:0}}>
 {pending.map(share=><section key={share.deliveryId}>
  <strong>{own(share)?`收到系统分享 · ${share.files.length} 个文件${share.text?'和文字':''}`:'原账户有一份待处理分享'}</strong>
  <p>{!own(share)?'请切回原账户继续处理。':share.status==='needs-reshare'?share.message:`接收到${state.profile?'当前账户空间':'本机空间'}的资料库，确认后保存。`}</p>
  {own(share)&&share.text&&<p>{share.text.replace(/https?:\/\/[^\s<>"']+/g,url=>publicSourceUrl(url)??'[网址]').slice(0,160)}</p>}
  {own(share)&&<><button disabled={busy||!state.active||share.status==='needs-reshare'||share.status==='copying'||!state.host.modules().some(m=>m.id==='library'&&m.enabled&&m.state==='ready')} onClick={()=>void accept(share)}>确认保存到{state.profile?'当前账户':'本机'}资料库</button><button disabled={busy} onClick={()=>void action(()=>shares.dismiss(accountId,share.deliveryId))}>忽略收件，保留原件</button></>}
 </section>)}
 {ignoredHere.length>0&&<div><button onClick={()=>setShowIgnored(value=>!value)}>{showIgnored?'收起':'查看'}已忽略收件（{ignoredHere.length}）</button>{showIgnored&&ignoredHere.map(share=><section key={share.deliveryId}><p>{share.status==='needs-reshare'?'原授权已失效，需要重新分享；旧收件原件仍保留。':'此收件已忽略，原件仍保留。'}</p><button disabled={busy} onClick={()=>void action(()=>shares.restore(accountId,share.deliveryId))}>恢复到待处理收件</button></section>)}</div>}
 {status&&<div><span>{status.message}</span>{status.permission!=='granted'&&<button onClick={()=>void notifications.request().then(setStatus).then(refresh).catch(cause=>setError(String(cause)))}>开启通知</button>}{!status.exact&&<button onClick={()=>void notifications.exactSettings().catch(cause=>setError(String(cause)))}>允许精确定时</button>}</div>}
 {reminderState.error&&<div role="alert"><p>{reminderState.error}</p><button disabled={reminderState.state==='rebuilding'} onClick={()=>void reminderOperation.retry().catch(()=>{})}>重新排程提醒</button></div>}
 {reminderState.state==='rebuilding'&&<p role="status">正在核对本机提醒排程…</p>}
 {error&&<p role="alert">{error}</p>}</aside><WorkbenchApplication runtime={runtime}/></>;
}
async function boot(){root.render(<main><h1>日常工作台</h1><p role="status">正在读取 Android 本机空间…</p></main>);try{const runtime=await bootAndroidRuntime();root.render(<AndroidApplication runtime={runtime}/>);}catch(cause){root.render(<main><h1>本机空间需要检查</h1><p role="alert">{cause instanceof Error?cause.message:String(cause)}</p><p>本机原始资料仍保留，请检查后重新打开。凭证失效时需要重新配对。</p><button onClick={()=>void boot()}>重新读取</button></main>);}}
void boot();
