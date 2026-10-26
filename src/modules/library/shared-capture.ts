import type {ModuleContext} from '../../workbench/contracts/module';
import type {IncomingShare} from '../../workbench/contracts/platform';
import {deterministicId} from '../../workbench/storage/repository';
import {parseCaptureJob,publicSourceUrl} from './model';
const DAY=24*60*60*1000;
type Binding={assetId:string;operationId:string;inputToken?:string;expiresAt:number;submitted:boolean;jobId?:string};
type Bindings=Record<string,Binding>;
/** Only opaque tokens/receipt bindings enter the native credential store. Full URLs go to protected capture input. */
export class SharedCaptureHandoff {
 private key:string;
 constructor(private context:ModuleContext,private ensure:()=>void){this.key=`library:shared-capture:v1:${context.deviceId}`;}
 private async load():Promise<Bindings>{this.ensure();const raw=await this.context.platform.credentials.get(this.key);this.ensure();if(raw===null)return {};try{const value=JSON.parse(raw) as Bindings;if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(item=>!item||typeof item.assetId!=='string'||typeof item.operationId!=='string'||!Number.isFinite(item.expiresAt)||typeof item.submitted!=='boolean'))throw Error();return value;}catch{throw Error('分享获取状态需要检查，请保留收件并重新读取');}}
 private async save(bindings:Bindings){this.ensure();await this.context.platform.credentials.set(this.key,Object.keys(bindings).length?JSON.stringify(bindings):null);this.ensure();}
 async maintain(){const bindings=await this.load();if(!Object.keys(bindings).length)return;let changed=false;const jobs=await this.context.repository.list('library');this.ensure();for(const [key,item] of Object.entries(bindings)){if(item.expiresAt<=Date.now()){delete bindings[key];changed=true;continue;}if(item.inputToken&&item.jobId){const job=jobs.find(job=>job.id===item.jobId&&job.kind==='library.capture-job'&&job.schemaVersion===1);if(job){const state=parseCaptureJob(job.payload).state;if(['saved','failed','cancelled','unsupported','needs-permission','needs-selection'].includes(state)){delete item.inputToken;changed=true;}}}}if(changed)await this.save(bindings);}
 async submit(share:IncomingShare,assetId:string,rawUrl:string){
  const resources=this.context.platform.resources;
  if(!resources)throw Error('资料目录已保存在本机，网址尚未获取。连接自己的服务后，请重试这份收件');
  const bindings=await this.load();
  let changed=false;for(const [key,item] of Object.entries(bindings))if(item.expiresAt<=Date.now()){delete bindings[key];changed=true;}
  if(changed)await this.save(bindings);
  const received=share.receivedAt?Date.parse(share.receivedAt):Date.now();
  if(!Number.isFinite(received)||received+DAY<=Date.now())throw Error('获取网址的授权已超过 24 小时，请重新分享；本机资料目录仍保留');
  const key=deterministicId(`share-input:${share.deliveryId}:${assetId}`);
  let binding=bindings[key];
  if(binding?.submitted)return;
  try{
   if(!binding){const input=await resources.capture.input({url:rawUrl});this.ensure();const expiresAt=Math.min(received+DAY,Date.now()+DAY,input.expiresAt?Date.parse(input.expiresAt):Infinity);if(!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw Error('INPUT_EXPIRED');binding={assetId,operationId:deterministicId(`share-capture:${share.deliveryId}:${assetId}:${input.inputToken}`),inputToken:input.inputToken,expiresAt,submitted:false};bindings[key]=binding;await this.save(bindings);}
   const job=await resources.capture.start({operationId:binding.operationId,assetId,publicSourceUrl:publicSourceUrl(rawUrl),...(binding.inputToken?{inputToken:binding.inputToken}:{})});this.ensure();
   binding.submitted=true;binding.jobId=job.id;if(['saved','failed','cancelled','unsupported','needs-permission','needs-selection'].includes(job.payload.state))delete binding.inputToken;
   await this.save(bindings);
  }catch(cause){this.ensure();const code=(cause as {code?:string})?.code;const message=cause instanceof Error?cause.message:'';if(code==='INPUT_EXPIRED'||message==='INPUT_EXPIRED'){delete bindings[key];await this.save(bindings);throw Error('获取网址的授权已过期，请重新分享；本机资料目录仍保留');}throw Error('资料目录已保存在本机，网址尚未完成获取。收件已保留，请连接服务后重试；重复确认不会重复入库');}
 }
}
