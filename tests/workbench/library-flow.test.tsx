// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openRepository } from "../../src/platforms/browser/repository";
import { createBrowserPorts } from "../../src/platforms/browser/ports";
import { createHost } from "../../src/workbench/host";
import { manifest } from "../../src/modules/library/manifest";
import { createModule as createLibrary } from "../../src/modules/library/module";
import { manifest as tasksManifest } from "../../src/modules/tasks/manifest";
import { manifest as calendarManifest } from "../../src/modules/calendar/manifest";
import { createModule as createTasks } from "../../src/modules/tasks/module";
import { createModule as createCalendar } from "../../src/modules/calendar/module";
import { LibraryWorkflow } from "../../src/modules/library/workflow";
import { parseReadingState } from "../../src/modules/library/reading-state";
import {
  LibraryPage,
  defaultReadingSchedule,
} from "../../src/modules/library/page";
import type { ModuleContext } from "../../src/workbench/contracts/module";
const deviceId = "00000000-0000-4000-8000-000000000001";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function setup(indexedDB = new IDBFactory()) {
  const schemas = Object.fromEntries(
    [manifest, tasksManifest, calendarManifest].map((m) => [
      m.id,
      Object.fromEntries(
        Object.entries(m.schemas).map(([k, v]) => [k, v.version]),
      ),
    ]),
  );
  const repository = await openRepository("library-flow", {
    indexedDB,
    deviceId,
    schemas,
  });
  cleanups.push(() => repository.close());
  let context!: ModuleContext;
  const host = createHost(
    [
      {
        manifest,
        async load() {
          const module = createLibrary(),
            start = module.start;
          module.start = async (next, signal) => {
            context = next;
            await start(next, signal);
          };
          return module;
        },
      },
      {
        manifest: tasksManifest,
        async load() {
          return createTasks();
        },
      },
      {
        manifest: calendarManifest,
        async load() {
          return createCalendar();
        },
      },
    ],
    createBrowserPorts(),
    { repository },
  );
  await host.start();
  cleanups.push(() => host.stop());

  return {
    repository,
    host,
    context,
    workflow: new LibraryWorkflow(context),
    indexedDB,
  };
}
it("pdf_position_and_bookmarks_survive_restart", async () => {
  const env = await setup();
  const asset = await env.workflow.saveAsset({
    title: "实际阅读",
    publicSourceUrl: null,
    source: "本地导入",
    acquiredAt: null,
    mime: null,
    size: null,
    sha256: null,
    purpose: "",
    tags: [],
    availability: "link-only",
  });
  await env.workflow.saveReadingState({
    assetId: asset.id,
    page: 3,
    bookmarks: [2, 3],
  });
  env.repository.close();
  const reopened = await setup(env.indexedDB);
  expect(await reopened.workflow.readingState(asset.id)).toEqual({
    assetId: asset.id,
    page: 3,
    bookmarks: [2, 3],
  });
  expect(() =>
    parseReadingState({ assetId: asset.id, page: 0, bookmarks: [] }),
  ).toThrow();
});
it("offline_uncached_is_explicit", async () => {
  const env = await setup();
  const asset = await env.workflow.saveAsset({
    title: "尚未下载",
    publicSourceUrl: null,
    source: "远端",
    acquiredAt: new Date().toISOString(),
    mime: "application/pdf",
    size: 20,
    sha256: "a".repeat(64),
    purpose: "待阅读",
    tags: [],
    availability: "available",
  });
  expect(await env.workflow.openAsset(asset.id)).toMatchObject({
    file: null,
    state: "offline-missing",
  });
});
it("asset_purpose_does_not_create_task_and_task_assets_are_single_truth", async () => {
  const env = await setup();
  const asset = await env.workflow.saveAsset({
    title: "资料",
    publicSourceUrl: null,
    source: "本地",
    acquiredAt: null,
    mime: null,
    size: null,
    sha256: null,
    purpose: "先保存用途",
    tags: ["项目"],
    availability: "link-only",
  });
  expect(await env.repository.list("tasks")).toHaveLength(0);
  const taskId = await env.workflow.createTodo(asset.id, "安排阅读");
  await env.workflow.linkAsset(asset.id, taskId);
  const task = (await env.repository.get({
    moduleId: "tasks",
    entityId: taskId,
  }))!;
  expect(task.payload).toMatchObject({
    assets: [{ moduleId: "library", entityId: asset.id }],
  });
  expect(
    (await env.repository.get({ moduleId: "library", entityId: asset.id }))
      ?.payload,
  ).not.toHaveProperty("tasks");
  await env.workflow.schedule(taskId, {
    title: "阅读资料",
    startLocal: "2026-11-01T10:00",
    endLocal: "2026-11-01T11:00",
    timeZone: "Asia/Shanghai",
  });
  expect(
    (await env.repository.list("calendar")).filter(
      (e) => e.kind === "calendar.series",
    ),
  ).toHaveLength(1);
});
it("epub_uses_external_open", async () => {
  const env = await setup();
  const asset = await env.workflow.saveAsset({
    title: "电子书",
    publicSourceUrl: null,
    source: "本地",
    acquiredAt: new Date().toISOString(),
    mime: "application/epub+zip",
    size: 20,
    sha256: "a".repeat(64),
    purpose: "",
    tags: [],
    availability: "available",
  });
  expect((await env.workflow.openAsset(asset.id)).state).toBe(
    "unsupported-format",
  );
});
it("real_react_form_saves_purpose_and_searches_tags_without_task_creation", async () => {
  const env = await setup();
  await env.workflow.saveAsset({
    title: "阅读材料",
    publicSourceUrl: null,
    source: "本地导入",
    acquiredAt: null,
    mime: null,
    size: null,
    sha256: null,
    purpose: "",
    tags: [],
    availability: "link-only",
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  cleanups.push(async () => {
    await act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<LibraryPage context={env.context} workflow={env.workflow} />),
  );
  for (let n = 0; n < 40 && !container.textContent?.includes("阅读材料"); n++)
    await act(() => new Promise((r) => setTimeout(r, 5)));
  expect(container.textContent).toContain("阅读材料");
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "阅读材料",
  )!;
  await act(() => button.click());
  for (
    let n = 0;
    n < 40 && !container.querySelector('[aria-label="资料用途"]');
    n++
  )
    await act(() => new Promise((r) => setTimeout(r, 5)));
  const input = container.querySelector<HTMLTextAreaElement>(
    '[aria-label="资料用途"]',
  )!;
  await act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "用于本周项目");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() =>
    container
      .querySelector('form[aria-label="编辑资料"]')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  for (
    let n = 0;
    n < 40 && !container.textContent?.includes("用途与标签已保存在本机");
    n++
  )
    await act(() => new Promise((r) => setTimeout(r, 5)));
  expect((await env.workflow.list())[0].payload).toMatchObject({
    purpose: "用于本周项目",
  });
  expect(await env.repository.list("tasks")).toHaveLength(0);
});
const basicAsset = (title = "资料") => ({
  title,
  publicSourceUrl: null,
  source: "本地",
  acquiredAt: null,
  mime: null,
  size: null,
  sha256: null,
  purpose: "保留用途",
  tags: ["检索标签"],
  availability: "link-only" as const,
});
async function renderPage(env: Awaited<ReturnType<typeof setup>>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  cleanups.push(async () => {
    await act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<LibraryPage context={env.context} workflow={env.workflow} />),
  );
  return container;
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await act(() => new Promise((r) => setTimeout(r, 5)));
  }
  throw Error("界面未按预期更新");
}
async function fill(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  await act(() => {
    const proto =
      element.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : element.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  )!;
async function submit(container: HTMLElement, label: string) {
  await act(() =>
    container
      .querySelector(`form[aria-label="${label}"]`)!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
it("react_create_task_attach_existing_schedule_and_search_use_real_commands", async () => {
  const env = await setup(),
    asset = await env.workflow.saveAsset(basicAsset("完整闭环"));
  const container = await renderPage(env);
  await until(() => !!button(container, "完整闭环"));
  await act(() => button(container, "完整闭环").click());
  await until(() => !!button(container, "新建待办"));
  await act(() => button(container, "新建待办").click());
  await fill(
    container.querySelector('[aria-label="后续待办标题"]')!,
    "阅读并整理",
  );
  await submit(container, "从资料新建待办");
  await until(
    () =>
      container
        .querySelector('[aria-label="关联待办"]')
        ?.textContent?.includes("阅读并整理") ?? false,
  );
  expect(
    (await env.repository.list("tasks")).find((e) => e.kind === "tasks.task")!
      .payload,
  ).toMatchObject({ assets: [{ moduleId: "library", entityId: asset.id }] });
  await until(() => !button(container, "安排时间").disabled);
  await act(() => button(container, "安排时间").click());
  await fill(
    container.querySelector('[aria-label="阅读开始时间"]')!,
    "2026-11-02T10:00",
  );
  await fill(
    container.querySelector('[aria-label="阅读结束时间"]')!,
    "2026-11-02T11:00",
  );
  await submit(container, "安排阅读时间");
  await until(() => !!container.querySelector('[aria-label="关联日程"]'));
  expect(
    container.querySelector('[aria-label="关联日程"]')?.textContent,
  ).toContain("2026-11-02 10:00");
  expect(
    (await env.repository.list("calendar")).filter(
      (e) => e.kind === "calendar.series",
    ),
  ).toHaveLength(1);
  await until(() => !button(container, "安排时间").disabled);
  await act(() => button(container, "安排时间").click());
  await until(
    () => !!container.querySelector('form[aria-label="安排阅读时间"]'),
  );
  await submit(container, "安排阅读时间");
  await until(
    () => !container.querySelector('form[aria-label="安排阅读时间"]'),
  );
  expect(
    (await env.repository.list("calendar")).filter(
      (e) => e.kind === "calendar.series",
    ),
  ).toHaveLength(1);
  await until(() => !button(container, "安排时间").disabled);
  await fill(container.querySelector('[aria-label="搜索资料"]')!, "检索标签");
  await until(() => !!button(container, "完整闭环"));
  await fill(container.querySelector('[aria-label="搜索资料"]')!, "不匹配");
  await until(
    () => container.textContent?.includes("没有找到匹配的资料") ?? false,
  );
});
it("signed_link_failure_preserves_safe_catalog_and_purpose_and_cannot_overwrite_future_data", async () => {
  const env = await setup();
  await expect(
    env.workflow.collect("https://example.com/paper.pdf?token=topsecret"),
  ).rejects.toThrow(/保留/);
  const [entry] = await env.workflow.list();
  expect(entry.payload).toMatchObject({
    publicSourceUrl: "https://example.com/paper.pdf",
    availability: "link-only",
  });
  expect(JSON.stringify(await env.repository.pending())).not.toContain(
    "topsecret",
  );
  await env.workflow.saveAsset(
    { ...basicAsset(), publicSourceUrl: "https://example.com/paper.pdf" },
    entry.id,
  );
  await expect(env.workflow.startCapture(entry.id)).rejects.toThrow();
  expect((await env.workflow.asset(entry.id)).payload.purpose).toBe("保留用途");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.repository.apply({
    changes: [
      {
        cursor: 1,
        batchId: crypto.randomUUID(),
        entities: [
          {
            id,
            moduleId: "library",
            kind: "library.asset",
            schemaVersion: 9,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            payload: { title: "未来资料", newField: true },
          },
        ],
      },
    ],
    nextCursor: 1,
    hasMore: false,
  });
  await expect(env.workflow.saveAsset(basicAsset(), id)).rejects.toThrow(
    /只读/,
  );
  expect(
    (await env.repository.get({ moduleId: "library", entityId: id }))?.payload,
  ).toMatchObject({ newField: true });
});
it("disabled_tasks_keep_backlinks_readable_and_module_close_stops_writes", async () => {
  const env = await setup(),
    asset = await env.workflow.saveAsset(basicAsset()),
    taskId = await env.workflow.createTodo(asset.id, "保留关联");
  await env.host.setEnabled("tasks", false);
  const refs = await env.context.references.backlinks({
    moduleId: "library",
    entityId: asset.id,
  });
  expect(refs).toContainEqual({ moduleId: "tasks", entityId: taskId });
  expect(await env.context.references.resolve(refs[0])).toMatchObject({
    title: "保留关联",
    moduleEnabled: false,
  });
  await expect(env.workflow.linkAsset(asset.id, taskId)).rejects.toThrow(
    /停用/,
  );
  await env.host.setEnabled("library", false);
  await expect(env.workflow.saveAsset(basicAsset())).rejects.toThrow(/停用/);
});

it("actual_pdf_fixture_parses_through_bounded_range_transport", async () => {
  const { readFile } = await import("node:fs/promises");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createPdfRangeTransport } =
    await import("../../src/modules/library/pdf-reader");
  const bytes = new Uint8Array(
    await readFile(
      `${process.cwd()}/tests/fixtures/workbench/reading-two-pages.pdf`,
    ),
  );
  pdfjs.GlobalWorkerOptions.workerSrc = `file://${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`;
  const reads: number[] = [];
  const resources = {
    async read(_ref: unknown, offset: number, length: number) {
      reads.push(length);
      return bytes.slice(offset, offset + length);
    },
  } as unknown as import("../../src/workbench/contracts/resources").ResourcePort;
  const errors: unknown[] = [];
  const range = createPdfRangeTransport(
    {
      token: "fixture",
      name: "reading.pdf",
      mime: "application/pdf",
      size: bytes.length,
    },
    resources,
    (error) => errors.push(error),
  );
  const task = pdfjs.getDocument({
    range,
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: true,
  });
  try {
    const doc = await task.promise;
    expect(doc.numPages).toBe(2);
    const page = await doc.getPage(2);
    const text = await page.getTextContent();
    expect(
      text.items.map((item) => ("str" in item ? item.str : "")).join(""),
    ).toContain("Reading page 2");
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.max(...reads)).toBeLessThanOrEqual(1024 * 1024);
    expect(errors).toEqual([]);
  } finally {
    range.abort();
    await task.destroy();
  }
});

it("arrange_form_defaults_to_editable_half_hour_in_shanghai_and_saves_without_time_typing", async () => {
  const env = await setup();
  await env.workflow.saveAsset(basicAsset("无需填写时间的资料"));
  const container = await renderPage(env);
  await until(() => !!button(container, "无需填写时间的资料"));
  await act(() => button(container, "无需填写时间的资料").click());
  await until(() => !!button(container, "安排时间"));
  await act(() => button(container, "安排时间").click());
  const start = container.querySelector<HTMLInputElement>(
      '[aria-label="阅读开始时间"]',
    )!,
    end = container.querySelector<HTMLInputElement>(
      '[aria-label="阅读结束时间"]',
    )!;
  expect(start.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:(00|30)$/);
  expect(end.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:(00|30)$/);
  expect(
    Date.parse(`${end.value}+08:00`) - Date.parse(`${start.value}+08:00`),
  ).toBe(30 * 60 * 1000);
  expect(
    container.querySelector<HTMLInputElement>('[aria-label="阅读时区"]')!.value,
  ).toBe("Asia/Shanghai");
  expect(start.disabled).toBe(false);
  expect(end.disabled).toBe(false);
  await submit(container, "安排阅读时间");
  await until(() => !!container.querySelector('[aria-label="关联日程"]'));
  const series = (await env.repository.list("calendar")).find(
    (e) => e.kind === "calendar.series",
  )!;
  expect(series.payload).toMatchObject({
    startLocal: start.value,
    endLocal: end.value,
    timeZone: "Asia/Shanghai",
  });
});

it("default_reading_slot_rolls_over_shanghai_midnight_independently_of_device_zone", () => {
  expect(defaultReadingSchedule(new Date("2026-10-24T15:50:00.000Z"))).toEqual({
    start: "2026-10-25T00:00",
    end: "2026-10-25T00:30",
    timeZone: "Asia/Shanghai",
  });
});

it("upload_and_authored_edits_racing_keep_both_latest_fields", async () => {
  const env = await setup(),
    asset = await env.workflow.saveAsset({
      ...basicAsset("旧标题"),
      mime: "application/pdf",
      size: 42,
      sha256: "b".repeat(64),
      acquiredAt: new Date().toISOString(),
      availability: "pending",
    });
  const uploaded = {
    mime: "application/pdf",
    size: 42,
    sha256: "b".repeat(64),
  };
  await Promise.all([
    env.workflow.uploaded(asset.id, uploaded),
    env.workflow.saveAsset(
      {
        ...asset.payload,
        title: "编辑后的标题",
        purpose: "新用途不可被上传覆盖",
        tags: ["新标签"],
      },
      asset.id,
    ),
  ]);
  expect((await env.workflow.asset(asset.id)).payload).toMatchObject({
    ...uploaded,
    availability: "available",
    title: "编辑后的标题",
    purpose: "新用途不可被上传覆盖",
    tags: ["新标签"],
  });
});
it("stale_editor_keeps_uploaded_availability_and_acquisition_metadata", async () => {
  const env = await setup(),
    asset = await env.workflow.saveAsset({...basicAsset("编辑前"), mime: "application/pdf", size: 42, sha256: "b".repeat(64), acquiredAt: null, availability: "pending"});
  await env.workflow.uploaded(asset.id, {
    mime: "application/pdf",
    size: 42,
    sha256: "b".repeat(64),
  });
  await env.workflow.saveAsset(
    {
      ...asset.payload,
      title: "编辑后",
      purpose: "打开表单后才完成上传",
      tags: ["仍保留文件"],
    },
    asset.id,
  );
  expect((await env.workflow.asset(asset.id)).payload).toMatchObject({
    mime: "application/pdf",
    size: 42,
    sha256: "b".repeat(64),
    availability: "available",
    title: "编辑后",
    purpose: "打开表单后才完成上传",
    tags: ["仍保留文件"],
  });
});
it("stale_editor_keeps_newly_synchronized_capture_descriptor", async () => {
  const env = await setup(),
    now = new Date().toISOString(),
    id = crypto.randomUUID();
  const original = {
    id,
    moduleId: "library",
    kind: "library.asset",
    schemaVersion: 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    payload: basicAsset("抓取中"),
  };
  await env.repository.apply({
    changes: [
      { cursor: 1, batchId: crypto.randomUUID(), entities: [original] },
    ],
    nextCursor: 1,
    hasMore: false,
  });
  const stale = await env.workflow.asset(id);
  const captured = {
    ...stale.payload,
    mime: "image/png",
    size: 75,
    sha256: "c".repeat(64),
    acquiredAt: now,
    availability: "available" as const,
  };
  await env.repository.apply({
    changes: [
      {
        cursor: 2,
        batchId: crypto.randomUUID(),
        entities: [{ ...original, revision: 2, payload: captured }],
      },
    ],
    nextCursor: 2,
    hasMore: false,
  });
  await env.workflow.saveAsset(
    {
      ...stale.payload,
      title: "抓取完成后改名",
      purpose: "保存新用途",
      tags: ["抓取标签"],
    },
    id,
  );
  expect((await env.workflow.asset(id)).payload).toMatchObject({
    ...captured,
    title: "抓取完成后改名",
    purpose: "保存新用途",
    tags: ["抓取标签"],
  });
});

it('opens_the_exact_resource_from_a_completed_linked_task_and_respects_disabled_targets', async () => {
  const {WorkbenchShell} = await import('../../src/workbench/ui/shell');
  const env = await setup();
  const asset = await env.workflow.saveAsset(basicAsset('会议资料导航样例'));
  const taskId = await env.workflow.createTodo(asset.id, '会议准备导航样例');
  await env.host.invoke('tasks', 'status', {id: taskId, status: 'done', operationId: crypto.randomUUID()});
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  cleanups.push(async () => {await act(() => root.unmount()); container.remove();});
  await act(() => root.render(<WorkbenchShell host={env.host}/>));
  expect(typeof env.host.references.open).toBe('function');
  await act(() => env.host.references.open!({moduleId:'tasks', entityId:taskId}));
  for(let n=0;n<40&&!container.querySelector('.wb-reference-list button');n++) await act(() => new Promise(r=>setTimeout(r,5)));
  expect(container.textContent).toContain('会议准备导航样例');
  const link = container.querySelector<HTMLButtonElement>('.wb-reference-list button');
  expect(link?.textContent).toBe('会议资料导航样例');
  await act(() => link!.click());
  for(let n=0;n<40&&!container.querySelector('[aria-label="资料名称"]');n++) await act(() => new Promise(r=>setTimeout(r,5)));
  expect(container.querySelector<HTMLInputElement>('[aria-label="资料名称"]')?.value).toBe('会议资料导航样例');
  const purpose = container.querySelector<HTMLTextAreaElement>('[aria-label="资料用途"]')!;
  await act(() => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(purpose,'未保存的会议重点'); purpose.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async () => {await expect(env.host.references.open!({moduleId:'tasks',entityId:taskId})).rejects.toThrow(/保存/);});
  expect(purpose.value).toBe('未保存的会议重点');
  const search = container.querySelector<HTMLInputElement>('[aria-label="搜索资料"]')!;
  await act(async () => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'过滤掉当前资料'); search.dispatchEvent(new Event('input',{bubbles:true}));});
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="资料用途"]')?.value).toBe('未保存的会议重点');
  expect(search.value).toBe('');
  await act(() => container.querySelector('form[aria-label="编辑资料"]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  for(let n=0;n<100&&(!container.textContent?.includes('用途与标签已保存在本机') || container.querySelector<HTMLButtonElement>('form[aria-label="编辑资料"] button')?.disabled);n++) await act(() => new Promise(r=>setTimeout(r,5)));
  await act(() => env.host.setEnabled('library',false));
  await expect(env.host.references.open!({moduleId:'library',entityId:asset.id})).rejects.toThrow(/停用|关闭|不可用/);
});
