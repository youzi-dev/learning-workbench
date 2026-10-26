import type { Id, IsoTime } from "../../workbench/contracts/data";
export type Asset = {
  title: string;
  publicSourceUrl: string | null;
  source: string;
  acquiredAt: IsoTime | null;
  mime: string | null;
  size: number | null;
  sha256: string | null;
  purpose: string;
  tags: string[];
  availability: "link-only" | "pending" | "available";
};
export type CaptureState =
  | "queued"
  | "identifying"
  | "fetching"
  | "verifying"
  | "saved"
  | "needs-selection"
  | "needs-permission"
  | "unsupported"
  | "failed"
  | "cancelled";
export type CaptureCandidate = {
  id: string;
  url: string;
  source: string;
  version: string | null;
  matchReason: string;
  permission: "public" | "authorized";
};
export type CaptureJob = {
  assetId: Id;
  state: CaptureState;
  attempts: number;
  candidates: CaptureCandidate[];
  errorCode: string | null;
};
export type CaptureRequest = {
  operationId: Id;
  assetId: Id;
  publicSourceUrl: string | null;
  inputToken?: Id;
  selectedCandidateId?: string;
};
export type CaptureInput = { url: string; credentialRef?: string; expiresAt?: string };
export function publicSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return null;
    url.hash = "";
    const video =
      url.hostname === "www.youtube.com" || url.hostname === "youtube.com"
        ? url.searchParams.get("v")
        : null;
    url.search = "";
    if (video && /^[a-zA-Z0-9_-]{1,40}$/.test(video))
      url.searchParams.set("v", video);
    url.pathname = url.pathname
      .split("/")
      .map((part) =>
        part.length > 100 || /^(token|secret|signature|auth)[=:_-]/i.test(part)
          ? "redacted"
          : part,
      )
      .join("/");
    return url.toString();
  } catch {
    return null;
  }
}
const captureStates: CaptureState[] = [
  "queued",
  "identifying",
  "fetching",
  "verifying",
  "saved",
  "needs-selection",
  "needs-permission",
  "unsupported",
  "failed",
  "cancelled",
];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("INVALID_LIBRARY");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("INVALID_LIBRARY_FIELDS");
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== "string" || value.length > max)
    throw Error("INVALID_LIBRARY");
  return value;
}
export function parseCaptureCandidate(value: unknown): CaptureCandidate {
  const v = record(value);
  fields(v, ["id", "url", "source", "version", "matchReason", "permission"]);
  const url = text(v.url, 4096);
  if (
    publicSourceUrl(url) !== url ||
    !["public", "authorized"].includes(v.permission as string)
  )
    throw Error("UNSAFE_SOURCE_METADATA");
  return {
    id: text(v.id, 200),
    url,
    source: text(v.source),
    version: v.version === null ? null : text(v.version, 200),
    matchReason: text(v.matchReason),
    permission: v.permission as CaptureCandidate["permission"],
  };
}
export function parseAsset(value: unknown): Asset {
  const v = record(value);
  fields(v, [
    "title",
    "publicSourceUrl",
    "source",
    "acquiredAt",
    "mime",
    "size",
    "sha256",
    "purpose",
    "tags",
    "availability",
  ]);
  const url = v.publicSourceUrl === null ? null : text(v.publicSourceUrl, 4096);
  if (url !== null && publicSourceUrl(url) !== url)
    throw Error("UNSAFE_SOURCE_METADATA");
  if (
    !["link-only", "pending", "available"].includes(v.availability as string) ||
    !Array.isArray(v.tags) ||
    v.tags.length > 100
  )
    throw Error("INVALID_ASSET");
  const acquiredAt = v.acquiredAt === null ? null : text(v.acquiredAt, 100),
    mime = v.mime === null ? null : text(v.mime, 255),
    sha256 = v.sha256 === null ? null : text(v.sha256, 64);
  if (
    (acquiredAt !== null && !Number.isFinite(Date.parse(acquiredAt))) ||
    (v.size !== null &&
      (!Number.isSafeInteger(v.size) ||
        (v.size as number) < 0 ||
        (v.size as number) > 1073741824)) ||
    (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256))
  )
    throw Error("INVALID_ASSET");
  if (
    v.availability === "available" &&
    (!sha256 || v.size === null || !mime || !acquiredAt)
  )
    throw Error("UNCOMMITTED_ASSET");
  return {
    title: text(v.title),
    publicSourceUrl: url,
    source: text(v.source),
    acquiredAt,
    mime,
    size: v.size as number | null,
    sha256,
    purpose: text(v.purpose, 10000),
    tags: v.tags.map((t) => text(t, 100)),
    availability: v.availability as Asset["availability"],
  };
}
export function parseCaptureJob(value: unknown): CaptureJob {
  const v = record(value);
  fields(v, ["assetId", "state", "attempts", "candidates", "errorCode"]);
  if (
    !captureStates.includes(v.state as CaptureState) ||
    !Number.isSafeInteger(v.attempts) ||
    (v.attempts as number) < 0 ||
    !Array.isArray(v.candidates) ||
    v.candidates.length > 100
  )
    throw Error("INVALID_CAPTURE_JOB");
  return {
    assetId: text(v.assetId, 100),
    state: v.state as CaptureState,
    attempts: v.attempts as number,
    candidates: v.candidates.map(parseCaptureCandidate),
    errorCode: v.errorCode === null ? null : text(v.errorCode, 100),
  };
}
