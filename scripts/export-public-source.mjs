import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Explicitly selected files are exported from the current working tree, never Git history.
const rootFiles = new Set([
  '.dockerignore', 'capacitor.config.ts', 'vite.android.config.ts', '.gitignore', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md',
  'SECURITY.md', 'CHANGELOG.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'index.html', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vite.browser.config.ts', 'vitest.config.ts',
]);
const publicDocs = new Set([
  'docs/public-source.md', 'docs/operations/deployment.md', 'docs/operations/backup-restore.md',
  'docs/operations/offhost-backup.md', 'docs/operations/capture-broker.md',
  'docs/releases/personal-workbench-acceptance.md', 'docs/research/2026-10-24-capture-source-evidence.json',
]);
const exactSources = new Set([
  'android/build.gradle', 'android/settings.gradle', 'android/variables.gradle', 'android/gradle.properties',
  'android/capacitor.settings.gradle', 'android/app/build.gradle', 'android/app/capacitor.build.gradle',
  'android/app/proguard-rules.pro', 'android/app/src/main/AndroidManifest.xml',
  'android/gradlew', 'android/gradlew.bat', 'android/gradle/wrapper/gradle-wrapper.properties',
  'android/gradle/wrapper/gradle-wrapper.jar',
  'deploy/.env.example', 'deploy/server.Dockerfile', 'deploy/worker.Dockerfile', 'deploy/Caddyfile',
  'deploy/compose.yaml', 'deploy/backup.sh', 'deploy/restore.sh', 'deploy/egress-guard.sh', 'deploy/egress.conf',
]);
const extraTrees = [
  'android/app/src/main/java', 'android/app/src/androidTest/java', 'android/app/src/main/res',
  'android/app/src/main/assets/licenses', 'deploy/licenses',
];
const documentFixtures = new Set([
  'tests/fixtures/workbench/reading-two-pages.pdf', 'tests/fixtures/workbench/schedule.csv',
  'tests/fixtures/workbench/schedule.ics',
]);
const pdfFixturePath = 'tests/fixtures/workbench/reading-two-pages.pdf';
const pdfFixtureSha256 = 'ccf50fc7169305910b032eadcf22cd47e61341d9835a3a8b8011f8ab220ae6a1';
const wrapperPath = 'android/gradle/wrapper/gradle-wrapper.jar';
const wrapperSha256 = '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172';
const executablePaths = new Set(['android/gradlew', 'deploy/backup.sh', 'deploy/restore.sh', 'deploy/egress-guard.sh']);
const extensions = {
  server: new Set(['.ts', '.sql']),
  worker: new Set(['.ts']),
  'android-web': new Set(['.html']),
  src: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.html', '.svg']),
  tests: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.txt']),
  scripts: new Set(['.mjs', '.cjs', '.js', '.ts', '.py', '.sh', '.ps1']),
  assets: new Set(['.png', '.icns', '.ico', '.svg', '.plist', '.jpg', '.jpeg', '.webp', '.gif']),
  browser: new Set(['.html', '.webmanifest', '.png', '.svg', '.md']),
  licenses: new Set(['.md', '.txt', '.json', '.html']),
  website: new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.svg', '.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif', '.txt']),
  '.github': new Set(['.yml', '.yaml', '.md', '.json']),
};
const excludedDirectories = new Set([
  '.git', '.cache', 'node_modules', 'userdata', 'user-data', 'personal', 'private',
  'backups', 'backup', 'exports', 'tutorial-cache', 'credentials', 'secrets', 'signing',
  'resources', 'release', 'dist', 'dist-main', 'dist-browser', 'dist-android', 'dist-server',
  'build', '.gradle', 'generated', 'capture-dist', '__pycache__',
]);
const excludedFiles = /^(?:\.env(?:\..*)?|\.DS_Store|state\.json|models(?:-backup)?\.json|(?:credentials|secrets|backup)\.(?:json|ya?ml|txt)|.*\.(?:pem|key|p12|pfx|p8|sqlite|sqlite3|db|bak))$/i;
const maxFileBytes = 8 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;
const manifestName = 'PUBLIC_SOURCE_MANIFEST.json';

