import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Writable, Readable } from "node:stream";
import { pipeline, finished } from "node:stream/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, Agent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BlobDescriptor } from "../src/workbench/contracts/files";
export const CAPTURE_MAX_BYTES = 1073741824;
export async function streamToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<BlobDescriptor> {
  let size = 0;
  const hash = createHash("sha256"),
    output = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const max = Math.min(
    options.maxBytes ?? CAPTURE_MAX_BYTES,
    CAPTURE_MAX_BYTES,
  );
  const counter = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > max) {
        callback(Error("BODY_LIMIT"));
        return;
      }
      hash.update(chunk);
      if (output.write(chunk)) callback();
      else output.once("drain", callback);
    },
    final(callback) {
      output.end(callback);
    },
  });
  output.on("error", (error) => counter.destroy(error));
  try {
    await pipeline(Readable.fromWeb(body as never), counter, {
      signal: options.signal,
    });
    return {
      sha256: hash.digest("hex"),
      size,
      mime: "application/octet-stream",
    };
  } catch (error) {
    output.destroy();
    await finished(output).catch(() => {});
    await rm(path, { force: true });
    throw error;
  }
}
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Error("CANCELLED");
}
class ProxyAgent extends Agent {
  private readonly outstanding = new Set<() => void>();
  constructor(
    private readonly proxy: URL,
    private readonly signal: AbortSignal,
  ) {
    super({ keepAlive: false });
  }
  override destroy(): void {
    for (const abort of this.outstanding) abort();
    super.destroy();
  }
  createConnection(options: any, callback: any): any {
    let socket: import("node:net").Socket | undefined;
    let secureSocket: import("node:tls").TLSSocket | undefined;
    let delivered = false;
    const request = httpRequest({
      hostname: this.proxy.hostname,
      port: this.proxy.port || 3128,
      method: "CONNECT",
      path: `${options.host}:443`,
      headers: { host: `${options.host}:443` },
    });
    const cleanup = () => {
      clearTimeout(handshakeDeadline);
      this.signal.removeEventListener("abort", abort);
      this.outstanding.delete(abort);
    };
    const fail = (error: Error) => {
      cleanup();
      request.destroy();
      secureSocket?.destroy();
      socket?.destroy();
      if (!delivered) {
        delivered = true;
        callback(error);
      }
    };
    const abort = () => fail(abortReason(this.signal));
    const handshakeDeadline = setTimeout(
      () => fail(Error("CONNECT_TIMEOUT")),
      30000,
    );
    this.outstanding.add(abort);
    this.signal.addEventListener("abort", abort, { once: true });
    request.once("socket", (transport) => {
      socket = transport;
      transport.once("close", () => {
        if (!delivered) fail(Error("CONNECT_CLOSED"));
        else cleanup();
      });
    });
    request.once("connect", (response, tunnel) => {
      socket = tunnel;
      if (this.signal.aborted) {
        abort();
        return;
      }
      if (response.statusCode !== 200) {
        fail(Error("EGRESS_DENIED"));
        return;
      }
      secureSocket = tlsConnect({
        socket: tunnel,
        servername: options.host,
        rejectUnauthorized: true,
      });
      secureSocket.once("secureConnect", () => {
        if (this.signal.aborted) {
          abort();
          return;
        }
        clearTimeout(handshakeDeadline);
        if (!delivered) {
          delivered = true;
          callback(null, secureSocket);
        }
      });
      secureSocket.once("error", fail);
      secureSocket.once("close", () => {
        if (!delivered) fail(Error("CONNECT_CLOSED"));
        else cleanup();
      });
    });
    request.once("error", fail);
    if (this.signal.aborted) abort();
    else request.end();
  }
}
/** Every request and redirect opens a policy checked CONNECT. No native fetch
 * fallback exists: it would ignore proxy environment variables in Node. */
