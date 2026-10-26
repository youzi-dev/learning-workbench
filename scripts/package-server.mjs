import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile, chmod} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Each path is deliberate. No directory walk, automatic build or dependency install.
export const SERVER_KIT_FILES = Object.freeze([
 '.dockerignore',
 'dist-server/app.mjs','dist-server/cli.mjs','dist-server/schemas.mjs',
 'dist-server/capture-broker.mjs','dist-server/capture-remote.mjs','dist-server/backup.mjs','dist-server/deploy.mjs','dist-server/offhost.mjs',
 'dist-server/migrations/001-initial.sql',
 'deploy/server.Dockerfile','deploy/worker.Dockerfile','deploy/compose.yaml','deploy/Caddyfile','deploy/.env.example',
 'deploy/backup.sh','deploy/restore.sh','deploy/egress-guard.sh','deploy/egress.conf',
 'deploy/capture-dist/worker.mjs','deploy/capture-dist/proxy.mjs',
 'deploy/licenses/NOTICE.md','deploy/licenses/restic-0.19.1-LICENSE.txt',
 'licenses/Capacitor-android-8.5.3-LICENSE.txt',
 'licenses/Capacitor-core-8.5.3-LICENSE.txt',
 'licenses/Learning-Workbench-LICENSE.txt',
 'licenses/NOTICE.md',
 'licenses/SenseVoice-MODEL-LICENSE.txt',
 'licenses/THIRD_PARTY_NOTICES.md',
 'licenses/ThreadPool-LICENSE.txt',
 'licenses/android-native/Apache-2.0.txt',
 'licenses/android-native/Cordova-14.0.1-NOTICE.txt',
 'licenses/android-native/NOTICE.md',
 'licenses/android-native/dependency-manifest.json',
 'licenses/boolbase-1.0.0-LICENSE',
 'licenses/css-select-5.2.2-LICENSE',
 'licenses/css-what-6.2.2-LICENSE',
 'licenses/diff-9.0.0-LICENSE',
 'licenses/dom-serializer-2.0.0-LICENSE',
 'licenses/domelementtype-2.3.0-LICENSE',
 'licenses/domhandler-5.0.3-LICENSE',
 'licenses/dompurify-3.4.8-LICENSE',
 'licenses/dompurify-3.4.8-LICENSE-MPL',
 'licenses/domutils-3.2.2-LICENSE',
 'licenses/eigen-COPYING-MPL2.txt',
 'licenses/electron-LICENSE.txt',
 'licenses/entities-4.5.0-LICENSE',
 'licenses/entities-8.1.0-LICENSE',
 'licenses/hclust-cpp-LICENSE.txt',
 'licenses/jitl-quickjs-ffi-types-0.32.0-LICENSE',
 'licenses/jitl-quickjs-wasmfile-release-sync-0.32.0-LICENSE',
 'licenses/kaldi-decoder-LICENSE.txt',
 'licenses/kaldi-native-fbank-LICENSE.txt',
 'licenses/kaldifst-LICENSE.txt',
 'licenses/kissfft-BSD-3-Clause.txt',
 'licenses/kissfft-COPYING.txt',
 'licenses/marked-14.0.0-LICENSE.md',
 'licenses/monaco-editor-0.56.0-LICENSE',
 'licenses/nlohmann-json-LICENSE.txt',
 'licenses/noble-hashes-2.4.0-LICENSE',
 'licenses/node-html-parser-9.0.4-LICENSE',
 'licenses/npm-license-manifest.json',
 'licenses/nth-check-2.1.1-LICENSE',
 'licenses/onnxruntime-LICENSE.txt',
 'licenses/onnxruntime-ThirdPartyNotices.txt',
 'licenses/openfst-AUTHORS.txt',
 'licenses/openfst-LICENSE.txt',
 'licenses/pdfjs-dist-6.4.299-LICENSE',
 'licenses/quickjs-emscripten-core-0.32.0-LICENSE',
 'licenses/react-19.3.0-LICENSE',
 'licenses/react-dom-19.3.0-LICENSE',
 'licenses/release-identity.json',
 'licenses/scheduler-0.28.0-LICENSE',
 'licenses/sherpa-onnx-LICENSE.txt',
 'licenses/simple-sentencepiece-LICENSE.txt',
 'licenses/types-trusted-types-2.0.7-LICENSE',
 'licenses/vscode-codicons-0.0.46-24-LICENSE',
 'licenses/vscode-codicons-0.0.46-24-LICENSE-CODE',

 'scripts/verify-cloud.mjs',
 'docs/operations/deployment.md','docs/operations/backup-restore.md','docs/operations/offhost-backup.md',
 'docs/releases/personal-workbench-acceptance.md',
].sort());
async function regularFile(path) {
 let current=path;for(;;){const s=await lstat(current);if(s.isSymbolicLink())throw Error('KIT_SYMLINK_FORBIDDEN');const parent=dirname(current);if(parent===current)break;current=parent;}
 if(!(await lstat(path)).isFile())throw Error('KIT_INPUT_NOT_REGULAR');
}
async function rootVersion(source) {
 await regularFile(join(source,'package.json'));
 const {version}=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
 if(typeof version!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('INVALID_KIT_VERSION');
 return version;
}
export async function prepareServerKit(source, stage) {
 const version=await rootVersion(source);
 const files=[];
 for(const path of SERVER_KIT_FILES){const absolute=join(source,path);await regularFile(absolute);const bytes=await readFile(absolute);if(!bytes.length)throw Error('KIT_INPUT_EMPTY');await mkdir(dirname(join(stage,path)),{recursive:true});await writeFile(join(stage,path),bytes,{mode:path.endsWith('.sh')?0o755:0o644});files.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});}
 const manifest=Buffer.from(JSON.stringify({name:'learning-workbench-server',version,type:'module',scripts:{'verify:cloud':'node scripts/verify-cloud.mjs'}},null,2)+'\n');
 await writeFile(join(stage,'package.json'),manifest,{mode:0o644});files.push({path:'package.json',sha256:createHash('sha256').update(manifest).digest('hex'),size:manifest.length});files.sort((a,b)=>a.path.localeCompare(b.path));
 await writeFile(join(stage,'SHA256SUMS'),files.map(file=>`${file.sha256}  ${file.path}\n`).join(''),{mode:0o644});return files;
}
export async function packageServer(source=resolve('.')) {
 const actual=await realpath(source),release=join(actual,'release'),version=await rootVersion(actual);
 // Validate all inputs before replacing an existing output or opening a tar process.
 for(const path of SERVER_KIT_FILES)await regularFile(join(actual,path));
 await mkdir(release,{recursive:true});if((await lstat(release)).isSymbolicLink())throw Error('UNSAFE_KIT_OUTPUT');
 const stage=await mkdtemp(join(tmpdir(),'workbench-server-kit-'));
 try{const content=join(stage,'content');await mkdir(content);const files=await prepareServerKit(actual,content);const archive=join(stage,`learning-workbench-server-${version}.tar.gz`);
 const child=spawnSync('tar',['-czf',archive,'-C',content,'.'],{encoding:'utf8',env:{PATH:process.env.PATH,COPYFILE_DISABLE:'1'},timeout:120000,maxBuffer:65536});if(child.error||child.status!==0)throw Error('KIT_ARCHIVE_FAILED');
 const target=join(release,`learning-workbench-server-${version}.tar.gz`);
 try{if((await lstat(target)).isSymbolicLink())throw Error('UNSAFE_KIT_OUTPUT');}catch(error){if(error.code!=='ENOENT')throw error;}
 await writeFile(target,await readFile(archive),{mode:0o644});await chmod(target,0o644);
 const hashes=join(release,`learning-workbench-server-${version}.SHA256SUMS`);
 try{if((await lstat(hashes)).isSymbolicLink())throw Error('UNSAFE_KIT_OUTPUT');}catch(error){if(error.code!=='ENOENT')throw error;}
 await writeFile(hashes,files.map(file=>`${file.sha256}  ${file.path}\n`).join(''),{mode:0o644});
 return {status:'packaged-prebuilt-server',archive:`release/learning-workbench-server-${version}.tar.gz`,files:files.length};
 }finally{await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{if(process.argv.length!==2)throw Error('INVALID_ARGUMENT');console.log(JSON.stringify(await packageServer()));}catch{console.error('SERVER_KIT_INPUTS_MISSING_OR_PACKAGING_FAILED');process.exitCode=1;}}
