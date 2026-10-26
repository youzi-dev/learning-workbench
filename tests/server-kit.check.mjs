import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareServerKit, SERVER_KIT_FILES} from '../scripts/package-server.mjs';
test('prepares only explicit public deployment inputs with deterministic hashes and no private extras',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'server-kit-test-')));try{const source=join(root,'source'),one=join(root,'one'),two=join(root,'two');await mkdir(one);await mkdir(two);
 for(const path of SERVER_KIT_FILES){await mkdir(dirname(join(source,path)),{recursive:true});await writeFile(join(source,path),`fixture ${path}`);}
 await writeFile(join(source,'package.json'),JSON.stringify({version:'0.11.1'}));
 for(const extra of ['.env','.superpowers/private','data/db.sqlite','release/client-installer.exe']){await mkdir(dirname(join(source,extra)),{recursive:true});await writeFile(join(source,extra),'PRIVATE_NOT_TO_PACKAGE');}
 const first=await prepareServerKit(source,one),second=await prepareServerKit(source,two);assert.deepEqual(first,second);assert.equal(JSON.parse(await readFile(join(one,'package.json'),'utf8')).version,'0.11.1');assert.equal((await readFile(join(one,'SHA256SUMS'),'utf8')).includes('PRIVATE'),false);assert.equal(first.length,SERVER_KIT_FILES.length+1);
 await assert.rejects(readFile(join(one,'.env')));await assert.rejects(readFile(join(one,'release/client-installer.exe')));await rm(join(source,'dist-server/offhost.mjs'));await assert.rejects(prepareServerKit(source,two));
 await symlink(join(source,'.env'),join(source,'dist-server/offhost.mjs'));await assert.rejects(prepareServerKit(source,two),/KIT_SYMLINK_FORBIDDEN/);
 }finally{await rm(root,{recursive:true,force:true});}
});
