/** A restore cannot replace conversations while a request is still writing its results. */
export class ModelOperations {
  private active=0;
  private controller=new AbortController();
  signal():AbortSignal {return this.controller.signal;}
  invalidate():void {this.controller.abort(new Error('学习模块或账户已改变'));this.controller=new AbortController();}
  private restoring=false;
  private drained=new Set<()=>void>();
  async drain():Promise<void> {if(!this.active)return;await new Promise<void>(resolve=>this.drained.add(resolve));}
  async run<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.restoring)throw Error('正在恢复备份，请等恢复完成后再调用模型。');
    this.active++;
    try{return await operation();}finally{this.active--;if(!this.active){for(const resolve of this.drained)resolve();this.drained.clear();}}
  }
  async restore<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.active || this.restoring)throw Error('请等当前模型或项目 Agent 操作完成后再恢复备份。');
    this.restoring=true;
    try{return await operation();}finally{this.restoring=false;}
  }
}
/** Native bindings capture a lease; later binds/stops revoke it before publication. */
export class NativeLearningScope {
  private controller=new AbortController();
  get signal():AbortSignal {return this.controller.signal;}
  begin():AbortSignal {this.controller.abort(new Error('学习设备范围已改变'));this.controller=new AbortController();return this.controller.signal;}
  isCurrent(signal:AbortSignal):boolean {return signal===this.controller.signal&&!signal.aborted;}
  abort():void {this.controller.abort(new Error('学习模块或账户已改变'));}
}
