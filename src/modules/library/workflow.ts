import type {
  Entity,
  Id,
  JsonValue,
  LocalReceipt,
} from "../../workbench/contracts/data";
import {SharedCaptureHandoff} from "./shared-capture";
import type {IncomingShare} from "../../workbench/contracts/platform";
import type { ModuleContext } from "../../workbench/contracts/module";
import type {
  BlobDescriptor,
  LocalFileRef,
} from "../../workbench/contracts/files";
import {SYNC_MAX_MUTATIONS, SYNC_MAX_BODY_BYTES} from "../../workbench/contracts/sync";
import { canonical, deterministicId } from "../../workbench/storage/repository";
import {
  parseAsset,
  publicSourceUrl,
  type Asset,
  type CaptureJob,
} from "./model";
import { parseReadingState, type ReadingState } from "./reading-state";
import { parseTask, type Task } from "../tasks/model";
import { parseSeries, type CalendarSeries } from "../calendar/model";
const json = (value: unknown) => value as JsonValue;
export const descriptor = (asset: Asset): BlobDescriptor | undefined =>
  asset.sha256 && asset.size !== null && asset.mime
    ? { sha256: asset.sha256, size: asset.size, mime: asset.mime }
    : undefined;
export class LibraryWorkflow {
  private writes: Promise<unknown> = Promise.resolve();
  private sharedCapture: SharedCaptureHandoff;
  constructor(
    readonly context: ModuleContext,
    readonly signal?: AbortSignal,
  ) {this.sharedCapture = new SharedCaptureHandoff(context, () => this.check());}
  async maintainPastedCaptures(): Promise<void> {this.check(); await this.context.platform.resources?.capture.flush(); this.check();}
  maintainSharedCaptures(): Promise<void> {const next = this.writes.catch(() => {}).then(() => this.sharedCapture.maintain());this.writes = next;return next;}
  private check() {
    if (this.signal?.aborted) throw Error("资料模块已关闭");
    if (!this.context.deviceId) throw Error("设备身份尚未就绪，当前只读");
  }
  private put(
    id: Id,
    kind: string,
    payload: unknown | ((current: Entity | null) => unknown),
  ): Promise<LocalReceipt> {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        this.check();
        const current = await this.context.repository.get({
          moduleId: "library",
          entityId: id,
        });
        if (
          current &&
          (current.schemaVersion !== 1 ||
            current.kind !== kind ||
            current.deletedAt)
        )
          throw Error("此资料需要更新客户端，当前只读");
        this.check();
        const now = new Date().toISOString();
        return this.context.repository.commit({
          batchId: crypto.randomUUID(),
          mutations: [
            {
              operationId: crypto.randomUUID(),
              deviceId: this.context.deviceId!,
              entityId: id,
              moduleId: "library",
              kind,
              schemaVersion: 1,
              baseRevision: current?.revision || null,
              createdAt: current?.createdAt ?? now,
              updatedAt: now,
              action: "put",
              payload: json(
                typeof payload === "function" ? payload(current) : payload,
              ),
            },
          ],
        }, {expectedLocal: {[id]: current ? canonical(current) : null}});
      });
    this.writes = next;
    return next;
  }
  /** One native delivery becomes one atomic library batch. A deliberate re-share has a new deliveryId. */
  ingestShare(share: IncomingShare): Promise<LocalReceipt> {
    const captured = structuredClone(share);
    const next = this.writes.catch(() => {}).then(() => this.ingestShareOnce(captured));
    this.writes = next;
    return next;
  }
  private async ingestShareOnce(share: IncomingShare): Promise<LocalReceipt> {
    this.check();
    if (!share.deliveryId || share.status === 'needs-reshare' || share.status === 'copying') throw Error(share.message ?? '请重新分享文件');
    const batchId = deterministicId(`share:${share.deliveryId}:batch`);
    const rootId = deterministicId(`share:${share.deliveryId}:asset:0`);
    const existing = await this.context.repository.get({moduleId: 'library', entityId: rootId});
    if (existing) {await this.handoffSharedLinks(share); return {batchId, state: 'saved-local'};}
    const incomingText = share.text?.trim() ?? '';
    if (incomingText.length > 10000) throw Error('分享文字超过 10000 字，请拆分后重新分享');
    if (share.files.length + (incomingText || share.url ? 1 : 0) > SYNC_MAX_MUTATIONS) throw Error('每次分享最多包含 100 项资料，文字或链接也占一项，请拆分后重新分享');
    const assets: Asset[] = [];
    const now = share.receivedAt ?? new Date().toISOString();
    for (let index = 0; index < share.files.length; index++) {
      this.check();
      const resources = this.context.platform.resources;
      if (!resources) throw Error('此设备暂不支持导入文件');
      const id = deterministicId(`share:${share.deliveryId}:asset:${index}`);
      const ref = await this.context.platform.files.stage(share.files[index]);
      const file = await resources.bindAsset(id, ref);
      assets.push(parseAsset({title: ref.name, publicSourceUrl: null, source: '系统分享', acquiredAt: now, ...file, purpose: '', tags: [], availability: 'pending'}));
    }
    const text = share.text?.trim() ?? '';
    const rawUrl = share.url ?? text.match(/https:\/\/[^\s<>"']+/)?.[0];
    const url = rawUrl ? publicSourceUrl(rawUrl) : null;
    // Complete signed URLs never enter the document or index.
    const prose = text.replace(/https?:\/\/[^\s<>"']+/g, raw => publicSourceUrl(raw) ?? '').trim();
    if (url || prose) assets.push(parseAsset({title: url ? new URL(url).hostname : prose.slice(0, 200), publicSourceUrl: url, source: '系统分享', acquiredAt: null, mime: null, size: null, sha256: null, purpose: prose, tags: [], availability: 'link-only'}));
    if (!assets.length) throw Error('分享内容为空，请重新分享');
    this.check();
    const batch = {batchId, mutations: assets.map((payload,index) => ({operationId: deterministicId(`${batchId}:${index}`), deviceId: this.context.deviceId!, entityId: deterministicId(`share:${share.deliveryId}:asset:${index}`), moduleId: 'library', kind: 'library.asset', schemaVersion: 1, baseRevision: null, createdAt: now, updatedAt: now, action: 'put' as const, payload: json(payload)}))};
    if (batch.mutations.length > SYNC_MAX_MUTATIONS || new TextEncoder().encode(canonical(batch)).length > SYNC_MAX_BODY_BYTES) throw Error('分享内容超过同步上限，请拆分后重新分享');
    const receipt = await this.context.repository.commit(batch);
    void this.context.platform.resources?.flushUploads().catch(() => {});
    await this.handoffSharedLinks(share);
    return receipt;
  }
  private async handoffSharedLinks(share: IncomingShare) {
    const rawUrl = share.url ?? share.text?.match(/https:\/\/[^\s<>"']+/)?.[0];
    if (rawUrl && publicSourceUrl(rawUrl)) await this.sharedCapture.submit(share, deterministicId(`share:${share.deliveryId}:asset:${share.files.length}`), rawUrl);
  }
  async asset(id: Id): Promise<Entity<Asset>> {
    const entry = await this.context.repository.get({
      moduleId: "library",
      entityId: id,
    });
    if (!entry || entry.deletedAt || entry.kind !== "library.asset")
      throw Error("找不到这份资料");
    if (entry.schemaVersion !== 1)
      throw Error("此资料需要更新客户端，当前只读");
    return { ...entry, payload: parseAsset(entry.payload) };
  }
  async list(query = "") {
    const search = query.trim().toLocaleLowerCase();
    return (await this.context.repository.list("library"))
      .filter(
        (e) =>
          e.kind === "library.asset" &&
          !e.deletedAt &&
          (!search ||
            JSON.stringify(e.payload).toLocaleLowerCase().includes(search)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async saveAsset(
    input: Asset,
    id: Id = crypto.randomUUID(),
  ): Promise<Entity<Asset>> {
    const details = parseAsset(input);
    await this.put(id, "library.asset", (current: Entity | null) => {
      if (!current) return details;
      // A stale editor owns only authored fields, never acquisition metadata.
      const latest = parseAsset(current.payload);
      return parseAsset({
        ...latest,
        title: details.title,
        purpose: details.purpose,
        tags: details.tags,
      });
    });
    return this.asset(id);
  }
  async uploaded(id: Id, file: BlobDescriptor) {
    await this.put(id, "library.asset", (current: Entity | null) => {
      if (!current) throw Error("找不到这份资料");
      const latest = parseAsset(current.payload);
      // An import-conflict choice may replace this asset while its old upload is in flight.
      if (latest.sha256 !== file.sha256 || latest.size !== file.size) throw Object.assign(Error('资料已选择另一份原件'), {code: 'ASSET_ORIGINAL_CHANGED'});
      return parseAsset({
        ...latest,
        ...file,
        mime: latest.mime ?? file.mime,
        acquiredAt: latest.acquiredAt ?? new Date().toISOString(),
        availability: "available",
      });
    });
  }
  async collect(input: string): Promise<Entity<Asset>> {
    const match = input.trim().match(/https:\/\/[^\s<>"']+/g);
    if (!match || match.length !== 1)
      throw Error("请粘贴一个 HTTPS 网址；分享文字中可包含一个网址");
    const raw = match[0],
      url = publicSourceUrl(raw);
    if (!url) throw Error("请输入有效的 HTTPS 网址");
    const asset = await this.saveAsset({
      title: new URL(url).hostname,
      publicSourceUrl: url,
      source: new URL(url).hostname,
      acquiredAt: null,
      mime: null,
      size: null,
      sha256: null,
      purpose: "",
      tags: [],
      availability: "link-only",
    });
    const resources = this.context.platform.resources;
    if (!resources) throw Error('此设备尚未接通资料存储，原链接已保留');
    await resources.capture.enqueue(asset.id, raw);
    void this.maintainPastedCaptures().catch(() => {});
    return this.asset(asset.id);
  }
  async startCapture(
    assetId: Id,
    url?: string,
    selectedCandidateId?: string,
  ): Promise<Entity<CaptureJob>> {
    this.check();
    const resources = this.context.platform.resources;
    if (!resources) throw Error("当前设备尚未连接资料获取服务，原链接已保留");
    const asset = await this.asset(assetId);
    let inputToken: string | undefined;
    if (url) {
      inputToken = (await resources.capture.input({ url })).inputToken;
    }
    this.check();
    return resources.capture.start({
      operationId: crypto.randomUUID(),
      assetId,
      publicSourceUrl: asset.payload.publicSourceUrl,
      ...(inputToken ? { inputToken } : {}),
      ...(selectedCandidateId ? { selectedCandidateId } : {}),
    });
  }
  async importFiles(files?: readonly File[]): Promise<Entity<Asset>[]> {
    this.check();
    const resources = this.context.platform.resources;
    if (!resources) throw Error("此设备暂不支持导入文件");
    const refs = await resources.importFiles(files),
      result: Entity<Asset>[] = [];
    for (const ref of refs) {
      this.check();
      const id = crypto.randomUUID(),
        file = await resources.bindAsset(id, ref);
      const asset = await this.saveAsset(
        {
          title: ref.name,
          publicSourceUrl: null,
          source: "本地导入",
          acquiredAt: new Date().toISOString(),
          ...file,
          purpose: "",
          tags: [],
          availability: "pending",
        },
        id,
      );
      result.push(asset);
    }
    void resources.flushUploads().catch(() => {});
    return result;
  }
  async openAsset(assetId: Id): Promise<{
    file: LocalFileRef | null;
    state: "ready" | "offline-missing" | "link-only" | "unsupported-format";
    localState?: "staged" | "cached";
    pinned?: boolean;
  }> {
    const asset = (await this.asset(assetId)).payload;
    const unsupported =
      asset.mime === "application/epub+zip" ||
      (!asset.mime?.startsWith("image/") &&
        !asset.mime?.startsWith("video/") &&
        asset.mime !== "application/pdf");
    const file = await this.context.platform.resources?.localForAsset(
      assetId,
      descriptor(asset),
    );
    if (file && file.state !== "missing")
      return {
        file: file.ref,
        state: unsupported ? "unsupported-format" : "ready",
        localState: file.state,
        pinned: file.pinned,
      };
    if (unsupported && asset.mime)
      return { file: null, state: "unsupported-format" };
    return {
      file: null,
      state:
        asset.availability === "link-only" ? "link-only" : "offline-missing",
    };
  }
  async readingState(assetId: Id): Promise<ReadingState> {
    const entry = await this.context.repository.get({
      moduleId: "library",
      entityId: deterministicId(`${assetId}:reading`),
    });
    if (!entry) return { assetId, page: 1, bookmarks: [] };
    if (entry.schemaVersion !== 1)
      throw Error("阅读记录来自较新版本，当前只读");
    return parseReadingState(entry.payload);
  }
  async saveReadingState(input: ReadingState) {
    const state = parseReadingState(input);
    return this.put(
      deterministicId(`${state.assetId}:reading`),
      "library.reading-state",
      state,
    );
  }
  async linkAsset(assetId: Id, taskId: Id): Promise<LocalReceipt> {
    this.check();
    await this.asset(assetId);
    return (await this.context.invoke("tasks", "attach-asset", {
      taskId,
      asset: { moduleId: "library", entityId: assetId },
    })) as unknown as LocalReceipt;
  }
  async tasks(): Promise<Entity<Task>[]> {
    return (
      (await this.context.invoke("tasks", "list", {})) as unknown as Entity[]
    )
      .filter(
        (e) => e.kind === "tasks.task" && !e.deletedAt && e.schemaVersion === 1,
      )
      .flatMap((e) => {
        try {
          return [{ ...e, payload: parseTask(e.payload) }];
        } catch {
          return [];
        }
      });
  }
  async createTodo(assetId: Id, title: string): Promise<Id> {
    this.check();
    const previous = new Set((await this.tasks()).map((e) => e.id));
    await this.context.invoke("tasks", "create", {
      title,
      assets: [{ moduleId: "library", entityId: assetId }],
    });
    const task = (await this.tasks()).find(
      (e) =>
        !previous.has(e.id) &&
        e.payload.assets.some(
          (a) => a.moduleId === "library" && a.entityId === assetId,
        ),
    );
    if (!task) throw Error("待办已保存，请在待办中查看");
    await this.linkAsset(assetId, task.id);
    return task.id;
  }
  async schedules(taskIds: Id[]): Promise<Entity<CalendarSeries>[]> {
    return (
      (await this.context.invoke(
        "calendar",
        "series",
        {},
      )) as unknown as Entity[]
    )
      .filter(
        (e) =>
          e.kind === "calendar.series" && !e.deletedAt && e.schemaVersion === 1,
      )
      .flatMap((e) => {
        try {
          const payload = parseSeries(e.payload);
          return payload.taskId && taskIds.includes(payload.taskId)
            ? [{ ...e, payload }]
            : [];
        } catch {
          return [];
        }
      });
  }
  async schedule(
    taskId: Id,
    input: {
      title: string;
      startLocal: string;
      endLocal: string;
      timeZone: string;
    },
  ) {
    this.check();
    const existing = await this.schedules([taskId]);
    if (
      existing.some(
        (e) =>
          e.payload.title === input.title &&
          e.payload.startLocal === input.startLocal &&
          e.payload.endLocal === input.endLocal &&
          e.payload.timeZone === input.timeZone,
      )
    )
      return;
    await this.context.invoke(
      "calendar",
      "create",
      json(parseSeries({ ...input, taskId })),
    );
  }
}
