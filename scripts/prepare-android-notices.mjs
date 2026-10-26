import {cp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const root = new URL('../', import.meta.url);
// cap sync copies dist-android to assets/public. Native assets/licenses is separate.
const target = new URL('dist-android/licenses/', root);
await readFile(new URL('dist-android/index.html', root));
const manifest = JSON.parse(await readFile(new URL('licenses/npm-license-manifest.json', root), 'utf8'));
for (const entry of manifest) {
  const data = await readFile(new URL(`licenses/${entry.file}`, root));
  if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw Error(`License hash mismatch: ${entry.file}`);
}
await rm(target, {recursive: true, force: true});
await mkdir(target, {recursive: true});
await cp(new URL('licenses/', root), target, {recursive: true});
await cp(new URL('LICENSE', root), new URL('Learning-Workbench-LICENSE.txt', target));
await writeFile(new URL('ANDROID-README.txt', target), 'App MIT and shared JavaScript notices are in this folder. android-native/ contains the resolved Android runtime notices. Native SQLCipher/LibTomCrypt/SQLite texts and source records remain separately in assets/licenses. This folder is a conservative cross-platform superset: desktop Electron and speech engine/model notices do not mean those components are bundled in Android.\n');
console.log('Prepared Android app/shared/native public notices; existing native license assets preserved');
