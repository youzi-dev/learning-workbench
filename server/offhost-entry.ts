import {readReplicationConfig, initializeRepository, readReplicationState, replicationHealthy, Replicator} from './offhost';
import {assertLinuxMount, validateOwnedDirectory} from './deployment';

async function loadCurrentConfig() {
  await assertLinuxMount('/operator', 'ro');
  return readReplicationConfig('/operator', process.env.WORKBENCH_DEPLOYMENT_ID ?? '');
}
async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length || !['init','once','serve','health'].includes(mode)) throw Error('INVALID_OFFHOST_COMMAND');
  if (process.getuid?.() !== 11000) throw Error('OPERATIONS_UID_REQUIRED');
  await assertLinuxMount('/backups', 'rw'); await validateOwnedDirectory('/backups', 11000, 11000, 0o700);
  if (mode === 'health') {
    const config = await loadCurrentConfig();
    if (!replicationHealthy(await readReplicationState('/backups'), new Date(), config.identity)) throw Error('REPLICATION_STALE_OR_FAILED'); return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    if (mode === 'init') {await initializeRepository(await loadCurrentConfig(), controller.signal); console.log(JSON.stringify({status: 'repository-initialized'})); return;}
    // Re-read the actual private files each tick. A changed target or password cannot reuse
    // success for the old config, and the child receives the current credentials only.
    const tick = async () => {
      let config: Awaited<ReturnType<typeof readReplicationConfig>> | null = null;
      try {config = await loadCurrentConfig();} catch {}
      const result = await new Replicator('/backups', config).tick(new Date(), controller.signal, {force: mode === 'once'});
      return {config, result};
    };
    const {config, result} = await tick();
    if (mode === 'once') {
      if (!config || !['transferred','unchanged'].includes(result.status)) throw Error('REPLICATION_INCOMPLETE_OR_FAILED');
      // Re-read again so a file edit during transfer cannot produce a stale success claim.
      const current = await loadCurrentConfig();
      if (!replicationHealthy(await readReplicationState('/backups'), new Date(), current.identity)) throw Error('REPLICATION_INCOMPLETE_OR_FAILED');
      console.log(JSON.stringify({status: 'encrypted-replication-complete'})); return;
    }
    // Await each tick; SIGTERM interrupts the timer and terminates the active restic child.
    while (!controller.signal.aborted) {
      await new Promise<void>(resolve => {
        const onAbort = () => {clearTimeout(timer); resolve();};
        const timer = setTimeout(() => {controller.signal.removeEventListener('abort', onAbort); resolve();}, 30_000);
        controller.signal.addEventListener('abort', onAbort, {once: true}); if (controller.signal.aborted) onAbort();
      });
      if (!controller.signal.aborted) await tick();
    }
  } finally {process.off('SIGTERM', stop); process.off('SIGINT', stop);}
}
main().catch(() => {console.error('OFFHOST_OPERATION_INCOMPLETE_OR_FAILED'); process.exitCode = 1;});
