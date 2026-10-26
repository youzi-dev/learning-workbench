import {createReadStream} from "node:fs";
import type {BlobStore, BlobDescriptor} from "../../src/workbench/contracts/files";
import type {WorkerInput} from "../../worker/runner";
import {CaptureQueue, type CaptureLease, type CaptureOutcome} from "./queue";
import {CAPTURE_LIMITS, errorOutcome} from "./policy";
export type IsolatedResult =
  | {
      state: "file";
      path: string;
      file: BlobDescriptor;
      strategy: "https" | "yt-dlp";
      dispose: () => Promise<void>;
    }
  | CaptureOutcome;
export interface CaptureRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  acquire(input: WorkerInput, signal: AbortSignal): Promise<IsolatedResult>;
}
/** The host also enforces a ceiling, so an unresponsive worker cannot keep a
 * lease alive forever even if its own cancellation code stops making progress. */
async function boundedAcquisition(
  runtime: CaptureRuntime,
  input: WorkerInput,
  signal: AbortSignal,
): Promise<IsolatedResult> {
  signal.throwIfAborted();
  return new Promise<IsolatedResult>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, result?: IsolatedResult) => {
      if (settled) {
        if (result?.state === "file") void result.dispose().catch(() => {});
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      finish(
        signal.reason instanceof Error ? signal.reason : Error("CANCELLED"),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    runtime.acquire(input, signal).then(
      (result) => finish(null, result),
      (error) => finish(error),
    );
  });
}
export class CaptureDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    private readonly queue: CaptureQueue,
    private readonly blobs: BlobStore & {
      describe(accountId: string, sha256: string): Promise<BlobDescriptor>;
    },
    private readonly runtime: CaptureRuntime,
    private readonly limits: Pick<
      WorkerInput,
      "maxBytes" | "imagePdfTimeoutMs" | "videoTimeoutMs"
    > = {},
  ) {}
  async start(): Promise<void> {
    if (this.timer) return;
    await this.runtime.start();
    this.stopping = false;
    this.timer = setInterval(() => this.pump(), 1000);
    this.pump();
  }
  private pump(): void {
    if (this.stopping) return;
    this.queue.maintain();
    while (this.running.size < 2) {
      const lease = this.queue.lease("container-dispatcher");
      if (!lease) break;
      const abort = new AbortController();
      this.running.set(lease.job.id, abort);
      void this.run(lease, abort).finally(() =>
        this.running.delete(lease.job.id),
      );
    }
  }
  private async run(
    lease: CaptureLease,
    abort: AbortController,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      if (abort.signal.aborted) return;
      try {
        this.queue.heartbeat(lease.job.id, lease.leaseToken);
      } catch {
        abort.abort();
      }
    }, 10000);
    // Worker-specific image/PDF and video timers remain 5/30 minutes. The host
    // ceiling uses the larger budget because opaque URLs can identify as video.
    const ceiling = Math.max(
      Math.min(
        this.limits.imagePdfTimeoutMs ?? CAPTURE_LIMITS.imagePdfTimeoutMs,
        CAPTURE_LIMITS.imagePdfTimeoutMs,
      ),
      Math.min(
        this.limits.videoTimeoutMs ?? CAPTURE_LIMITS.videoTimeoutMs,
        CAPTURE_LIMITS.videoTimeoutMs,
      ),
    );
    const deadline = setTimeout(
      () => abort.abort(Error("DEADLINE_EXCEEDED")),
      ceiling,
    );
    let result: IsolatedResult | undefined, uploadId: string | undefined;
    try {
      const input = this.queue.input(lease.job.id, lease.leaseToken);
      this.queue.heartbeat(lease.job.id, lease.leaseToken, "fetching");
      result = await boundedAcquisition(
        this.runtime,
        { ...input, ...this.limits },
        abort.signal,
      );
      if (result.state !== "file") {
        this.queue.settle(lease.job.id, lease.leaseToken, result);
        return;
      }
      this.queue.heartbeat(lease.job.id, lease.leaseToken, "verifying");
      const upload = await this.blobs.begin(lease.accountId, result.file);
      uploadId = upload.uploadId;
      let index = 0,
        pending = Buffer.alloc(0);
      const received = new Set(upload.received);
      for await (const chunk of createReadStream(result.path)) {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= upload.chunkBytes) {
          if (!received.has(index))
            await this.blobs.putChunk(
              lease.accountId,
              uploadId,
              index,
              pending.subarray(0, upload.chunkBytes),
            );
          index++;
          pending = pending.subarray(upload.chunkBytes);
        }
      }
      if (pending.length && !received.has(index))
        await this.blobs.putChunk(lease.accountId, uploadId, index, pending);
      this.queue.heartbeat(lease.job.id, lease.leaseToken, "verifying");
      const committed = await this.blobs.commit(lease.accountId, uploadId);
      await this.queue.finalize(
        lease.job.id,
        lease.leaseToken,
        committed,
        this.blobs,
      );
    } catch (error) {
      if (uploadId)
        await this.blobs.cancel(lease.accountId, uploadId).catch(() => {});
      try {
        this.queue.settle(lease.job.id, lease.leaseToken, errorOutcome(error));
      } catch {
        /* Cancellation or reclaimed lease wins; committed blob is retained. */
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      if (result?.state === "file") await result.dispose();
    }
  }
  cancel(accountId: string, jobId: string): void {
    this.queue.cancel(accountId, jobId);
    this.running.get(jobId)?.abort();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const abort of this.running.values()) abort.abort();
    while (this.running.size)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await this.runtime.stop();
  }
}
