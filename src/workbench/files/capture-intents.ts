import type {Entity} from '../contracts/data';
import type {CaptureJob, CaptureRequest, CaptureInput} from '../../modules/library/model';
import {publicSourceUrl} from '../../modules/library/model';
import {deterministicId} from '../storage/repository';
import {readJson, writeJson, type DurableFileStorage} from './storage';
export type CaptureIntent = {assetId: string; operationId: string; publicSourceUrl: string; protected: boolean; expiresAt: number; state: 'waiting' | 'needs-input' | 'submitted'; inputToken?: string; jobId?: string};
export interface ProtectedInputs {
  adopt?(from: string, to: string, id: string): Promise<boolean>;
  put(account: string, id: string, raw: string, expiresAt: number): Promise<void>;
  get(account: string, id: string): Promise<string | null>;
  remove(account: string, id: string): Promise<void>;
}
const DAY = 86400000;
/** Device-local intent is safe to inspect. Complete URLs exist only in the protected adapter. */
export class CaptureIntents {
  private flushing?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private account: string, private storage: DurableFileStorage, private protectedInputs: ProtectedInputs | undefined, private check: () => void) {}
  private async load() {this.check(); const result = await readJson<Record<string, CaptureIntent>>(this.storage, this.account, 'capture-intents-v1', {}); this.check(); return result;}
  private async save(items: Record<string, CaptureIntent>) {this.check(); await writeJson(this.storage, this.account, 'capture-intents-v1', items); this.check();}
  private run<T>(action: () => Promise<T>): Promise<T> {const task = this.serial.catch(() => {}).then(action); this.serial = task; return task;}
  expire(): Promise<void> {return this.run(async () => {
    const items = await this.load(); let changed = false;
    for (const item of Object.values(items)) if (item.protected && item.expiresAt <= Date.now()) {
      await this.protectedInputs?.remove(this.account, item.operationId);
      if (item.state !== 'submitted' && item.state !== 'needs-input') {item.state = 'needs-input'; delete item.inputToken; changed = true;}
    }
    if (changed) await this.save(items);
  });}
  async status(assetId: string) {const item = (await this.load())[assetId]; return item ? {...item, state: item.protected && item.state !== 'submitted' && item.expiresAt <= Date.now() ? 'needs-input' as const : item.state} : null;}
  enqueue(assetId: string, raw: string): Promise<void> {return this.run(async () => {
    const url = publicSourceUrl(raw); if (!url || raw.length > 16384) throw Error('请输入有效的 HTTPS 网址');
    const items = await this.load();
    const previous = items[assetId];
    if (previous && previous.state !== 'needs-input' && previous.expiresAt > Date.now()) return;
    const expiresAt = Date.now() + DAY;
    const item: CaptureIntent = {assetId, operationId: deterministicId(`paste:${assetId}:${expiresAt}`), publicSourceUrl: url, protected: raw !== url, expiresAt, state: 'waiting'};
    if (item.protected) {
      if (!this.protectedInputs) item.state = 'needs-input';
      else await this.protectedInputs.put(this.account, item.operationId, raw, expiresAt);
    }
    items[assetId] = item; await this.save(items);
  });}
  flush(api: {input(input: CaptureInput): Promise<{inputToken: string}>; start(input: CaptureRequest): Promise<Entity<CaptureJob>>}, signal?: AbortSignal): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run(async () => {
    const ensure = () => {this.check(); signal?.throwIfAborted();};
    const items = await this.load();
    for (const item of Object.values(items)) {
      ensure();
      if (item.state === 'submitted' || item.state === 'needs-input') continue;
      if (item.protected && item.expiresAt <= Date.now()) {
        await this.protectedInputs?.remove(this.account, item.operationId);
        delete item.inputToken; item.state = 'needs-input'; await this.save(items); continue;
      }
      try {
        if (item.protected && !item.inputToken) {
          const raw = await this.protectedInputs?.get(this.account, item.operationId); ensure();
          if (!raw) {item.state = 'needs-input'; await this.save(items); continue;}
          const result = await api.input({url: raw, expiresAt: new Date(item.expiresAt).toISOString()}); ensure();
          item.inputToken = result.inputToken; await this.save(items);
        }
        ensure();
        const job = await api.start({operationId: item.operationId, assetId: item.assetId, publicSourceUrl: item.publicSourceUrl, ...(item.inputToken ? {inputToken: item.inputToken} : {})}); ensure();
        item.state = 'submitted'; item.jobId = job.id; delete item.inputToken;
        await this.save(items); await this.protectedInputs?.remove(this.account, item.operationId);
      } catch (cause) {
        ensure();
        if ((cause instanceof Error ? cause.message : '') === 'INPUT_EXPIRED') {item.state = 'needs-input'; delete item.inputToken; await this.protectedInputs?.remove(this.account, item.operationId); await this.save(items);}
        // Connection failure retains the same operation and original expiry for restart/reconnect.
      }
    }
  }).finally(() => {this.flushing = undefined;});
  return this.flushing;
  }
}
