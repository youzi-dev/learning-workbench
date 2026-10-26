import type {IncomingShare, SharePort} from '../../workbench/contracts/platform';
import type {LocalReceipt} from '../../workbench/contracts/data';
import type {AndroidBridge} from './bridge';
export function createAndroidShares(bridge:AndroidBridge):SharePort & {ignored():Promise<IncomingShare[]>;dismiss(accountId:string,deliveryId:string):Promise<void>;restore(accountId:string,deliveryId:string):Promise<void>;confirm(accountId:string,share:IncomingShare,ingest:(share:IncomingShare)=>Promise<LocalReceipt>):Promise<LocalReceipt>} {
 return {pending:async()=>(await bridge.inboxPending()).deliveries,ignored:async()=>(await bridge.inboxPending({includeIgnored:true})).deliveries.filter(item=>item.dismissed),dismiss:(accountId,deliveryId)=>bridge.inboxDismiss({accountId,deliveryId}),restore:(accountId,deliveryId)=>bridge.inboxRestore({accountId,deliveryId}),async acknowledge(){throw Error('请先确认接收账户，再保存分享');},async confirm(accountId,share,ingest){
  if(share.status==='needs-reshare'||share.status==='copying')throw Error(share.message??'文件授权已失效，请重新分享');
  const claim=await bridge.inboxClaim({deliveryId:share.deliveryId,accountId});
  if(claim.accountId!==accountId)throw Error('这份分享已绑定其他账户，请切换到原账户处理');
  const receipt=await ingest(share);
  await bridge.inboxAcknowledge({deliveryId:share.deliveryId,accountId});
  return receipt;
 }};
}
