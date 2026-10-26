import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyCloud, validateCloudBase, readCloudCredential} from '../scripts/verify-cloud.mjs';
const token='A'.repeat(43);
const lookup=async()=>[{address:'93.184.216.34',family:4}];
function transport(extra={}){return async(url,options)=>{assert.equal(options.redirect,'error');assert.equal(options.method,'GET');const path=new URL(url).pathname;if(extra[path])return extra[path](options);if(path==='/healthz')return Response.json({status:'ready'});if(path==='/ready')return new Response('',{status:404});return options.headers.authorization?Response.json({changes:[],nextCursor:0,hasMore:false}):Response.json({error:'UNAUTHORIZED'},{status:401});};}
test('rejects unsafe endpoints and DNS private targets before sending credential',async()=>{
 for(const input of ['http://example.org','https://localhost','https://127.0.0.1','https://[::1]','https://10.0.0.1','https://[::ffff:127.0.0.1]','https://[fc00::1]','https://user:pass@example.org','https://example.org/path','https://example.org/?key=x','https://example.org/#x'])assert.throws(()=>validateCloudBase(input));
 let called=false;const result=await verifyCloud({base:'https://example.org',token},{fetch:async()=>{called=true;throw Error('unexpected');},lookup:async()=>[{address:'192.168.1.1',family:4}]});assert.equal(result.status,'incomplete');assert.equal(called,false);
});
test('reports only read-only smoke checks and explicitly absent blob proof',async()=>{
 const result=await verifyCloud({base:'https://example.org',token},{fetch:transport(),lookup});assert.equal(result.status,'endpoint-smoke-passed');assert.equal(result.checks.knownBlob,'not-checked');assert.ok(!JSON.stringify(result).includes(token));
});
test('bounds body, rejects redirects/errors/invalid structures without logging bodies',async()=>{
 for(const response of [new Response('PRIVATE DATA',{status:503}),Response.json({status:'PRIVATE DATA'}),new Response('x'.repeat(600000))]){const result=await verifyCloud({base:'https://example.org',token},{fetch:transport({'/healthz':()=>response}),lookup});assert.equal(result.status,'incomplete');assert.ok(!JSON.stringify(result).includes('PRIVATE DATA'));}
 const result=await verifyCloud({base:'https://example.org',token},{fetch:async()=>{throw Error('https://secret:password@example.org');},lookup});assert.equal(result.status,'incomplete');assert.ok(!JSON.stringify(result).includes('password'));
});
test('private token file refuses permissive modes and accepts existing device credential',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'cloud-smoke-')));try{const file=join(root,'device.json');await writeFile(file,JSON.stringify({accountId:'fixture',deviceId:'fixture',token}),{mode:0o600});assert.equal(await readCloudCredential(file),token);await chmod(file,0o644);await assert.rejects(readCloudCredential(file));}finally{await rm(root,{recursive:true,force:true});}
});

test('known blob proof streams exact bytes/hash and requires unauth denial',async()=>{
 const {createHash}=await import('node:crypto');const body=Buffer.from('synthetic known file');const blob={sha256:createHash('sha256').update(body).digest('hex'),size:body.length,mime:'text/plain'};
 const fetch=transport({[`/v1/blobs/${blob.sha256}`]:options=>options.headers.authorization?new Response(body):new Response('UNAUTHORIZED',{status:401})});
 const good=await verifyCloud({base:'https://example.org',token,blob},{fetch,lookup});assert.equal(good.status,'endpoint-smoke-passed');assert.equal(good.checks.knownBlob,'passed');
 const bad=await verifyCloud({base:'https://example.org',token,blob:{...blob,size:1}},{fetch,lookup});assert.equal(bad.status,'incomplete');
});

test('FIFO credential and optional evidence reject promptly without a writer',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'cloud-fifo-')));try{const fifo=join(root,'input-fifo'),credential=join(root,'device.json');await writeFile(credential,JSON.stringify({token}),{mode:0o600});const made=spawnSync('mkfifo',['-m','600',fifo],{timeout:1000});assert.equal(made.status,0);
 for(const args of [['--credential',fifo],['--credential',credential,'--blob-evidence',fifo]]){const child=spawnSync(process.execPath,['scripts/verify-cloud.mjs','--base','https://example.org',...args],{encoding:'utf8',timeout:1500});assert.equal(child.error,undefined);assert.equal(child.status,1);assert.equal(JSON.parse(child.stdout).status,'incomplete');}
 }finally{await rm(root,{recursive:true,force:true});}
});
