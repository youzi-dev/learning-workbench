import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from '../../src/workbench/files/storage';
import {IDBFactory} from 'fake-indexeddb';
import {openDatabase} from '../../server/database';
import {AuthService} from '../../server/auth';
import {SyncService, registryFromManifests} from '../../server/sync';
import {createApp} from '../../server/app';
import {CaptureQueue} from '../../server/capture/queue';
import {CaptureDispatcher, type CaptureRuntime, type IsolatedResult} from '../../server/capture/runtime';
import {DiskBlobStore} from '../../server/blob';
import {streamToFile} from '../../worker/downloaders';
import type {WorkerInput} from '../../worker/runner';
import {manifest} from '../../src/modules/library/manifest';
import {LibraryWorkflow, descriptor} from '../../src/modules/library/workflow';
import {openRepository} from '../../src/platforms/browser/repository';
import {browserProtectedInputs} from '../../src/platforms/browser/protected-inputs';
import {BrowserFileStorage} from '../../src/platforms/browser/file-storage';
import {createBrowserPorts} from '../../src/platforms/browser/ports';
import {createBrowserConnection} from '../../src/platforms/browser/session';
import {createWorkbenchRuntime} from '../../src/workbench/runtime';
import type {ModuleRegistration} from '../../src/workbench/contracts/module';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const action of cleanups.splice(0).reverse()) await action();});
const pdf = new TextEncoder().encode('%PDF-1.7\nDeterministic public test resource\n%%EOF');
/** Only public source HTTP is deterministic here. Auth, capture queue/dispatcher,
 * durable blobs, metadata sync, client repositories and range reads are real. */
class PublicFixtureRuntime implements CaptureRuntime {
  readonly sources: string[] = [];
  async start() {}
  async stop() {}
  async acquire(input: WorkerInput, signal: AbortSignal): Promise<IsolatedResult> {
    this.sources.push(input.url);
    const fetchPublic = async (url: string) => {
      if (new URL(url).hostname !== 'public.example.org') throw Error('UNEXPECTED_PUBLIC_SOURCE');
      return new Response(pdf, {headers: {'content-type': 'application/pdf'}});
    };
    const response = await fetchPublic(input.url);
    const directory = await mkdtemp(join(tmpdir(), 'capture-public-fixture-'));
    try {
      const path = join(directory, 'resource');
      const file = await streamToFile(response.body!, path, {signal});
      return {state: 'file', path, file: {...file, mime: 'application/pdf'}, strategy: 'https', dispose: () => rm(directory, {recursive: true, force: true})};
    } catch (cause) {await rm(directory, {recursive: true, force: true}); throw cause;}
  }
}
function metadata() {const values = new Map<string, string>(); return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};}
it('collects through authenticated HTTP then pulls committed descriptor and reads verified PDF bytes on demand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capture-http-')); cleanups.push(() => rm(directory, {recursive: true, force: true}));
  const db = openDatabase(join(directory, 'server.sqlite')); cleanups.push(() => db.close());
  const auth = new AuthService(db), accountId = await auth.provisionOwner();
  const queue = new CaptureQueue(db, {secretKey: new Uint8Array(32).fill(8)});
  const blobs = new DiskBlobStore(join(directory, 'blobs'));
  // R4: another platform already committed identical bytes under a generic presentation label.
  const existing={sha256:await sha256(pdf),size:pdf.length,mime:'application/octet-stream'};
  const upload=await blobs.begin(accountId,existing);await blobs.putChunk(accountId,upload.uploadId,0,pdf);await blobs.commit(accountId,upload.uploadId);
  const publicRuntime = new PublicFixtureRuntime();
  const dispatcher = new CaptureDispatcher(queue, blobs, publicRuntime);
  await dispatcher.start(); cleanups.push(() => dispatcher.stop());
  const app = createApp({auth, sync: new SyncService(db, registryFromManifests([manifest])), blobs, capture: {queue, dispatcher}});
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${(app.address() as {port: number}).port}`;
  expect((await fetch(`${baseUrl}/v1/capture/jobs`, {method: 'POST', body: '{}'})).status).toBe(401);
  const indexedDB = new IDBFactory(), storage = await BrowserFileStorage.open({indexedDB}); cleanups.push(() => storage.close());
  let workflow: LibraryWorkflow | undefined;
  const registration: ModuleRegistration = {manifest, async load() {return {manifest, navigation: [], settings: [], commands: {}, async start(context, signal) {workflow = new LibraryWorkflow(context, signal);}, async stop() {}, render() {return null;}};}};
  const source = {async import() {return [];}, async stage(ref: any) {return ref;}, async read(): Promise<Uint8Array> {throw Error('NO_PICKED_FILE');}};
  const runtime = await createWorkbenchRuntime({
    registrations: [registration], ports: createBrowserPorts(source), resources: {storage, source, protectedInputs: await browserProtectedInputs(indexedDB)}, autoSync: false,
    connection: createBrowserConnection({metadata: metadata(), sessionStorage: metadata()}),
    open: (id, deviceId) => openRepository(id, {indexedDB, deviceId, schemas: {library: {'library.asset': 1, 'library.capture-job': 1, 'library.reading-state': 1}}}),
  });
  cleanups.push(() => runtime.stop());
  await runtime.pair({baseUrl, code: await auth.createPairingCode(accountId), name: 'HTTP fixture', recover: false, adoptLocal: false});
  const asset = await workflow!.collect('https://public.example.org/manual.pdf?token=transient-secret');
  await workflow!.maintainPastedCaptures();
  expect((await runtime.snapshot().repository.list('library')).filter(item => item.kind === 'library.capture-job')).toHaveLength(1);
  await expect.poll(() => queue.list(accountId)[0]?.payload.state, {timeout: 4000, interval: 20}).toBe('saved');
  await runtime.sync();
  const committed = await workflow!.asset(asset.id);
  expect(committed.payload.availability).toBe('available');
  expect(committed.payload.mime).toBe('application/pdf');expect(await blobs.describe(accountId,existing.sha256)).toEqual(existing);
  const file = descriptor(committed.payload)!;
  expect(await runtime.snapshot().resources!.localForAsset(asset.id, file)).toEqual({state: 'missing'});
  const local = await runtime.snapshot().resources!.ensureLocal(asset.id, file);
  expect(await runtime.snapshot().resources!.read(local, 5, 10)).toEqual(pdf.slice(5, 15));
  expect(publicRuntime.sources).toEqual(['https://public.example.org/manual.pdf?token=transient-secret']);
  const businessData = JSON.stringify(await runtime.snapshot().repository.exportData());
  expect(businessData).not.toContain('transient-secret');
  expect(businessData).not.toContain('inputToken');
  expect(JSON.stringify(await runtime.snapshot().repository.pending())).not.toContain('transient-secret');
  const oldResources = runtime.snapshot().resources!;
  await runtime.session.logout('leave');
  await expect(oldResources.read(local, 0, 5)).rejects.toMatchObject({code: 'scope-changed'});
});
