import {readFile, writeFile} from 'node:fs/promises';
import {androidVersion} from './android-release-config.mjs';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await writeFile(new URL('licenses/release-identity.json', root), JSON.stringify({
  name: pkg.name, productName: pkg.build.productName, appId: pkg.build.appId,
  version: pkg.version, androidVersionCode: androidVersion(pkg.version).versionCode,
  distribution: 'private', macOS: 'ad hoc signed; unnotarized', windows: 'unsigned private installer',
  android: 'stable private release signing required; certificate checked separately',
}, null, 2) + '\n');
