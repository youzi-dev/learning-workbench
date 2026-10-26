import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {runCli} from './cli-command';
export {runCli} from './cli-command';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : 'STARTUP_FAILED'); process.exitCode = 1; });
}
