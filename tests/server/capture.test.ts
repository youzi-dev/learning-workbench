import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../../server/database";
import { CaptureQueue } from "../../server/capture/queue";
import { streamToFile } from "../../worker/downloaders";
import { publicSourceUrl } from "../../src/modules/library/model";
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workbench-capture-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  disposers.push(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let now = 1000;
  const queue = new CaptureQueue(db, {
    secretKey: new Uint8Array(32).fill(7),
    now: () => now,
    leaseMs: 100,
  });
  return {
    dir,
    db,
    queue,
    account: randomUUID(),
    tick: (ms: number) => {
      now += ms;
    },
  };
}
async function submit(q: CaptureQueue, account: string, inputToken?: string) {
  return q.submit(account, {
    operationId: randomUUID(),
    assetId: randomUUID(),
    publicSourceUrl: "https://example.org/manual.pdf",
    ...(inputToken ? { inputToken } : {}),
  });
}
it("permission_and_selection_do_not_retry", async () => {
  const { queue, account, tick } = fixture();
  for (const state of ["needs-permission", "needs-selection"] as const) {
    const job = await submit(queue, account);
    const lease = queue.lease("worker")!;
    queue.settle(job.id, lease.leaseToken, {
      state,
      errorCode: state,
      candidates: [],
    });
    tick(1000);
    expect(queue.lease("worker")).toBeNull();
    expect(queue.get(account, job.id).payload.state).toBe(state);
  }
});
it("lease_crash_recovers_once and stale worker cannot finish reclaimed job", async () => {
  const { queue, account, tick, db, dir } = fixture();
  const job = await submit(queue, account);
  const lease = queue.lease("old")!;
  tick(101);
  db.close();
  const reopenedDb = openDatabase(join(dir, "db.sqlite"));
  disposers.push(() => reopenedDb.close());
  const reopened = new CaptureQueue(reopenedDb, {
    secretKey: new Uint8Array(32).fill(7),
    now: () => 1101,
    leaseMs: 100,
  });
  const recovered = reopened.lease("new")!;
  expect(recovered.job.id).toBe(job.id);
  expect(recovered.leaseToken).not.toBe(lease.leaseToken);
  expect(reopened.lease("third")).toBeNull();
  expect(() =>
    reopened.settle(job.id, lease.leaseToken, {
      state: "failed",
      errorCode: "old",
    }),
  ).toThrow("LEASE_LOST");
});
it("concurrency and transient retry limits survive disk state", async () => {
  const { queue, account, tick } = fixture();
  for (let i = 0; i < 3; i++) await submit(queue, account);
  const first = queue.lease("one")!,
    second = queue.lease("two")!;
  expect(queue.lease("three")).toBeNull();
  queue.cancel(account, second.job.id);
  queue.cancel(
    account,
    queue.list(account).find((j) => j.payload.state === "queued")!.id,
  );
  let current = first;
  for (let i = 0; i < 4; i++) {
    queue.settle(first.job.id, current.leaseToken, {
      state: "failed",
      errorCode: "NETWORK",
      transient: true,
    });
    tick(10000);
    if (i < 3) current = queue.lease("one")!;
  }
  expect(queue.get(account, first.job.id).payload.attempts).toBe(4);
  expect(queue.lease("one")).toBeNull();
});
it("cancel_never_marks_saved and does not permit late settlement", async () => {
  const { queue, account } = fixture();
  const job = await submit(queue, account),
    lease = queue.lease("worker")!;
  queue.cancel(account, job.id);
  queue.cancel(account, job.id);
  expect(() =>
    queue.settle(job.id, lease.leaseToken, {
      state: "saved",
      blob: { sha256: "a".repeat(64), size: 2, mime: "image/png" },
    }),
  ).toThrow("LEASE_LOST");
  expect(queue.get(account, job.id).payload.state).toBe("cancelled");
});
it("signed_query_never_reaches_sync_backup_or_logs and terminal_job_destroys_secret_input", async () => {
  const { queue, account, db, tick } = fixture();
  const secret =
    "https://example.org/manual.pdf?X-Amz-Signature=very-secret&token=hidden";
  const input = queue.storeInput(account, { url: secret });
  const job = await submit(queue, account, input.inputToken);
  expect(JSON.stringify(queue.get(account, job.id))).not.toContain(
    "very-secret",
  );
  const raw = JSON.stringify(db.prepare("SELECT * FROM capture_inputs").all());
  expect(raw).not.toContain("very-secret");
  const lease = queue.lease("worker")!;
  expect(queue.input(job.id, lease.leaseToken).url).toBe(secret);
  queue.settle(job.id, lease.leaseToken, {
    state: "needs-permission",
    errorCode: "PERMISSION",
  });
  expect(db.prepare("SELECT * FROM capture_inputs").all()).toHaveLength(0);
  const another = queue.storeInput(account, { url: secret });
  tick(24 * 3600 * 1000 + 1);
  expect(() =>
    queue.submit(account, {
      operationId: randomUUID(),
      assetId: randomUUID(),
      publicSourceUrl: null,
      inputToken: another.inputToken,
    }),
  ).toThrow("INPUT_EXPIRED");
  expect(publicSourceUrl(secret)).toBe("https://example.org/manual.pdf");
});
it("body_limit_ignores_content_length and removes incomplete file", async () => {
  const { dir } = fixture();
  const file = join(dir, "download");
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    }),
    { headers: { "content-length": "1" } },
  );
  await expect(
    streamToFile(response.body!, file, { maxBytes: 10 }),
  ).rejects.toThrow("BODY_LIMIT");
  expect(() => readFileSync(file)).toThrow();
});

