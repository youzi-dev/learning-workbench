import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {runBrokerCli} from './broker-command';
export {runBrokerCli} from './broker-command';

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runBrokerCli(process.argv.slice(2)).catch(()=>{console.error('CAPTURE_BROKER_STARTUP_FAILED');process.exitCode=1;});
}
