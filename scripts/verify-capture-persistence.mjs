import { build } from "esbuild";
import { mkdtemp, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
const directory = await mkdtemp(join(tmpdir(), "workbench-capture-persist-"));
const entry = `export {CaptureQueue} from './server/capture/queue';export {CaptureDispatcher} from './server/capture/runtime';export {IsolatedCaptureRuntime} from './server/capture/docker-runtime';export {RemoteCaptureRuntime} from './server/capture/remote-runtime';export {DiskBlobStore} from './server/blob';export {openDatabase} from './server/database';`;
await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "capture-persistence-entry.ts",
    loader: "ts",
  },
  outfile: join(directory, "capture.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
const {
  CaptureQueue,
  CaptureDispatcher,
  IsolatedCaptureRuntime,
  RemoteCaptureRuntime,
  DiskBlobStore,
  openDatabase,
} = await import(pathToFileURL(join(directory, "capture.mjs")).href);
await cp("server/migrations", join(directory, "migrations"), {
  recursive: true,
});
const captureSocket = process.env.WORKBENCH_CAPTURE_SOCKET;
const image = process.env.WORKBENCH_CAPTURE_IMAGE ?? (captureSocket ? null : "workbench-test-capture:2026-10-24");
// Remote verification is an API-side probe and must not require Docker access.
const inspected = captureSocket ? null : JSON.parse((await promisify(execFile)("docker", ["image", "inspect", image])).stdout)[0];
const path = join(directory, "database.sqlite"),
  blobPath = join(directory, "blobs");
let db = openDatabase(path),
  dispatcher;
const account = randomUUID(),
  assetId = randomUUID(),
  now = new Date().toISOString(),
  source = "https://www.w3.org/Icons/w3c_home.png";
const asset = {
  id: assetId,
  moduleId: "library",
  kind: "library.asset",
  schemaVersion: 1,
  revision: 1,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  payload: {
    title: "W3C public image",
    publicSourceUrl: source,
    source: "www.w3.org",
    acquiredAt: null,
    mime: null,
    size: null,
    sha256: null,
    purpose: "采集持久化验收",
    tags: [],
    availability: "link-only",
  },
};
try {
  db.prepare(
    "INSERT INTO sync_entities(account_id,module_id,entity_id,envelope) VALUES(?,?,?,?)",
  ).run(account, "library", assetId, JSON.stringify(asset));
  const queue = new CaptureQueue(db, { secretKey: new Uint8Array(32).fill(9) }),
    blobs = new DiskBlobStore(blobPath);
  const job = queue.submit(account, {
    operationId: randomUUID(),
    assetId,
    publicSourceUrl: source,
  });
  dispatcher = new CaptureDispatcher(
    queue,
    blobs,
    captureSocket ? new RemoteCaptureRuntime(captureSocket) : new IsolatedCaptureRuntime({image: inspected.Id, platform: `${inspected.Os}/${inspected.Architecture}`, deploymentId: 'persistence-check'}),
  );
  await dispatcher.start();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const state = queue.get(account, job.id).payload.state;
    if (state === "saved") break;
    if (
      [
        "failed",
        "unsupported",
        "needs-permission",
        "cancelled",
        "needs-selection",
      ].includes(state)
    )
      throw Error(`capture ended ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (queue.get(account, job.id).payload.state !== "saved")
    throw Error("capture did not finish");
  await dispatcher.stop();
  dispatcher = null;
  db.close();
  db = openDatabase(path);
  const restartedQueue = new CaptureQueue(db, {
      secretKey: new Uint8Array(32).fill(9),
    }),
    restartedBlobs = new DiskBlobStore(blobPath);
  const saved = JSON.parse(
    db
      .prepare(
        "SELECT envelope FROM sync_entities WHERE account_id=? AND module_id=? AND entity_id=?",
      )
      .get(account, "library", assetId).envelope,
  );
  const file = await restartedBlobs.describe(account, saved.payload.sha256),
    bytes = await restartedBlobs.read(account, file.sha256, 0, file.size);
  if (
    saved.payload.availability !== "available" ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256 ||
    restartedQueue.get(account, job.id).payload.state !== "saved"
  )
    throw Error("restart verification failed");
  // Image identity in remote mode belongs to the broker's readiness/deployment
  // evidence. Keep an operator-supplied hint separate from local verification.
  const imageDigest = inspected?.Id ?? null;
  const evidence = {
    image,
    imageDigest,
    transport: captureSocket ? "UDS" : "direct-Docker",
    imageVerifiedLocally: Boolean(inspected),
    date: new Date().toISOString(),
    source,
    state: "saved",
    availability: saved.payload.availability,
    sqliteReopened: true,
    blobStoreReopened: true,
    verified: file,
  };
  await mkdir("docs/research", { recursive: true });
  await writeFile(
    "docs/research/2026-10-24-capture-persistence-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (dispatcher) await dispatcher.stop();
  if (db.isOpen) db.close();
  await rm(directory, { recursive: true, force: true });
}
