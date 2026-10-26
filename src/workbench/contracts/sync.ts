import type {Id, ModuleId, MutationBatch, PullPage, PushResult} from './data';
export type SyncHello = {protocolVersion: 1; hostApiVersion: 1; schemas: Record<ModuleId, Record<string, number>>};
export type SyncWelcome = {compatible: boolean; minimumProtocol: number; readonlyKinds: string[]};
export interface SyncTransport {
  handshake(hello: SyncHello): Promise<SyncWelcome>;
  push(batch: MutationBatch): Promise<PushResult>;
  pull(cursor: number, limit: number): Promise<PullPage>;
}
export type CaptureState = 'queued' | 'identifying' | 'fetching' | 'verifying' | 'saved' | 'needs-selection' | 'needs-permission' | 'unsupported' | 'failed' | 'cancelled';
export type CaptureCandidate = {id: string; url: string; source: string; version: string | null; matchReason: string; permission: 'public' | 'authorized'};
export type CaptureRequest = {operationId: Id; assetId: Id; publicSourceUrl: string | null; inputToken?: Id; selectedCandidateId?: string};
export type CaptureInput = {url: string; credentialRef?: string};

/** Wire defaults shared by bounded import/adoption builders and the HTTP service. */
export const SYNC_MAX_MUTATIONS = 100;
export const SYNC_MAX_BODY_BYTES = 1_048_576;
