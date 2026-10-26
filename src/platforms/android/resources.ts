import type {FilePort} from '../../workbench/contracts/files';
import type {ResourceManagerOptions} from '../../workbench/files/manager';
import type {DurableFileStorage} from '../../workbench/files/storage';
import type {AndroidBridge} from './bridge';
export function encodeBytes(bytes:Uint8Array):string {let value='';for(let offset=0;offset<bytes.length;offset+=8192)value+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(value);}
export function decodeBytes(value:string):Uint8Array {return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
export function androidResources(bridge:AndroidBridge):Pick<ResourceManagerOptions,'source'|'storage'|'preview'|'exportFile'|'protectedInputs'> & {saveBackup(bytes:Uint8Array,name:string):Promise<void>} {
 const source:FilePort={import:async()=>(await bridge.filePick()).files,stage:async ref=>ref,read:async(ref,offset,length)=>decodeBytes((await bridge.fileRead({token:ref.token,offset,length})).data)};
 const storage:DurableFileStorage={async read(accountId,key){const {data}=await bridge.storageRead({accountId,key});return data===null?null:decodeBytes(data);},async size(accountId,key){return (await bridge.storageSize({accountId,key})).size;},async readRange(accountId,key,offset,length){const {data}=await bridge.storageRead({accountId,key,offset,length});return data===null?null:decodeBytes(data);},write:(accountId,key,bytes)=>bridge.storageWrite({accountId,key,data:encodeBytes(bytes)}),remove:(accountId,key)=>bridge.storageRemove({accountId,key})};
 return {source,storage,protectedInputs:{
 async put(accountId,id,raw,expiresAt){await bridge.captureInput({operation:'put',accountId,id,raw,expiresAt});},
 async get(accountId,id){return (await bridge.captureInput({operation:'get',accountId,id})).value;},
 async remove(accountId,id){await bridge.captureInput({operation:'remove',accountId,id});}
 },
 async exportFile(input) {
   input.signal.throwIfAborted();
   const {token} = await bridge.filePrepareExport({accountId:input.accountId,keys:input.keys,size:input.size,mime:input.mime});
   const release = () => {void bridge.fileReleaseExport({token});};
   input.signal.addEventListener('abort',release,{once:true});
   try {input.signal.throwIfAborted(); await bridge.fileExport({token,name:input.name,mime:input.mime}); input.signal.throwIfAborted();}
   finally {input.signal.removeEventListener('abort',release); await bridge.fileReleaseExport({token});}
 },saveBackup:(bytes,name)=>bridge.fileSaveBackup({name,data:encodeBytes(bytes)}),async preview(input){input.signal.throwIfAborted();const result=await bridge.filePreview({accountId:input.accountId,keys:input.keys,size:input.size,mime:input.mime});const release=()=>bridge.fileReleasePreview({token:result.token});if(input.signal.aborted){await release();input.signal.throwIfAborted();}return {url:result.url,release};}};
}
