/** Executable operator integration entry. Builds only a temporary harness. No
 * production /acquire field can select a probe/command or Docker configuration. */
import {build} from 'esbuild';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const exec=promisify(execFile);
const directory=await mkdtemp(join(tmpdir(),'cb-integration-'));
const deploymentId=`probe-${randomUUID().slice(0,8)}`;
const configuredImage=process.env.WORKBENCH_CAPTURE_IMAGE;
if(!configuredImage)throw Error('WORKBENCH_CAPTURE_IMAGE_REQUIRED');
const inspected=JSON.parse((await exec('docker',['image','inspect',configuredImage])).stdout)[0];
const image=inspected.Id,platform=`${inspected.Os}/${inspected.Architecture}`;
let broker,remote,probeRan=false;
async function docker(args,signal){return (await exec('docker',args,{timeout:60000,maxBuffer:1048576,signal})).stdout.trim();}
try {
  await build({stdin:{contents:"export {CaptureBroker} from './server/capture/broker';export {IsolatedCaptureRuntime} from './server/capture/docker-runtime';export {RemoteCaptureRuntime} from './server/capture/remote-runtime';",resolveDir:process.cwd(),loader:'ts'},outfile:join(directory,'harness.mjs'),bundle:true,platform:'node',format:'esm',target:'node24'});
  const {CaptureBroker,IsolatedCaptureRuntime,RemoteCaptureRuntime}=await import(pathToFileURL(join(directory,'harness.mjs')).href);
  const driver={async run(args,signal){
    const output=await docker(args,signal);
    if(!probeRan&&process.env.WORKBENCH_CAPTURE_EGRESS==='1'&&args[0]==='exec'&&args[2]==='cat'&&args[3]==='/proc/1/status'&&/Uid:\s+10001\s/.test(output)&&/CapEff:\s+0000000000000000/.test(output)) {
      probeRan=true;const guard=args[1];const metadata=JSON.parse(await docker(['inspect',guard]))[0];const network=Object.keys(metadata.NetworkSettings.Networks)[0];
      const proxies=(await docker(['ps','-aq','--filter','label=org.workbench.capture.owner=capture-broker-v1','--filter',`label=org.workbench.capture.deployment=${deploymentId}`,'--filter','label=org.workbench.capture.role=proxy'])).split(/\s+/);if(proxies.length!==1||!proxies[0])throw Error('PROBE_BOUNDARY_NOT_FOUND');
      await new Promise((resolve,reject)=>{const probe=spawn(process.execPath,['scripts/verify-capture-egress.mjs'],{stdio:'inherit',env:{...process.env,WORKBENCH_CAPTURE_IMAGE:image,WORKBENCH_CAPTURE_PROBE_GUARD:guard,WORKBENCH_CAPTURE_PROBE_PROXY:proxies[0],WORKBENCH_CAPTURE_PROBE_NETWORK:network}});probe.once('error',reject);probe.once('close',code=>code===0?resolve():reject(Error('BROKER_EGRESS_PROBE_FAILED')));});
    }
    return output;
  }};
  const runtime=new IsolatedCaptureRuntime({image,platform,deploymentId,scratchRoot:directory,driver});
  broker=new CaptureBroker({socketPath:join(directory,'capture.sock'),imageDigest:image,runtime});await broker.start();remote=new RemoteCaptureRuntime(join(directory,'capture.sock'),directory);await remote.start();
  const input=process.env.WORKBENCH_CAPTURE_INPUT_JSON?JSON.parse(process.env.WORKBENCH_CAPTURE_INPUT_JSON):{url:'https://www.w3.org/Icons/w3c_home.png'};
  const result=await remote.acquire(input,new AbortController().signal);
  try {
    if(result.state!=='file')throw Error(`POSITIVE_CAPTURE_${result.state.toUpperCase()}`);
    const bytes=await readFile(result.path);if(createHash('sha256').update(bytes).digest('hex')!==result.file.sha256||bytes.length!==result.file.size)throw Error('POSITIVE_CAPTURE_INVALID');
    if(process.env.WORKBENCH_CAPTURE_EGRESS==='1'&&!probeRan)throw Error('BROKER_EGRESS_PROBE_NOT_RUN');
    const probes=process.env.WORKBENCH_CAPTURE_NEGATIVE_INPUTS_JSON?JSON.parse(process.env.WORKBENCH_CAPTURE_NEGATIVE_INPUTS_JSON):[
      {name:'ipv4-loopback',input:{url:'https://127.0.0.1/'}},
      {name:'ipv6-loopback',input:{url:'https://[::1]/'}},
      {name:'metadata',input:{url:'https://169.254.169.254/'}},
      {name:'mapped-loopback',input:{url:'https://[::ffff:127.0.0.1]/'}},
    ];
    if(!Array.isArray(probes)||probes.length>20)throw Error('INVALID_NEGATIVE_PROBES');const blocked=[];
    for(const probe of probes){if(!probe||typeof probe.name!=='string'||! /^[a-z0-9-]{1,60}$/.test(probe.name))throw Error('INVALID_NEGATIVE_PROBES');const outcome=await remote.acquire(probe.input,new AbortController().signal);if(outcome.state==='file'){await outcome.dispose();throw Error('BROKER_EGRESS_ALLOWED');}if(!['PRIVATE_TARGET','EGRESS_DENIED','HTTPS_REQUIRED'].includes(outcome.errorCode))throw Error('BROKER_EGRESS_UNPROVEN');blocked.push({name:probe.name,state:outcome.state,errorCode:outcome.errorCode});}
    console.log(JSON.stringify({protocol:1,imageDigest:image,platform,deploymentId,transport:'UDS',positiveCapture:result.file,brokerOwnedEgressProbe:probeRan,blocked}));
  }finally{if(result.state==='file')await result.dispose();}
} finally {await remote?.stop();await broker?.stop();await rm(directory,{recursive:true,force:true});}