class ExportError extends Error {}

function reject(reason, relative) {
  // Never put file contents, source roots, credentials or raw OS errors in diagnostics.
  const name = relative?.replace(/[^A-Za-z0-9._@+ /-]/g, '?');
  throw new ExportError(`Public export rejected: ${reason}${name ? ` (${name})` : ''}`);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function statIfPresent(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function allowedName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(name);
}

function allowedType(relative) {
  if (documentFixtures.has(relative)) return true;
  const [root] = relative.split('/');
  const name = path.posix.basename(relative);
  if (root === 'android') return new Set(['.java', '.xml', '.png', '.txt', '.json']).has(path.posix.extname(name).toLowerCase());
  if (root === 'deploy') return new Set(['.md', '.txt']).has(path.posix.extname(name).toLowerCase());
  return extensions[root]?.has(path.posix.extname(name).toLowerCase())
    || (root === 'licenses' && /(?:^|[-.])(?:LICENSE|COPYING|NOTICE|AUTHORS)(?:-[A-Z0-9-]+)?$/i.test(name));
}

function scanContents(relative, buffer) {
  // Scan all selected bytes, including images, so a renamed key is not a loophole.
  const contents = buffer.toString('utf8');
  const patterns = [
    /\bsk-(?:(?:proj|ant-api\d+|ant)-)?[A-Za-z0-9_-]{28,}\b/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bAIza[A-Za-z0-9_-]{35}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/,
    /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  ];
  if (patterns.some(pattern => pattern.test(contents))) reject('credential pattern', relative);
  for (const match of contents.matchAll(/https?:\/\/([^\s/:"'<>]+):([^\s/@"'<>]+)@([^\s/"'<>]+)/gi)) {
    const host = match[3].replace(/:\d+$/, '').toLowerCase();
    const reservedHost = /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/.test(host)
      || /\.(?:test|invalid|example)$/.test(host);
    const loopbackHost = /^(?:localhost|127\.0\.0\.1)$/.test(host);
    const fixturePair = match[1] === 'x' && match[2] === 'y';
    if (!reservedHost && !(relative.startsWith('tests/') && (loopbackHost || fixturePair))) reject('credential URL', relative);
  }
  // Test fixtures may use conventional fictional accounts; the actual host account is never exempt.
  const currentAccount = path.basename(homedir()).toLowerCase();
  const fakeAccounts = new Set(['alice', 'bob', 'user', 'learner', 'example', 'test', 'tester']);
  const homePaths = /(?:\/(?:Users|home)\/|[A-Za-z]:[\\/]+Users[\\/]+)([^\s/\\"'`<>]+)/gi;
  for (const match of contents.matchAll(homePaths)) {
    const account = match[1].toLowerCase();
    if (!(relative.startsWith('tests/') && fakeAccounts.has(account) && account !== currentAccount)) {
      reject('personal home path', relative);
    }
  }
  if (relative === pdfFixturePath) {
    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-'
      || createHash('sha256').update(buffer).digest('hex') !== pdfFixtureSha256) reject('fixture integrity', relative);
    return;
  }
  if (relative === wrapperPath) {
    if (!buffer.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
      || createHash('sha256').update(buffer).digest('hex') !== wrapperSha256) reject('wrapper integrity', relative);
    return;
  }
  const extension = path.posix.extname(relative).toLowerCase();
  const magic = {
    '.png': () => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    '.icns': () => buffer.subarray(0, 4).toString('ascii') === 'icns',
    '.ico': () => buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
    '.jpg': () => buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    '.jpeg': () => buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    '.gif': () => /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii')),
    '.webp': () => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (magic[extension] && !magic[extension]()) reject('unexpected binary file type', relative);
  if (!magic[extension] && contents.includes('\0')) reject('unexpected binary file type', relative);
}

function validateDocumentLinks(files) {
  const selected = new Set(files.map(file => file.path));
  if (!selected.has('README.md')) reject('missing required file', 'README.md');
  for (const document of files.filter(file => file.path === 'README.md' || (publicDocs.has(file.path) && file.path.endsWith('.md')))) {
    const text = document.buffer.toString('utf8');
    const targets = [
      ...Array.from(text.matchAll(/!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g), match => match[1]),
      ...Array.from(text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm), match => match[1]),
    ];
    for (const target of targets) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { reject('invalid document link', document.path); }
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(document.path), decoded.replace(/:\d+$/, '')));
      if (selected.has(relative) || [...selected].some(file => file.startsWith(relative.replace(/\/$/, '') + '/'))) continue;
      reject('document link points outside selected public files', document.path);
    }
  }
}

