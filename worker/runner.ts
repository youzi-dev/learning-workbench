import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import {
  identifyHtml,
  videoAdapter,
  publicVersions,
} from "../server/capture/strategies";
import { CAPTURE_LIMITS, errorOutcome } from "../server/capture/policy";
import { downloadVideo, proxyFetch, streamToFile } from "./downloaders";
import type {
  CaptureInput,
  CaptureCandidate,
} from "../src/modules/library/model";
import type { BlobDescriptor } from "../src/workbench/contracts/files";
export type WorkerInput = CaptureInput & {
  selectedUrl?: string;
  doi?: string;
  maxBytes?: number;
  imagePdfTimeoutMs?: number;
  videoTimeoutMs?: number;
};
export type WorkerResult =
  | {
      state: "file";
      file: BlobDescriptor;
      path: string;
      strategy: "https" | "yt-dlp";
    }
  | {
      state: "needs-selection";
      candidates: CaptureCandidate[];
      errorCode: string;
    }
  | ReturnType<typeof errorOutcome>;
async function boundedText(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) throw Error("BODY_LIMIT");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function acquire(
  input: WorkerInput,
  directory: string,
  proxy: string,
  signal?: AbortSignal,
): Promise<WorkerResult> {
  const controller = new AbortController();
  const jobSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  let sourceInputRequired = false;
  const noteProtectedSource = () => {
    sourceInputRequired = true;
  };
  const source = new URL(input.url);
  let doi =
    input.doi ??
    (source.hostname === "doi.org"
      ? decodeURIComponent(source.pathname.slice(1))
      : undefined);
  const video = videoAdapter(input.url),
    timeout = video
      ? (input.videoTimeoutMs ?? CAPTURE_LIMITS.videoTimeoutMs)
      : (input.imagePdfTimeoutMs ?? CAPTURE_LIMITS.imagePdfTimeoutMs);
  let timer = setTimeout(
    () => controller.abort(Error("DEADLINE_EXCEEDED")),
    Math.min(
      timeout,
      video ? CAPTURE_LIMITS.videoTimeoutMs : CAPTURE_LIMITS.imagePdfTimeoutMs,
    ),
  );
  try {
    jobSignal.throwIfAborted();
    if (input.credentialRef) throw Error("AUTH_ADAPTER_REQUIRED");
    if (video)
      return {
        state: "file",
        strategy: "yt-dlp",
        ...(await downloadVideo(
          input.url,
          directory,
          proxy,
          jobSignal,
          Math.min(
            input.maxBytes ?? CAPTURE_LIMITS.maxBytes,
            CAPTURE_LIMITS.maxBytes,
          ),
        )),
      };
    const response = await proxyFetch(
      input.selectedUrl ?? input.url,
      proxy,
      jobSignal,
    );
    const mime = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (mime.startsWith("video/")) {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(Error("DEADLINE_EXCEEDED")),
        Math.min(
          input.videoTimeoutMs ?? CAPTURE_LIMITS.videoTimeoutMs,
          CAPTURE_LIMITS.videoTimeoutMs,
        ),
      );
    }
    if (mime === "text/html" || mime === "application/xhtml+xml") {
      const html = await boundedText(response, CAPTURE_LIMITS.htmlMaxBytes);
      doi ??=
        /<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)/i.exec(
          html,
        )?.[1];
      const candidates = identifyHtml(html, response.url, noteProtectedSource);
      if (candidates.length)
        return {
          state: "needs-selection",
          candidates,
          errorCode: sourceInputRequired
            ? "SOME_SOURCES_REQUIRE_INPUT"
            : "SELECT_SOURCE",
        };
      if (doi) {
        const alternatives = await publicVersions(
          doi,
          async (url) =>
            JSON.parse(
              await boundedText(
                await proxyFetch(url, proxy, jobSignal),
                CAPTURE_LIMITS.htmlMaxBytes,
              ),
            ),
          noteProtectedSource,
        );
        if (alternatives.length)
          return {
            state: "needs-selection",
            candidates: alternatives,
            errorCode: sourceInputRequired
              ? "SOME_SOURCES_REQUIRE_INPUT"
              : "CONFIRM_VERSION",
          };
      }
      return {
        state: "unsupported",
        errorCode: sourceInputRequired
          ? "SOURCE_INPUT_REQUIRED"
          : "NO_PUBLIC_RESOURCE",
      };
    }
    if (
      !/^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|video\/(mp4|webm|ogg))$/.test(
        mime,
      )
    ) {
      await response.body?.cancel();
      throw Error("UNSUPPORTED_TYPE");
    }
    const path = join(directory, "resource");
    if (!response.body) throw Error("EMPTY_BODY");
    const file = await streamToFile(response.body, path, {
      maxBytes: input.maxBytes,
      signal: jobSignal,
    });
    // Validate basic signatures before a MIME claim enters the durable library.
    const { open } = await import("node:fs/promises"),
      handle = await open(path, "r");
    const prefix = Buffer.alloc(32);
    try {
      await handle.read(prefix, 0, 32, 0);
    } finally {
      await handle.close();
    }
    const signatureMatches =
      mime === "application/pdf"
        ? prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))
        : mime === "image/png"
          ? prefix
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mime === "image/jpeg"
            ? prefix[0] === 255 && prefix[1] === 216
            : mime === "image/gif"
              ? /^GIF8[79]a/.test(prefix.toString("ascii", 0, 6))
              : mime === "image/webp"
                ? prefix.toString("ascii", 0, 4) === "RIFF" &&
                  prefix.toString("ascii", 8, 12) === "WEBP"
                : mime === "image/avif"
                  ? prefix.toString("ascii", 4, 8) === "ftyp" &&
                    /avif|avis/.test(prefix.toString("ascii", 8, 32))
                  : mime === "video/mp4"
                    ? prefix.toString("ascii", 4, 8) === "ftyp"
                    : mime === "video/webm"
                      ? prefix
                          .subarray(0, 4)
                          .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
                      : mime === "video/ogg"
                        ? prefix.toString("ascii", 0, 4) === "OggS"
                        : false;
    if (!signatureMatches) throw Error("CONTENT_SIGNATURE_MISMATCH");
    return { state: "file", strategy: "https", path, file: { ...file, mime } };
  } catch (error) {
    if (doi && !jobSignal.aborted) {
      const alternatives = await publicVersions(
        doi,
        async (url) =>
          JSON.parse(
            await boundedText(
              await proxyFetch(url, proxy, jobSignal),
              CAPTURE_LIMITS.htmlMaxBytes,
            ),
          ),
        noteProtectedSource,
      );
      if (alternatives.length)
        return {
          state: "needs-selection",
          candidates: alternatives,
          errorCode: sourceInputRequired
            ? "SOME_SOURCES_REQUIRE_INPUT"
            : "CONFIRM_VERSION",
        };
    }
    if (sourceInputRequired && !jobSignal.aborted)
      return { state: "unsupported", errorCode: "SOURCE_INPUT_REQUIRED" };
    return errorOutcome(jobSignal.aborted ? jobSignal.reason : error);
  } finally {
    clearTimeout(timer);
  }
}
export async function workerMain(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > CAPTURE_LIMITS.inputMaxBytes)
      throw Error("INPUT_LIMIT");
  }
  const input = JSON.parse(raw) as WorkerInput;
  const result = await acquire(
    input,
    "/work",
    process.env.WORKBENCH_PROXY ?? "",
  );
  if (result.state === "file") {
    process.stdout.write(
      JSON.stringify({
        state: "file",
        file: result.file,
        strategy: result.strategy,
      }) + "\n",
    );
    await pipeline(createReadStream(result.path), process.stdout);
  } else process.stdout.write(JSON.stringify(result) + "\n");
  await rm("/work/resource", { force: true });
  await rm("/work/media.mp4", { force: true });
}
