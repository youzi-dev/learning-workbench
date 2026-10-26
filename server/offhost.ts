import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, rename, unlink} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {isIP} from 'node:net';
import {createHash, randomUUID} from 'node:crypto';
import {withLatestVerifiedBackup} from './backup';
import {resolvePublicTarget, type Resolver} from './capture/egress';

const RETRY_MS = 5 * 60_000, TIMEOUT_MS = 2 * 3600_000;
const TAG = 'personal-workbench';
export type ReplicationConfig = {
  identity: string; deploymentId: string; repositoryFile: string; passwordFile: string;
  credentials: {accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string};
};
export type ResticRunner = (args: string[], options: {cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal}) => Promise<void>;
export type ReplicationState = {
  version: 1; status: 'incomplete' | 'running' | 'failed' | 'complete'; updatedAt: string;
  nextAttemptAt: string | null; lastSuccessId: string | null; lastSuccessAt: string | null;
  lastSuccessIdentity: string | null;
  errorCode?: 'REPLICATION_FAILED' | 'REPLICATION_INCOMPLETE';
};
export type ReplicationResult = {status: 'transferred' | 'unchanged' | 'deferred' | 'failed' | 'incomplete'};
/** Private fingerprint only: never persist the URL, credentials or encryption password. */
export function replicationConfigIdentity(repository: string, deploymentId: string, password: string, credentials: ReplicationConfig['credentials']): string {
  const canonicalRepository = repository.startsWith('s3:') ? `s3:${new URL(repository.slice(3)).href}` : repository;
  return createHash('sha256').update(JSON.stringify({repository: canonicalRepository, deploymentId, password, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, region: credentials.region ?? null, sessionToken: credentials.sessionToken ?? null})).digest('hex');
}
function fail(code: string): never {throw Error(code);}
/** Every existing component must be real; the leaf must be owned and private. */
async function privatePath(path: string, directory = false): Promise<void> {
  const absolute = resolve(path); let current = absolute;
  for (;;) {
    const stat = await lstat(current); if (stat.isSymbolicLink()) fail('UNSAFE_OPERATOR_PATH');
    if (current === absolute && (directory ? !stat.isDirectory() : !stat.isFile())) fail('UNSAFE_OPERATOR_FILE');
    if (current === absolute && (stat.uid !== process.getuid?.() || stat.mode & 0o077)) fail('UNSAFE_OPERATOR_FILE');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function privateText(path: string, limit = 16_384): Promise<string> {
  await privatePath(path); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > limit) fail('UNSAFE_OPERATOR_FILE');
    const value = await handle.readFile('utf8'); if (Buffer.byteLength(value) > limit) fail('UNSAFE_OPERATOR_FILE'); return value;
  } finally {await handle.close();}
}
function configured(value: unknown, minimum = 1): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= 4096 && !/[\r\n\0]/.test(value) && !/^(?:change[-_ ]?me|example|placeholder|your[-_ ].*|default|test|password|secret)$/i.test(value);
}
export function validateRepository(value: string): void {
  if (!value.startsWith('s3:https://') || /[\r\n\0]/.test(value)) fail('INVALID_REPOSITORY');
  let url: URL; try {url = new URL(value.slice(3));} catch {fail('INVALID_REPOSITORY');}
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Endpoint is an explicit S3 HTTPS service, never a local/plaintext backend.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/' || /%(?:2f|5c|00)/i.test(url.pathname) || isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) fail('INVALID_REPOSITORY');
}
/** Production reads three fixed files; no repository URL/secret arguments or ambient AWS config. */
export async function readReplicationConfig(directory: string, deploymentId: string, resolver?: Resolver): Promise<ReplicationConfig> {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(deploymentId)) fail('DEPLOYMENT_ID_REQUIRED');
  await privatePath(directory, true);
  const repositoryFile = join(resolve(directory), 'repository'), passwordFile = join(resolve(directory), 'password');
  const repository = (await privateText(repositoryFile)).trim(); validateRepository(repository);
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {await Promise.race([resolvePublicTarget(repository.slice(3), resolver), new Promise<never>((_, reject) => {dnsTimer = setTimeout(() => reject(Error('INVALID_REPOSITORY')), 5000);})]);} finally {if (dnsTimer) clearTimeout(dnsTimer);}
  const password = await privateText(passwordFile); if (!configured(password.trim(), 20) || new Set(password.trim()).size < 10) fail('INVALID_REPLICATION_PASSWORD');
  let value: Record<string, unknown>;
  try {value = JSON.parse(await privateText(join(directory, 'credentials.json')));} catch {fail('INVALID_REPLICATION_CREDENTIALS');}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['accessKeyId','secretAccessKey','region','sessionToken'].includes(key)) || !configured(value.accessKeyId, 8) || !configured(value.secretAccessKey, 16) || value.region !== undefined && !/^[a-z0-9-]{1,64}$/.test(String(value.region)) || value.sessionToken !== undefined && !configured(value.sessionToken)) fail('INVALID_REPLICATION_CREDENTIALS');
  const credentials = value as ReplicationConfig['credentials'];
  return {identity: replicationConfigIdentity(repository, deploymentId, password, credentials), deploymentId, repositoryFile, passwordFile, credentials};
}
export function resticEnvironment(config: ReplicationConfig): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp',
    RESTIC_REPOSITORY_FILE: config.repositoryFile, RESTIC_PASSWORD_FILE: config.passwordFile,
    AWS_ACCESS_KEY_ID: config.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: config.credentials.secretAccessKey,
    ...(config.credentials.region ? {AWS_DEFAULT_REGION: config.credentials.region} : {}),
    ...(config.credentials.sessionToken ? {AWS_SESSION_TOKEN: config.credentials.sessionToken} : {}),
  };
}
/** No shell or inherited environment; no raw child output can expose URLs, keys or filenames. */
export const runRestic: ResticRunner = async (args, options) => {
  options.signal.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const child = spawn('/usr/bin/restic', ['--no-cache', ...args], {cwd: options.cwd, env: options.env, stdio: 'ignore'});
    let killer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {child.kill('SIGTERM'); killer ??= setTimeout(() => child.kill('SIGKILL'), 5000); killer.unref();};
    options.signal.addEventListener('abort', cancel, {once: true}); if (options.signal.aborted) cancel();
    const finish = (success: boolean) => {options.signal.removeEventListener('abort', cancel); if (killer) clearTimeout(killer); success && !options.signal.aborted ? done() : reject(Error('RESTIC_OPERATION_FAILED'));};
    child.once('error', () => finish(false)); child.once('close', code => finish(code === 0));
  });
};
const empty = (): ReplicationState => ({version: 1, status: 'incomplete', updatedAt: new Date(0).toISOString(), nextAttemptAt: null, lastSuccessId: null, lastSuccessAt: null, lastSuccessIdentity: null});
function isISO(value: unknown): value is string {return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));}
export async function readReplicationState(root: string): Promise<ReplicationState> {
  let raw: string; try {raw = await privateText(join(root, '.replication-status.json'), 4096);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error;}
  let s: ReplicationState; try {s = JSON.parse(raw);} catch {fail('INVALID_REPLICATION_STATE');}
  if (s.lastSuccessIdentity !== undefined && s.lastSuccessIdentity !== null && !/^[a-f0-9]{64}$/.test(s.lastSuccessIdentity)) fail('INVALID_REPLICATION_STATE');
  if (s.version !== 1 || !['incomplete','running','failed','complete'].includes(s.status) || !isISO(s.updatedAt) || ![s.nextAttemptAt, s.lastSuccessAt].every(v => v === null || isISO(v)) || !(s.lastSuccessId === null || /^snapshot-\d{8}T\d{9}Z-[a-f0-9-]{36}$/.test(s.lastSuccessId)) || s.errorCode !== undefined && !['REPLICATION_FAILED','REPLICATION_INCOMPLETE'].includes(s.errorCode)) fail('INVALID_REPLICATION_STATE');
  // Reconstruct an allowlisted object so a tampered status cannot surface arbitrary strings.
  return {version: 1, status: s.status, updatedAt: s.updatedAt, nextAttemptAt: s.nextAttemptAt, lastSuccessId: s.lastSuccessId, lastSuccessAt: s.lastSuccessAt, lastSuccessIdentity: s.lastSuccessIdentity ?? null, ...(s.errorCode ? {errorCode: s.errorCode} : {})};
}
async function saveState(root: string, state: ReplicationState): Promise<void> {
  await privatePath(root, true); const temp = join(root, `.replication-${randomUUID()}.tmp`);
  const fd = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {await fd.writeFile(JSON.stringify(state)); await fd.sync();} finally {await fd.close();}
  try {await rename(temp, join(root, '.replication-status.json'));} finally {await unlink(temp).catch(() => {});}
  const directory = await open(root, constants.O_RDONLY); try {await directory.sync();} finally {await directory.close();}
}
export function replicationHealthy(state: ReplicationState, now = new Date(), currentIdentity?: string): boolean {
  return !!currentIdentity && state.lastSuccessIdentity === currentIdentity && !['incomplete','failed'].includes(state.status) && state.lastSuccessAt !== null && now.getTime() >= Date.parse(state.lastSuccessAt) && now.getTime() - Date.parse(state.lastSuccessAt) <= 26 * 3600_000 && (state.status !== 'running' || now.getTime() - Date.parse(state.updatedAt) < TIMEOUT_MS);
}
export async function initializeRepository(config: ReplicationConfig, signal: AbortSignal, runner: ResticRunner = runRestic): Promise<void> {
  await runner(['init'], {cwd: '/tmp', env: resticEnvironment(config), signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])});
}
export class Replicator {
  private current?: Promise<ReplicationResult>;
  constructor(private root: string, private config: ReplicationConfig | null, private runner: ResticRunner = runRestic) {}
  tick(now = new Date(), signal: AbortSignal = new AbortController().signal, options: {force?: boolean} = {}): Promise<ReplicationResult> {
    if (this.current) return this.current;
    this.current = this.perform(now, signal, options.force === true).finally(() => {this.current = undefined;}); return this.current;
  }
  private async perform(now: Date, signal: AbortSignal, force: boolean): Promise<ReplicationResult> {
    const state = await readReplicationState(this.root);
    const next = new Date(now.getTime() + RETRY_MS).toISOString(), updatedAt = now.toISOString();
    if (!this.config || !/^[a-f0-9]{64}$/.test(this.config.identity)) {await saveState(this.root, {...state, status: 'incomplete', updatedAt, nextAttemptAt: next, errorCode: 'REPLICATION_INCOMPLETE'}); return {status: 'incomplete'};}
    const sameTarget = state.lastSuccessIdentity === this.config.identity;
    if (!force && state.nextAttemptAt && Date.parse(state.nextAttemptAt) > now.getTime()) {
      if (!sameTarget) await saveState(this.root, {...state, status: 'incomplete', updatedAt, errorCode: 'REPLICATION_INCOMPLETE'});
      return {status: 'deferred'};
    }
    const config = this.config, combined = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      const result = await withLatestVerifiedBackup(this.root, sameTarget ? state.lastSuccessId : null, async (path, manifest) => {
        combined.throwIfAborted(); await saveState(this.root, {...state, status: 'running', updatedAt, nextAttemptAt: next});
        const options = {cwd: dirname(path), env: resticEnvironment(config), signal: combined};
        await this.runner(['backup','--host',config.deploymentId,'--tag',TAG,'--',basename(path)], options);
        await this.runner(['forget','--host',config.deploymentId,'--tag',TAG,'--group-by','host,tags','--keep-daily','7','--keep-weekly','4'], options);
        combined.throwIfAborted();
        await saveState(this.root, {version: 1, status: 'complete', updatedAt, nextAttemptAt: next, lastSuccessId: manifest.id, lastSuccessAt: updatedAt, lastSuccessIdentity: config.identity});
      });
      if (result.status === 'unchanged' && state.lastSuccessAt && state.status !== 'complete') await saveState(this.root, {...state, status: 'complete', updatedAt, nextAttemptAt: next, errorCode: undefined});
      return {status: result.status};
    } catch {
      await saveState(this.root, {...state, status: 'failed', updatedAt, nextAttemptAt: next, errorCode: 'REPLICATION_FAILED'});
      return {status: 'failed'};
    }
  }
}
