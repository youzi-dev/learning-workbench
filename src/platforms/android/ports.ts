import type {AndroidBridge} from './bridge';
import type {PlatformPorts} from '../../workbench/contracts/platform';
import type {ModuleSettingsStore} from '../../workbench/host';
import {createAndroidCredentials} from './credentials';
import {createAndroidShares} from './shares';
import {createAndroidNotifications} from './notifications';
import {androidResources} from './resources';
export function createAndroidPorts(bridge:AndroidBridge):PlatformPorts {return {environment:'native',capabilities:new Set(['files','notifications','share-receive']),files:androidResources(bridge).source,credentials:createAndroidCredentials(bridge),shares:createAndroidShares(bridge),notifications:createAndroidNotifications(bridge)};}
export function androidSettings(bridge:AndroidBridge):ModuleSettingsStore {return {async get(id){const {value}=await bridge.metadataGet({key:`module:${id}`});if(value===null)return null;if(value!=='true'&&value!=='false')throw Error('设备模块设置无法读取');return value==='true';},set:(id,enabled)=>bridge.metadataSet({key:`module:${id}`,value:String(enabled)})};}
