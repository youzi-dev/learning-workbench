import {expect,it} from 'vitest';
import {createQuitCoordinator} from '../src/node/quit-coordinator';
import {createDesktopDocumentController} from '../src/renderer/desktop-document';
import {emptyBrowserDocument} from '../src/core/browser-state';
import {createDesktopQuitRouter} from '../src/renderer/desktop-quit';

it('leaving_learning_keeps_a_root_quit_listener_and_waits_for_saved_drafts',async()=>{
 let document=emptyBrowserDocument(),generation=2,revision=0,mutationRevision=0;
 let release!:()=>void;const saveGate=new Promise<void>(resolve=>{release=resolve;});
 const controller=createDesktopDocumentController({async load(){return{document,generation,revision,mutationRevision};},async save(input){await saveGate;document=input.document;mutationRevision=input.mutationRevision;revision++;return{document,generation,revision,mutationRevision};},async exportBackup(){throw Error('unused');},async importBackup(){return null;}});
 await controller.start();const write=controller.change(doc=>({...doc,drafts:{...doc.drafts,messages:{...doc.drafts.messages,test:'需要保留的草稿'}}}));
 let request:((token:string)=>Promise<number>)|undefined,cancel:((token:string)=>void)|undefined,leaves=0;
 const router=createDesktopQuitRouter();router.install({onQuitRequest(callback){request=callback;return()=>{request=undefined;};},onQuitCancelled(callback){cancel=callback;return()=>{cancel=undefined;};}},async()=>{leaves++;},async()=>generation);
 const detach=router.onQuitRequest(async token=>{await controller.prepareQuit(token);return controller.snapshot().generation;});const detachCancel=router.onQuitCancelled(token=>controller.cancelQuit(token));
 // Navigation's real leave operation flushes before closing the controller.
 const leaving=controller.flush().then(()=>{detach();detachCancel();controller.close();});let left=false;void leaving.then(()=>{left=true;});await Promise.resolve();expect(left).toBe(false);release();await write;await leaving;expect(document.drafts.messages.test).toBe('需要保留的草稿');
 const events:string[]=[];let coordinator:ReturnType<typeof createQuitCoordinator>;
 coordinator=createQuitCoordinator({requestFlush:async token=>{const acknowledged=await request!(token);expect(acknowledged).toBe(2);coordinator.acknowledge(token);},flush:async()=>{events.push('flushed');},confirmDiscard:async()=>{events.push('discard-dialog');return false;},finish:()=>{events.push('quit');},release:token=>cancel?.(token),timeoutMs:25});
 await coordinator.request();expect(leaves).toBe(1);expect(events).toEqual(['flushed','quit']);
});
it('a_dirty_module_blocks_quit_before_learning_ack_and_can_retry_after_cancel',async()=>{
 let request!: (token:string)=>Promise<number>,cancel!:(token:string)=>void,dirty=true,prepared=0,cancelled='';
 const router=createDesktopQuitRouter();router.install({onQuitRequest(callback){request=callback;return()=>{};},onQuitCancelled(callback){cancel=callback;return()=>{};}},async()=>{if(dirty)throw Error('项目代码尚未保存');},async()=>9);
 router.onQuitRequest(async()=>{prepared++;return 9;});router.onQuitCancelled(token=>{cancelled=token;});
 await expect(request('dirty-quit')).rejects.toThrow('项目代码尚未保存');expect(prepared).toBe(0);cancel('dirty-quit');expect(cancelled).toBe('dirty-quit');dirty=false;expect(await request('safe-quit')).toBe(9);expect(prepared).toBe(1);
});
it('mounted_learning_uses_one_ack_and_cancelled_native_flush_releases_the_real_controller_lock',async()=>{
 let document=emptyBrowserDocument(),revision=0;
 const controller=createDesktopDocumentController({async load(){return{document,generation:4,revision,mutationRevision:0};},async save(input){document=input.document;return{...input,revision:++revision};},async exportBackup(){return true;},async importBackup(){return null;}});await controller.start();
 let request!: (token:string)=>Promise<number>,cancel!:(token:string)=>void,registrations=0,prepared=0,fallback=0,failFlush=true;const events:string[]=[];
 const router=createDesktopQuitRouter();router.install({onQuitRequest(callback){registrations++;request=callback;return()=>{};},onQuitCancelled(callback){cancel=callback;return()=>{};}},async()=>controller.flush(),async()=>{fallback++;return 4;});
 router.onQuitRequest(async token=>{prepared++;await controller.prepareQuit(token);return controller.snapshot().generation;});router.onQuitCancelled(token=>controller.cancelQuit(token));
 const coordinator=createQuitCoordinator({requestFlush:async token=>{const generation=await request(token);expect(generation).toBe(4);coordinator.acknowledge(token);},flush:async()=>{if(failFlush)throw Error('main write failed');},confirmDiscard:async()=>false,finish:()=>{events.push('quit');},release:token=>cancel(token),timeoutMs:25});
 await coordinator.request();expect(registrations).toBe(1);expect(prepared).toBe(1);expect(fallback).toBe(0);expect(controller.snapshot().status).toBe('saved');
 await controller.change(doc=>({...doc,drafts:{...doc.drafts,messages:{afterCancel:'取消后继续编辑'}}}));expect(document.drafts.messages.afterCancel).toBe('取消后继续编辑');failFlush=false;await coordinator.request();expect(prepared).toBe(2);expect(events).toEqual(['quit']);controller.close();
});
