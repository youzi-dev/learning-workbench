export const CAPTURE_LIMITS = {
  maxBytes: 1073741824,
  maxConcurrent: 2,
  maxTransientRetries: 3,
  imagePdfTimeoutMs: 300000,
  videoTimeoutMs: 1800000,
  htmlMaxBytes: 2097152,
  inputMaxBytes: 32768,
  secretTtlMs: 86400000,
} as const;
export function errorOutcome(error: unknown): {
  state: "failed" | "needs-permission" | "unsupported";
  errorCode: string;
  transient?: boolean;
} {
  const message = error instanceof Error ? error.message : "CAPTURE_FAILED";
  const nativeCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const code = [
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
  ].includes(nativeCode)
    ? nativeCode
    : message;
  if (
    ["PERMISSION_REQUIRED", "INPUT_EXPIRED", "AUTH_ADAPTER_REQUIRED"].includes(
      code,
    )
  )
    return { state: "needs-permission", errorCode: code };
  if (
    [
      "EGRESS_DENIED",
      "PRIVATE_TARGET",
      "HTTPS_REQUIRED",
      "SOURCE_UNAVAILABLE",
      "ENCODING_UNSUPPORTED",
      "VIDEO_UNAVAILABLE",
      "UNSUPPORTED_TYPE",
    ].includes(code)
  )
    return { state: "unsupported", errorCode: code };
  return {
    state: "failed",
    errorCode: /^[A-Z0-9_]{1,100}$/.test(code) ? code : "CAPTURE_FAILED",
    transient: [
      "NETWORK",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
    ].includes(code),
  };
}
