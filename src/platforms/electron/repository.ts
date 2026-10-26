import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {Id} from '../../workbench/contracts/data';
import {createRepository, emptyRepositoryState, RepositoryError, TABLES, type RepositoryOptions, type ManagedRepository, type RepositoryDriver, type RepositoryState} from '../../workbench/storage/repository';
export type ElectronRepository = ManagedRepository & {readonly path: string; readonly directory: string};
export type ElectronRepositoryOptions = RepositoryOptions & {directory?: string};
/** A distinct file per account; the v1 document is never opened for writing. */
export async function openRepository(accountId: Id, options: ElectronRepositoryOptions = {}): Promise<ElectronRepository> {
  if (!accountId) throw new RepositoryError('invalid', 'Missing account');
  const directory = options.directory ?? join(homedir(), '.growth-workbench', 'workbench-v2');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const path = join(directory, `workbench-v2-${createHash('sha256').update(accountId).digest('hex')}.sqlite`);
  let db: DatabaseSync, readonly = false;
  if (existsSync(path)) {
    db = new DatabaseSync(path, {readOnly: true});
    const version = (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version;
    readonly = version > 2;
    if (!readonly) {db.close(); db = new DatabaseSync(path);}
  } else db = new DatabaseSync(path);
  if (!readonly) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of TABLES) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
      db.exec('PRAGMA user_version=2; COMMIT');
    } catch (error) {db.exec('ROLLBACK'); db.close(); throw error;}
  }
  let closed = false;
  const load = (): RepositoryState => {
    if (closed) throw new RepositoryError('unavailable', 'Repository is closed');
    const state = emptyRepositoryState();
    const available = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[]).map(t => t.name));
    for (const table of TABLES) if (available.has(table)) for (const row of db.prepare(`SELECT key, value FROM ${table}`).all() as {key: string; value: string}[]) state[table][row.key] = JSON.parse(row.value);
    return state;
  };
  const driver: RepositoryDriver = {
    readonly,
    async read(action) {
      if (closed) throw new RepositoryError('unavailable');
      db.exec('BEGIN');
      try {const result = action(load()); db.exec('COMMIT'); return result;} catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    async write(action) {
      if (closed) throw new RepositoryError('unavailable');
      if (readonly) throw new RepositoryError('readonly-schema', 'Future container is read-only', true);
      db.exec('BEGIN IMMEDIATE');
      try {
        const before = load(), state = structuredClone(before), result = action(state);
        for (const table of TABLES) {
          const remove = db.prepare(`DELETE FROM ${table} WHERE key=?`), put = db.prepare(`INSERT INTO ${table}(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
          for (const key of Object.keys(before[table])) if (!(key in state[table])) remove.run(key);
          for (const [key, value] of Object.entries(state[table])) if (JSON.stringify(before[table][key]) !== JSON.stringify(value)) put.run(key, JSON.stringify(value));
        }
        db.exec('COMMIT'); return result;
      } catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    close() {if (!closed) {closed = true; db.close();}}
  };
  try {return Object.assign(await createRepository(driver, options), {path, directory});} catch (error) {driver.close(); throw error;}
}
