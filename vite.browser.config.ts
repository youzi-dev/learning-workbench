import {defineConfig, type Plugin} from 'vite';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {builtinModules} from 'node:module';

const base=process.env.WORKBENCH_BROWSER_BASE??'/learn/';
if(!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base))throw new Error('WORKBENCH_BROWSER_BASE must start and end with / and contain only local path segments');
const buildId=randomUUID();
const optionalAsrEnabled=process.env.WORKBENCH_BROWSER_ASR==='1';
const localSyncEnabled=process.env.WORKBENCH_BROWSER_LOCAL_SYNC==='1';
const coreModules=new Set(builtinModules.flatMap(name=>[name,name.replace(/^node:/,'')]));
const browserBoundary:Plugin={
 name:'workbench-browser-boundary',
 transformIndexHtml(html){
  // Opt in only for an isolated localhost verification build; releases stay HTTPS-only.
  return localSyncEnabled ? html.replace("connect-src 'self' https:;", "connect-src 'self' https: http://127.0.0.1:* http://localhost:*;") : html;
 },
 resolveId(source){
  if(coreModules.has(source)||/^(?:node:|electron(?:\/|$)|monaco-editor(?:\/|$))/.test(source))throw new Error('Desktop dependency reached browser build: '+source);
 },
 generateBundle(_options,bundle){
  for(const item of Object.values(bundle))if(item.type==='chunk'){
   for(const id of Object.keys(item.modules))if(/(?:\/src\/(?:main|preload)\/|\/node_modules\/(?:electron|monaco-editor)\/)/.test(id))throw new Error('Desktop module in browser graph: '+id);
  }
  this.emitFile({type:'asset',fileName:'browser-build.json',source:JSON.stringify({base,buildId,optionalAsrEnabled,localSyncEnabled})});
 }
};
export default defineConfig({
 root:resolve('browser'),base,publicDir:resolve('browser/public'),
 define:{__WB_BROWSER_BUILD_ID__:JSON.stringify(buildId),__WB_BROWSER_ASR_ENABLED__:JSON.stringify(optionalAsrEnabled)},
 plugins:[browserBoundary],
 build:{outDir:resolve('dist-browser'),emptyOutDir:true,assetsInlineLimit:0},
 worker:{format:'es'},
 preview:{host:'127.0.0.1',port:4174,strictPort:true}
});
