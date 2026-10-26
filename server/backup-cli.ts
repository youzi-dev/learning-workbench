import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {runBackupCli} from './backup-command';
export {runBackupCli} from './backup-command';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBackupCli(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BACKUP_OPERATION_FAILED';
    console.error(code); process.exitCode = 1;
  });
}
