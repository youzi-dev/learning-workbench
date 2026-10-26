import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {WorkbenchRuntime} from '../../workbench/runtime';
import {WorkbenchApplication} from '../../workbench/ui/application';
import {desktopCall,type ElectronWorkbenchBridge} from './ports';
import type {DesktopReminderStatus} from './notifications';
export function DesktopWorkbenchApplication({runtime,bridge}:{runtime:WorkbenchRuntime;bridge:ElectronWorkbenchBridge}) {
  const state=useSyncExternalStore(runtime.subscribe,runtime.snapshot,runtime.snapshot);
  return <WorkbenchApplication runtime={runtime} accountDetails={<DesktopReminderStatusPanel bridge={bridge} scope={state.scope}/>}/>;
}
export function DesktopReminderStatusPanel({bridge,scope}:{bridge:ElectronWorkbenchBridge;scope:number}) {
  const [report,setReport]=useState<{scope:number;status:DesktopReminderStatus}>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0), sequence=useRef(0);
  useEffect(() => {
    const own = ++generation.current; setError(''); setBusy(false);
    const refresh = () => {
      const request = ++sequence.current;
      void desktopCall<DesktopReminderStatus>(bridge, 'calendar-status').then(status => {
        if (own === generation.current && request === sequence.current) {setReport({scope, status}); setError('');}
      }, () => {
        if (own === generation.current && request === sequence.current) setError('无法读取本机提醒状态，请重试。');
      });
    };
    refresh(); const timer = setInterval(refresh, 5_000); window.addEventListener('focus', refresh);
    return () => {generation.current++; clearInterval(timer); window.removeEventListener('focus', refresh);};
  }, [bridge, scope]);
  async function retry() {
    const own = generation.current, request = ++sequence.current; setBusy(true); setError('');
    try {
      const status = await desktopCall<DesktopReminderStatus>(bridge, 'calendar-retry');
      if (own === generation.current && request === sequence.current) {setReport({scope, status}); setError('');}
    } catch {
      if (own === generation.current && request === sequence.current) setError('日程提醒重试未完成，请检查系统通知设置后重试。');
    } finally {if (own === generation.current) setBusy(false);}
  }
  const status=report?.scope===scope?report.status:undefined;
  const labels={idle:'提醒服务尚未绑定账户',rebuilding:'正在核对本机日程提醒',scheduled:`已安排 ${status?.pending??0} 条未来提醒`,disabled:'日程模块已关闭，提醒已停止',failed:'日程提醒需要检查',stopped:'当前账户提醒已停止'};
  return <section className="wb-preview-item" style={{marginTop:24}} aria-label="桌面日程提醒">
    <h2>桌面日程提醒</h2>
    <p role="status">{status?labels[status.state]:'正在读取提醒状态…'}</p>
    <p>仅为已保存或已同步到本机的日程安排未来 30 天提醒。默认提前 10 分钟，具体时间使用日程设置。</p>
    <p>保留在托盘运行时继续提醒；完全退出后停止提醒。重新打开或从睡眠恢复时重建，已过期的提醒不补发。</p>
    <p>{status?.permission==='unavailable'?'此设备的系统通知目前不可用。':'通知许可无法由应用确认，请在系统设置中允许本应用通知。'}系统勿扰或专注模式可能影响显示。</p>
    {status?.delivery==='submitted'&&<p>最近通知已交给系统，尚未收到显示确认。</p>}
    {status?.delivery==='shown'&&<p>最近通知：系统报告已显示；这不代表你已看到通知。</p>}
    {(error||status?.error)&&<p role="alert">{error||status?.error}</p>}
    <button disabled={busy} onClick={()=>void retry()}>{busy?'正在重试…':'核对并重试提醒'}</button>
    <p>失败提醒仅在触发后 1 分钟内可重试，超过后不会补发。</p>
  </section>;
}
