import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {DiskBlobStore} from './blob';
import type { ModuleManifest } from '../src/workbench/contracts/module';
import { openDatabase } from './database';
import { AuthService } from './auth';
import { SyncService, registryFromManifests, type SchemaRegistry } from './sync';
import { createApp } from './app';
import {CaptureQueue} from './capture/queue';
import {CaptureDispatcher} from './capture/runtime';
import {RemoteCaptureRuntime} from './capture/remote-runtime';
import {loadCaptureKey} from './capture-key';

/** Administrator-only local CLI. Pairing codes are printed only for an explicit `pair` command. */
export async function runCli(args: string[], output: (line: string) => void = console.log): Promise<void> {
  const [command, ...rest] = args;
  if (!['provision', 'pair', 'revoke', 'serve'].includes(command)) throw new Error('INVALID_COMMAND: provision | pair | revoke | serve');
  const flags: Record<string, string> = Object.create(null);
  for (let index = 0; index < rest.length; index += 2) {
    if (!['--db','--device','--schemas','--host','--port','--allowed-origins','--blob-dir','--capture','--capture-key-file','--capture-socket'].includes(rest[index]) || !rest[index + 1] || Object.hasOwn(flags, rest[index])) throw new Error('INVALID_ARGUMENT');
    flags[rest[index]] = rest[index + 1];
  }
  if (!flags['--db']) throw new Error('DATABASE_PATH_REQUIRED');
  if (command === 'serve' && !flags['--schemas']) throw new Error('SCHEMA_REGISTRY_REQUIRED');
  if (command === 'revoke' && !flags['--device']) throw new Error('DEVICE_ID_REQUIRED');
  if (flags['--capture'] && !['on', 'off'].includes(flags['--capture'])) throw Error('INVALID_CAPTURE_MODE');
  if (command === 'serve' && flags['--capture'] === 'on' && !flags['--capture-key-file']) throw Error('CAPTURE_KEY_FILE_REQUIRED');
  if (command === 'serve' && flags['--capture'] === 'on' && !flags['--capture-socket']) throw Error('CAPTURE_SOCKET_REQUIRED');
  const db = openDatabase(resolve(flags['--db'])); const auth = new AuthService(db);
  let dispatcher: CaptureDispatcher | undefined;
  try {
    if (command === 'serve') {
      const definitions = await import(pathToFileURL(resolve(flags['--schemas'])).href) as { manifests?: ModuleManifest[]; schemas?: SchemaRegistry };
      const schemas = definitions.manifests ? registryFromManifests(definitions.manifests) : definitions.schemas;
      if (!schemas || !Object.keys(schemas).length || Object.values(schemas).some(kinds => !kinds || Object.values(kinds).some(schema => !Number.isSafeInteger(schema.version) || schema.version < 1 || typeof schema.parse !== 'function'))) throw new Error('INVALID_SCHEMA_REGISTRY');
      const port = Number(flags['--port'] ?? 8787); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
      const allowedOrigins = (flags['--allowed-origins'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
      if (allowedOrigins.some(value => {try {const url = new URL(value); return !['http:', 'https:'].includes(url.protocol) || url.origin !== value;} catch {return true;}})) throw new Error('INVALID_ALLOWED_ORIGIN');
      const blobDirectory = resolve(flags['--blob-dir'] ?? join(dirname(resolve(flags['--db'])), 'blobs'));
      const blobs = new DiskBlobStore(blobDirectory);
      let remote: RemoteCaptureRuntime | undefined;
      let capture: {queue: CaptureQueue; dispatcher: CaptureDispatcher} | undefined;
      if (flags['--capture'] === 'on') {
        const keyPath = resolve(flags['--capture-key-file']);
        if (keyPath === resolve(flags['--db']) || keyPath === blobDirectory || keyPath.startsWith(`${blobDirectory}/`)) throw Error('CAPTURE_KEY_PATH_MUST_BE_PRIVATE');
        const queue = new CaptureQueue(db, {secretKey: await loadCaptureKey(keyPath)});
        remote = new RemoteCaptureRuntime(flags['--capture-socket']);
        dispatcher = new CaptureDispatcher(queue, blobs, remote);
        await dispatcher.start();
        capture = {queue, dispatcher};
      }
      const server = createApp({auth, sync: new SyncService(db, schemas), allowedOrigins, blobs, capture, readiness: async () => {db.prepare('SELECT 1').get(); if (remote) await remote.checkReady();}});
      await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(port, flags['--host'] ?? '127.0.0.1', () => { server.off('error', reject); resolveListen(); }); });
      output(JSON.stringify({ listening: server.address() }));
      let closing = false;
      const close = () => {
        if (closing) return; closing = true;
        server.close(() => {void (dispatcher?.stop() ?? Promise.resolve()).finally(() => db.close());});
        server.closeIdleConnections();
      };
      process.once('SIGTERM', close); process.once('SIGINT', close);
      server.once('close', () => { process.off('SIGTERM', close); process.off('SIGINT', close); });
      return;
    }
    const account = db.prepare('SELECT id FROM accounts WHERE owner_slot=1').get() as { id: string } | undefined;
    if (command === 'provision') output(JSON.stringify({ accountId: await auth.provisionOwner() }));
    else {
      if (!account) throw new Error('OWNER_NOT_PROVISIONED');
      if (command === 'pair') output(JSON.stringify({ pairingCode: await auth.createPairingCode(account.id), expiresInSeconds: 600 }));
      else { auth.revoke(account.id, flags['--device']); output(JSON.stringify({ revoked: true })); }
    }
    db.close();
  } catch (error) {await dispatcher?.stop().catch(() => {}); db.close(); throw error; }
}
