import React from 'react';
import {createRoot} from 'react-dom/client';
import {desktopQuit} from './desktop-quit';
import type {WorkbenchRuntime} from '../workbench/runtime';
import {catalog} from '../workbench/catalog-ui';
import {createWorkbenchRuntime} from '../workbench/runtime';
import {electronResources} from '../platforms/electron/resources';
import type {RepositoryHandle} from '../platforms/electron/session';
import {DesktopWorkbenchApplication} from '../platforms/electron/reminder-status';
import {desktopCalendarHooks} from '../platforms/electron/reminder-hooks';
import {createElectronPorts, electronRepository, electronModuleSettings, electronConnection, desktopCall} from '../platforms/electron/ports';

// The original learning UI is preserved in legacy-app.tsx for its record-level adapter.
const workbenchRoot = createRoot(document.getElementById('root')!);
async function bootWorkbench() {
  workbenchRoot.render(<div className="wb-empty"><h1>日常工作台</h1><p role="status">正在读取本机空间…</p></div>);
  try {
    let activeRuntime:WorkbenchRuntime|undefined;
    desktopQuit.install(window.workbench,async()=>{if(!activeRuntime)throw Error('工作台尚未就绪，请稍后退出');await activeRuntime.snapshot().host.prepareLeave();},async()=>(await window.workbench.load()).generation);
    const repositoryHandles = new WeakMap<object, RepositoryHandle & {accountId: string}>();
    const desktopCatalog = catalog.map(registration => registration.manifest.id === 'learning' ? {...registration, load: async () => (await import('../modules/learning/desktop-page')).createModule()} : registration);
    await desktopCall(window.workbenchV2, 'initialize');
    const resources = electronResources(window.workbenchV2);
    const runtime = await createWorkbenchRuntime({
      registrations: desktopCatalog,
      ports: createElectronPorts(resources.source,window.workbenchV2),
      resources,
      settings: electronModuleSettings(window.workbenchV2),
      connection: electronConnection(window.workbenchV2),
      hooks: desktopCalendarHooks(window.workbenchV2,repositoryHandles,{async activate(_profile, repository) {const handle=repositoryHandles.get(repository);if(!handle)throw Error('学习账户缺少本机句柄');if(handle.accountId!==(_profile?.accountId??'local-device')){await desktopCall(window.workbenchV2,'learning-stop');return;}await desktopCall(window.workbenchV2,'learning-bind',[handle.handle]);},async deactivate(){await desktopCall(window.workbenchV2,'learning-stop');}}),
      async open(accountId, deviceId) {
        const descriptor = await desktopCall<RepositoryHandle>(window.workbenchV2, 'open-profile', [accountId, deviceId]);
        const repository = electronRepository(window.workbenchV2, descriptor); repositoryHandles.set(repository, {...descriptor, accountId}); return repository;
      },
    });
    activeRuntime=runtime;
    workbenchRoot.render(<DesktopWorkbenchApplication runtime={runtime} bridge={window.workbenchV2}/>);
  } catch (cause) {workbenchRoot.render(<main className="wb-shell"><section className="wb-empty"><h1>本机记录需要检查</h1><p role="alert">{cause instanceof Error ? cause.message : String(cause)}</p><p>原学习文件已保留。检查原文件后可重新读取。</p><button onClick={() => void bootWorkbench()}>重新读取</button></section></main>);}
}
void bootWorkbench();
