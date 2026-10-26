import type {CredentialPort} from '../../workbench/contracts/platform';
import type {AndroidBridge} from './bridge';
export function createAndroidCredentials(bridge:AndroidBridge):CredentialPort {return {get:async key=>(await bridge.credentialGet({key})).value,set:(key,value)=>bridge.credentialSet({key,value})};}
