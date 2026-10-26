import { expect, it } from "vitest";
import {
  assertPublicAddress,
  resolvePublicTarget,
} from "../../server/capture/egress";
it("redirect_dns_and_subprocess_cannot_reach_private_network address families", async () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "2001:db8::1",
  ])
    expect(() => assertPublicAddress(ip)).toThrow("PRIVATE_TARGET");
  expect(() => assertPublicAddress("1.1.1.1")).not.toThrow();
  expect(() => assertPublicAddress("2606:4700:4700::1111")).not.toThrow();
  await expect(
    resolvePublicTarget("https://public.example/file", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  ).rejects.toThrow("PRIVATE_TARGET");
  await expect(resolvePublicTarget("http://example.com/file")).rejects.toThrow(
    "HTTPS_REQUIRED",
  );
});
it("rebinding is checked per connection and URL credentials are rejected", async () => {
  let count = 0;
  const resolve = async () => [
    { address: ++count === 1 ? "1.1.1.1" : "169.254.169.254", family: 4 },
  ];
  expect(
    (await resolvePublicTarget("https://public.example/a", resolve)).address,
  ).toBe("1.1.1.1");
  await expect(
    resolvePublicTarget("https://public.example/b", resolve),
  ).rejects.toThrow("PRIVATE_TARGET");
  await expect(
    resolvePublicTarget("https://user:password@example.com/"),
  ).rejects.toThrow("INVALID_TARGET");
});

async function stalledProxy(stage: "connect" | "tls") {
  const { createServer } = await import("node:http");
  const sockets = new Set<import("node:stream").Duplex>();
  let accepted!: () => void;
  const connected = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const server = createServer();
  server.on("connect", (_request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    if (stage === "tls") {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => accepted());
      socket.resume();
    } else accepted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("LISTEN");
  return {
    url: `http://127.0.0.1:${address.port}`,
    connected,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
for (const stage of ["connect", "tls"] as const) {
  it(`aborting during deferred ${stage} rejects and closes the pending proxy socket`, async () => {
    const { proxyFetch } = await import("../../worker/downloaders");
    const proxy = await stalledProxy(stage),
      controller = new AbortController();
    const pending = proxyFetch(
      "https://public.example/file",
      proxy.url,
      controller.signal,
    );
    try {
      await proxy.connected;
      setTimeout(() => controller.abort(), 40);
      const outcome = await Promise.race([
        pending.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("pending"), 300),
        ),
      ]);
      expect(outcome).toBe("rejected");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(proxy.sockets.size).toBe(0);
    } finally {
      controller.abort();
      await proxy.close();
    }
  });
  it(`worker hard deadline covers deferred ${stage} before a response exists`, async () => {
    const { acquire } = await import("../../worker/runner");
    const proxy = await stalledProxy(stage);
    try {
      const result = await Promise.race([
        acquire(
          { url: "https://public.example/page", imagePdfTimeoutMs: 40 },
          "/unused",
          proxy.url,
        ),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 300),
        ),
      ]);
      expect(result).not.toBe("pending");
      expect(result).toEqual(
        expect.objectContaining({
          state: "failed",
          errorCode: "DEADLINE_EXCEEDED",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(proxy.sockets.size).toBe(0);
    } finally {
      await proxy.close();
    }
  });
}
it("redirected HTML reports its final URL and resolves image/srcset/video candidates there", async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createServer: createHttps } = await import("node:https");
  const { createServer: createHttp } = await import("node:http");
  const { connect } = await import("node:net");
  const tls = await import("node:tls");
  const { proxyFetch } = await import("../../worker/downloaders");
  const { acquire } = await import("../../worker/runner");
  const directory = await mkdtemp(join(tmpdir(), "workbench-redirect-test-"));
  const configuration = join(directory, "cert.cnf"),
    key = join(directory, "key.pem"),
    cert = join(directory, "cert.pem");
  await writeFile(
    configuration,
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=origin.example\n[ext]\nsubjectAltName=DNS:origin.example,DNS:cdn.example\nbasicConstraints=critical,CA:TRUE\n",
  );
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-config",
    configuration,
  ]);
  const previous = tls.getCACertificates();
  tls.setDefaultCACertificates([...previous, await readFile(cert, "utf8")]);
  const sockets = new Set<import("node:stream").Duplex>();
  const upstream = createHttps(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      if (request.headers.host === "origin.example") {
        response.writeHead(302, {
          location:
            request.url === "/query-candidates"
              ? "https://cdn.example/final/books/queries.html"
              : "https://cdn.example/final/books/index.html",
        });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        request.url === "/final/books/queries.html"
          ? '<img src="/image?id=first"><img src="/image?id=second"><img src="/private.png?token=hidden-secret">'
          : '<img src="cover.png" srcset="../hi.png 2x"><video src="../clips/trailer.mp4"></video>',
      );
    },
  );
  const proxy = createHttp();
  for (const server of [upstream, proxy])
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw Error("LISTEN");
  proxy.on("connect", (_request, client, head) => {
    const target = connect(upstreamAddress.port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      client.pipe(target);
      target.pipe(client);
    });
    target.on("error", () => client.destroy());
    client.on("error", () => target.destroy());
    client.on("close", () => target.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw Error("LISTEN");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await proxyFetch(
      "https://origin.example/start",
      proxyUrl,
      AbortSignal.timeout(2000),
    );
    expect(response.url).toBe("https://cdn.example/final/books/index.html");
    await response.body?.cancel();
    const result = await acquire(
      { url: "https://origin.example/start", imagePdfTimeoutMs: 2000 },
      directory,
      proxyUrl,
    );
    expect(result).toEqual(
      expect.objectContaining({ state: "needs-selection" }),
    );
    if (result.state !== "needs-selection") throw Error("EXPECTED_SELECTION");
    expect(result.candidates.map((candidate) => candidate.url)).toEqual([
      "https://cdn.example/final/books/cover.png",
      "https://cdn.example/final/hi.png",
      "https://cdn.example/final/clips/trailer.mp4",
    ]);
    const protectedSources = await acquire(
      {
        url: "https://origin.example/query-candidates",
        imagePdfTimeoutMs: 2000,
      },
      directory,
      proxyUrl,
    );
    expect(protectedSources).toEqual({
      state: "unsupported",
      errorCode: "SOURCE_INPUT_REQUIRED",
    });
    expect(JSON.stringify(protectedSources)).not.toContain("hidden-secret");
  } finally {
    tls.setDefaultCACertificates(previous);
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});
