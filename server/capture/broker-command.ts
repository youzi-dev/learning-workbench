import {CaptureBroker} from './broker';
import {IsolatedCaptureRuntime} from './docker-runtime';
/** Operator-only entry. No DB/key/blob options and no TCP address exist. */
export async function runBrokerCli(args:string[],output:(line:string)=>void=console.log):Promise<CaptureBroker> {
  const flags:Record<string,string>=Object.create(null);
  for(let i=0;i<args.length;i+=2){if(!['--socket','--image','--platform','--deployment-id','--scratch-dir'].includes(args[i])||!args[i+1]||Object.hasOwn(flags,args[i]))throw Error('INVALID_BROKER_ARGUMENT');flags[args[i]]=args[i+1];}
  for(const name of ['--socket','--image','--platform','--deployment-id','--scratch-dir'])if(!flags[name])throw Error('BROKER_CONFIGURATION_REQUIRED');
  const runtime=new IsolatedCaptureRuntime({image:flags['--image'],platform:flags['--platform'] as 'linux/amd64'|'linux/arm64',deploymentId:flags['--deployment-id'],scratchRoot:flags['--scratch-dir']});
  const broker=new CaptureBroker({socketPath:flags['--socket'],imageDigest:flags['--image'],runtime});await broker.start();
  output(JSON.stringify({protocol:1,ready:true,imageDigest:flags['--image'],maxConcurrent:2}));
  let closing=false;const close=()=>{if(closing)return;closing=true;process.off('SIGTERM',close);process.off('SIGINT',close);void broker.stop().catch(()=>{process.exitCode=1;});};process.once('SIGTERM',close);process.once('SIGINT',close);return broker;
}
