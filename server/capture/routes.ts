import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeviceIdentity } from "../auth";
import type {
  CaptureInput,
  CaptureRequest,
} from "../../src/modules/library/model";
import { CaptureQueue } from "./queue";
import type { CaptureDispatcher } from "./runtime";
async function input(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of request) {
    count += chunk.length;
    if (count > 32768) throw Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw Error("INVALID_CAPTURE_REQUEST");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INVALID_CAPTURE_REQUEST");
  return value as Record<string, unknown>;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
/** DeviceIdentity is supplied only by the host's authenticated request path. */
export async function handleCaptureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  identity: DeviceIdentity,
  queue: CaptureQueue,
  dispatcher?: Pick<CaptureDispatcher, "cancel">,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/capture/")) return false;
  try {
    if (url.searchParams.has("accountId"))
      throw Error("CLIENT_ACCOUNT_FORBIDDEN");
    if (request.method === "GET" && url.pathname === "/v1/capture/jobs") {
      json(response, 200, queue.list(identity.accountId));
      return true;
    }
    if (request.method !== "POST") {
      json(response, 404, { error: "NOT_FOUND" });
      return true;
    }
    const body = await input(request);
    if (Object.hasOwn(body, "accountId"))
      throw Error("CLIENT_ACCOUNT_FORBIDDEN");
    if (url.pathname === "/v1/capture/inputs") {
      if (
        Object.keys(body).some((key) => !["url", "credentialRef", "expiresAt"].includes(key))
      )
        throw Error("INVALID_CAPTURE_INPUT");
      json(
        response,
        201,
        queue.storeInput(identity.accountId, body as CaptureInput),
      );
      return true;
    }
    if (url.pathname === "/v1/capture/jobs") {
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "operationId",
              "assetId",
              "publicSourceUrl",
              "inputToken",
              "selectedCandidateId",
            ].includes(key),
        )
      )
        throw Error("INVALID_CAPTURE_REQUEST");
      json(
        response,
        201,
        queue.submit(identity.accountId, body as CaptureRequest),
      );
      return true;
    }
    const match =
      /^\/v1\/capture\/jobs\/([a-fA-F0-9-]{36})\/(cancel|retry)$/.exec(
        url.pathname,
      );
    if (match) {
      if (match[2] === "cancel") {
        if (Object.keys(body).length) throw Error("INVALID_CAPTURE_REQUEST");
        if (dispatcher) dispatcher.cancel(identity.accountId, match[1]);
        else queue.cancel(identity.accountId, match[1]);
      } else {
        if (Object.keys(body).some((key) => key !== "operationId"))
          throw Error("INVALID_CAPTURE_REQUEST");
        queue.retry(identity.accountId, match[1], body.operationId as string);
      }
      json(response, 200, queue.get(identity.accountId, match[1]));
      return true;
    }
    json(response, 404, { error: "NOT_FOUND" });
    return true;
  } catch (error) {
    const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const known =
      /^(INVALID_|CAPTURE_NOT_FOUND|CANDIDATE_NOT_FOUND|CLIENT_ACCOUNT_FORBIDDEN|BODY_TOO_LARGE|SOURCE_REQUIRED|SECRET_INPUT_REQUIRED|OPERATION_MISMATCH|INPUT_|RETRY_|NEW_INPUT_REQUIRED)/.test(
        code,
      );
    json(
      response,
      code === "CAPTURE_NOT_FOUND"
        ? 404
        : code === "BODY_TOO_LARGE"
          ? 413
          : known
            ? 400
            : 500,
      { error: known ? code : "INTERNAL_ERROR" },
    );
    return true;
  }
}
/** A leased job token is a short-lived capability for that job only; this
 * handler has no lease-creation, account-list, blob-delete or credential API.
 * Used on a private control listener, never the public device route. */
export async function handleWorkerLeaseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  queue: CaptureQueue,
): Promise<boolean> {
  const match =
    /^\/worker\/capture\/([a-fA-F0-9-]{36})\/(input|heartbeat|outcome)$/.exec(
      url.pathname,
    );
  if (!match) return false;
  try {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(
      request.headers.authorization ?? "",
    )?.[1];
    if (!token) throw Error("LEASE_LOST");
    if (request.method === "POST" && match[2] === "heartbeat") {
      await input(request);
      queue.heartbeat(match[1], token);
      json(response, 200, { renewed: true });
    } else if (request.method === "POST" && match[2] === "outcome") {
      const body = await input(request);
      if (
        ![
          "needs-permission",
          "needs-selection",
          "unsupported",
          "failed",
        ].includes(body.state as string)
      )
        throw Error("INVALID_OUTCOME");
      json(response, 200, queue.settle(match[1], token, body as never));
    } else if (request.method === "GET" && match[2] === "input")
      json(response, 200, queue.input(match[1], token));
    else json(response, 404, { error: "NOT_FOUND" });
  } catch {
    json(response, 403, { error: "LEASE_LOST" });
  }
  return true;
}
