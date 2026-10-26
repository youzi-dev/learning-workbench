import type {BlobDescriptor} from '../src/workbench/contracts/files';
export const MAX_BLOB_BYTES = 1_073_741_824;
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateBlob(file: BlobDescriptor): void {
  if (!file || !validHash(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BLOB_BYTES || typeof file.mime !== 'string' || !file.mime || file.mime.length > 255 || /[\r\n]/.test(file.mime)) throw new Error('INVALID_BLOB');
}
