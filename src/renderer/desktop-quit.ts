type QuitBridge = {
  onQuitRequest(callback:(token:string)=>Promise<number>):()=>void;
  onQuitCancelled(callback:(token:string)=>void):()=>void;
};
/** The root owns IPC listeners; mounted learning views supply only their save lock. */
export function createDesktopQuitRouter() {
  const requests=new Set<(token:string)=>Promise<number>>(),cancellations=new Set<(token:string)=>void>();
  let uninstall=()=>{};
  return {
    install(bridge:QuitBridge,beforeQuit:()=>Promise<void>,generation:()=>Promise<number>) {
      uninstall();
      const stopRequest=bridge.onQuitRequest(async token=>{
        await beforeQuit();
        const current=[...requests].at(-1);
        return current?current(token):generation();
      });
      const stopCancelled=bridge.onQuitCancelled(token=>{for(const cancel of cancellations)cancel(token);});
      uninstall=()=>{stopRequest();stopCancelled();};return uninstall;
    },
    onQuitRequest(callback:(token:string)=>Promise<number>) {requests.add(callback);return()=>{requests.delete(callback);};},
    onQuitCancelled(callback:(token:string)=>void) {cancellations.add(callback);return()=>{cancellations.delete(callback);};},
  };
}
export const desktopQuit=createDesktopQuitRouter();
