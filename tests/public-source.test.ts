import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/export-public-source.mjs', import.meta.url));
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })));
});

async function fixture(extra: Record<string, string | Buffer> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'public-source-')));
  folders.push(root);
  const source = path.join(root, 'source');
  const output = path.join(root, 'snapshot');
  const files = {
    'README.md': '# Public project\n\n[Export policy](docs/public-source.md)\n',
    'LICENSE': 'MIT test fixture\n',
    'package.json': '{"name":"public-source-fixture","version":"1.0.0","type":"module"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
    'docs/public-source.md': '# Public source policy\n',
    'src/main.ts': 'export const message = "学习记录由用户自己保存";\n',
    'tests/fake.test.ts': 'const apiKey = "sk-example-not-a-real-key";\n',
    'scripts/build.mjs': 'console.log("build");\n',
    'website/index.html': '<!doctype html><title>Public fixture</title>\n',
    '.github/workflows/ci.yml': 'name: CI\n',
    'licenses/example-1.0.0-LICENSE': 'Fixture license\n',
    '.gitignore': 'node_modules/\n.cache/\n',
    ...extra,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(source, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  return { root, source, output };
}

function run(source: string, output: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, '--source', source, '--output', output, ...args], { encoding: 'utf8' });
}

async function filesUnder(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await filesUnder(path.join(directory, entry.name), relative + '/'));
    else result.push(relative);
  }
  return result.sort();
}