it("HTML visible image candidates and edition variants remain explicit selections", async () => {
  const { identifyHtml, openAccessCandidates } =
    await import("../../server/capture/strategies");
  const items = identifyHtml(
    '<html><meta property="og:image" content="/cover.png"><img src="/a.png" srcset="/a2.png 2x, /a3.png 3x"><link rel="alternate" type="application/pdf" href="/draft.pdf" title="作者手稿"></html>',
    "https://example.org/book",
  );
  expect(items.map((c) => c.url)).toEqual([
    "https://example.org/cover.png",
    "https://example.org/a.png",
    "https://example.org/a2.png",
    "https://example.org/a3.png",
    "https://example.org/draft.pdf",
  ]);
  const candidates = openAccessCandidates(
    {
      doi: "https://doi.org/10.1000/example",
      locations: [
        {
          is_oa: true,
          pdf_url: "https://university.edu/draft.pdf",
          version: "submittedVersion",
          source: { display_name: "机构存档" },
        },
        { is_oa: false, pdf_url: "https://publisher.com/vor.pdf" },
      ],
    },
    "10.1000/example",
  );
  expect(candidates).toEqual([
    expect.objectContaining({
      version: "submittedVersion",
      source: "机构存档",
      matchReason:
        "DOI 10.1000/example 相同；来源标注 submittedVersion，需要确认版本",
    }),
  ]);
});
it("chosen candidate must come from the same asset and cannot silently pick a different version", async () => {
  const { queue, account } = fixture();
  const job = await submit(queue, account),
    lease = queue.lease("worker")!;
  queue.settle(job.id, lease.leaseToken, {
    state: "needs-selection",
    candidates: [
      {
        id: "draft",
        url: "https://example.org/author-draft.pdf",
        source: "作者主页",
        version: "作者手稿",
        matchReason: "同 DOI，版本不同",
        permission: "public",
      },
    ],
  });
  const selected = queue.submit(account, {
    operationId: randomUUID(),
    assetId: job.payload.assetId,
    publicSourceUrl: "https://example.org/manual.pdf",
    selectedCandidateId: "draft",
  });
  const picked = queue.lease("worker")!;
  expect(picked.job.id).toBe(selected.id);
  expect(queue.input(picked.job.id, picked.leaseToken).url).toBe(
    "https://example.org/author-draft.pdf",
  );
  expect(() =>
    queue.submit(account, {
      operationId: randomUUID(),
      assetId: randomUUID(),
      publicSourceUrl: "https://example.org/manual.pdf",
      selectedCandidateId: "draft",
    }),
  ).toThrow("CANDIDATE_NOT_FOUND");
});
it("saved metadata requires exact committed descriptor and cancellation retains committed file", async () => {
  const { DiskBlobStore } = await import("../../server/blob");
  const { createHash } = await import("node:crypto");
  const { queue, account, dir } = fixture(),
    store = new DiskBlobStore(join(dir, "blobs"));
  const job = await submit(queue, account),
    lease = queue.lease("worker")!;
  const bytes = new Uint8Array([1, 2, 3]),
    file = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: 3,
      mime: "image/png",
    };
  await expect(
    queue.finalize(job.id, lease.leaseToken, file, store),
  ).rejects.toThrow("BLOB_NOT_FOUND");
  const upload = await store.begin(account, file);
  await store.putChunk(account, upload.uploadId, 0, bytes);
  await store.commit(account, upload.uploadId);
  await expect(
    queue.finalize(job.id, lease.leaseToken, { ...file, size: 999 }, store),
  ).rejects.toThrow("DESCRIPTOR_MISMATCH");
  const savedResults = await Promise.all([
    queue.finalize(job.id, lease.leaseToken, file, store),
    queue.finalize(job.id, lease.leaseToken, file, store),
  ]);
  expect(savedResults.map((result) => result.payload.state)).toEqual([
    "saved",
    "saved",
  ]);
  queue.cancel(account, job.id);
  expect(queue.get(account, job.id).payload.state).toBe("saved");
  expect(await store.read(account, file.sha256, 0, 3)).toEqual(bytes);
});
it("expired inputs are inaccessible after restart and wrong local key cannot decrypt", async () => {
  const { queue, account, db, tick } = fixture();
  const stored = queue.storeInput(account, {
    url: "https://example.org/file.pdf?token=secret",
  });
  const job = await submit(queue, account, stored.inputToken),
    lease = queue.lease("worker")!;
  const wrong = new CaptureQueue(db, {
    secretKey: new Uint8Array(32).fill(8),
    now: () => 1000,
  });
  expect(() => wrong.input(job.id, lease.leaseToken)).toThrow();
  tick(86400001);
  new CaptureQueue(db, {
    secretKey: new Uint8Array(32).fill(7),
    now: () => 86401001,
  });
  expect(db.prepare("SELECT * FROM capture_inputs").all()).toHaveLength(0);
});
it("retry is idempotent after later state changes and isolated by account", async () => {
  const { queue, account } = fixture();
  const job = await submit(queue, account),
    lease = queue.lease("worker")!;
  queue.settle(job.id, lease.leaseToken, {
    state: "failed",
    errorCode: "NETWORK",
  });
  const operation = randomUUID();
  queue.retry(account, job.id, operation);
  const second = queue.lease("worker")!;
  queue.settle(job.id, second.leaseToken, {
    state: "needs-permission",
    errorCode: "PERMISSION",
  });
  queue.retry(account, job.id, operation);
  expect(queue.get(account, job.id).payload.state).toBe("needs-permission");
  expect(() => queue.cancel(randomUUID(), job.id)).toThrow("CAPTURE_NOT_FOUND");
});
it("library schemas reject secret fields instead of validating then retaining unknown payload", async () => {
  const { parseAsset, parseCaptureCandidate, parseCaptureJob } =
    await import("../../src/modules/library/model");
  const asset = {
    title: "资料",
    publicSourceUrl: "https://example.org/a.pdf",
    source: "example.org",
    acquiredAt: null,
    mime: null,
    size: null,
    sha256: null,
    purpose: "阅读",
    tags: [],
    availability: "link-only",
  };
  expect(() => parseAsset({ ...asset, inputToken: "secret" })).toThrow(
    "INVALID_LIBRARY_FIELDS",
  );
  expect(() =>
    parseCaptureCandidate({
      id: "a",
      url: "https://example.org/a.pdf",
      source: "example.org",
      version: null,
      matchReason: "页面文件",
      permission: "public",
      rawUrl: "https://example.org?token=secret",
    }),
  ).toThrow("INVALID_LIBRARY_FIELDS");
  expect(() =>
    parseCaptureJob({
      assetId: randomUUID(),
      state: "queued",
      attempts: 0,
      candidates: [],
      errorCode: null,
      credentialRef: "secret",
    }),
  ).toThrow("INVALID_LIBRARY_FIELDS");
});
it("terminal result acknowledgements are idempotent and do not publish twice", async () => {
  const { queue, account, db } = fixture();
  const job = await submit(queue, account),
    lease = queue.lease("worker")!;
  const outcome = {
    state: "needs-permission" as const,
    errorCode: "PERMISSION_REQUIRED",
  };
  queue.settle(job.id, lease.leaseToken, outcome);
  const before = db.prepare("SELECT COUNT(*) AS count FROM sync_changes").get();
  expect(queue.settle(job.id, lease.leaseToken, outcome).payload.state).toBe(
    "needs-permission",
  );
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM sync_changes").get(),
  ).toEqual(before);
  expect(() =>
    queue.settle(job.id, lease.leaseToken, {
      state: "unsupported",
      errorCode: "DIFFERENT",
    }),
  ).toThrow("OUTCOME_MISMATCH");
});
it("dispatcher hard deadline releases a hung acquisition lease and stop completes", async () => {
  const { CaptureDispatcher } = await import("../../server/capture/runtime");
  const { DiskBlobStore } = await import("../../server/blob");
  const { queue, account, dir } = fixture();
  const job = await submit(queue, account);
  const runtime = {
    async start() {},
    async stop() {},
    async acquire() {
      return new Promise<never>(() => {});
    },
  };
  const dispatcher = new CaptureDispatcher(
    queue,
    new DiskBlobStore(join(dir, "blobs")),
    runtime as never,
    { imagePdfTimeoutMs: 40, videoTimeoutMs: 40 },
  );
  await dispatcher.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queue.get(account, job.id).payload.state).toBe("failed");
    expect(queue.get(account, job.id).payload.errorCode).toBe(
      "DEADLINE_EXCEEDED",
    );
    expect(
      await Promise.race([
        dispatcher.stop().then(() => "stopped"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 200),
        ),
      ]),
    ).toBe("stopped");
    expect(queue.lease("replacement")).toBeNull();
  } finally {
    void dispatcher.stop();
  }
});
it("query-distinguished and signed source candidates never become a different fetch URL", async () => {
  const { identifyHtml, openAccessCandidates } =
    await import("../../server/capture/strategies");
  const html =
    '<img src="/image?id=first"><img src="/image?id=second"><img src="/private.png?token=hidden-secret"><img src="/safe.png">';
  const candidates = identifyHtml(html, "https://example.org/page");
  expect(candidates.map((candidate) => candidate.url)).toEqual([
    "https://example.org/safe.png",
  ]);
  expect(JSON.stringify(candidates)).not.toContain("hidden-secret");
  const alternatives = openAccessCandidates(
    {
      doi: "https://doi.org/10.1000/example",
      locations: [
        { is_oa: true, pdf_url: "https://example.org/pdf?id=first" },
        { is_oa: true, pdf_url: "https://example.org/pdf?id=second" },
        {
          is_oa: true,
          pdf_url: "https://example.org/private.pdf?token=hidden-secret",
        },
        { is_oa: true, pdf_url: "https://example.org/public.pdf" },
      ],
    },
    "10.1000/example",
  );
  expect(alternatives.map((candidate) => candidate.url)).toEqual([
    "https://example.org/public.pdf",
  ]);
  expect(JSON.stringify(alternatives)).not.toContain("hidden-secret");
});
it("unsuccessful recapture preserves the genuine committed asset and original descriptor", async () => {
  const { DiskBlobStore } = await import("../../server/blob");
  const { createHash } = await import("node:crypto");
  const { queue, account, db, dir } = fixture(),
    assetId = randomUUID(),
    now = new Date(1000).toISOString();
  const original = {
    id: assetId,
    moduleId: "library",
    kind: "library.asset",
    schemaVersion: 1,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    payload: {
      title: "已保存图片",
      publicSourceUrl: "https://example.org/image.png",
      source: "example.org",
      acquiredAt: null,
      mime: null,
      size: null,
      sha256: null,
      purpose: "阅读",
      tags: [],
      availability: "link-only",
    },
  };
  db.prepare(
    "INSERT INTO sync_entities(account_id,module_id,entity_id,envelope) VALUES(?,?,?,?)",
  ).run(account, "library", assetId, JSON.stringify(original));
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWQAAAAASUVORK5CYII=",
    "base64",
  );
  const file = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mime: "image/png",
    },
    store = new DiskBlobStore(join(dir, "blobs"));
  const job = queue.submit(account, {
      operationId: randomUUID(),
      assetId,
      publicSourceUrl: original.payload.publicSourceUrl,
    }),
    lease = queue.lease("first")!;
  const upload = await store.begin(account, file);
  await store.putChunk(account, upload.uploadId, 0, bytes);
  await store.commit(account, upload.uploadId);
  await queue.finalize(job.id, lease.leaseToken, file, store);
  const readAsset = () =>
    JSON.parse(
      (
        db
          .prepare(
            "SELECT envelope FROM sync_entities WHERE account_id=? AND module_id=? AND entity_id=?",
          )
          .get(account, "library", assetId) as { envelope: string }
      ).envelope,
    ).payload;
  const committed = readAsset();
  expect(committed.availability).toBe("available");
  for (const state of [
    "failed",
    "cancelled",
    "needs-selection",
    "needs-permission",
    "unsupported",
  ] as const) {
    const recapture = queue.submit(account, {
      operationId: randomUUID(),
      assetId,
      publicSourceUrl: original.payload.publicSourceUrl,
    });
    const current = queue.lease("recapture")!;
    expect(readAsset()).toEqual(committed);
    queue.heartbeat(recapture.id, current.leaseToken, "fetching");
    expect(readAsset()).toEqual(committed);
    queue.heartbeat(recapture.id, current.leaseToken, "verifying");
    expect(readAsset()).toEqual(committed);
    if (state === "cancelled") queue.cancel(account, recapture.id);
    else
      queue.settle(recapture.id, current.leaseToken, {
        state,
        errorCode: "RECAPTURE_NOT_SAVED",
      });
    expect(readAsset()).toEqual(committed);
    expect(await store.read(account, file.sha256, 0, file.size)).toEqual(
      new Uint8Array(bytes),
    );
  }
});
it("an unavailable selected candidate is reported as a client error over HTTP", async () => {
  const { createServer } = await import("node:http");
  const { handleCaptureRequest } = await import("../../server/capture/routes");
  const { queue, account } = fixture();
  const app = createServer((request, response) => {
    void handleCaptureRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://localhost"),
      { accountId: account, deviceId: randomUUID() },
      queue,
    );
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const address = app.address();
    if (!address || typeof address === "string") throw Error("LISTEN");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/capture/jobs`,
      {
        method: "POST",
        body: JSON.stringify({
          operationId: randomUUID(),
          assetId: randomUUID(),
          publicSourceUrl: "https://example.org/page",
          selectedCandidateId: "missing",
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "CANDIDATE_NOT_FOUND" });
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
});