async function readSelected(source, relative) {
  const parts = relative.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = await lstat(path.join(source, ...parts.slice(0, index)));
    if (parent.isSymbolicLink()) reject('symlink', parts.slice(0, index).join('/'));
    if (!parent.isDirectory()) reject('unexpected directory type', relative);
  }
  const file = path.join(source, ...parts);
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) reject('symlink', relative);
  if (!stat.isFile()) reject('unexpected file type', relative);
  if (stat.size > maxFileBytes) reject('file size limit', relative);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const resolved = await realpath(file);
    const current = await lstat(resolved);
    if (!inside(source, resolved) || !opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      reject('source path changed or escaped', relative);
    }
    if (opened.size > maxFileBytes) reject('file size limit', relative);
    const buffer = await handle.readFile();
    if (buffer.length > maxFileBytes) reject('file size limit', relative);
    scanContents(relative, buffer);
    const executable = executablePaths.has(relative) || (relative.startsWith('scripts/') && /\.(?:sh|py|mjs|cjs|js)$/.test(relative));
    const mode = executable && (opened.mode & 0o111) ? '0755' : '0644';
    return { path: relative, buffer, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), mode };
  } finally { await handle.close(); }
}

async function collectFiles(source, { omitWorkflows }) {
  const files = [];
  async function walk(relative) {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = await lstat(path.join(source, ...parts.slice(0, index)));
      if (parent.isSymbolicLink()) reject('symlink', parts.slice(0, index).join('/'));
      if (!parent.isDirectory()) reject('unexpected directory type', relative);
    }
    const directory = path.join(source, ...relative.split('/'));
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) reject('symlink', relative);
    if (!stat.isDirectory()) reject('unexpected directory type', relative);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (excludedDirectories.has(entry.name.toLowerCase()) || excludedFiles.test(entry.name)) continue;
      const selected = `${relative}/${entry.name}`;
      if (omitWorkflows && selected === '.github/workflows') continue;
      if (!allowedName(entry.name)) reject('unexpected pathname', selected);
      if (entry.isSymbolicLink()) reject('symlink', selected);
      if (entry.isDirectory()) await walk(selected);
      else {
        if (!allowedType(selected)) reject('unexpected file extension', selected);
        files.push(await readSelected(source, selected));
      }
    }
  }
  for (const name of [...rootFiles].sort()) {
    if (await statIfPresent(path.join(source, name))) files.push(await readSelected(source, name));
  }
  for (const relative of [...publicDocs, ...exactSources]) {
    if (await statIfPresent(path.join(source, ...relative.split('/')))) files.push(await readSelected(source, relative));
  }
  for (const name of [...Object.keys(extensions), ...extraTrees]) {
    if (await statIfPresent(path.join(source, name))) await walk(name);
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const required of ['README.md', 'LICENSE', 'package.json', 'pnpm-lock.yaml']) {
    if (!files.some(file => file.path === required)) reject('missing required file', required);
  }
  if (files.reduce((total, file) => total + file.bytes, 0) > maxTotalBytes) reject('total source size limit');
  validateDocumentLinks(files);
  return files;
}

