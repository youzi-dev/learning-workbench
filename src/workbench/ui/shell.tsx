import React, {Component, useLayoutEffect, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode} from 'react';
import type {WorkbenchHost} from '../host';
import {ModuleSettings} from './module-settings';
import {TodayPage} from './today';
import './shell.css';

// Refactoring UI §2.7: quiet, consistent navigation symbols; names remain accessible text.
const navigationPaths: Record<string, string> = {
  today: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  journal: 'M4 4h10v16H4zM8 8h3M8 12h3M17 4l3 3-5 5-3 1 1-3z',
  tasks: 'M9 6h11M9 12h11M9 18h11M3 5l1 1 2-2M3 11l1 1 2-2M3 17l1 1 2-2',
  calendar: 'M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M7 3v4M17 3v4M3 11h18M7 15h2M15 15h2M7 18h2',
  library: 'M3 5h4v15H3zM9 5h4v15H9zM15 6l4-1 3 14-4 1z',
  learning: 'M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1M12 6v14',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
};
function NavigationIcon({name}: {name: string}) {
  return <svg className="wb-nav-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={navigationPaths[name] ?? navigationPaths.library}/></svg>;
}
class ModuleBoundary extends Component<{host: WorkbenchHost; moduleId: string; children: ReactNode}, {error: boolean}> {
  state = {error: false}; static getDerivedStateFromError() {return {error: true};}
  componentDidCatch(error: Error, _info: ErrorInfo) {this.props.host.reportRenderError(this.props.moduleId, error);}
  render() {return this.state.error ? <div className="wb-empty" role="alert"><h2>这个模块暂时无法打开</h2><p>已有内容仍保存在本机。其他模块可以继续使用。</p></div> : this.props.children;}
}
export function WorkbenchShell({host, accountPanel, syncLabel, accountLabel = '本机空间'}: {host: WorkbenchHost; accountPanel?: ReactNode; syncLabel?: ReactNode; accountLabel?: string}) {
  useSyncExternalStore(host.subscribe, host.snapshot, host.snapshot); const [selected, setSelected] = useState('today'); const [leaveError, setLeaveError] = useState(''); const [entityId, setEntityId] = useState<string | undefined>();
  const navigate = (next: string) => {void host.prepareLeave().then(() => {setLeaveError(''); setEntityId(undefined); setSelected(next);}).catch(cause => setLeaveError(cause instanceof Error ? cause.message : String(cause)));};
  const shell = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => host.onEntityRequested(ref => {const route = host.navigation().find(item => item.moduleId === ref.moduleId); if (route) {setLeaveError(''); setEntityId(ref.entityId); setSelected(`${route.moduleId}/${route.id}`);}}), [host]);
  useLayoutEffect(() => host.onAccountRequested(() => navigate('account')), [host]);
  useLayoutEffect(() => {shell.current?.scrollIntoView?.({block: 'start', behavior: 'instant'});}, [selected, entityId]);
  const navigation = host.navigation(), modules = host.modules(), active = navigation.find(item => `${item.moduleId}/${item.id}` === selected);
  const unavailable = selected !== 'today' && selected !== 'settings' && selected !== 'account' && !active;
  return <div className="wb-shell" ref={shell}><aside className="wb-sidebar"><a href="#" className="wb-brand" onClick={event => {event.preventDefault(); navigate('today');}}><span className="wb-brand-symbol">◒</span><span>日常工作台<small>留下一点，慢慢向前</small></span></a><div className="wb-nav-caption">我的空间</div><nav aria-label="工作台导航"><button aria-current={selected === 'today' ? 'page' : undefined} onClick={() => navigate('today')}><NavigationIcon name="today"/>今日</button>{navigation.map(item => <button key={`${item.moduleId}/${item.id}`} aria-current={selected === `${item.moduleId}/${item.id}` ? 'page' : undefined} onClick={() => navigate(`${item.moduleId}/${item.id}`)}><NavigationIcon name={item.moduleId}/>{item.title}</button>)}</nav><div className="wb-sidebar-bottom"><p><span className="wb-status-dot"/> {accountLabel}</p><small>{syncLabel ?? '云端同步尚未连接'}</small><button aria-current={selected === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><NavigationIcon name="settings"/><span>模块管理</span></button></div></aside><div className="wb-main"><header className="wb-topbar"><span>{selected === 'settings' ? '设置 / 模块管理' : selected === 'account' ? '账户与同步' : active?.title ?? '我的空间 / 今日'}</span><button className="wb-device-badge" aria-label="账户与同步" onClick={() => navigate('account')}>{syncLabel ?? '账户与同步'}</button></header><main className="wb-content">{leaveError && <p className="wb-notice" role="alert">{leaveError}</p>}{selected === 'settings' ? <ModuleSettings host={host}/> : selected === 'account' ? accountPanel ?? <p>账户连接尚未接通。</p> : active ? <><div className="wb-capabilities">{modules.find(module => module.id === active.moduleId)?.capabilityExplanations.map(text => <p key={text}>{text}</p>)}</div><ModuleBoundary key={`${selected}/${entityId ?? ""}`} host={host} moduleId={active.moduleId}><ModulePage host={host} moduleId={active.moduleId} routeId={active.id} entityId={entityId}/></ModuleBoundary></> : unavailable ? <section className="wb-empty"><h1>模块已关闭或暂不可用</h1><p>可以在模块管理中查看状态并重新开启。</p><button onClick={() => navigate('settings')}>打开模块管理</button></section> : <><TodayPage host={host} onNavigate={moduleId => {const route = host.navigation().find(item => item.moduleId === moduleId); navigate(route ? `${route.moduleId}/${route.id}` : 'settings');}}/>{modules.some(module => module.error) && <p role="alert" className="wb-notice">部分模块暂时不可用，可以在模块管理中查看。</p>}</>}</main><footer className="wb-footer">给想法留个位置，也给自己留点余地。</footer></div></div>;
}
function ModulePage({host, moduleId, routeId, entityId}: {host: WorkbenchHost; moduleId: string; routeId: string; entityId?: string}) {return host.render(moduleId, routeId, entityId);}
