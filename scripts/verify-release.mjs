import {createReadStream} from 'node:fs';
import {readFile, readdir, lstat, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {androidVersion} from './android-release-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateName = /(?:^|\/)(?:\.env(?:\..*)?|\.secrets|private-keys|signing|keystore-password\.txt|local-data|user-data|user-exports|user-backups|recordings|tutorial-cache)(?:\/|$)|\.(?:keystore|jks|p12|pfx|p8|key|pem)$/i;
const privateContent = /\/Users\/[^/]+\/|\/Volumes\/MacWork\/|\.superpowers\/tools\/|WORKBENCH_ANDROID_(?:STORE|KEY)_PASSWORD\s*=/;
const textFile = /\.(?:[cm]?js|json|map|txt|md|html|css|xml|plist|yaml|yml|properties)$/i;
const hash = data => createHash('sha256').update(data).digest('hex');
function assert(value, message) { if (!value) throw Error(message); }
function scan(name, data) {
  assert(!privateName.test(name.replaceAll('\\', '/')), `Private file excluded: ${basename(name)}`);
  if (data && textFile.test(name)) assert(!privateContent.test(data.toString('utf8')), `Private machine path excluded: ${basename(name)}`);
}
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function filesIn(path, prefix = '') {
  const result = [];
  for (const name of (await readdir(path)).sort()) {
    const child = join(path, name), rel = prefix + name;
    scan(rel);
    const stat = await lstat(child);
    if (stat.isDirectory()) result.push(...await filesIn(child, rel + '/'));
    else if (stat.isFile()) {
      if (textFile.test(name)) scan(rel, await readFile(child));
      result.push({path: rel, sha256: await fileHash(child), size: stat.size});
    }
  }
  return result;
}
function asarTool() {
  const require = createRequire(import.meta.url);
  return createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'))('@electron/asar');
}
async function verifyLicenses(read, pkg) {
  const expected = JSON.parse(await readFile(join(root, 'licenses/release-identity.json'), 'utf8'));
  const identity = JSON.parse(await read('release-identity.json'));
  assert(identity.name === pkg.name && identity.productName === pkg.build.productName && identity.appId === pkg.build.appId && identity.version === pkg.version && identity.androidVersionCode === androidVersion(pkg.version).versionCode && identity.distribution === 'private', 'Packaged release identity/version mismatch');
  assert(JSON.stringify(identity) === JSON.stringify(expected), 'Packaged release metadata mismatch');
  // Check the complete prepared public license folder, including native notices and copied full texts.
  const files = await filesIn(join(root, 'licenses'));
  for (const file of files) assert(hash(await read(file.path)) === file.sha256, `Missing or changed packaged notice: ${file.path}`);
  assert(hash(await read('Learning-Workbench-LICENSE.txt')) === hash(await readFile(join(root, 'LICENSE'))), 'App MIT license mismatch');
  return files.length;
}
async function verifyDesktop(path, platform, pkg) {
  const resources = platform === 'mac' ? join(path, 'Contents/Resources') : join(path, 'resources');
  const asar = asarTool(), archive = join(resources, 'app.asar');
  const appPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert(appPackage.name === pkg.name && appPackage.version === pkg.version, 'Desktop application package identity/version mismatch');
  for (const listedName of asar.listPackage(archive)) {
    const name = listedName.replace(/^[/\\]+/, '');
    scan(name);
    if (textFile.test(name) && !asar.statFile(archive, name).unpacked) scan(name, asar.extractFile(archive, name));
  }
  const notices = await verifyLicenses(name => readFile(join(resources, 'licenses', name)), pkg);
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) assert((await readFile(join(resources, 'licenses', name))).length > 100, `Missing Electron notice: ${name}`);
  if (platform === 'mac') {
    const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents/Info.plist')], {encoding: 'utf8'}));
    assert(plist.CFBundleIdentifier === pkg.build.appId && plist.CFBundleShortVersionString === pkg.version && plist.CFBundleName === pkg.build.productName, 'macOS bundle identity/version mismatch');
  } else assert((await lstat(join(path, pkg.build.win.executableName + '.exe'))).isFile(), 'Windows product executable missing');
  const files = await filesIn(path);
  return {payload: basename(path), files: files.length, notices, sha256: hash(JSON.stringify(files)), identity: {appId: pkg.build.appId, version: pkg.version}, check: 'unpacked application contents; runtime execution not performed'};
}
// These produced ZIP/APK artifacts use UTF-8 names. ditto can omit the UTF-8 flag;
// metadata_encoding handles those entries, while explicitly flagged names still use UTF-8.
// Python's standard ZIP reader performs no filesystem extraction or downloads.
export function zipContents(path, include) {
  const script = `import sys,zipfile,json,hashlib,re\nz=zipfile.ZipFile(sys.argv[1], metadata_encoding='utf-8'); wanted=json.loads(sys.argv[2]); names=sorted(z.namelist()); hashes={}\nfor n in names:\n if re.search(r'(^|/)(\\.env(\\..*)?|\\.secrets|private-keys|signing|keystore-password\\.txt|local-data|user-data|user-exports|user-backups|recordings|tutorial-cache)(/|$)|\\.(keystore|jks|p12|pfx|p8|key|pem)$',n,re.I): raise Exception('Private archive entry excluded')\n if n in wanted: hashes[n]=hashlib.sha256(z.read(n)).hexdigest()\n if re.search(r'\\.([cm]?js|json|map|txt|md|html|css|xml|plist|yaml|yml|properties)$',n,re.I):\n  if re.search(rb'[/]Users[/][^/]+[/]|[/]Volumes[/][^/]+[/]|\\.superpowers/tools/|WORKBENCH_ANDROID_(STORE|KEY)_PASSWORD\\s*=',z.read(n)): raise Exception('Private archive content excluded')\nprint(json.dumps({'names':names,'hashes':hashes}))`;
  return JSON.parse(execFileSync('python3', ['-c', script, path, JSON.stringify(include)], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}));
}
async function verifyAndroid(path, identityPath, pkg) {
  assert(identityPath, '--android-apk requires --android-identity manifest/signature evidence JSON');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  const apkHash = await fileHash(path), version = androidVersion(pkg.version);
  assert(identity.apkSha256 === apkHash && identity.applicationId === pkg.build.appId && identity.versionName === version.versionName && identity.versionCode === version.versionCode && identity.minSdkVersion === 29 && identity.targetSdkVersion === 36 && identity.debuggable === false, 'Android manifest identity/version/SDK/debuggable evidence mismatch');
  assert(identity.signatureVerified === true && identity.certificateSha256?.replaceAll(':', '').toUpperCase() === 'A50F3283C22532FB7A119414E7009EE973FE8E841C48C71E02FDC3E5FF0A217C', 'Android stable public certificate evidence mismatch');
  const expected = await filesIn(join(root, 'licenses'));
  const native = await filesIn(join(root, 'android/app/src/main/assets/licenses'));
  const required = [...expected.map(f => ({...f, path: 'assets/public/licenses/' + f.path})), ...native.map(f => ({...f, path: 'assets/licenses/' + f.path}))];
  const zip = zipContents(path, required.map(f => f.path));
  for (const file of required) assert(zip.hashes[file.path] === file.sha256, `Missing or changed APK notice: ${file.path}`);
  assert(zip.names.includes('AndroidManifest.xml') && zip.names.includes('assets/public/index.html'), 'Android manifest/frontend missing');
  return {artifact: basename(path), sha256: apkHash, notices: required.length, identity: {applicationId: identity.applicationId, versionName: identity.versionName, versionCode: identity.versionCode, minSdkVersion: 29, targetSdkVersion: 36, debuggable: false, certificateSha256: identity.certificateSha256.replaceAll(':', '').toUpperCase()}, check: 'APK contents and supplied SHA256-bound external manifest/signature evidence; device execution not performed'};
}

