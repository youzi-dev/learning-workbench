import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {DesktopReminderStatusPanel} from '../../src/platforms/electron/reminder-status';
import {createElectronPorts} from '../../src/platforms/electron/ports';
import type {DesktopReminderStatus} from '../../src/platforms/electron/notifications';
const {JSDOM}=createRequire(import.meta.url)('jsdom') as {JSDOM:new(html:string,options:{url:string})=>{window:Window&typeof globalThis}};
afterEach(()=>vi.unstubAllGlobals());
it('native_calendar_status_keeps_permission_unknown_and_retry_recovers_visible_error',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 let status:DesktopReminderStatus={state:'failed',permission:'unknown',delivery:'failed',pending:1,error:'系统未显示通知，请重试',lastRebuiltAt:'2026-10-24T05:49:00Z'};const requests:string[]=[];
 const bridge={async request(operation:string){requests.push(operation);if(operation==='calendar-retry')status={...status,state:'scheduled',error:null,delivery:'shown'};return {ok:true as const,value:status};}};
 const container=dom.window.document.getElementById('root')!,root=createRoot(container);
 try {
  await act(async()=>root.render(<DesktopReminderStatusPanel bridge={bridge} scope={1}/>));
  expect(container.textContent).toContain('系统未显示通知');expect(container.textContent).toContain('通知许可无法由应用确认');expect(container.textContent).toContain('完全退出后停止提醒');expect(container.textContent).toContain('托盘');
  const button=Array.from(container.querySelectorAll('button')).find(item=>item.textContent?.includes('重试'))!;await act(async()=>button.click());expect(requests.filter(item=>item==='calendar-retry')).toHaveLength(1);expect(container.querySelector('[role="alert"]')).toBeNull();expect(container.textContent).toContain('系统报告已显示');
  const ports=createElectronPorts(undefined,bridge);expect(ports.capabilities.has('notifications')).toBe(true);expect(await ports.notifications.permission()).toBe('prompt');
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
it('M1 older status response cannot replace successful retry, latest read clears a prior error',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});vi.stubGlobal('window',dom.window);vi.stubGlobal('document',dom.window.document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const status:DesktopReminderStatus={state:'scheduled',permission:'unknown',delivery:'shown',pending:3,error:null,lastRebuiltAt:'2026-10-24T05:49:00Z'};
 let resolveOld!:(value:unknown)=>void,reads=0;
 const bridge={async request(operation:string){if(operation==='calendar-status'&&++reads===1)return await new Promise<any>(resolve=>{resolveOld=resolve;});return {ok:true as const,value:status};}};
 const container=dom.window.document.getElementById('root')!,root=createRoot(container);
 try{await act(async()=>root.render(<DesktopReminderStatusPanel bridge={bridge} scope={1}/>));await act(async()=>container.querySelector<HTMLButtonElement>('button')!.click());
 expect(container.textContent).toContain('已安排 3 条');await act(async()=>resolveOld({ok:true,value:{...status,state:'failed',error:'过期状态'}}));expect(container.textContent).not.toContain('过期状态');expect(container.textContent).toContain('已安排 3 条');
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