describe('fresh public source export', () => {
  it('exports complete minimal native/server source, exact public docs and executable modes', async () => {
    const selected = [
      'README.md', 'THIRD_PARTY_NOTICES.md', 'docs/public-source.md',
      '.dockerignore', 'capacitor.config.ts', 'vite.android.config.ts', 'android-web/index.html',
      'server/cli.ts', 'server/migrations/001-initial.sql', 'worker/main.ts',
      'android/build.gradle', 'android/settings.gradle', 'android/variables.gradle',
      'android/app/build.gradle', 'android/app/capacitor.build.gradle', 'android/app/proguard-rules.pro',
      'android/capacitor.settings.gradle', 'android/gradle.properties', 'android/gradlew', 'android/gradlew.bat',
      'android/gradle/wrapper/gradle-wrapper.properties', 'android/gradle/wrapper/gradle-wrapper.jar',
      'android/app/src/main/AndroidManifest.xml', 'android/app/src/main/java/dev/growthworkbench/app/MainActivity.java',
      'android/app/src/main/res/values/strings.xml', 'android/app/src/main/res/mipmap-mdpi/ic_launcher.png',
      'android/app/src/main/assets/licenses/sources.json', 'licenses/android-native/Apache-2.0.txt',
      'deploy/.env.example', 'deploy/server.Dockerfile', 'deploy/worker.Dockerfile', 'deploy/Caddyfile',
      'deploy/compose.yaml', 'deploy/backup.sh', 'deploy/restore.sh', 'deploy/egress-guard.sh', 'deploy/egress.conf',
      'deploy/licenses/NOTICE.md', 'docs/operations/deployment.md', 'docs/operations/backup-restore.md',
      'docs/operations/offhost-backup.md', 'docs/operations/capture-broker.md',
      'docs/releases/personal-workbench-acceptance.md', 'docs/research/2026-10-24-capture-source-evidence.json',
    ];
    const inputs: Record<string, Buffer> = {};
    for (const relative of selected) inputs[relative] = await readFile(new URL('../' + relative, import.meta.url));
    const {source, output} = await fixture({
      ...inputs,
      'android/build/private.bin': Buffer.from([0,1]),
      'android/.gradle/private.bin': Buffer.from([0,1]),
      'android/local.properties': 'sdk.dir=private-sdk',
      'android/app/src/main/assets/public/index.html': 'generated web payload',
      'android/app/src/main/assets/capacitor.config.json': 'generated config',
      'android/signing/release.key': 'private key',
      'server/userData/records.json': 'private',
      'deploy/.env': 'private', 'deploy/capture-dist/worker.mjs': 'built',
      'deploy/operator-notes.md': 'private', 'docs/research/private.md': 'private',
    });
    await chmod(path.join(source, 'android/gradlew'), 0o755);
    await chmod(path.join(source, 'deploy/backup.sh'), 0o755);
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    const files = await filesUnder(output);
    for (const relative of selected) expect(await readFile(path.join(output, relative))).toEqual(inputs[relative]);
    expect(files.filter(file => /^(android|server|worker|deploy)\//.test(file))).toEqual(selected.filter(file => /^(android|server|worker|deploy)\//.test(file)).sort());
    expect(files).not.toContain('docs/research/private.md');
    const manifest = JSON.parse(await readFile(path.join(output, 'PUBLIC_SOURCE_MANIFEST.json'), 'utf8'));
    expect(manifest.files.find((file: {path: string}) => file.path === 'android/gradlew').mode).toBe('0755');
    expect((await stat(path.join(output, 'android/gradlew'))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(output, 'deploy/backup.sh'))).mode & 0o777).toBe(0o755);
  });

  it('only admits the pinned wrapper JAR and rejects altered bytes before output creation', async () => {
    const jar = await readFile(new URL('../android/gradle/wrapper/gradle-wrapper.jar', import.meta.url));
    expect(createHash('sha256').update(jar).digest('hex')).toBe('7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172');
    const {source, output} = await fixture({'android/gradle/wrapper/gradle-wrapper.jar': Buffer.concat([jar, Buffer.from('modified')])});
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('wrapper integrity');
    await expect(readdir(output)).rejects.toMatchObject({code:'ENOENT'});
  });

  it('omits workflows only when explicitly requested while preserving other public GitHub config', async () => {
    const {source, output} = await fixture({'.github/ISSUE_TEMPLATE/bug.md': 'Public issue template'});
    const result = run(source, output, ['--omit-workflows']);
    expect(result.status, result.stderr).toBe(0);
    expect(await filesUnder(output)).toContain('.github/ISSUE_TEMPLATE/bug.md');
    expect(await filesUnder(output)).not.toContain('.github/workflows/ci.yml');
    const manifest = JSON.parse(await readFile(path.join(output, 'PUBLIC_SOURCE_MANIFEST.json'), 'utf8'));
    expect(manifest.omitWorkflows).toBe(true);
  });

  it.each(['server/cli.ts', 'worker/main.ts', 'deploy/.env.example', 'android/app/src/main/java/dev/growthworkbench/app/MainActivity.java'])
    ('scans newly selected source %s for credentials', async relative => {
      const secret = 'ghp_' + 'A1b2C3d4E5f6'.repeat(4);
      const {source, output} = await fixture({[relative]: secret});
      const result = run(source, output);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('credential pattern');
      expect(result.stderr).not.toContain(secret);
    });

  it('exports only exact authored document fixtures with pinned PDF bytes', async () => {
    const selected = ['tests/fixtures/workbench/reading-two-pages.pdf', 'tests/fixtures/workbench/schedule.csv', 'tests/fixtures/workbench/schedule.ics'];
    const inputs: Record<string, Buffer> = {};
    for (const relative of selected) inputs[relative] = await readFile(new URL('../' + relative, import.meta.url));
    const {source, output} = await fixture(inputs);
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    for (const relative of selected) expect(await readFile(path.join(output, relative))).toEqual(inputs[relative]);
  });

  it('rejects altered PDF fixture bytes', async () => {
    const {source, output} = await fixture({'tests/fixtures/workbench/reading-two-pages.pdf': '%PDF-1.7 fake'});
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fixture integrity');
  });

  it('requires relative links in selected public operations docs to close within the snapshot', async () => {
    const {source, output} = await fixture({'docs/operations/deployment.md': '[Private runbook](secret-runbook.md)'});
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('docs/operations/deployment.md');
    expect(result.stderr).toContain('link');
  });

  it('rejects symlink ancestors in exact selected public docs', async () => {
    const {source, output, root} = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'deployment.md'), 'outside');
    await symlink(outside, path.join(source, 'docs/operations'));
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlink');
  });

  it('writes the manifest modes exactly even under a restrictive process umask', async () => {
    const {source, output} = await fixture({'android/gradlew': '#!/bin/sh\necho fixture\n'});
    await chmod(path.join(source, 'android/gradlew'), 0o755);
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', 'process.umask(0o077); await import(process.argv[1]);', script, '--source', source, '--output', output], {encoding:'utf8'});
    expect(result.status, result.stderr).toBe(0);
    expect((await stat(path.join(output, 'android/gradlew'))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(output, 'README.md'))).mode & 0o777).toBe(0o644);
  });

  it('exports optional ASR preparation sources while omitting generated runtime, weights and cache', async () => {
    const selected = ['scripts/prepare-browser-asr.mjs', 'src/browser/voice/resources.json'];
    const sourceFiles: Record<string, Buffer> = {};
    for (const relative of selected) sourceFiles[relative] = await readFile(new URL('../' + relative, import.meta.url));
    const {source, output} = await fixture({
      ...sourceFiles,
      'dist-browser/optional-asr/1.13.8/build-a/sherpa-onnx-wasm-web.wasm': Buffer.from([0,97,115,109]),
      'dist-browser/optional-asr/1.13.8/build-a/model.int8.onnx': Buffer.from([0,1,2]),
      '.cache/browser-local-voice/prepared/model.int8.onnx': Buffer.from([0,1,2]),
      '.cache/browser-local-voice/sherpa_onnx_web-1.13.8.tar.gz': Buffer.from([0,1,2]),
    });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    const files = await filesUnder(output);
    for (const relative of selected) expect(await readFile(path.join(output, relative))).toEqual(sourceFiles[relative]);
    expect(files.some(file => file.includes('optional-asr/') || file.startsWith('.cache/'))).toBe(false);
  });

  it('keeps the existing 8 MiB source file limit for optional preparation code', async () => {
    const {source, output} = await fixture({'scripts/prepare-browser-asr.mjs': Buffer.alloc(8 * 1024 * 1024 + 1, 'x')});
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scripts/prepare-browser-asr.mjs');
    await expect(readdir(output)).rejects.toMatchObject({code:'ENOENT'});
  });

  it('exports the real browser entry, config, manifest and icons without browser build or personal data', async () => {
    const publicBrowserFiles = [
      'vite.browser.config.ts', 'browser/index.html', 'browser/public/manifest.webmanifest',
      'browser/public/icons/icon-192.png', 'browser/public/icons/icon-512.png',
      'browser/public/icons/maskable-512.png', 'browser/public/icons/README.md',
      'src/browser/main.tsx', 'scripts/build-browser-sw.mjs',
    ];
    const browserFiles: Record<string, Buffer> = {};
    for (const relative of publicBrowserFiles) {
      browserFiles[relative] = await readFile(new URL('../' + relative, import.meta.url));
    }
    const { source, output } = await fixture({
      ...browserFiles,
      'browser/public/icons/example.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
      'dist-browser/index.html': 'built browser output\n',
      'browser/dist-browser/index.html': 'nested built browser output\n',
      'browser/public/personal/answers.json': 'personal learning answers\n',
      'browser/userData/notes.json': 'nested browser user data\n',
      'browser/public/private/history.json': 'private browser history\n',
      'browser/public/resources/speech/model.onnx': 'downloaded model\n',
      'browser/public/models.json': 'model credentials\n',
      'browser/public/models-backup.json': 'model credential backup\n',
      'browser/public/.env.local': 'private environment\n',
      'resources/speech/model.onnx': 'downloaded model\n',
      'userData/history.json': 'personal history\n',
      '.git/logs/HEAD': 'private commit history\n',
    });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    const exported = await filesUnder(output);
    const selected = [...publicBrowserFiles, 'browser/public/icons/example.svg'];
    expect(exported.filter(file => file.startsWith('browser/') || file === 'vite.browser.config.ts'))
      .toEqual(selected.filter(file => file.startsWith('browser/') || file === 'vite.browser.config.ts').sort());
    expect(exported).toContain('src/browser/main.tsx');
    expect(exported).toContain('scripts/build-browser-sw.mjs');
    expect(exported.some(file => /^(?:dist-browser|resources|userData|\.git)\//.test(file))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(output, 'PUBLIC_SOURCE_MANIFEST.json'), 'utf8'));
    for (const relative of selected) {
      const bytes = await readFile(path.join(source, relative));
      expect((await readFile(path.join(output, relative))).equals(bytes)).toBe(true);
      expect(manifest.files.find((file: { path: string }) => file.path === relative)).toEqual({
        path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: '0644',
      });
    }
  });

  it.each(['browser/index.html', 'browser/public/manifest.webmanifest', 'browser/public/icons/example.svg', 'vite.browser.config.ts'])
    ('scans credentials in newly selected browser source %s', async relative => {
      const secret = 'sk-proj-' + 'A1b2C3d4E5f6G7h8'.repeat(3);
      const { source, output, root } = await fixture({ [relative]: secret });
      const result = run(source, output);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('credential pattern');
      expect(result.stderr).toContain(relative);
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(source);
      expect(await readdir(root)).not.toContain('snapshot');
    });

  it('scans browser icon bytes after a valid PNG header', async () => {
    const secret = 'sk-proj-' + 'A1b2C3d4E5f6G7h8'.repeat(3);
    const contents = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(secret)]);
    const { source, output } = await fixture({ 'browser/public/icons/icon.png': contents });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('credential pattern');
    expect(result.stderr).not.toContain(secret);
  });

  it.each([
    ['browser/public/icons/icon.png', 'not a PNG'],
    ['browser/public/manifest.webmanifest', 'binary\0manifest'],
  ])('checks the binary type of newly selected browser source %s', async (relative, contents) => {
    const { source, output } = await fixture({ [relative]: contents });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected binary file type');
  });

  it('rejects personal home paths in browser source', async () => {
    const homePath = '/' + 'Users/' + 'PrivateOwner/Desktop/classroom.txt';
    const { source, output } = await fixture({ 'browser/index.html': homePath });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('personal home path');
    expect(result.stderr).not.toContain(homePath);
  });

  it.each(['browser', 'browser/public', 'vite.browser.config.ts'])('rejects newly selected browser symlink %s', async relative => {
    const { source, output, root } = await fixture();
    const target = path.join(root, 'external');
    if (relative.endsWith('.ts')) await writeFile(target, 'external config');
    else await mkdir(target);
    await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await symlink(target, path.join(source, relative));
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlink');
    expect(result.stderr).not.toContain(target);
    expect(await readdir(root)).not.toContain('snapshot');
  });

  it('exports selected public files, omits local history/data and hashes exactly the copied bytes', async () => {
    const { source, output } = await fixture({
      '.git/config': 'private history\n',
      'node_modules/private/index.js': 'not source\n',
      '.cache/private.json': 'cache\n',
      'release/backup.zip': 'installer\n',
      'resources/speech/model.onnx': 'downloaded model\n',
      'userData/state.json': 'personal answers\n',
      'docs/research/internal.md': 'private research\n',
      'docs/cache-qa.md': 'private QA\n',
      'docs/plans/internal.md': 'private plan\n',
      'docs/superpowers/specs/internal.md': 'private specification\n',
      'src/userData/state.json': 'nested user data\n',
      'src/.env.local': 'API_KEY=not-for-export\n',
      'assets/signing/certificate.p12': 'signing material\n',
    });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    const exported = await filesUnder(output);
    expect(exported).toEqual([
      '.github/workflows/ci.yml', '.gitignore', 'LICENSE', 'PUBLIC_SOURCE_MANIFEST.json', 'README.md',
      'docs/public-source.md', 'licenses/example-1.0.0-LICENSE', 'package.json', 'pnpm-lock.yaml',
      'scripts/build.mjs', 'src/main.ts', 'tests/fake.test.ts', 'website/index.html',
    ]);
    const serialized = await readFile(path.join(output, 'PUBLIC_SOURCE_MANIFEST.json'), 'utf8');
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain(output);
    const manifest = JSON.parse(serialized);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(exported.filter(file => file !== 'PUBLIC_SOURCE_MANIFEST.json'));
    for (const file of manifest.files) {
      const data = await readFile(path.join(output, file.path));
      expect(file.bytes).toBe(data.length);
      expect(file.sha256).toBe(createHash('sha256').update(data).digest('hex'));
      expect(data.equals(await readFile(path.join(source, file.path)))).toBe(true);
    }
  });

  it('does not rewrite learner examples or known fake credentials', async () => {
    const contents = 'const apiKey = "YOUR_API_KEY"; const url = "https://user:pass@example.com/v1"; const lesson = "请输入自己的 API Key";\n';
    const { source, output } = await fixture({ 'tests/example.test.ts': contents });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(output, 'tests/example.test.ts'), 'utf8')).toBe(contents);
  });

  it('preserves the one-character x:y URL used to test real-site credential rejection', async () => {
    const contents = 'const rejectedUrl = "https://x:y@www.runoob.com/";\n';
    const { source, output } = await fixture({ 'tests/url-security.test.ts': contents });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(output, 'tests/url-security.test.ts'), 'utf8')).toBe(contents);
  });

  it('preserves a reserved example-host URL used by the website verifier', async () => {
    const contents = 'const invalidRelease = "https://user:secret@example.com/";\n';
    const { source, output } = await fixture({ 'website/verify.mjs': contents });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(output, 'website/verify.mjs'), 'utf8')).toBe(contents);
  });

  it.each(['file', 'directory'])('rejects an included symlink %s before creating an export', async kind => {
    const { source, output, root } = await fixture();
    const privateFile = path.join(root, 'private.ts');
    await writeFile(privateFile, 'private outside the source tree');
    if (kind === 'file') await symlink(privateFile, path.join(source, 'src', 'leak.ts'));
    else await symlink(root, path.join(source, 'src', 'linked'));
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symlink/i);
    expect(result.stderr).not.toContain(privateFile);
    expect(result.stderr).not.toContain('private outside');
    expect(await readdir(root)).not.toContain('snapshot');
  });

  it.each(['src/blob.zip', 'tests/answer.csv', 'website/.hidden.js', 'src/private notes.ts'])('rejects unexpected selected path %s', async relative => {
    const { source, output, root } = await fixture({ [relative]: 'unexpected' });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/path|type|extension/i);
    expect(await readdir(root)).not.toContain('snapshot');
  });

  it('checks binary contents instead of accepting renamed arbitrary files', async () => {
    const { source, output } = await fixture({ 'assets/icon.png': 'not a PNG' });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('assets/icon.png');
  });

  it('scans a credential embedded after a valid image header', async () => {
    const secret = 'sk-proj-' + 'A1b2C3d4E5f6G7h8'.repeat(3);
    const contents = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(secret)]);
    const { source, output, root } = await fixture({ 'assets/icon.png': contents });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('assets/icon.png');
    expect(result.stderr).not.toContain(secret);
    expect(await readdir(root)).not.toContain('snapshot');
  });

  it.each([
    ['OpenAI', () => 'sk-proj-' + 'aBcDeF0123456789'.repeat(4)],
    ['DeepSeek', () => 'sk-' + 'a1b2c3d4e5f60789'.repeat(2)],
    ['GitHub', () => 'ghp_' + 'aBcDeF012345'.repeat(3)],
    ['AWS', () => 'AKIA' + 'A1B2C3D4E5F6G7H8'],
    ['private key', () => ['-----BEGIN', ' PRIVATE KEY-----\nprivate bytes'].join('')],
    ['credential URL', () => 'https://' + 'actual-user:actual-password@real-provider.com/v1'],
    ['uppercase credential URL', () => 'HTTPS://' + 'actual-user:actual-password@real-provider.com/v1'],
  ])('rejects a %s secret without printing its value or an absolute source path', async (_name, value) => {
    const secret = value();
    const { source, output, root } = await fixture({ 'src/config.ts': `const credential = ${JSON.stringify(secret)};\n` });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('src/config.ts');
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(source);
    expect(await readdir(root)).not.toContain('snapshot');
  });

  it('rejects a personal home path in selected product code', async () => {
    const homePath = '/' + 'Users/' + 'PrivateOwner/Desktop/classroom.txt';
    const { source, output } = await fixture({ 'src/config.ts': `const privatePath = ${JSON.stringify(homePath)};\n` });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('src/config.ts');
    expect(result.stderr).not.toContain(homePath);
  });

  it('rejects a lowercase Windows home path in selected product code', async () => {
    const homePath = 'c:' + '\\users\\PrivateOwner\\Documents\\classroom.txt';
    const { source, output } = await fixture({ 'src/config.ts': `const privatePath = ${JSON.stringify(homePath)};\n` });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('src/config.ts');
    expect(result.stderr).not.toContain(homePath);
  });

  it('preserves deliberate fake home paths in security tests', async () => {
    const fakeAccount = path.basename(homedir()).toLowerCase() === 'alice' ? 'bob' : 'alice';
    const homePath = '/' + 'Users/' + fakeAccount + '/private.txt';
    const contents = `const invalidPath = ${JSON.stringify(homePath)};\n`;
    const { source, output } = await fixture({ 'tests/path-security.test.ts': contents });
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(path.join(output, 'tests/path-security.test.ts'), 'utf8')).toBe(contents);
  });

  it('rejects README links to documents omitted from the snapshot', async () => {
    const { source, output } = await fixture({ 'README.md': '[Private QA](docs/cache-qa.md)\n', 'docs/cache-qa.md': 'private\n' });
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('README.md');
    expect(result.stderr).toMatch(/link/i);
  });

  it('refuses to overwrite an existing output directory', async () => {
    const { source, output } = await fixture();
    await mkdir(output);
    await writeFile(path.join(output, 'do-not-touch.txt'), 'keep this');
    const result = run(source, output);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/output.*exists/i);
    expect(await readFile(path.join(output, 'do-not-touch.txt'), 'utf8')).toBe('keep this');
    expect(await readdir(output)).toEqual(['do-not-touch.txt']);
  });

  it('preserves a preexisting directory if the output ancestor is replaced after creation', async () => {
    const { source, root } = await fixture();
    const parent = path.join(root, 'output-parent');
    const output = path.join(parent, 'snapshot');
    const privateParent = path.join(root, 'preexisting-parent');
    const privateOutput = path.join(privateParent, 'snapshot');
    await mkdir(parent);
    await mkdir(privateOutput, { recursive: true });
    await writeFile(path.join(privateOutput, '.gitignore'), 'preexisting file forces wx collision');
    await writeFile(path.join(privateOutput, 'sentinel.txt'), 'keep this private fixture');
    // Interpose only the real mkdir boundary to model the otherwise timing-dependent ancestor change.
    const preload = path.join(root, 'replace-parent.mjs');
    await writeFile(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.promises.mkdir;
      let changed = false;
      fs.promises.mkdir = async (file, options) => {
        const result = await original(file, options);
        if (String(file) === ${JSON.stringify(output)} && !options?.recursive && !changed) {
          changed = true;
          await fs.promises.rename(${JSON.stringify(parent)}, ${JSON.stringify(parent + '-moved')});
          await fs.promises.symlink(${JSON.stringify(privateParent)}, ${JSON.stringify(parent)});
        }
        return result;
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', preload, script, '--source', source, '--output', output], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(await readFile(path.join(privateOutput, 'sentinel.txt'), 'utf8')).toBe('keep this private fixture');
    expect(await readFile(path.join(privateOutput, '.gitignore'), 'utf8')).toBe('preexisting file forces wx collision');
  });

  it('rejects output within a public source directory', async () => {
    const { source } = await fixture();
    const result = run(source, path.join(source, 'src', 'snapshot'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/output.*path/i);
    expect(await readdir(path.join(source, 'src'))).toEqual(['main.ts']);
  });

  it('allows a new cache snapshot without recursively exporting existing cache snapshots', async () => {
    const { source } = await fixture({ '.cache/old-export/src/private.ts': 'old copy' });
    const output = path.join(source, '.cache', 'new-export');
    const result = run(source, output);
    expect(result.status, result.stderr).toBe(0);
    expect(await filesUnder(output)).not.toContain('.cache/old-export/src/private.ts');
  });

  it('fails on ambiguous command arguments without leaking argument values', async () => {
    const { source, output } = await fixture();
    const result = run(source, output, ['--force', 'private-argument-value']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain('private-argument-value');
    expect(result.stderr).toMatch(/argument/i);
  });
});
