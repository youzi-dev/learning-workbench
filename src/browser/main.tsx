import React from 'react';
import {createRoot} from 'react-dom/client';
import {bootBrowserRuntime} from '../platforms/browser/boot';
import {WorkbenchApplication} from '../workbench/ui/application';
const root = createRoot(document.getElementById('root')!);
async function boot() {
  root.render(<div className="wb-empty"><h1>日常工作台</h1><p role="status">正在读取本机空间…</p></div>);
  try {const runtime = await bootBrowserRuntime(); root.render(<WorkbenchApplication runtime={runtime}/>);}
  catch (cause) {root.render(<main className="wb-shell"><section className="wb-empty"><h1>本机记录需要检查</h1><p role="alert">{cause instanceof Error ? cause.message : String(cause)}</p><p>原学习记录已保留。请保留浏览器网站数据，检查后再重试。</p><button onClick={() => void boot()}>重新读取</button></section></main>);}
}
void boot();