export async function proxyFetch(
  value: string,
  proxyUrl: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<Response> {
  signal.throwIfAborted();
  if (redirects > 8) throw Error("REDIRECT_LIMIT");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw Error("EGRESS_DENIED");
  const agent = new ProxyAgent(new URL(proxyUrl), signal);
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          agent,
          signal,
          headers: {
            "accept-encoding": "identity",
            "user-agent": "PersonalWorkbench/1.0",
          },
        },
        (response) => {
          response.once("close", () => agent.destroy());
          resolve(response);
        },
      );
      request.on("error", (error) => {
        agent.destroy();
        reject(error);
      });
      request.end();
    },
  );
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if (!response.headers.location) throw Error("REDIRECT_INVALID");
    return proxyFetch(
      new URL(response.headers.location, url).toString(),
      proxyUrl,
      signal,
      redirects + 1,
    );
  }
  if (response.statusCode === 401 || response.statusCode === 403) {
    response.destroy();
    throw Error("PERMISSION_REQUIRED");
  }
  if ((response.statusCode ?? 500) >= 500) {
    response.destroy();
    throw Error("NETWORK");
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw Error("SOURCE_UNAVAILABLE");
  }
  const encoding = response.headers["content-encoding"];
  if (encoding && encoding !== "identity") {
    response.destroy();
    throw Error("ENCODING_UNSUPPORTED");
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers))
    if (typeof value === "string") headers.set(key, value);
  const result = new Response(
    Readable.toWeb(response) as ReadableStream<Uint8Array>,
    { status: 200, headers },
  );
  Object.defineProperty(result, "url", { value: url.toString() });
  Object.defineProperty(result, "redirected", { value: redirects > 0 });
  return result;
}
export async function downloadVideo(
  url: string,
  directory: string,
  proxy: string,
  signal: AbortSignal,
  maxBytes = CAPTURE_MAX_BYTES,
): Promise<{ path: string; file: BlobDescriptor }> {
  signal.throwIfAborted();
  const path = join(directory, "media.mp4");
  // The URL is stdin-only; no cookies, account stores or user config are read.
  const args = [
    "--ignore-config",
    "--no-playlist",
    "--no-cache-dir",
    "--no-progress",
    "--quiet",
    "--no-warnings",
    "--proxy",
    proxy,
    "--socket-timeout",
    "30",
    "--retries",
    "0",
    "--fragment-retries",
    "0",
    "--max-filesize",
    String(maxBytes),
    "-f",
    "best[ext=mp4]",
    "--restrict-filenames",
    "--no-part",
    "--fixup",
    "never",
    "-o",
    path,
    "--batch-file",
    "-",
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("yt-dlp", args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        ALL_PROXY: proxy,
        NO_PROXY: "",
      },
    });
    let diagnostic = "";
    child.stderr.on("data", (bytes: Buffer) => {
      if (diagnostic.length < 65536) diagnostic += bytes.toString();
    });
    const check = setInterval(() => {
      void stat(path)
        .then((s) => {
          if (s.size > maxBytes) child.kill("SIGKILL");
        })
        .catch(() => {});
    }, 100);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) => {
      clearInterval(check);
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else
        reject(
          Error(
            signal.aborted
              ? "CANCELLED"
              : /tunnel connection failed: 403|proxyerror|proxy error/i.test(
                    diagnostic,
                  )
                ? "EGRESS_DENIED"
                : /sign in|login|private|premium|403|members.only|not available|bot/i.test(
                      diagnostic,
                    )
                  ? "PERMISSION_REQUIRED"
                  : /timed.out|temporary|network|connection.reset/i.test(
                        diagnostic,
                      )
                    ? "NETWORK"
                    : "VIDEO_UNAVAILABLE",
          ),
        );
    });
    child.stdin.end(`${url}\n`);
  });
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r"),
    prefix = Buffer.alloc(16);
  try {
    await handle.read(prefix, 0, 16, 0);
  } finally {
    await handle.close();
  }
  if (prefix.toString("ascii", 4, 8) !== "ftyp")
    throw Error("CONTENT_SIGNATURE_MISMATCH");
  const info = await stat(path);
  if (info.size > maxBytes) {
    await rm(path, { force: true });
    throw Error("BODY_LIMIT");
  }
  // Read in bounded chunks in final server ingestion; hash here uses streaming.
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return {
    path,
    file: { size: info.size, sha256: hash.digest("hex"), mime: "video/mp4" },
  };
}
