import { lookup } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { get as httpsGet } from "node:https";
import { connect, isIP } from "node:net";
import type { Socket } from "node:net";
export type Address = { address: string; family: number };
export type Resolver = (host: string) => Promise<Address[]>;
function ipv6Bytes(ip: string): number[] {
  let input = ip.toLowerCase().split("%")[0];
  if (input.includes(".")) {
    const split = input.lastIndexOf(":");
    const tail = input
      .slice(split + 1)
      .split(".")
      .map(Number);
    input =
      input.slice(0, split) +
      ":" +
      ((tail[0] << 8) | tail[1]).toString(16) +
      ":" +
      ((tail[2] << 8) | tail[3]).toString(16);
  }
  const halves = input.split("::"),
    left = halves[0] ? halves[0].split(":") : [],
    right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return words.flatMap((word) => {
    const n = parseInt(word, 16);
    return [n >> 8, n & 255];
  });
}
export function assertPublicAddress(ip: string): void {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
      throw Error("PRIVATE_TARGET");
    return;
  }
  if (family === 6) {
    const b = ipv6Bytes(ip);
    // Permit globally routable unicast only. Reject mapped, NAT64, 6to4,
    // link-local, unique-local, loopback, documentation and transition ranges.
    if (
      (b[0] & 0xe0) !== 0x20 ||
      (b[0] === 0x20 && b[1] === 0x02) ||
      (b[0] === 0x20 &&
        b[1] === 0x01 &&
        (b[2] < 2 || (b[2] === 0x0d && b[3] === 0xb8))) ||
      (b[0] === 0x3f && (b[1] & 0xf0) === 0xf0)
    )
      throw Error("PRIVATE_TARGET");
    return;
  }
  throw Error("PRIVATE_TARGET");
}
export async function resolvePublicTarget(
  value: string,
  resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }),
): Promise<Address & { hostname: string; port: number }> {
  const url = new URL(value);
  if (url.protocol !== "https:") throw Error("HTTPS_REQUIRED");
  if (
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    value.length > 16384
  )
    throw Error("INVALID_TARGET");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname);
  if (!addresses.length) throw Error("DNS_EMPTY");
  // Every returned address must be public, even if the connector picks the first.
  addresses.forEach((item) => assertPublicAddress(item.address));
  return { ...addresses[0], hostname, port: 443 };
}
/** Explicit public DNS transport avoids trusting a workstation's VPN fake-IP
 * resolver. TLS is verified for the resolver name while its socket is pinned
 * to a fixed public IP. DNS answers still pass the normal address policy. */
export async function resolveViaPublicDoh(
  hostname: string,
): Promise<Address[]> {
  const results = await Promise.all(
    [1, 28].map(
      (type) =>
        new Promise<Address[]>((resolve, reject) => {
          const request = httpsGet(
            {
              hostname: "1.1.1.1",
              servername: "cloudflare-dns.com",
              path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
              headers: { accept: "application/dns-json" },
              timeout: 10000,
            },
            (response) => {
              let body = "";
              response.on("data", (chunk) => {
                body += chunk.toString();
                if (Buffer.byteLength(body) > 65536)
                  response.destroy(Error("DNS_LIMIT"));
              });
              response.on("error", reject);
              response.on("end", () => {
                try {
                  if (response.statusCode !== 200) throw Error("DNS_FAILED");
                  const value = JSON.parse(body) as {
                    Status: number;
                    Answer?: { type: number; data: string }[];
                  };
                  if (value.Status !== 0) throw Error("DNS_FAILED");
                  resolve(
                    (value.Answer ?? [])
                      .filter((answer) => answer.type === type)
                      .map((answer) => ({
                        address: answer.data,
                        family: type === 1 ? 4 : 6,
                      })),
                  );
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          request.on("error", reject);
          request.on("timeout", () => request.destroy(Error("DNS_TIMEOUT")));
        }),
    ),
  );
  const addresses = results.flat();
  if (!addresses.length) throw Error("DNS_EMPTY");
  addresses.forEach((item) => assertPublicAddress(item.address));
  return addresses;
}
export function createEgressProxy(
  options: { resolver?: Resolver; maxConnections?: number } = {},
): Server {
  const proxy = createServer((_request, response) => {
    response.writeHead(403);
    response.end("HTTPS CONNECT required");
  });
  let connections = 0;
  proxy.on("connect", async (request, client, head) => {
    if (++connections > (options.maxConnections ?? 64)) {
      connections--;
      client.destroy();
      return;
    }
    client.once("close", () => {
      connections--;
    });
    let upstream: Socket | undefined;
    try {
      if (
        !request.url ||
        !/^([a-zA-Z0-9._-]+|\[[a-fA-F0-9:]+\]):443$/.test(request.url)
      )
        throw Error("INVALID_TARGET");
      const target = await resolvePublicTarget(
        `https://${request.url}/`,
        options.resolver ?? resolveViaPublicDoh,
      );
      if (client.destroyed) return;
      // Connect to the validated literal. Never let a second DNS lookup choose
      // a rebound address between policy validation and connection establishment.
      upstream = connect({
        host: target.address,
        port: 443,
        family: target.family,
      });
      upstream.setTimeout(30000, () => upstream?.destroy());
      upstream.once("connect", () => {
        if (
          !upstream ||
          upstream.remoteAddress?.replace(/^::ffff:/, "") !==
            target.address.replace(/^::ffff:/, "")
        ) {
          upstream?.destroy();
          client.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream?.destroy());
      client.once("close", () => upstream?.destroy());
    } catch {
      upstream?.destroy();
      if (!client.destroyed)
        client.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
    }
  });
  proxy.requestTimeout = 30000;
  proxy.headersTimeout = 10000;
  return proxy;
}
