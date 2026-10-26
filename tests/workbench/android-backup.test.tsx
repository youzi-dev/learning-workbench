// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {createWorkbenchRuntime} from '../../src/workbench/runtime';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {openRepository} from '../../src/platforms/browser/repository';
import {BrowserFileStorage} from '../../src/platforms/browser/file-storage';
import {WorkbenchApplication} from '../../src/workbench/ui/application';
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const cleanups:(()=>unknown)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function setup(){const factory=new IDBFactory();const storage=await BrowserFileStorage.open({indexedDB:factory});cleanups.push(()=>storage.close());const saved:{bytes:Uint8Array;name:string}[]=[];const ports=createBrowserPorts();const runtime=await createWorkbenchRuntime({registrations:[],ports,autoSync:false,open:account=>openRepository(account,{indexedDB:factory}),resources:{storage,source:ports.files,async saveBackup(bytes,name){saved.push({bytes:new Uint8Array(bytes),name});}},connection:{async loadProfile(){return null;},async saveProfile(){},async pair(){throw Error('not used');},transport(){throw Error('not used');},async clearCredential(){},async authorizedFetch(){throw Error('not used');}}});cleanups.push(()=>runtime.stop());return {runtime,saved};}
it('native_backup_save_is_bound_to_the_exporting_account_scope',async()=>{const {runtime,saved}=await setup();const save=runtime.snapshot().saveBackup;expect(save).toBeTypeOf('function');await save!(new Uint8Array([1,2]),'first.json');expect(saved).toEqual([{bytes:new Uint8Array([1,2]),name:'first.json'}]);await runtime.session.switchAccount('next-account');await expect(save!(new Uint8Array([3]),'stale.json')).rejects.toMatchObject({code:'scope-changed'});expect(saved).toHaveLength(1);});
it('shared_account_backup_button_uses_platform_save_instead_of_blob_download',async()=>{const {runtime,saved}=await setup();const container=document.createElement('div');document.body.append(container);const root=createRoot(container);cleanups.push(async()=>{await act(async()=>root.unmount());container.remove();});await act(async()=>root.render(<WorkbenchApplication runtime={runtime}/>));const account=container.querySelector<HTMLButtonElement>('[aria-label="账户与同步"]');expect(account).not.toBeNull();await act(async()=>account!.click());const button=[...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='导出备份');expect(button).toBeDefined();await act(async()=>{button!.click();await new Promise(resolve=>setTimeout(resolve,10));});expect(saved).toHaveLength(1);expect(saved[0].name).toMatch(/^workbench-\d{4}-\d\d-\d\d\.json$/);expect(JSON.parse(new TextDecoder().decode(saved[0].bytes))).toMatchObject({schemaVersion:2});});
