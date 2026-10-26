import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {open, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
/** Operator-selected persistent secret path; never generated in a job tempdir or
 * included in the account's metadata/file backup format. */
export async function loadCaptureKey(path: string): Promise<Uint8Array> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const bytes = randomBytes(32); await handle.writeFile(bytes); await handle.sync();
    return new Uint8Array(bytes);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  } finally {await handle?.close();}
  const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await existing.stat();
    if (!details.isFile() || details.size !== 32 || (process.platform !== 'win32' && (details.mode & 0o077) !== 0)) throw Error('INVALID_CAPTURE_KEY_FILE');
    const bytes = new Uint8Array(await existing.readFile());
    if (bytes.length !== 32) throw Error('INVALID_CAPTURE_KEY_FILE');
    return bytes;
  } finally {await existing.close();}
}
