import React, {useEffect, useSyncExternalStore} from 'react';
import type {WorkbenchRuntime} from '../runtime';
import type {SyncEngine} from '../sync/engine';
import {WorkbenchShell} from './shell';
import {AccountPanel} from './account';
import {SyncStatus} from './sync-status';
import {ConflictReview} from './conflict-review';
import {BackupPanel} from './backup';
export function WorkbenchApplication({runtime,accountDetails}: {runtime: WorkbenchRuntime;accountDetails?: React.ReactNode}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  useEffect(() => {
    const online = () => runtime.notifyOnline(navigator.onLine);
    online(); window.addEventListener('online', online); window.addEventListener('offline', online);
    return () => {window.removeEventListener('online', online); window.removeEventListener('offline', online);};
  }, [runtime]);
  const account = <>
    <div className="wb-page-intro"><span className="wb-eyebrow">自己的资料，自己的节奏</span><h1>账户与同步</h1><p>日常编辑先保存在这台设备。连接自己的服务后，其他设备可以继续查看和编辑。</p></div>
    <AccountPanel session={runtime.session} engine={state.engine} onPair={runtime.pair}/>
    {state.engine && <SyncStatus engine={state.engine}/>}
    {state.repository.deviceId && state.active && <ConflictReview repository={state.repository} deviceId={state.repository.deviceId} subscribe={state.host.subscribe} onResolved={() => {state.host.notifyDataChanged(); void runtime.sync().catch(() => {});}}/>}
    {state.backup && <BackupPanel key={state.scope} service={state.backup} save={state.saveBackup}/>}
    {accountDetails}
    {state.error && <p role="alert" className="wb-notice">账户切换尚未完成。本机资料仍保留，请重新连接。</p>}
  </>;
  if (!state.active) return <div className="wb-shell"><main className="wb-content">{account}</main></div>;
  return <WorkbenchShell key={state.scope} host={state.host} accountPanel={account} accountLabel={state.profile ? '账户空间' : '本机空间'} syncLabel={state.engine ? <EngineLabel engine={state.engine}/> : '本机保存 · 连接账户'}/>;
}
function EngineLabel({engine}: {engine: SyncEngine}) {
  const state = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  const labels = {pending: '已存本机 · 待同步', syncing: '正在同步', synced: '已同步', conflict: '需要核对版本', failed: '同步未完成'};
  return <>{labels[state.state]}</>;
}