export async function verifyRelease(argv = process.argv.slice(2)) {
  const allowed = new Set(['mac-app', 'mac-zip', 'win-installer', 'win-unpacked', 'android-apk', 'android-identity', 'output']);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    assert(argv[i]?.startsWith('--') && allowed.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--') && !args[key], 'Use explicit unique --artifact path options');
    args[key] = resolve(argv[i + 1]);
  }
  assert(args['mac-app'] || args['win-installer'] || args['win-unpacked'] || args['android-apk'], 'Request at least one produced artifact/payload');
  assert(!args['mac-zip'] || args['mac-app'], '--mac-zip requires corresponding --mac-app');
  assert(!args['win-installer'] || args['win-unpacked'], '--win-installer requires corresponding --win-unpacked payload');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const results = [];
  if (args['mac-app']) results.push({platform: 'macOS', ...await verifyDesktop(args['mac-app'], 'mac', pkg)});
  if (args['win-unpacked']) results.push({platform: 'Windows', ...await verifyDesktop(args['win-unpacked'], 'win', pkg)});
  for (const [key, magic] of [['mac-zip', 'PK'], ['win-installer', 'MZ']]) if (args[key]) {
    const stat = await lstat(args[key]); assert(stat.isFile() && stat.size > 0, `Missing produced ${key}`);
    const stream = createReadStream(args[key], {start: 0, end: 1});
    let prefix = ''; for await (const data of stream) prefix += data.toString('ascii');
    assert(prefix === magic, `Invalid ${key} file header`);
    if (key === 'mac-zip') {
      const files = await filesIn(args['mac-app']);
      const wanted = files.map(f => basename(args['mac-app']) + '/' + f.path);
      const zip = zipContents(args[key], wanted);
      for (let i = 0; i < files.length; i++) assert(zip.hashes[wanted[i]] === files[i].sha256, 'macOS ZIP differs from checked application contents');
    }
    results.push({artifact: basename(args[key]), sha256: await fileHash(args[key]), size: stat.size, check: key === 'mac-zip' ? 'ZIP matches checked application file contents' : 'installer header/checksum; corresponding unpacked payload checked separately, installer not executed or unpacked'});
  }
  if (args['android-apk']) results.push({platform: 'Android', ...await verifyAndroid(args['android-apk'], args['android-identity'], pkg)});
  const manifest = {schema: 1, distribution: 'private', version: pkg.version, runtimeAcceptance: 'not performed', results};
  const output = args.output ?? join(root, 'release/private-release-checksums.json');
  await mkdir(dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Verified ${results.length} explicit artifact/payload entries; ${basename(output)}`);
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) verifyRelease().catch(error => { console.error(`Release verification failed: ${error.message}`); process.exitCode = 1; });