async function writeExclusive(file, buffer, mode) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    await handle.writeFile(buffer);
    // A restrictive operator umask must not make the published manifest inaccurate.
    await handle.chmod(mode);
  } finally { await handle.close(); }
}

export async function exportPublicSource({ sourceDir = process.cwd(), destination, omitWorkflows = false }) {
  if (!destination) reject('output argument is required');
  let output;
  try {
    const sourceStat = await lstat(path.resolve(sourceDir));
    if (sourceStat.isSymbolicLink()) reject('symlink source root');
    if (!sourceStat.isDirectory()) reject('source root must be a directory');
    const source = await realpath(sourceDir);
    output = path.resolve(destination);
    // Resolve existing parents before containment checks (e.g. the system /tmp alias).
    let ancestor = path.dirname(output);
    while (!await statIfPresent(ancestor)) ancestor = path.dirname(ancestor);
    const ancestorStat = await lstat(ancestor);
    if (ancestorStat.isSymbolicLink()) reject('symlink output parent');
    const physicalOutput = path.resolve(await realpath(ancestor), path.relative(ancestor, output));
    if (inside(physicalOutput, source)) reject('output contains the source directory');
    if (inside(source, physicalOutput) && !inside(path.join(source, '.cache'), physicalOutput)) {
      reject('output path must be outside source or in its cache');
    }
    if (physicalOutput === path.join(source, '.cache')) reject('output must be a new cache subdirectory');
    if (await statIfPresent(output)) reject('output already exists');
    output = physicalOutput;
    if (typeof omitWorkflows !== 'boolean') reject('invalid workflow option');
    const files = await collectFiles(source, { omitWorkflows });
    const manifestFiles = files.map(({ path: relative, bytes, sha256, mode }) => ({ path: relative, bytes, sha256, mode }));
    const manifest = {
      schemaVersion: 2,
      policyVersion: 2,
      omitWorkflows,
      sourceTreeSha256: createHash('sha256').update(JSON.stringify(manifestFiles)).digest('hex'),
      files: manifestFiles,
    };
    await mkdir(path.dirname(output), { recursive: true });
    // mkdir without recursive exclusively claims a new output; existing directories are never replaced.
    await mkdir(output, { mode: 0o755 });
    const ownedDirectory = await lstat(output);
    async function assertOwnedOutput() {
      const current = await lstat(output);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedDirectory.dev
        || current.ino !== ownedDirectory.ino || await realpath(output) !== output) {
        reject('output path changed');
      }
    }
    await assertOwnedOutput();
    for (const file of files) {
      await assertOwnedOutput();
      const target = path.join(output, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      if (!inside(output, await realpath(path.dirname(target)))) reject('output path escaped');
      await writeExclusive(target, file.buffer, Number.parseInt(file.mode, 8));
    }
    await assertOwnedOutput();
    await writeExclusive(path.join(output, manifestName), JSON.stringify(manifest, null, 2) + '\n', 0o644);
    return manifest;
  } catch (error) {
    // Pathname-based recursive cleanup could remove an unrelated directory after concurrent substitution.
    // Leave failed output for inspection; only exit 0 plus a verified manifest is a usable snapshot.
    if (error instanceof ExportError) throw error;
    reject('filesystem operation failed');
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--omit-workflows' && !Object.hasOwn(options, key)) { options[key] = true; continue; }
    if (!['--source', '--output'].includes(key) || Object.hasOwn(options, key)) reject('invalid or duplicate argument');
    const value = args[++index];
    if (!value || value.startsWith('--')) reject('argument needs a value');
    options[key] = value;
  }
  return { sourceDir: options['--source'], destination: options['--output'], omitWorkflows: options['--omit-workflows'] ?? false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const manifest = await exportPublicSource(parseArgs(process.argv.slice(2)));
    console.log(`Public source snapshot ready: ${manifest.files.length} files; SHA-256 ${manifest.sourceTreeSha256}`);
  } catch (error) {
    console.error(error instanceof ExportError ? error.message : 'Public export rejected: unexpected failure');
    process.exitCode = 1;
  }
}
