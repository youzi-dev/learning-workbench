import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
// Official SQLite guidance verified 2026-10-23: https://www.sqlite.org/wal.html#walresetbug
export function isSafeSqliteVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 3 && ((minor === 44 && patch >= 6) || (minor === 50 && patch >= 7) || (minor === 51 && patch >= 3) || minor > 51);
}
export function verifySqlite() {
  const db = new DatabaseSync(':memory:');
  try {
    const { version } = db.prepare('SELECT sqlite_version() AS version').get();
    if (!isSafeSqliteVersion(version)) throw new Error(`UNSAFE_SQLITE_RUNTIME: ${version}; https://www.sqlite.org/wal.html#walresetbug`);
    return version;
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(`SQLite ${verifySqlite()}: known WAL-reset fix present (runtime checked)`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
