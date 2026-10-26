import {basename, resolve} from 'node:path';
import {createBackup, pruneBackups, restoreBackup, verifyBackup} from './backup';

/** Local operator command only. Never accepts a capture key or prints business data. */
export async function runBackupCli(args: string[], output: (line: string) => void = console.log): Promise<void> {
  const [command, ...rest] = args;
  const allowed: Record<string, string[]> = {create: ['--db','--blob-dir','--backup-root'], verify: ['--snapshot'], restore: ['--snapshot','--destination'], prune: ['--backup-root']};
  if (!Object.hasOwn(allowed, command)) throw Error('INVALID_COMMAND');
  const flags: Record<string, string> = Object.create(null);
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed[command].includes(rest[i]) || !rest[i + 1] || Object.hasOwn(flags, rest[i])) throw Error('INVALID_ARGUMENT');
    flags[rest[i]] = resolve(rest[i + 1]);
  }
  if (allowed[command].some(flag => !flags[flag])) throw Error('REQUIRED_ARGUMENT_MISSING');
  const names = (entries: string[]) => entries.map(name => /^[.A-Za-z0-9_-]{1,120}$/.test(name) ? name : '[redacted-name]');
  if (command === 'create') {
    const result = await createBackup({databasePath: flags['--db'], blobDirectory: flags['--blob-dir'], backupRoot: flags['--backup-root']});
    output(JSON.stringify({status: 'complete', snapshot: basename(result.path), databaseSha256: result.manifest.database.sha256, copiedFiles: result.manifest.files.length, retained: result.retention.kept.length, pruned: result.retention.removed.length, untouched: names(result.retention.untouched)}));
  } else if (command === 'verify') {
    const result = await verifyBackup(flags['--snapshot']); output(JSON.stringify({status: 'verified', snapshot: result.id, databaseSha256: result.database.sha256, copiedFiles: result.files.length}));
  } else if (command === 'restore') {
    const result = await restoreBackup({backupPath: flags['--snapshot'], destination: flags['--destination']});
    output(JSON.stringify({status: 'restored-isolated-directory', databaseSha256: result.manifest.database.sha256, copiedFiles: result.manifest.files.length}));
  } else {
    const result = await pruneBackups({backupRoot: flags['--backup-root']}); output(JSON.stringify({status: 'retention-complete', retained: result.kept.length, pruned: result.removed.length, untouched: names(result.untouched)}));
  }
}
