import {useEffect, useSyncExternalStore} from 'react';
import type {SyncEngine, SyncState} from '../sync/engine';
import './sync.css';
const labels: Record<SyncState, string> = {pending: '已存本机 · 待同步', syncing: '正在同步', synced: '已同步', conflict: '需要核对版本', failed: '同步未完成'};
export function SyncStatus({engine}: {engine: SyncEngine}) {
  const status = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);
  useEffect(() => {void engine.refresh().catch(() => {});}, [engine]);
  return <section className="wb-sync-status" aria-label="同步状态"><span role="status" data-state={status.state}>{labels[status.state]}</span><small>{status.pending > 0 && `${status.pending} 个操作待同步`}{status.conflicts > 0 && ` · ${status.conflicts} 个版本冲突`}</small>{status.error && <p role="alert">{status.error === 'UNAUTHORIZED' ? '登录已过期，请重新绑定或恢复此设备登录。' : status.error === 'PROTOCOL_UNSUPPORTED' ? '请更新客户端后继续同步。' : '连接或数据版本暂不可用，本机内容已保留。'}</p>}<button type="button" disabled={status.state === 'syncing'} onClick={() => {void engine.sync().catch(() => {});}}>立即同步</button>{status.readonlyKinds.length > 0 && <p>部分数据来自新版客户端，已完整保留，当前只读：{status.readonlyKinds.join('、')}</p>}</section>;
}
