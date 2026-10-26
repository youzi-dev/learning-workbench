import {defineConfig, type Plugin} from 'vite';
import {resolve} from 'node:path';
import {builtinModules} from 'node:module';
const forbidden = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));
const nativeBoundary: Plugin = {
  name: 'android-platform-boundary',
  resolveId(source) {
    if (forbidden.has(source) || /^(?:node:|electron(?:\/|$)|monaco-editor(?:\/|$))/.test(source)) throw Error('Desktop dependency reached Android build: ' + source);
  },
  generateBundle(_options, bundle) {
    for (const item of Object.values(bundle)) if (item.type === 'chunk') for (const id of Object.keys(item.modules)) {
      if (/\/src\/(?:electron|platforms\/electron)\//.test(id)) throw Error('Desktop module reached Android bundle: ' + id);
      // These existing React/worker helpers are intentionally shared with the browser learning UI.
      if (/\/src\/renderer\//.test(id) && !/\/renderer\/(?:icon|lab-panel|lab-client|lab\.worker|model-settings|model-picker)\.(?:tsx?|css)(?:\?|$)/.test(id)) throw Error('Unapproved desktop renderer reached Android bundle: ' + id);
    }
  },
};
export default defineConfig({
  root: resolve('android-web'), base: '/', publicDir: resolve('browser/public'),
  define: {__WB_BROWSER_BUILD_ID__: JSON.stringify('android-native'), __WB_BROWSER_ASR_ENABLED__: JSON.stringify(false)},
  plugins: [nativeBoundary], build: {outDir: resolve('dist-android'), emptyOutDir: true, assetsInlineLimit: 0},
  worker: {format: 'es'},
});
