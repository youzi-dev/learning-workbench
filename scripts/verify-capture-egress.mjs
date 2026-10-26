import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
const exec = promisify(execFile);
const image =
  process.env.WORKBENCH_CAPTURE_IMAGE ?? "workbench-test-capture:2026-10-24";
const prefix = `workbench-test-egress-${randomUUID()}`;
// Operator-only harness: reuse the broker-created boundary, never expose probe
// commands through /acquire. The caller owns and keeps this guard alive.
const externalBoundary = Boolean(process.env.WORKBENCH_CAPTURE_PROBE_GUARD);
const network = process.env.WORKBENCH_CAPTURE_PROBE_NETWORK ?? `${prefix}-net`,
  proxy = process.env.WORKBENCH_CAPTURE_PROBE_PROXY ?? `${prefix}-proxy`,
  guard = process.env.WORKBENCH_CAPTURE_PROBE_GUARD ?? `${prefix}-guard`,
  canary = `${prefix}-canary`;
async function docker(args) {
  return (
    await exec("docker", args, { timeout: 60000, maxBuffer: 2097152 })
  ).stdout.trim();
}
let hostConnections = 0;
const host = createServer((socket) => {
  hostConnections++;
  socket.end();
});
await new Promise((resolve) => host.listen(0, "0.0.0.0", resolve));
const hostPort = host.address().port;
const evidence = {
  date: new Date().toISOString(),
  image,
  imageDigest: await docker(["image", "inspect", image, "--format", "{{.Id}}"]),
  blocked: [],
  hostConnections: 0,
  canaryConnections: null,
};
try {
  if (!externalBoundary) {
  await docker(["network", "create", "--internal", network]);
  await docker([
    "run",
    "-d",
    "--name",
    proxy,
    "--network",
    network,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    "10001:10001",
    "--entrypoint",
    "node",
    image,
    "/opt/workbench/proxy.mjs",
  ]);
  await docker(["network", "connect", "bridge", proxy]);
  }
  const proxyIp = JSON.parse(await docker(["inspect", proxy]))[0]
    .NetworkSettings.Networks[network].IPAddress;
  const canaryCode =
    "require('net').createServer(s=>{console.log('CANARY_CONNECTION');s.end()}).listen(8080,'0.0.0.0');require('net').createServer(s=>{console.log('CANARY_CONNECTION');s.end()}).listen(443,'0.0.0.0')";
  await docker([
    "run",
    "-d",
    "--name",
    canary,
    "--network",
    network,
    "--cap-drop",
    "ALL",
    "--user",
    "10001:10001",
    "--entrypoint",
    "node",
    image,
    "-e",
    canaryCode,
  ]);
  const canaryIp = JSON.parse(await docker(["inspect", canary]))[0]
    .NetworkSettings.Networks[network].IPAddress;
  const gateway = JSON.parse(await docker(["network", "inspect", network]))[0]
    .IPAM.Config[0].Gateway;
  const hostIp = await docker([
    "exec",
    proxy,
    "node",
    "-e",
    "require('dns').lookup('host.docker.internal',(e,a)=>{if(e)process.exit(1);console.log(a)})",
  ]);
  await docker([
    "exec",
    proxy,
    "node",
    "-e",
    `const s=require('net').createConnection({host:${JSON.stringify(canaryIp)},port:8080},()=>s.end());s.on('error',()=>process.exit(1));`,
  ]);
  await docker([
    "exec",
    proxy,
    "node",
    "-e",
    `const s=require('net').createConnection({host:${JSON.stringify(hostIp)},port:${hostPort}},()=>s.end());s.on('error',()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1));`,
  ]);
  const baseline =
    (await docker(["logs", canary])).split("CANARY_CONNECTION").length - 1;
  if (baseline !== 1 || hostConnections !== 1)
    throw Error("positive canary reachability control failed");
  hostConnections = 0;
  evidence.positiveControls = { privateCanary: baseline, hostCanary: 1 };

  if (!externalBoundary) {
  await docker([
    "run",
    "-d",
    "--name",
    guard,
    "--network",
    network,
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_ADMIN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SETPCAP",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    "0:0",
    "-e",
    `WORKBENCH_PROXY_IP=${proxyIp}`,
    "--entrypoint",
    "/bin/sh",
    image,
    "/opt/workbench/egress-guard.sh",
  ]);
  }
  let secure = false;
  for (let i = 0; i < 20; i++) {
    const status = await docker(["exec", guard, "cat", "/proc/1/status"]);
    if (
      /Uid:\s+10001\s/.test(status) &&
      /CapEff:\s+0000000000000000/.test(status)
    ) {
      secure = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!secure) throw Error("guard did not permanently drop privileges");
  const probe = `
    const net=require('net');const cp=require('child_process');
    async function connect(host,port){return new Promise(resolve=>{const s=net.createConnection({host,port});let done=false;function finish(v){if(done)return;done=true;s.destroy();resolve(v);}s.on('connect',()=>finish(true));s.on('error',()=>finish(false));s.setTimeout(500,()=>finish(false));});}
    async function tunnel(target){return new Promise(resolve=>{const s=net.createConnection({host:${JSON.stringify(proxyIp)},port:3128},()=>s.write('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n'));s.once('data',b=>{s.destroy();resolve(b.toString().startsWith('HTTP/1.1 403'));});s.once('error',()=>resolve(false));s.setTimeout(12000,()=>{s.destroy();resolve(false)});});}
    (async()=>{
      const results=[];
      for(const [host,port] of ${JSON.stringify([
        [canaryIp, 8080],
        [hostIp, hostPort],
        [gateway, hostPort],
        ["host.docker.internal", hostPort],
        ["169.254.169.254", 80],
        ["127.0.0.1", 8080],
        ["::1", 8080],
        ["::ffff:169.254.169.254", 80],
      ])})results.push({target:host+':'+port,blocked:!await connect(host,port)});
      for(const target of ${JSON.stringify([`${canaryIp}:443`, `${canary}:443`, "169.254.169.254:443", "[::1]:443", "[::ffff:127.0.0.1]:443"])})results.push({target:'proxy '+target,blocked:await tunnel(target)});
      const helper=cp.spawnSync('python3',['-c',${JSON.stringify(`import socket,sys\ns=socket.socket();s.settimeout(0.5)\ntry:s.connect(('${canaryIp}',8080));sys.exit(1)\nexcept OSError:sys.exit(0)`)}],{env:{PATH:process.env.PATH},timeout:2000});
      results.push({target:'python helper bypass',blocked:helper.status===0});
      console.log(JSON.stringify(results));if(results.some(r=>!r.blocked))process.exitCode=1;
    })().catch(e=>{console.error(e.message);process.exitCode=1});`;
  const result = await docker([
    "run",
    "--rm",
    "--network",
    `container:${guard}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    "10001:10001",
    "--entrypoint",
    "node",
    image,
    "-e",
    probe,
  ]);
  evidence.blocked = JSON.parse(result);
  const logs = await docker(["logs", canary]);
  evidence.canaryConnections =
    logs.split("CANARY_CONNECTION").length - 1 - baseline;
  evidence.hostConnections = hostConnections;
  if (evidence.canaryConnections !== 0 || hostConnections !== 0)
    throw Error("private canary received a connection");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  host.close();
  await docker(["rm", "-f", ...(externalBoundary ? [canary] : [guard, proxy, canary])]).catch(() => {});
  if (!externalBoundary) await docker(["network", "rm", network]).catch(() => {});
}
