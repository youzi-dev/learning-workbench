// @vitest-environment jsdom
import {Blob as NodeBlob} from 'node:buffer';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {IDBFactory} from 'fake-indexeddb';
import {openRepository} from '../../src/platforms/browser/repository';
import {BrowserFileStorage} from '../../src/platforms/browser/file-storage';
import {catalog} from '../../src/workbench/catalog-ui';
import {catalogSchemas} from '../../src/workbench/catalog';
import {createHost} from '../../src/workbench/host';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {createResourceManager} from '../../src/workbench/files/manager';
import {FileCache} from '../../src/workbench/files/cache';
import {sha256} from '../../src/workbench/files/storage';
import {AssetReader} from '../../src/modules/library/reader';
import {LibraryWorkflow} from '../../src/modules/library/workflow';
import {androidResources} from '../../src/platforms/android/resources';
import type {ModuleContext} from '../../src/workbench/contracts/module';
const cleanups:(()=>unknown)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();vi.unstubAllGlobals();});
async function setup(){
 vi.stubGlobal('Blob',NodeBlob);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const indexedDB=new IDBFactory(),repo=await openRepository('ui',{indexedDB,schemas:catalogSchemas}),storage=await BrowserFileStorage.open({indexedDB});cleanups.push(()=>repo.close(),()=>storage.close());
 const source={async import(){return [];},async stage(ref:any){return ref;},async read(){throw Error('unused');}};
 let releases=0,exports=0;
 const manager=createResourceManager({accountId:'ui',signal:new AbortController().signal,storage,source,preview:async()=>({url:'blob:safe',async release(){releases++;}}),exportFile:async()=>{exports++;}});
 let context!:ModuleContext;
 const registrations=catalog.filter(item=>['journal','library'].includes(item.manifest.id)).map(item=>item.manifest.id==='library'?{...item,async load(){const module=await item.load(),start=module.start;module.start=async(next,signal)=>{context=next;await start(next,signal);};return module;}}:item);
 const host=createHost(registrations,{...createBrowserPorts(source),resources:manager},{repository:repo});await host.start();cleanups.push(()=>host.stop());
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);cleanups.push(async()=>{await act(async()=>root.unmount());container.remove();});
 return {host,repo,storage,manager,context,container,root,releases:()=>releases,exports:()=>exports};
}
async function until(check:()=>boolean){for(let index=0;index<80;index++){if(check())return;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});}throw Error('UI not ready');}
const button=(container:HTMLElement,text:string)=>Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent===text)!;
async function input(element:HTMLInputElement|HTMLTextAreaElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')!.set!.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));});}
async function save(root:HTMLElement){await act(async()=>{(root.querySelector('form[aria-label="编辑记录"]')??root.querySelector('form'))!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,20));});}
it('I7 journal picker creates/removes stable refs through real commands, preserves on edit, and guards unsaved attachment changes',async()=>{
 const d=await setup(),id=crypto.randomUUID();await d.host.invoke('library','save',{id,asset:{title:'已有课程资料',publicSourceUrl:'https://example.org/course',source:'example.org',acquiredAt:null,mime:null,size:null,sha256:null,purpose:'学习',tags:[],availability:'link-only'}});
 await act(async()=>d.root.render(d.host.render('journal','home')));
 await input(d.container.querySelector('textarea')!,'今天读了课程资料');await act(async()=>button(d.container,'关联已有资料').click());await until(()=>!!d.container.querySelector('input[type=checkbox]'));
 await act(async()=>d.container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
 await expect(d.host.prepareLeave()).rejects.toThrow('记录尚未保存');await save(d.container);
 let entries=await d.host.invoke('journal','list',{}) as any[];expect(entries[0].payload.attachments).toEqual([{moduleId:'library',entityId:id}]);expect(JSON.stringify(entries)).not.toContain('fileContents');
 await act(async()=>button(d.container,'编辑').click());await save(d.container);entries=await d.host.invoke('journal','list',{}) as any[];expect(entries[0].payload.attachments).toHaveLength(1);
 await act(async()=>button(d.container,'编辑').click());await act(async()=>button(d.container,'移除关联').click());await expect(d.host.prepareLeave()).rejects.toThrow('尚未保存');
 await save(d.container);entries=await d.host.invoke('journal','list',{}) as any[];expect(entries[0].payload.attachments).toEqual([]);await expect(d.host.prepareLeave()).resolves.toBeUndefined();
});
it('I4/I6 actual reader releases preview before local removal and offers export for unsupported EPUB',async()=>{
 const d=await setup(),bytes=new TextEncoder().encode('file bytes'),file={sha256:await sha256(bytes),size:bytes.length,mime:'image/png'},id=crypto.randomUUID();
 await new FileCache(d.storage).put('ui',file,bytes);
 const entry=await d.host.invoke('library','save',{id,asset:{title:'image.png',publicSourceUrl:null,source:'test',acquiredAt:new Date().toISOString(),...file,purpose:'',tags:[],availability:'available'}}) as any;
 const workflow=new LibraryWorkflow(d.context);await act(async()=>d.root.render(<AssetReader entry={entry} workflow={workflow}/>));
 await until(()=>!!button(d.container,'离线保留'));await act(async()=>button(d.container,'离线保留').click());await until(()=>d.container.textContent!.includes('取消离线保留'));expect(d.container.textContent).toContain('取消离线保留');
 await act(async()=>button(d.container,'移除本机下载').click());await until(()=>d.container.textContent!.includes('已移除本机下载'));expect(d.releases()).toBeGreaterThan(0);expect(await d.manager.localForAsset(id,file)).toEqual({state:'missing'});expect((await d.repo.get({moduleId:'library',entityId:id}))?.deletedAt).toBeNull();
 const epub={...file,mime:'application/epub+zip'};await new FileCache(d.storage).put('ui',epub,bytes);
 const epubEntry=await d.host.invoke('library','save',{id:crypto.randomUUID(),asset:{...entry.payload,...epub,title:'book.epub'}}) as any;
 await act(async()=>d.root.render(<AssetReader entry={epubEntry} workflow={workflow}/>));
 await until(()=>d.container.textContent!.includes('EPUB'));expect(d.container.textContent).toContain('EPUB');await act(async()=>button(d.container,'保存文件后用其他应用打开').click());await until(()=>d.exports()===1);expect(d.exports()).toBe(1);
 const bound=d.context.platform.resources!;await act(async()=>d.host.setEnabled('library',false));await expect(bound.exportFile(new FileCache(d.storage).reference('ui',epub),'book.epub')).rejects.toThrow('停用');
});
it('I6 Android export uses opaque bounded storage keys and revokes chooser ownership on abort',async()=>{
 const calls:string[]=[],controller=new AbortController();let complete!:()=>void;
 const bridge={async filePrepareExport(input:any){expect(input.keys).toEqual(['stage:owned/part/0']);calls.push('prepare');return {token:'opaque-export'};},async fileExport(input:any){expect(input).toMatchObject({token:'opaque-export',name:'book.epub',mime:'application/epub+zip'});calls.push('save');await new Promise<void>(resolve=>{complete=resolve;});},async fileReleaseExport(){calls.push('release');}};
 const resources=androidResources(bridge as any),pending=resources.exportFile!({accountId:'account',keys:['stage:owned/part/0'],size:100,mime:'application/epub+zip',name:'book.epub',signal:controller.signal});
 await new Promise(resolve=>setTimeout(resolve,0));controller.abort();complete();await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(calls).toEqual(['prepare','save','release','release']);
});
