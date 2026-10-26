import type {Entity, Id} from './data';
import type {BlobDescriptor, LocalFileRef} from './files';
import type {CaptureInput, CaptureJob, CaptureRequest} from '../../modules/library/model';

export type LocalAssetFile = {state: 'staged' | 'cached'; ref: LocalFileRef; file: BlobDescriptor; pinned?: boolean} | {state: 'missing'};
export type ResourcePreview = {url: string; release(): Promise<void>};
/** Closed resource capabilities. Modules never receive an authenticated HTTP client. */
export interface ResourcePort {
  capture: {
    enqueue(assetId: Id, rawUrl: string): Promise<void>;
    status(assetId: Id): Promise<import('../files/capture-intents').CaptureIntent | null>;
    flush(signal?: AbortSignal): Promise<void>;
    start(input: CaptureRequest): Promise<Entity<CaptureJob>>;
    cancel(jobId: Id): Promise<Entity<CaptureJob>>;
    retry(jobId: Id, operationId: Id): Promise<Entity<CaptureJob>>;
    input(input: CaptureInput): Promise<{inputToken: Id; expiresAt?: string}>;
  };
  importFiles(files?: readonly File[]): Promise<LocalFileRef[]>;
  bindAsset(assetId: Id, ref: LocalFileRef): Promise<BlobDescriptor>;
  localForAsset(assetId: Id, file?: BlobDescriptor): Promise<LocalAssetFile>;
  upload(assetId: Id): Promise<BlobDescriptor>;
  ensureLocal(assetId: Id, file: BlobDescriptor): Promise<LocalFileRef>;
  read(ref: LocalFileRef, offset: number, length: number): Promise<Uint8Array>;
  preview(ref: LocalFileRef): Promise<ResourcePreview>;
  exportFile(ref: LocalFileRef, name: string): Promise<void>;
  setPinned(assetId: Id, file: BlobDescriptor, pinned: boolean): Promise<void>;
  removeLocal(assetId: Id, file: BlobDescriptor): Promise<void>;
  /** The caller commits verified file metadata through its own repository. */
  onUploaded(listener: (assetId: Id, file: BlobDescriptor) => Promise<void>): () => void;
  flushUploads(): Promise<void>;
}
