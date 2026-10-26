import type {RuntimeHooks} from '../../workbench/runtime';
import type {RepositoryHandle} from './session';
import {desktopCall, type ElectronWorkbenchBridge} from './ports';
/** Calendar attachment composes, rather than replaces, the existing learning lifecycle. */
export function desktopCalendarHooks(bridge: ElectronWorkbenchBridge, handles: WeakMap<object, Pick<RepositoryHandle,'handle'> & {accountId:string}>, previous: RuntimeHooks): RuntimeHooks {
  return {...previous,
    async activate(profile,repository) {
      await previous.activate?.(profile,repository);
      const descriptor=handles.get(repository);
      if(!descriptor)throw Error('提醒账户缺少本机句柄');
      if(descriptor.accountId!==(profile?.accountId??'local-device')){await desktopCall(bridge,'calendar-stop',[descriptor.accountId]);return;}
      await desktopCall(bridge,'calendar-bind',[descriptor.handle]);
    },
    async deactivate(accountId) {
      try {await desktopCall(bridge,'calendar-stop',[accountId]);} finally {await previous.deactivate?.(accountId);}
    },
  };
}
