import type {Id} from './data';
export type LocalFileRef = {token: string; name: string; mime: string; size: number};
export interface FilePort {read(ref: LocalFileRef, offset: number, length: number): Promise<Uint8Array>; import(): Promise<LocalFileRef[]>; stage(ref: LocalFileRef): Promise<LocalFileRef>;}
export type BlobDescriptor = {sha256: string; size: number; mime: string};
export type UploadSession = {uploadId: Id; chunkBytes: number; received: number[]};
export interface BlobStore {
  begin(accountId: Id, file: BlobDescriptor): Promise<UploadSession>;
  putChunk(accountId: Id, uploadId: Id, index: number, bytes: Uint8Array): Promise<void>;
  commit(accountId: Id, uploadId: Id): Promise<BlobDescriptor>;
  read(accountId: Id, sha256: string, offset: number, length: number): Promise<Uint8Array>;
  cancel(accountId: Id, uploadId: Id): Promise<void>;
}
