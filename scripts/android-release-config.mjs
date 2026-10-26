import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function androidVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw Error('Android release requires a plain major.minor.patch version');
  const [major, minor, patch] = match.slice(1).map(Number);
  const code = major * 1000000 + minor * 1000 + patch;
  if (minor >= 1000 || patch >= 1000 || !Number.isSafeInteger(code) || code < 1 || code > 2147483647) throw Error('Android version is outside the supported integer range');
  return {versionName: version, versionCode: code};
}

export function requireSigningEnvironment(env = process.env) {
  for (const name of ['WORKBENCH_ANDROID_KEYSTORE', 'WORKBENCH_ANDROID_STORE_PASSWORD_FILE', 'WORKBENCH_ANDROID_KEY_PASSWORD_FILE']) {
    if (!env[name]) throw Error(`Android release requires ${name}`);
    // Check existence only. Password contents are consumed privately by Gradle.
    try { if (!statSync(env[name]).isFile()) throw Error(); }
    catch { throw Error(`Android release requires an existing file for ${name}`); }
  }
  if (!env.WORKBENCH_ANDROID_KEY_ALIAS?.trim()) throw Error('Android release requires WORKBENCH_ANDROID_KEY_ALIAS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = androidVersion(pkg.version);
  requireSigningEnvironment();
  console.log(`Android private release preflight: ${version.versionName} (${version.versionCode}); signing inputs present`);
}
