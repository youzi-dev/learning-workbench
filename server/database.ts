import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** SQLite's WAL-reset fix: https://www.sqlite.org/wal.html#walresetbug (checked 2026-10-23).
 * Fixed mainline >=3.51.3; maintenance backports 3.44.6 and 3.50.7.
 * 3.45..3.49 are NOT covered just because their number exceeds 3.44.6.
 */
export function isSafeSqliteVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major === 3 && ((minor === 44 && patch >= 6) || (minor === 50 && patch >= 7) || (minor === 51 && patch >= 3) || minor > 51);
}
export function assertSqliteRuntime(db: DatabaseSync): string {
  const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
  if (!isSafeSqliteVersion(row.version)) throw new Error(`UNSAFE_SQLITE_RUNTIME: ${row.version}; see https://www.sqlite.org/wal.html#walresetbug`);
  return row.version;
}
export function openDatabase(path: string, options: { production?: boolean } = {}): DatabaseSync {
  if (path === ':memory:') throw new Error('PERSISTENT_DATABASE_REQUIRED');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    // Enabled by default in every environment; explicit false is intended only for isolated tests.
    if (options.production !== false) assertSqliteRuntime(db);
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version > 1) throw new Error('DATABASE_VERSION_UNSUPPORTED');
    chmodSync(path, 0o600);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (user_version === 0) transaction(db, () => db.exec(readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8')));
    return db;
  } catch (error) { db.close(); throw error; }
}
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
