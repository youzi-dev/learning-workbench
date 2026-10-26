import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';
import {lookup as dnsLookup} from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['192.0.2.0',24],['198.51.100.0',24],['203.0.113.0',24],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32]]) denied.addSubnet(address,prefix,'ipv6');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix]of [['2002::',16],['2001::',23],['3fff::',20]])denied.addSubnet(address,prefix,'ipv6');
function publicAddress(address) {
 const family=isIP(address); if(!family||family===6&&!globalV6.check(address,'ipv6'))return false;
 return !denied.check(address, family===4?'ipv4':'ipv6');
}
export function validateCloudBase(input) {
 if(typeof input!=='string'||!input||input.length>2048||/[\s\0]/.test(input))throw Error('INVALID_CLOUD_BASE');
 let url;try{url=new URL(input);}catch{throw Error('INVALID_CLOUD_BASE');}
 const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!host.includes('.')&&!isIP(host)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)||isIP(host)&&!publicAddress(host))throw Error('INVALID_CLOUD_BASE');
 return url.origin;
}
async function privateJson(path) {
 if(!path)throw Error('PRIVATE_EVIDENCE_REQUIRED');const absolute=resolve(path);let current=absolute;
 for(;;){const s=await lstat(current);if(s.isSymbolicLink()||current===absolute&&(!s.isFile()||s.uid!==process.getuid?.()||s.mode&0o077||s.size>16384))throw Error('UNSAFE_EVIDENCE_FILE');const parent=dirname(current);if(parent===current)break;current=parent;}
 const fd=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await fd.stat();if(!s.isFile()||s.uid!==process.getuid?.()||s.mode&0o077||s.size>16384)throw Error('UNSAFE_EVIDENCE_FILE');const raw=await fd.readFile('utf8');if(Buffer.byteLength(raw)>16384)throw Error('UNSAFE_EVIDENCE_FILE');return JSON.parse(raw);}finally{await fd.close();}
}
export async function readCloudCredential(path) {
 const value=await privateJson(path);if(!value||typeof value!=='object'||! /^[A-Za-z0-9_-]{43}$/.test(value.token??'')||Object.keys(value).some(k=>!['token','accountId','deviceId'].includes(k)))throw Error('INVALID_DEVICE_CREDENTIAL');return value.token;
}
function blobDescriptor(value) {
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['sha256','size','mime'].includes(k))||! /^[a-f0-9]{64}$/.test(value.sha256??'')||!Number.isSafeInteger(value.size)||value.size<0||value.size>1073741824||typeof value.mime!=='string'||!value.mime||value.mime.length>255)throw Error('INVALID_BLOB_EVIDENCE');return value;
}
async function bytes(response, maximum, hash) {
 if(Number(response.headers.get('content-length')??0)>maximum){await response.body?.cancel();throw Error('BODY_LIMIT');}
 const reader=response.body?.getReader();if(!reader)return hash?0:Buffer.alloc(0);
 let count=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>maximum)throw Error('BODY_LIMIT');if(hash)hash.update(value);else chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 return hash?count:Buffer.concat(chunks);
}
/** GET requests only. Injection is a test transport seam, never a CLI TLS/private-address bypass. */
export async function verifyCloud(options, transport={}) {
 const checks={dns:'not-checked',health:'not-checked',authenticatedPull:'not-checked',unauthenticatedPull:'not-checked',unauthenticatedBlob:'not-checked',privateBroker:'not-checked',knownBlob:'not-checked'};
 const result={scope:'endpoint-smoke-only',status:'incomplete',checks,doesNotProve:['PC-off','reboot-persistence','device-installation','cloud-backup-restoration']};
 try {
  const base=validateCloudBase(options.base);
  if(! /^[A-Za-z0-9_-]{43}$/.test(options.token??''))throw Error('INVALID_DEVICE_CREDENTIAL');
  const host=new URL(base).hostname.replace(/^\[|\]$/g,'');
  let addresses,dnsTimer;
  try{addresses=isIP(host)?[{address:host}]:await Promise.race([(transport.lookup??dnsLookup)(host,{all:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('DNS_TIMEOUT')),5000);})]);}finally{if(dnsTimer)clearTimeout(dnsTimer);}
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw Error('NONPUBLIC_DNS');checks.dns='passed';
  const get=async(path,authenticated,status,maximum=524288,asBlob)=>{
   const response=await (transport.fetch??fetch)(base+path,{method:'GET',redirect:'error',headers:authenticated?{authorization:`Bearer ${options.token}`}:{},signal:AbortSignal.timeout(asBlob?120000:10000)});
   if(response.status!==status){await response.body?.cancel();throw Error('HTTP_CHECK_FAILED');}
   if(asBlob){const hash=createHash('sha256');const size=await bytes(response,maximum,hash);if(size!==asBlob.size||hash.digest('hex')!==asBlob.sha256)throw Error('BLOB_MISMATCH');return;}
   const raw=await bytes(response,maximum);if(status!==200||!raw.length)return null;try{return JSON.parse(raw.toString());}catch{throw Error('INVALID_RESPONSE');}
  };
  const health=await get('/healthz',false,200,4096);if(!health||health.status!=='ready'||Object.keys(health).length!==1)throw Error('NOT_READY');checks.health='passed';
  const page=await get('/v1/sync/pull?cursor=0&limit=1',true,200);
  if(!page||!Array.isArray(page.changes)||page.changes.length>1||!Number.isSafeInteger(page.nextCursor)||page.nextCursor<0||typeof page.hasMore!=='boolean'||page.changes.some(c=>!c||!Number.isSafeInteger(c.cursor)||c.cursor<1||typeof c.batchId!=='string'||!Array.isArray(c.entities))||page.nextCursor!==(page.changes.at(-1)?.cursor??0))throw Error('INVALID_PULL_STRUCTURE');checks.authenticatedPull='passed';
  await get('/v1/sync/pull?cursor=0&limit=1',false,401,4096);checks.unauthenticatedPull='passed';
  await get(`/v1/blobs/${'0'.repeat(64)}`,false,401,4096);checks.unauthenticatedBlob='passed';
  await get('/ready',false,404,4096);checks.privateBroker='passed';
  if(options.blob){const blob=blobDescriptor(options.blob);await get(`/v1/blobs/${blob.sha256}`,false,401,4096);await get(`/v1/blobs/${blob.sha256}`,true,200,blob.size,blob);checks.knownBlob='passed';}
  result.status='endpoint-smoke-passed';
 }catch{result.errorCode='ENDPOINT_SMOKE_INCOMPLETE_OR_FAILED';}
 return result;
}
export async function runCloudCli(args, output=console.log) {
 try {
  const flags={};for(let i=0;i<args.length;i+=2){if(!['--base','--credential','--blob-evidence'].includes(args[i])||!args[i+1]||Object.hasOwn(flags,args[i]))throw Error('INVALID_ARGUMENT');flags[args[i]]=args[i+1];}
  if(!flags['--base']||!flags['--credential'])throw Error('CLOUD_INPUTS_REQUIRED');
  const result=await verifyCloud({base:flags['--base'],token:await readCloudCredential(flags['--credential']),...(flags['--blob-evidence']?{blob:blobDescriptor(await privateJson(flags['--blob-evidence']))}:{})});output(JSON.stringify(result));return result.status==='endpoint-smoke-passed'?0:1;
 }catch{output(JSON.stringify({scope:'endpoint-smoke-only',status:'incomplete',errorCode:'CLOUD_CONFIGURATION_INCOMPLETE_OR_INVALID'}));return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await runCloudCli(process.argv.slice(2));
