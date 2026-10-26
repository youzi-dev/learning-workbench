import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { MutationBatch } from '../src/workbench/contracts/data';
import {SYNC_MAX_BODY_BYTES} from '../src/workbench/contracts/sync';
import type { SyncHello } from '../src/workbench/contracts/sync';
import { AuthService } from './auth';
import {handleBlobRequest} from './blob-routes';
import type {BlobStore, BlobDescriptor} from '../src/workbench/contracts/files';
import { SyncService } from './sync';
import {handleCaptureRequest} from './capture/routes';
import type {CaptureQueue} from './capture/queue';
import type {CaptureDispatcher} from './capture/runtime';

function reply(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(data));
}
async function readJson(request: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  if (Number(request.headers['content-length'] ?? 0) > maximum) throw new Error('BODY_TOO_LARGE');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maximum) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
  try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body as Record<string, unknown>; }
  catch { throw new Error('INVALID_JSON'); }
}
export function createApp(options: { auth: AuthService; sync: SyncService; maxBodyBytes?: number; readiness?: () => Promise<void>; capture?: {queue: CaptureQueue; dispatcher?: Pick<CaptureDispatcher, 'cancel'>}; allowedOrigins?: readonly string[]; blobs?: BlobStore & {describe(accountId: string, sha256: string): Promise<BlobDescriptor>} }): Server {
  return createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      if (origin) {
        if (!options.allowedOrigins?.includes(origin)) throw new Error('ORIGIN_FORBIDDEN');
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      }
      if (request.method === 'OPTIONS') {
        const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!origin || !['GET', 'POST'].includes(String(request.headers['access-control-request-method'])) || requestedHeaders.some(header => !['authorization', 'content-type', 'range'].includes(header))) throw new Error('ORIGIN_FORBIDDEN');
        response.writeHead(204, {'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range', 'Access-Control-Max-Age': '600'}); response.end(); return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz' && options.readiness) {
        try { await options.readiness(); reply(response, 200, {status: 'ready'}); } catch { reply(response, 503, {status: 'unavailable'}); }
        return;
      }
      if (url.searchParams.has('accountId')) throw new Error('CLIENT_ACCOUNT_FORBIDDEN');
      if (request.method === 'POST' && url.pathname === '/v1/devices/pair') {
        const body = await readJson(request, options.maxBodyBytes ?? SYNC_MAX_BODY_BYTES);
        if (Object.keys(body).some(key => !['code','name','deviceId','replaceExistingDevice'].includes(key))) throw new Error('INVALID_REQUEST');
        const credential = options.auth.pair(body.code as string, body.name as string, request.socket.remoteAddress ?? 'unknown', body.deviceId as string | undefined, body.replaceExistingDevice as boolean | undefined);
        reply(response, 201, credential); return;
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
      const identity = options.auth.authenticate(match?.[1] ?? '');
      if (options.capture && await handleCaptureRequest(request, response, url, identity, options.capture.queue, options.capture.dispatcher)) return;
      if (options.blobs && await handleBlobRequest(request, response, url, identity, options.blobs)) return;
      if (request.method === 'GET' && url.pathname === '/v1/sync/pull') {
        reply(response, 200, await options.sync.pullChanges(identity.accountId, Number(url.searchParams.get('cursor') ?? 0), Number(url.searchParams.get('limit') ?? 50))); return;
      }
      if (request.method === 'POST') {
        const body = await readJson(request, options.maxBodyBytes ?? SYNC_MAX_BODY_BYTES);
        if (Object.hasOwn(body, 'accountId')) throw new Error('CLIENT_ACCOUNT_FORBIDDEN');
        if (url.pathname === '/v1/sync/handshake') { reply(response, 200, options.sync.handshake(body as unknown as SyncHello)); return; }
        if (url.pathname === '/v1/sync/push') {
          const batch = body as unknown as MutationBatch;
          if (!Array.isArray(batch.mutations) || batch.mutations.some(mutation => !mutation || typeof mutation !== 'object')) throw new Error('INVALID_BATCH');
          if (batch.mutations.some(mutation => mutation.deviceId !== identity.deviceId)) throw new Error('DEVICE_MISMATCH');
          reply(response, 200, await options.sync.applyBatch(identity.accountId, batch)); return;
        }
        if (url.pathname === '/v1/devices/refresh') { reply(response, 200, options.auth.refresh(match![1])); return; }
        if (url.pathname === '/v1/devices/revoke') {
          if (typeof body.deviceId !== 'string') throw new Error('INVALID_REQUEST');
          options.auth.revoke(identity.accountId, body.deviceId); reply(response, 200, { revoked: true }); return;
        }
      }
      reply(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
      const known = /^(UNAUTHORIZED|RATE_LIMITED|INVALID_|UNKNOWN_SCHEMA|SCHEMA_VERSION_UNSUPPORTED|BATCH_MISMATCH|BODY_TOO_LARGE|CLIENT_ACCOUNT_FORBIDDEN|DEVICE_MISMATCH|DEVICE_ID_IN_USE|ORIGIN_FORBIDDEN)/.test(code);
      reply(response, code === 'ORIGIN_FORBIDDEN' ? 403 : code === 'UNAUTHORIZED' ? 401 : code === 'RATE_LIMITED' ? 429 : code === 'BODY_TOO_LARGE' ? 413 : known ? 400 : 500, { error: known ? code : 'INTERNAL_ERROR' });
    }
  });
}
