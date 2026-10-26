import {expect,it} from 'vitest';
import {IsolatedCaptureRuntime, type DockerCommandAdapter} from '../../server/capture/docker-runtime';
const image=`sha256:${'a'.repeat(64)}`;
function adapter(identity={Id:image,Os:'linux',Architecture:'arm64'}) {
  const commands:string[][]=[];
  const driver:DockerCommandAdapter={async run(args){commands.push(args);if(args[0]==='image')return JSON.stringify([identity]);if(args[0]==='inspect')return JSON.stringify([{NetworkSettings:{Networks:{[commands.find(c=>c[0]==='network'&&c[1]==='create')!.at(-1)!]:{IPAddress:'172.30.0.2'}}}}]);return '';}};
  return {commands,driver};
}
it('fails readiness on floating images or verified architecture/digest mismatch without creating Docker resources',async()=>{
  expect(()=>new IsolatedCaptureRuntime({image:'latest',platform:'linux/arm64',deploymentId:'test'})).toThrow('IMAGE_PIN_REQUIRED');
  for(const identity of [{Id:`sha256:${'b'.repeat(64)}`,Os:'linux',Architecture:'arm64'},{Id:image,Os:'linux',Architecture:'amd64'}]){const {driver,commands}=adapter(identity);const runtime=new IsolatedCaptureRuntime({image,platform:'linux/arm64',deploymentId:'test',driver});await expect(runtime.start()).rejects.toThrow('IMAGE_NOT_VERIFIED');expect(commands).toHaveLength(1);}
});
it('reconciles only fixed owner/deployment labels and uses pinned platform, labels and bounded proxy resources',async()=>{
  const {driver,commands}=adapter();const runtime=new IsolatedCaptureRuntime({image,platform:'linux/arm64',deploymentId:'test-only',driver});await runtime.start();await runtime.stop();
  const lists=commands.filter(args=>args[0]==='ps'||(args[0]==='network'&&args[1]==='ls'));expect(lists.length).toBeGreaterThan(0);for(const args of lists){expect(args).toContain('label=org.workbench.capture.owner=capture-broker-v1');expect(args).toContain('label=org.workbench.capture.deployment=test-only');}
  const proxy=commands.find(args=>args[0]==='run')!;expect(proxy).toContain(image);expect(proxy).toContain('linux/arm64');expect(proxy).toContain('--pids-limit');expect(proxy).toContain('--memory');expect(proxy).toContain('--cpus');expect(proxy.some(v=>v.includes('org.workbench.capture.role=proxy'))).toBe(true);expect(proxy).not.toContain('--volume');
});
it('fails closed on unbounded resource reconciliation and never deletes arbitrary IDs returned by an adapter',async()=>{
  const {driver}=adapter();const base=driver.run;const commands:string[][]=[];driver.run=async(args,signal)=>{commands.push(args);if(args[0]==='ps')return 'unrelated-name';return base(args,signal);};
  const runtime=new IsolatedCaptureRuntime({image,platform:'linux/arm64',deploymentId:'test',driver});await expect(runtime.start()).rejects.toThrow('OWNED_RESOURCE_LIMIT');expect(commands.some(c=>c[0]==='rm')).toBe(false);
});
it('cancellation waits for owned guard creation then removes fixed job IDs before returning',async()=>{
  const {driver,commands}=adapter();const base=driver.run;let release!:()=>void,started=false;
  driver.run=async(args,signal)=>{if(args[0]==='run'&&args.includes('org.workbench.capture.role=guard')){commands.push(args);started=true;await new Promise<void>(resolve=>{release=resolve;});return 'guard';}return base(args,signal);};
  const runtime=new IsolatedCaptureRuntime({image,platform:'linux/arm64',deploymentId:'cancel-test',driver});await runtime.start();
  const abort=new AbortController();const pending=runtime.acquire({url:'https://example.org/'},abort.signal);const rejected=expect(pending).rejects.toThrow();await expect.poll(()=>started).toBe(true);abort.abort(Error('CANCELLED'));release();await rejected;
  const guard=commands.find(args=>args.includes('org.workbench.capture.role=guard'))!;const name=guard[guard.indexOf('--name')+1];expect(commands.some(args=>args[0]==='rm'&&args.includes(name))).toBe(true);expect(commands.some(args=>args[0]==='create')).toBe(false);await runtime.stop();
});

it('disables daemon logging for every private proxy, guard and downloader while preserving attached transfer arguments',async()=>{
  const {driver,commands}=adapter();const base=driver.run;
  driver.run=async(args,signal)=>{
    if(args[0]==='exec'){commands.push(args);return 'Uid: 10001 10001 10001 10001\nCapEff: 0000000000000000';}
    if(args[0]==='create'){commands.push(args);throw Error('STOP_BEFORE_ATTACH');}
    return base(args,signal);
  };
  const runtime=new IsolatedCaptureRuntime({image,platform:'linux/arm64',deploymentId:'logging-test',driver});await runtime.start();
  await expect(runtime.acquire({url:'https://example.org/'},new AbortController().signal)).rejects.toThrow('STOP_BEFORE_ATTACH');await runtime.stop();
  const containers=commands.filter(args=>args[0]==='run'||args[0]==='create');expect(containers).toHaveLength(3);
  for(const args of containers)expect(args[args.indexOf('--log-driver')+1]).toBe('none');
  const downloader=containers.find(args=>args[0]==='create')!;expect(downloader).toContain('-i');expect(downloader).toContain('--rm');
});
