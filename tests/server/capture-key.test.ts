import {afterEach, expect, it} from 'vitest';
import {mkdtemp, rm, stat, writeFile, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadCaptureKey} from '../../server/capture-key';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
it('retains exactly the same private 32 byte key across server restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capture-key-')); cleanups.push(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'private', 'capture.key'), first = await loadCaptureKey(path);
  expect(first.length).toBe(32); expect(await loadCaptureKey(path)).toEqual(first);
  expect((await stat(path)).mode & 0o077).toBe(0);
  await writeFile(path, new Uint8Array(12));
  await expect(loadCaptureKey(path)).rejects.toThrow('INVALID_CAPTURE_KEY_FILE');
});
