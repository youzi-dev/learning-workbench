import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Entity, JsonValue } from "../../src/workbench/contracts/data";
import type {
  BlobDescriptor,
  BlobStore,
} from "../../src/workbench/contracts/files";
import {
  parseAsset,
  parseCaptureCandidate,
  publicSourceUrl,
  type Asset,
  type CaptureCandidate,
  type CaptureInput,
  type CaptureJob,
  type CaptureRequest,
  type CaptureState,
} from "../../src/modules/library/model";
import { transaction } from "../database";
import {validateBlob} from "../blob-descriptor";

type Row = {
  id: string;
  account_id: string;
  request_json: string;
  envelope: string;
  lease_token: string | null;
  lease_until: number | null;
  input_token: string | null;
  available_at: number;
  operation_id: string;
  fingerprint: string;
};
export type CaptureLease = {
  job: Entity<CaptureJob>;
  leaseToken: string;
  leaseUntil: number;
  accountId: string;
};
export type CaptureOutcome = {
  state:
    "needs-selection" | "needs-permission" | "unsupported" | "failed" | "saved";
  errorCode?: string;
  candidates?: CaptureCandidate[];
  transient?: boolean;
  blob?: BlobDescriptor;
};
const active = ["identifying", "fetching", "verifying"];
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export class CaptureQueue {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly key: Uint8Array;
  constructor(
    private readonly db: DatabaseSync,
    options: { secretKey: Uint8Array; now?: () => number; leaseMs?: number },
  ) {
    if (options.secretKey.length !== 32) throw Error("CAPTURE_KEY_REQUIRED");
    this.key = new Uint8Array(options.secretKey);
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 60000;
    db.exec(`CREATE TABLE IF NOT EXISTS capture_jobs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,request_json TEXT NOT NULL,envelope TEXT NOT NULL,input_token TEXT,lease_token TEXT,lease_until INTEGER,available_at INTEGER NOT NULL,UNIQUE(account_id,operation_id));
      CREATE TABLE IF NOT EXISTS capture_inputs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,ciphertext TEXT NOT NULL,expires_at INTEGER NOT NULL,job_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS capture_receipts(job_id TEXT NOT NULL,token_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(job_id,token_hash));
      CREATE TABLE IF NOT EXISTS capture_retry_ops(account_id TEXT NOT NULL,operation_id TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(account_id,operation_id));`);
    this.purgeExpired();
  }
  maintain(): void {
    this.purgeExpired();
  }
  private purgeExpired(): void {
    this.db
      .prepare("DELETE FROM capture_inputs WHERE expires_at<=?")
      .run(this.now());
  }
  storeInput(
    accountId: string,
    input: CaptureInput,
  ): { inputToken: string; expiresAt: string } {
    this.purgeExpired();
    const url = new URL(input.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      input.url.length > 16384 ||
      (input.credentialRef && input.credentialRef.length > 256)
    )
      throw Error("INVALID_CAPTURE_INPUT");
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const token = randomUUID();
    cipher.setAAD(Buffer.from(`${accountId}:${token}`));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(input)),
      cipher.final(),
    ]);
    const requestedExpiry = input.expiresAt === undefined ? Infinity : Date.parse(input.expiresAt);
    if (Number.isNaN(requestedExpiry) || requestedExpiry <= this.now()) throw Error('INPUT_EXPIRED');
    const expires = Math.min(this.now() + 24 * 3600 * 1000, requestedExpiry);
    this.db
      .prepare(
        "INSERT INTO capture_inputs(id,account_id,ciphertext,expires_at) VALUES(?,?,?,?)",
      )
      .run(
        token,
        accountId,
        Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString("base64"),
        expires,
      );
    return { inputToken: token, expiresAt: new Date(expires).toISOString() };
  }
  submit(accountId: string, request: CaptureRequest): Entity<CaptureJob> {
    if (
      !uuid(request.operationId) ||
      !uuid(request.assetId) ||
      (request.inputToken !== undefined && !uuid(request.inputToken))
    )
      throw Error("INVALID_CAPTURE_REQUEST");
    let publicUrl =
      request.publicSourceUrl === null
        ? null
        : publicSourceUrl(request.publicSourceUrl);
    if (
      request.publicSourceUrl !== null &&
      publicUrl !== request.publicSourceUrl
    )
      throw Error("SECRET_INPUT_REQUIRED");
    if (request.selectedCandidateId) {
      const previous = (
        this.db
          .prepare(
            "SELECT envelope FROM capture_jobs WHERE account_id=? ORDER BY rowid DESC",
          )
          .all(accountId) as { envelope: string }[]
      ).map((row) => JSON.parse(row.envelope) as Entity<CaptureJob>);
      const candidate = previous
        .filter(
          (job) =>
            job.payload.assetId === request.assetId &&
            job.payload.state === "needs-selection",
        )
        .flatMap((job) => job.payload.candidates)
        .find((candidate) => candidate.id === request.selectedCandidateId);
      if (!candidate) throw Error("CANDIDATE_NOT_FOUND");
      publicUrl = candidate.url;
    }
    if (!publicUrl && !request.inputToken) throw Error("SOURCE_REQUIRED");
    const clean = {
      operationId: request.operationId,
      assetId: request.assetId,
      publicSourceUrl: publicUrl,
      ...(request.selectedCandidateId
        ? { selectedCandidateId: request.selectedCandidateId }
        : {}),
    };
    const fingerprint = hash(
      JSON.stringify({ ...clean, inputToken: request.inputToken ?? null }),
    );
    return transaction(this.db, () => {
      const previous = this.db
        .prepare(
          "SELECT * FROM capture_jobs WHERE account_id=? AND operation_id=?",
        )
        .get(accountId, request.operationId) as Row | undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw Error("OPERATION_MISMATCH");
        return JSON.parse(previous.envelope);
      }
      this.purgeExpired();
      if (request.inputToken) {
        const input = this.db
          .prepare(
            "SELECT job_id FROM capture_inputs WHERE id=? AND account_id=?",
          )
          .get(request.inputToken, accountId) as
          { job_id: string | null } | undefined;
        if (!input) throw Error("INPUT_EXPIRED");
        if (input.job_id) throw Error("INPUT_ALREADY_USED");
      }
      const now = new Date(this.now()).toISOString();
      const entity: Entity<CaptureJob> = {
        id: randomUUID(),
        moduleId: "library",
        kind: "library.capture-job",
        schemaVersion: 1,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        payload: {
          assetId: request.assetId,
          state: "queued",
          attempts: 0,
          candidates: [],
          errorCode: null,
        },
      };
      this.db
        .prepare(
          "INSERT INTO capture_jobs(id,account_id,operation_id,fingerprint,request_json,envelope,input_token,available_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          entity.id,
          accountId,
          request.operationId,
          fingerprint,
          JSON.stringify(clean),
          JSON.stringify(entity),
          request.inputToken ?? null,
          this.now(),
        );
      if (request.inputToken)
        this.db
          .prepare("UPDATE capture_inputs SET job_id=? WHERE id=?")
          .run(entity.id, request.inputToken);
      this.publish(accountId, [entity]);
      return entity;
    });
  }
  private row(id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM capture_jobs WHERE id=?")
      .get(id) as Row | undefined;
    if (!row) throw Error("CAPTURE_NOT_FOUND");
    return row;
  }
  get(accountId: string, id: string): Entity<CaptureJob> {
    const row = this.row(id);
    if (row.account_id !== accountId) throw Error("CAPTURE_NOT_FOUND");
    return JSON.parse(row.envelope);
  }
  list(accountId: string): Entity<CaptureJob>[] {
    return (
      this.db
        .prepare("SELECT envelope FROM capture_jobs WHERE account_id=?")
        .all(accountId) as { envelope: string }[]
    ).map((row) => JSON.parse(row.envelope));
  }
  private publish(accountId: string, entities: Entity[]): void {
    const batchId = randomUUID();
    for (const entity of entities)
      this.db
        .prepare(
          "INSERT INTO sync_entities(account_id,module_id,entity_id,envelope) VALUES(?,?,?,?) ON CONFLICT(account_id,module_id,entity_id) DO UPDATE SET envelope=excluded.envelope",
        )
        .run(accountId, entity.moduleId, entity.id, JSON.stringify(entity));
    const row = this.db
      .prepare(
        "INSERT INTO sync_changes(account_id,batch_id,change_json) VALUES(?,?,?)",
      )
      .run(accountId, batchId, "{}");
    this.db.prepare("UPDATE sync_changes SET change_json=? WHERE cursor=?").run(
      JSON.stringify({
        cursor: Number(row.lastInsertRowid),
        batchId,
        entities,
      }),
      row.lastInsertRowid,
    );
  }
  private update(
    row: Row,
    payload: CaptureJob,
    terminal = false,
    blob?: BlobDescriptor,
  ): Entity<CaptureJob> {
    const current = JSON.parse(row.envelope) as Entity<CaptureJob>;
    const entity = {
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date(this.now()).toISOString(),
      payload,
    };
    this.db
      .prepare("UPDATE capture_jobs SET envelope=? WHERE id=?")
      .run(JSON.stringify(entity), row.id);
    const published: Entity[] = [entity as unknown as Entity];
    const assetRow = this.db
      .prepare(
        "SELECT envelope FROM sync_entities WHERE account_id=? AND module_id=? AND entity_id=?",
      )
      .get(row.account_id, "library", payload.assetId) as
      { envelope: string } | undefined;
    if (assetRow) {
      const assetEntity = JSON.parse(assetRow.envelope) as Entity<Asset>;
      if (!assetEntity.deletedAt && assetEntity.kind === "library.asset") {
        const asset = parseAsset(assetEntity.payload);
        const availability =
          asset.availability === "available" || payload.state === "saved"
            ? "available"
            : active.includes(payload.state) || payload.state === "queued"
              ? "pending"
              : "link-only";
        const next = {
          ...assetEntity,
          revision: assetEntity.revision + 1,
          updatedAt: entity.updatedAt,
          payload: {
            ...asset,
            availability,
            ...(blob ? { ...blob, acquiredAt: entity.updatedAt } : {}),
          },
        };
        published.push(next as unknown as Entity);
      }
    }
    if (terminal) {
      this.db.prepare("DELETE FROM capture_inputs WHERE job_id=?").run(row.id);
      this.db
        .prepare(
          "UPDATE capture_jobs SET input_token=NULL,lease_token=NULL,lease_until=NULL WHERE id=?",
        )
        .run(row.id);
    }
    this.publish(row.account_id, published);
    return entity;
  }
  lease(workerId: string): CaptureLease | null {
    if (!workerId || workerId.length > 200) throw Error("INVALID_WORKER");
    return transaction(this.db, () => {
      this.purgeExpired();
      const rows = this.db
        .prepare("SELECT * FROM capture_jobs ORDER BY available_at,id")
        .all() as Row[];
      let running = 0;
      for (const row of rows) {
        const job = JSON.parse(row.envelope) as Entity<CaptureJob>;
        if (active.includes(job.payload.state) && row.lease_until! > this.now())
          running++;
      }
      if (running >= 2) return null;
      const row = rows.find((r) => {
        const state = (JSON.parse(r.envelope) as Entity<CaptureJob>).payload
          .state;
        return (
          r.available_at <= this.now() &&
          (state === "queued" ||
            (active.includes(state) && (r.lease_until ?? 0) <= this.now()))
        );
      });
      if (!row) return null;
      const old = JSON.parse(row.envelope) as Entity<CaptureJob>;
      if (old.payload.attempts >= 4) {
        this.update(
          row,
          { ...old.payload, state: "failed", errorCode: "LEASE_EXHAUSTED" },
          true,
        );
        return null;
      }
      const token = randomBytes(32).toString("hex"),
        until = this.now() + this.leaseMs;
      this.db
        .prepare(
          "UPDATE capture_jobs SET lease_token=?,lease_until=? WHERE id=?",
        )
        .run(hash(token), until, row.id);
      const job = this.update(row, {
        ...old.payload,
        state: "identifying",
        attempts: old.payload.attempts + 1,
        errorCode: null,
      });
      return {
        job,
        leaseToken: token,
        leaseUntil: until,
        accountId: row.account_id,
      };
    });
  }
  private held(id: string, token: string): Row {
    const row = this.row(id),
      job = JSON.parse(row.envelope) as Entity<CaptureJob>;
    if (
      row.lease_token !== hash(token) ||
      (row.lease_until ?? 0) <= this.now() ||
      !active.includes(job.payload.state)
    )
      throw Error("LEASE_LOST");
    return row;
  }
  heartbeat(id: string, token: string, state?: "fetching" | "verifying"): void {
    transaction(this.db, () => {
      const row = this.held(id, token);
      this.db
        .prepare("UPDATE capture_jobs SET lease_until=? WHERE id=?")
        .run(this.now() + this.leaseMs, id);
      if (state) {
        const job = JSON.parse(row.envelope) as Entity<CaptureJob>;
        this.update(row, { ...job.payload, state });
      }
    });
  }
  input(id: string, token: string): CaptureInput {
    this.purgeExpired();
    const row = this.held(id, token);
    if (row.input_token) {
      const input = this.db
        .prepare(
          "SELECT ciphertext FROM capture_inputs WHERE id=? AND account_id=? AND job_id=?",
        )
        .get(row.input_token, row.account_id, id) as
        { ciphertext: string } | undefined;
      if (!input) throw Error("INPUT_EXPIRED");
      const bytes = Buffer.from(input.ciphertext, "base64"),
        decipher = createDecipheriv(
          "aes-256-gcm",
          this.key,
          bytes.subarray(0, 12),
        );
      decipher.setAAD(Buffer.from(`${row.account_id}:${row.input_token}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
    }
    const request = JSON.parse(row.request_json) as CaptureRequest;
    if (!request.publicSourceUrl) throw Error("SOURCE_REQUIRED");
    return { url: request.publicSourceUrl };
  }
  private receipt(
    id: string,
    token: string,
    fingerprint: string,
  ): Entity<CaptureJob> | null {
    const receipt = this.db
      .prepare(
        "SELECT fingerprint,envelope FROM capture_receipts WHERE job_id=? AND token_hash=?",
      )
      .get(id, hash(token)) as
      { fingerprint: string; envelope: string } | undefined;
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint) throw Error("OUTCOME_MISMATCH");
    return JSON.parse(receipt.envelope);
  }
  private acknowledge(
    id: string,
    token: string,
    fingerprint: string,
    entity: Entity<CaptureJob>,
  ): Entity<CaptureJob> {
    this.db
      .prepare(
        "INSERT INTO capture_receipts(job_id,token_hash,fingerprint,envelope) VALUES(?,?,?,?)",
      )
      .run(id, hash(token), fingerprint, JSON.stringify(entity));
    return entity;
  }
  settle(
    id: string,
    token: string,
    outcome: CaptureOutcome,
  ): Entity<CaptureJob> {
    const fingerprint = hash(JSON.stringify(outcome));
    return transaction(this.db, () => {
      const receipt = this.receipt(id, token, fingerprint);
      if (receipt) return receipt;
      const row = this.held(id, token),
        job = JSON.parse(row.envelope) as Entity<CaptureJob>;
      if (outcome.state === "saved") throw Error("BLOB_COMMIT_REQUIRED");
      const retry =
        outcome.state === "failed" &&
        outcome.transient === true &&
        job.payload.attempts < 4;
      const state = retry ? "queued" : outcome.state;
      const candidates = (outcome.candidates ?? []).map(parseCaptureCandidate);
      const errorCode =
        outcome.errorCode && /^[A-Z0-9_-]{1,100}$/i.test(outcome.errorCode)
          ? outcome.errorCode
          : "CAPTURE_FAILED";
      this.db
        .prepare(
          "UPDATE capture_jobs SET lease_token=NULL,lease_until=NULL,available_at=? WHERE id=?",
        )
        .run(
          this.now() +
            (retry ? Math.min(1000 * 2 ** job.payload.attempts, 30000) : 0),
          id,
        );
      return this.acknowledge(
        id,
        token,
        fingerprint,
        this.update(
          row,
          { ...job.payload, state, candidates, errorCode },
          !retry,
        ),
      );
    });
  }
  async finalize(
    id: string,
    token: string,
    blob: BlobDescriptor,
    store: BlobStore & {
      describe(accountId: string, sha256: string): Promise<BlobDescriptor>;
    },
  ): Promise<Entity<CaptureJob>> {
    validateBlob(blob);
    const fingerprint = hash(JSON.stringify({ state: "saved", blob }));
    const receipt = this.receipt(id, token, fingerprint);
    if (receipt) return receipt;
    const row = this.held(id, token);
    // Only a durable descriptor can prove that bytes are committed, not staging.
    const committed = await store.describe(row.account_id, blob.sha256);
    validateBlob(committed);
    if (
      committed.size !== blob.size ||
      committed.sha256 !== blob.sha256
    )
      throw Error("DESCRIPTOR_MISMATCH");
    return transaction(this.db, () => {
      const acknowledged = this.receipt(id, token, fingerprint);
      if (acknowledged) return acknowledged;
      const current = this.held(id, token),
        job = JSON.parse(current.envelope) as Entity<CaptureJob>;
      return this.acknowledge(
        id,
        token,
        fingerprint,
        this.update(
          current,
          { ...job.payload, state: "saved", errorCode: null },
          true,
          blob,
        ),
      );
    });
  }
  cancel(accountId: string, id: string): void {
    transaction(this.db, () => {
      const job = this.get(accountId, id);
      if (job.payload.state === "saved" || job.payload.state === "cancelled")
        return;
      this.update(
        this.row(id),
        { ...job.payload, state: "cancelled", errorCode: null },
        true,
      );
    });
  }
  retry(accountId: string, id: string, operationId: string): void {
    if (!uuid(operationId)) throw Error("INVALID_OPERATION");
    transaction(this.db, () => {
      const previous = this.db
        .prepare(
          "SELECT job_id FROM capture_retry_ops WHERE account_id=? AND operation_id=?",
        )
        .get(accountId, operationId) as { job_id: string } | undefined;
      if (previous) {
        if (previous.job_id !== id) throw Error("OPERATION_MISMATCH");
        return;
      }
      const job = this.get(accountId, id);
      if (job.payload.state !== "failed") throw Error("RETRY_REQUIRES_FAILED");
      const row = this.row(id);
      if (!JSON.parse(row.request_json).publicSourceUrl)
        throw Error("NEW_INPUT_REQUIRED");
      this.db
        .prepare("INSERT INTO capture_retry_ops VALUES(?,?,?)")
        .run(accountId, operationId, id);
      this.db
        .prepare("UPDATE capture_jobs SET available_at=? WHERE id=?")
        .run(this.now(), id);
      this.update(row, {
        ...job.payload,
        state: "queued",
        attempts: 0,
        errorCode: null,
      });
    });
  }
}
