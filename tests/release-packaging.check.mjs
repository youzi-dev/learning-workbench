import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, cp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {androidVersion, requireSigningEnvironment} from '../scripts/android-release-config.mjs';
import {verifyRelease, zipContents} from '../scripts/verify-release.mjs';

test('Android version code is bounded, exact and monotonically ordered', () => {
  assert.deepEqual(androidVersion('0.11.0'), {versionName: '0.11.0', versionCode: 11000});
  assert(androidVersion('0.11.1').versionCode > androidVersion('0.11.0').versionCode);
  assert(androidVersion('1.0.0').versionCode > androidVersion('0.999.999').versionCode);
  for (const value of ['0.1000.0', '0.1.1000', '2148.0.0', '1.2', '1.2.3-beta', '01.2.3', '0.0.0']) assert.throws(() => androidVersion(value));
});
test('Desktop dependency matcher excludes native Android artifacts and preserves shared runtimes', async () => {
  const root = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/\/$/, '');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const require = createRequire(import.meta.url);
  const lib = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
  const {getNodeModuleFileMatcher} = lib('app-builder-lib/out/fileMatcher.js');
  const matcher = getNodeModuleFileMatcher(root, '/unused-fixture-destination', s => s, {}, {config: pkg.build, debugLogger: {isEnabled: false}});
  const filter = matcher.createFilter();
  for (const [name, directory] of [
    ['node_modules/@capacitor/android', true],
    ['node_modules/@capacitor/android/package.json', false],
    ['node_modules/@capacitor/android/capacitor/build/intermediates/lint_model/debug/debug-artifact-libraries.xml', false],
  ]) assert.equal(filter(join(root, name), {moduleFullFilePath: name, isDirectory: () => directory}), false);
  for (const name of ['node_modules/@capacitor/core/dist/index.js', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'node_modules/react/index.js']) {
    assert.equal(filter(join(root, name), {moduleFullFilePath: name, isDirectory: () => false}), true);
  }
});
test('ZIP names decode UTF-8 with or without the flag, including ditto data descriptors', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workbench-zip-encoding-fixture-'));
  try {
    const name = '学习工作台.app/Contents/MacOS/学习工作台';
    const body = 'public executable fixture';
    const unflagged = join(folder, 'ditto-style.zip'), flagged = join(folder, 'flagged.apk');
    const script = `import io,pathlib,sys,zipfile
class Unseekable(io.BytesIO):
 def seek(self,*args): raise OSError('fixture uses data descriptors')
class UnflaggedUTF8(zipfile.ZipInfo):
 def _encodeFilenameFlags(self): return self.filename.encode('utf-8'),self.flag_bits & ~0x800
buffer=Unseekable()
with zipfile.ZipFile(buffer,'w') as z: z.writestr(UnflaggedUTF8(sys.argv[3]),sys.argv[4])
pathlib.Path(sys.argv[1]).write_bytes(buffer.getvalue())
with zipfile.ZipFile(sys.argv[1],metadata_encoding='utf-8') as z:
 assert z.getinfo(sys.argv[3]).flag_bits == 8
with zipfile.ZipFile(sys.argv[2],'w') as z: z.writestr(sys.argv[3],sys.argv[4])
with zipfile.ZipFile(sys.argv[2]) as z: assert z.getinfo(sys.argv[3]).flag_bits & 0x800
`;
    execFileSync('python3', ['-c', script, unflagged, flagged, name, body]);
    for (const path of [unflagged, flagged]) {
      const result = zipContents(path, [name]);
      assert(result.names.includes(name));
      assert.equal(result.hashes[name], createHash('sha256').update(body).digest('hex'));
    }
  } finally { await rm(folder, {recursive: true, force: true}); }
});
test('APK verifier checks ZIP notices and SHA256-bound manifest/signature evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workbench-apk-fixture-'));
  try {
    const apk = join(folder, 'fixture.apk'), identityPath = join(folder, 'identity.json');
    const root = new URL('../', import.meta.url).pathname;
    execFileSync('python3', ['-c', "import sys,zipfile,pathlib\nr=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(sys.argv[2],'w')\nfor base,prefix in [(r/'licenses','assets/public/licenses/'),(r/'android/app/src/main/assets/licenses','assets/licenses/')]:\n for f in sorted(base.rglob('*')):\n  if f.is_file(): z.write(f,prefix+str(f.relative_to(base)))\nz.writestr('AndroidManifest.xml','manifest fixture');z.writestr('assets/public/index.html','public fixture');z.close()", decodeURIComponent(root), apk]);
    const identity = {apkSha256: createHash('sha256').update(await readFile(apk)).digest('hex'), applicationId: 'dev.growthworkbench.app', versionName: '0.11.1', versionCode: 11001, minSdkVersion: 29, targetSdkVersion: 36, debuggable: false, signatureVerified: true, certificateSha256: 'A50F3283C22532FB7A119414E7009EE973FE8E841C48C71E02FDC3E5FF0A217C'};
    await writeFile(identityPath, JSON.stringify(identity));
    const args = ['--android-apk', apk, '--android-identity', identityPath, '--output', join(folder, 'checksums.json')];
    assert.equal((await verifyRelease(args)).results[0].identity.versionCode, 11001);
    await writeFile(identityPath, JSON.stringify({...identity, certificateSha256: 'wrong'}));
    await assert.rejects(verifyRelease(args), /certificate evidence mismatch/);
    await writeFile(identityPath, JSON.stringify({...identity, apkSha256: 'wrong'}));
    await assert.rejects(verifyRelease(args), /manifest identity/);
  } finally { await rm(folder, {recursive: true, force: true}); }
});
test('Release preflight rejects missing signing inputs and never reads their contents', async () => {
  assert.throws(() => requireSigningEnvironment({}), /requires WORKBENCH_ANDROID_KEYSTORE/);
  const folder = await mkdtemp(join(tmpdir(), 'workbench-signing-fixture-'));
  try {
    const path = join(folder, 'fixture'); await writeFile(path, 'public test fixture, not a key');
    requireSigningEnvironment({WORKBENCH_ANDROID_KEYSTORE: path, WORKBENCH_ANDROID_KEY_ALIAS: 'fixture', WORKBENCH_ANDROID_STORE_PASSWORD_FILE: path, WORKBENCH_ANDROID_KEY_PASSWORD_FILE: path});
    assert.throws(() => requireSigningEnvironment({WORKBENCH_ANDROID_KEYSTORE: folder}), /existing file/);
  } finally { await rm(folder, {recursive: true, force: true}); }
});
test('Release verifier checks notices/identity, and rejects absent and private payloads', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workbench-release-fixture-'));
  const payload = join(folder, 'win-unpacked'), resources = join(payload, 'resources');
  const root = new URL('../', import.meta.url);
  try {
    await assert.rejects(verifyRelease(['--win-installer', join(folder, 'missing.exe')]), /requires corresponding/);
    await assert.rejects(verifyRelease(['--win-unpacked', join(folder, 'missing')]), /ENOENT/);
    const source = join(folder, 'asar-source'); await mkdir(source, {recursive: true}); await mkdir(resources, {recursive: true});
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    await writeFile(join(source, 'package.json'), JSON.stringify({name: pkg.name, version: pkg.version}));
    const require = createRequire(import.meta.url);
    const asar = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'))('@electron/asar');
    await asar.createPackage(source, join(resources, 'app.asar'));
    await cp(new URL('licenses/', root), join(resources, 'licenses'), {recursive: true});
    for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) await writeFile(join(resources, 'licenses', name), 'Public license fixture\n'.repeat(10));
    await writeFile(join(payload, pkg.build.win.executableName + '.exe'), 'MZ fixture');
    const args = ['--win-unpacked', payload, '--output', join(folder, 'checksums.json')];
    const result = await verifyRelease(args); assert.equal(result.runtimeAcceptance, 'not performed');
    assert(!JSON.stringify(result).includes(folder));
    await writeFile(join(resources, '.env'), 'fixture');
    await assert.rejects(verifyRelease(args), /Private file excluded/); await rm(join(resources, '.env'));
    await writeFile(join(resources, 'leak.json'), JSON.stringify({fixture: ['/Users', 'mac', 'private-fixture'].join('/')}));
    await assert.rejects(verifyRelease(args), /Private machine path excluded/); await rm(join(resources, 'leak.json'));
    const identity = join(resources, 'licenses/release-identity.json'); const original = await readFile(identity);
    await writeFile(identity, JSON.stringify({...JSON.parse(original), appId: 'wrong.fixture'}));
    await assert.rejects(verifyRelease(args), /identity\/version mismatch/); await writeFile(identity, original);
    await rm(join(resources, 'licenses/pdfjs-dist-6.4.299-LICENSE'));
    await assert.rejects(verifyRelease(args), /ENOENT/);
  } finally { await rm(folder, {recursive: true, force: true}); }
});
