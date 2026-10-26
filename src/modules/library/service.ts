import type { Entity, Id } from "../../workbench/contracts/data";
import {
  parseCaptureJob,
  type CaptureInput,
  type CaptureJob,
  type CaptureRequest,
} from "./model";
export interface CapturePort {
  submitCapture(request: CaptureRequest): Promise<Entity<CaptureJob>>;
  cancelCapture(jobId: Id): Promise<void>;
  retryCapture(jobId: Id, operationId: Id): Promise<void>;
  storeCaptureInput(
    input: CaptureInput,
  ): Promise<{ inputToken: Id; expiresAt: string }>;
}
/** Secrets go directly to the authenticated server input endpoint. They never
 * pass through a LocalRepository, outbox, entity, activity or backup. */
export class HttpCaptureService implements CapturePort {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => Promise<string | null>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, value: unknown): Promise<any> {
    const token = await this.token();
    if (!token) throw Error("请先连接同步服务");
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
      cache: "no-store",
    });
    const body = await response.json();
    if (!response.ok)
      throw Error(typeof body.error === "string" ? body.error : "获取请求失败");
    return body;
  }
  async submitCapture(request: CaptureRequest): Promise<Entity<CaptureJob>> {
    const entity = (await this.request("/v1/capture/jobs", request)) as Entity;
    return { ...entity, payload: parseCaptureJob(entity.payload) };
  }
  async cancelCapture(jobId: Id): Promise<void> {
    await this.request(
      `/v1/capture/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
  }
  async retryCapture(jobId: Id, operationId: Id): Promise<void> {
    await this.request(`/v1/capture/jobs/${encodeURIComponent(jobId)}/retry`, {
      operationId,
    });
  }
  async storeCaptureInput(
    input: CaptureInput,
  ): Promise<{ inputToken: Id; expiresAt: string }> {
    return this.request("/v1/capture/inputs", input);
  }
}
