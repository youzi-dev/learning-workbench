import {useEffect, useRef} from 'react';
import type {ModuleContext} from '../contracts/module';
/** Keep unfinished forms mounted until their explicit save/cancel action. */
export function useLeaveProtection(register: ModuleContext['registerLeaveGuard'], blocked: boolean, message: string) {
  const latest = useRef({blocked, message}); latest.current = {blocked, message};
  useEffect(() => {
    const unregister = register?.(async () => {if (latest.current.blocked) throw Error(latest.current.message);});
    const beforeUnload = (event: BeforeUnloadEvent) => {if (latest.current.blocked) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', beforeUnload);
    return () => {unregister?.(); window.removeEventListener('beforeunload', beforeUnload);};
  }, [register]);
}
