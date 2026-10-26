import type {IncomingMessage, ServerResponse} from 'node:http';
import {once} from 'node:events';
import type {DeviceIdentity} from './auth';
import type {BlobDescriptor, BlobStore} from '../src/workbench/contracts/files';

type ReadableBlobStore = BlobStore & {describe(accountId: string, sha256: string): Promise<BlobDescriptor>};
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, maximum: number): Promise<Buffer> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
/** Called only after AuthService.authenticate on every HTTP request. */
export async function handleBlobRequest(request: IncomingMessage, response: ServerResponse, url: URL, identity: DeviceIdentity, store: ReadableBlobStore): Promise<boolean> {
  if (!url.pathname.startsWith('/v1/blobs/')) return false;
  try {
    if (url.searchParams.has('accountId')) throw new Error('CLIENT_ACCOUNT_FORBIDDEN');
    if (request.method === 'POST' && url.pathname === '/v1/blobs/begin') {
      const input = await body(request, 2048);
      let file: BlobDescriptor;
      try {file = JSON.parse(input.toString('utf8')) as BlobDescriptor;} catch {throw new Error('INVALID_BLOB');}
      if (!file || Object.keys(file).some(key => !['sha256', 'size', 'mime'].includes(key))) throw new Error('INVALID_BLOB');
      json(response, 201, await store.begin(identity.accountId, file)); return true;
    }
    const upload = /^\/v1\/blobs\/uploads\/([a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/(chunks\/(\d+)|commit|cancel)$/.exec(url.pathname);
    if (request.method === 'POST' && upload) {
      if (upload[2].startsWith('chunks/')) {
        await store.putChunk(identity.accountId, upload[1], Number(upload[3]), await body(request, 8_388_608));
        response.writeHead(204, {'cache-control': 'no-store'}); response.end();
      } else if (upload[2] === 'commit') json(response, 200, await store.commit(identity.accountId, upload[1]));
      else {await store.cancel(identity.accountId, upload[1]); json(response, 200, {cancelled: true});}
      return true;
    }
    const download = /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
    if (request.method === 'GET' && download) {
      const file = await store.describe(identity.accountId, download[1]);
      let offset = Number(url.searchParams.get('offset') ?? 0);
      let length = Number(url.searchParams.get('length') ?? file.size);
      let partial = url.searchParams.has('offset') || url.searchParams.has('length');
      if (request.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!range) throw new Error('INVALID_RANGE');
        offset = Number(range[1]); const end = range[2] ? Number(range[2]) : file.size - 1;
        length = end - offset + 1; partial = true;
      }
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > file.size || length > file.size - offset) throw new Error('INVALID_RANGE');
      if (request.headers.range && length === 0) throw new Error('INVALID_RANGE');
      response.writeHead(partial ? 206 : 200, {
        'content-type': 'application/octet-stream', 'content-length': length,
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
        ...(partial && length > 0 ? {'content-range': `bytes ${offset}-${offset + length - 1}/${file.size}`} : {})
      });
      let sent = 0;
      while (sent < length) {
        const bytes = await store.read(identity.accountId, file.sha256, offset + sent, Math.min(1_048_576, length - sent));
        sent += bytes.length;
        if (!response.write(bytes)) await once(response, 'drain');
      }
      response.end(); return true;
    }
    json(response, 404, {error: 'NOT_FOUND'}); return true;
  } catch (error) {
    if (response.headersSent) {response.destroy(error instanceof Error ? error : undefined); return true;}
    const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    const known = /^(INVALID_|CLIENT_ACCOUNT_FORBIDDEN|BLOB_NOT_FOUND|BLOB_CORRUPT|UPLOAD_NOT_FOUND|UPLOAD_CANCELLED|UPLOAD_INCOMPLETE|CHUNK_MISMATCH|CHECKSUM_MISMATCH|SIZE_MISMATCH|BODY_TOO_LARGE)/.test(code);
    const status = /NOT_FOUND$/.test(code) ? 404 : code === 'INVALID_RANGE' ? 416 : code === 'BODY_TOO_LARGE' ? 413 : known ? 400 : 500;
    json(response, status, {error: known ? code : 'INTERNAL_ERROR'}); return true;
  }
}
