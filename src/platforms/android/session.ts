import type {ConnectionProfile,RuntimeConnection} from '../../workbench/runtime';
import {parseProfile,blobUrl} from '../browser/session';
import {createHttpTransport,pairDevice,TransportError} from '../../workbench/sync/transport';
import {createAndroidCredentials} from './credentials';
import type {AndroidBridge} from './bridge';
export function createAndroidConnection(bridge:AndroidBridge):RuntimeConnection {
 const credentials=createAndroidCredentials(bridge);let current:ConnectionProfile|null=null;
 const key=(profile:ConnectionProfile)=>JSON.stringify([profile.baseUrl,profile.accountId]);
 return {async loadProfile(){const {value}=await bridge.metadataGet({key:'connection'});current=value===null?null:parseProfile(JSON.parse(value));return current;},async saveProfile(profile){current=profile?parseProfile(profile):null;await bridge.metadataSet({key:'connection',value:current?JSON.stringify(current):null});},async pair(input,deviceId){const result=await pairDevice(input.baseUrl,input.code,input.name,deviceId,fetch,input.recover);const profile=parseProfile({...result,baseUrl:input.baseUrl});await credentials.set(key(profile),result.token);return profile;},transport:profile=>createHttpTransport({baseUrl:profile.baseUrl,token:()=>credentials.get(key(profile)),fetch}),async clearCredential(accountId){if(current?.accountId===accountId)await credentials.set(key(current),null);},async authorizedFetch(profile,path,init={}){const token=await credentials.get(key(profile));if(!token)throw new TransportError('UNAUTHORIZED');const headers=new Headers(init.headers);headers.set('authorization',`Bearer ${token}`);return fetch(blobUrl(profile,path),{...init,headers,redirect:'error',credentials:'omit',cache:'no-store',signal:init.signal??AbortSignal.timeout(30000)});}};
}
