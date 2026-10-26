import {randomUUID} from 'node:crypto';
import {open, stat, rename, rm} from 'node:fs/promises';
import {basename} from 'node:path';
import type {LocalFileRef} from '../../workbench/contracts/files';
import type {FilePreviewSource} from '../../workbench/files/manager';
import {DiskFileStorage} from './file-storage';
import {guessMime} from '../browser/file-picker';

/** Native paths stay in main; the renderer receives only bounded opaque capabilities. */
export function createNativeFiles(options: {directory: string; authorize(accountId: string): void; pick?: () => Promise<string[]>; save?: (name: string) => Promise<string | null>}) {
  const storage = new DiskFileStorage(options.directory);
  const selected = new Map<string, {path: string; ref: LocalFileRef}>();
  const previews = new Map<string, Omit<FilePreviewSource, 'signal'>>();
  const validKey = (key: string) => {if (typeof key !== 'string' || !key || key.length > 500) throw Error('INVALID_FILE_KEY');};
  const range = (offset: number, length: number) => {if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 1_048_576) throw Error('INVALID_RANGE');};
  return {
    async pick() {
      if (!options.pick) throw Error('FILE_PICKER_UNAVAILABLE');
      const refs: LocalFileRef[] = [];
      for (const path of await options.pick()) {
        const details = await stat(path);
        if (!details.isFile() || details.size > 1_073_741_824) throw Error('INVALID_FILE');
        const ref = {token: `native:${randomUUID()}`, name: basename(path), mime: guessMime(path), size: details.size};
        selected.set(ref.token, {path, ref}); refs.push(ref);
      }
      return refs;
    },
    async readSource(ref: LocalFileRef, offset: number, length: number) {
      range(offset, length); const entry = selected.get(ref.token);
      if (!entry || offset + length > entry.ref.size) throw Error('LOCAL_FILE_NOT_FOUND');
      const handle = await open(entry.path, 'r');
      try {
        const bytes = new Uint8Array(length); let copied = 0;
        while (copied < length) {const {bytesRead} = await handle.read(bytes, copied, length - copied, offset + copied); if (!bytesRead) throw Error('SOURCE_SIZE_MISMATCH'); copied += bytesRead;}
        return bytes;
      } finally {await handle.close();}
    },
    async storage(operation: string, accountId: string, key: string, value?: Uint8Array | number, length?: number): Promise<unknown> {
      options.authorize(accountId); validKey(key);
      if (operation === 'read') {const size = await storage.size(accountId, key); if (size !== null && size > 1_048_576) throw Error('FILE_PART_TOO_LARGE'); return storage.read(accountId, key);}
      if (operation === 'size') return storage.size(accountId, key);
      if (operation === 'range') {range(value as number, length!); return storage.readRange(accountId, key, value as number, length!);}
      if (operation === 'write') {
        if (!(value instanceof Uint8Array) || value.length > 1_048_576) throw Error('FILE_PART_TOO_LARGE');
        return storage.write(accountId, key, value);
      }
      if (operation === 'remove') return storage.remove(accountId, key);
      throw Error('INVALID_FILE_OPERATION');
    },
    async preview(source: Omit<FilePreviewSource, 'signal'>) {
      options.authorize(source.accountId);
      if (!Array.isArray(source.keys) || source.keys.length > 1024 || !Number.isSafeInteger(source.size) || source.size < 0 || source.size > 1_073_741_824 || typeof source.mime !== 'string' || source.mime.length > 255) throw Error('INVALID_PREVIEW');
      let total = 0;
      for (const key of source.keys) {validKey(key); const size = await storage.size(source.accountId, key); if (size === null || size > 1_048_576) throw Error('LOCAL_FILE_NOT_FOUND'); total += size;}
      if (total !== source.size) throw Error('SIZE_MISMATCH');
      const token = randomUUID(); previews.set(token, structuredClone(source));
      return {token, url: `growth://files/${token}`};
    },
    async export(token: string, name: string) {
      const source = previews.get(token);
      if (!source || !options.save || typeof name !== 'string') throw Error('EXPORT_UNAVAILABLE');
      options.authorize(source.accountId);
      const destination = await options.save(basename(name).replace(/[\x00-\x1f]/g, '_').slice(0, 240) || '资料');
      if (!destination) throw Error('CANCELLED');
      const check = () => {if (!previews.has(token)) throw Error('EXPORT_REVOKED'); options.authorize(source.accountId);};
      check();
      const temporary = `${destination}.workbench-${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        let copied = 0;
        for (const key of source.keys) {
          check(); const size = await storage.size(source.accountId, key);
          if (size === null || size > 1_048_576) throw Error('FILE_PART_MISSING');
          const bytes = await storage.readRange(source.accountId, key, 0, size); check();
          if (!bytes || bytes.length !== size) throw Error('FILE_PART_MISSING');
          let offset = 0;
          while (offset < size) {check(); const {bytesWritten} = await handle.write(bytes, offset, size - offset); if (!bytesWritten) throw Error('EXPORT_WRITE_FAILED'); offset += bytesWritten;}
          copied += size;
        }
        if (copied !== source.size) throw Error('EXPORT_SIZE_MISMATCH');
        await handle.sync(); await handle.close(); check(); await rename(temporary, destination);
      } catch (cause) {await handle.close().catch(() => {}); await rm(temporary, {force: true}); throw cause;}
    },
    release(token: string) {previews.delete(token);},
    revoke(accountId: string) {for (const [token, source] of previews) if (source.accountId === accountId) previews.delete(token);},
    async response(request: Request): Promise<Response> {
      const token = new URL(request.url).pathname.slice(1), source = previews.get(token);
      if (!source || !['GET', 'HEAD'].includes(request.method)) return new Response('Unavailable', {status: 404});
      try {options.authorize(source.accountId);} catch {return new Response('Unavailable', {status: 403});}
      let start = 0, end = source.size - 1, status = 200;
      const requestedRange = request.headers.get('range');
      if (requestedRange) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
        if (!match || (!match[1] && !match[2])) return new Response(null, {status: 416, headers: {'content-range': `bytes */${source.size}`}});
        start = match[1] ? Number(match[1]) : Math.max(0, source.size - Number(match[2]));
        end = match[1] ? (match[2] ? Number(match[2]) : end) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= source.size) return new Response(null, {status: 416, headers: {'content-range': `bytes */${source.size}`}});
        end = Math.min(end, source.size - 1); status = 206;
      }
      const inline = /^(image\/(?:png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/.test(source.mime);
      const headers = new Headers({'content-type': inline ? source.mime : 'application/octet-stream', 'content-length': String(Math.max(0, end - start + 1)), 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'"});
      if (!inline) headers.set('content-disposition', 'attachment');
      if (status === 206) headers.set('content-range', `bytes ${start}-${end}/${source.size}`);
      if (request.method === 'HEAD' || source.size === 0) return new Response(null, {status, headers});
      const parts: {key: string; start: number; size: number}[] = []; let position = 0;
      for (const key of source.keys) {const size = await storage.size(source.accountId, key); if (size === null) return new Response('Missing', {status: 404}); parts.push({key, start: position, size}); position += size;}
      let cursor = start;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            request.signal.throwIfAborted();
            if (!previews.has(token)) throw Error('PREVIEW_RELEASED');
            options.authorize(source.accountId);
            if (cursor > end) {controller.close(); return;}
            const part = parts.find(part => cursor >= part.start && cursor < part.start + part.size);
            if (!part) throw Error('FILE_PART_MISSING');
            const length = Math.min(1_048_576, end - cursor + 1, part.start + part.size - cursor);
            const bytes = await storage.readRange(source.accountId, part.key, cursor - part.start, length);
            request.signal.throwIfAborted(); if (!previews.has(token)) throw Error('PREVIEW_RELEASED');
            if (!bytes || bytes.length !== length) throw Error('FILE_PART_MISSING');
            cursor += length; controller.enqueue(bytes);
          } catch (cause) {controller.error(cause);}
        },
      });
      return new Response(stream, {status, headers});
    },
    close() {selected.clear(); previews.clear();},
  };
}
