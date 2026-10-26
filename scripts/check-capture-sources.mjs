import { build } from "esbuild";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const temporary = await mkdtemp(join(tmpdir(), "workbench-source-check-"));
const image =
  process.env.WORKBENCH_CAPTURE_IMAGE ?? "workbench-test-capture:2026-10-24";
const output =
  process.env.WORKBENCH_CAPTURE_EVIDENCE ??
  "docs/research/2026-10-24-capture-source-evidence.json";
await build({
  entryPoints: ["server/capture/docker-runtime.ts"],
  outfile: join(temporary, "runtime.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { IsolatedCaptureRuntime } = await import(
  pathToFileURL(join(temporary, "runtime.mjs")).href
);
const inspected = JSON.parse((await promisify(execFile)("docker", ["image", "inspect", image])).stdout)[0];
const runtime = new IsolatedCaptureRuntime({image: inspected.Id, platform: `${inspected.Os}/${inspected.Architecture}`, deploymentId: 'source-check'});
const filter = process.env.WORKBENCH_CAPTURE_SOURCE_FILTER;
let results = [];
if (filter) {
  try {
    results = JSON.parse(await readFile(output, "utf8")).results ?? [];
  } catch {}
}
const version = (
  await promisify(execFile)("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--entrypoint",
    "yt-dlp",
    image,
    "--version",
  ])
).stdout.trim();
const imageDigest = (
  await promisify(execFile)("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{.Id}}",
  ])
).stdout.trim();
const sources = [
  {
    kind: "video-adapter",
    site: "Bilibili",
    url: "https://www.bilibili.com/video/BV17x411w7KC/",
  },
  {
    kind: "video-adapter",
    site: "YouTube",
    url: "https://www.youtube.com/watch?v=BaW_jenozKc",
  },
  {
    kind: "video-adapter",
    site: "Vimeo Big Buck Bunny",
    url: "https://vimeo.com/1084537",
  },
  { kind: "image", site: "W3C", url: "https://www.w3.org/Icons/w3c_home.png" },
  {
    kind: "pdf",
    site: "W3C",
    url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  },
  { kind: "html-image", site: "W3C", url: "https://www.w3.org/" },
  {
    kind: "video-direct",
    site: "W3Schools Big Buck Bunny sample",
    url: "https://www.w3schools.com/html/mov_bbb.mp4",
  },
];
try {
  await runtime.start();
  for (const source of sources.filter(
    (source) => !filter || source.site.includes(filter),
  )) {
    results = results.filter((previous) => previous.url !== source.url);
    const started = new Date().toISOString();
    try {
      const result = await runtime.acquire(
        { url: source.url, imagePdfTimeoutMs: 60000, videoTimeoutMs: 90000 },
        new AbortController().signal,
      );
      if (result.state === "file") {
        results.push({
          ...source,
          date: started,
          version,
          imageDigest,
          state: "downloaded",
          strategy: result.strategy,
          ...result.file,
        });
        await result.dispose();
      } else if (
        source.kind === "html-image" &&
        result.state === "needs-selection" &&
        result.candidates?.length
      ) {
        const selected =
          result.candidates.find((c) =>
            /\.(png|jpg|jpeg)(\?|$)/i.test(c.url),
          ) ?? result.candidates[0];
        const file = await runtime.acquire(
          { url: selected.url, imagePdfTimeoutMs: 60000 },
          new AbortController().signal,
        );
        if (file.state === "file") {
          results.push({
            ...source,
            date: started,
            version,
            imageDigest,
            state: "downloaded-selected-image",
            strategy: file.strategy,
            selectedUrl: selected.url,
            ...file.file,
          });
          await file.dispose();
        } else
          results.push({
            ...source,
            date: started,
            version,
            imageDigest,
            ...file,
            limitations: "HTML parsed, selected resource did not download",
          });
      } else
        results.push({
          ...source,
          date: started,
          version,
          imageDigest,
          ...result,
          limitations:
            "This source did not produce a verified file; not a passing source",
        });
    } catch (error) {
      results.push({
        ...source,
        date: started,
        version,
        imageDigest,
        state: "failed",
        errorCode: error instanceof Error ? error.message : "UNKNOWN",
        limitations: "No verified file",
      });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  await runtime.stop();
  await rm(temporary, { recursive: true, force: true });
}
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      image,
      downloader: { name: "yt-dlp", version },
      isolation:
        "nonroot worker; all capabilities dropped; namespace firewall proxy-only; no host mounts",
      results,
      limitations: [
        "Public accessibility is specific to this date, source URL and environment.",
        "A site adapter name is not a guarantee of download availability.",
        "No personal accounts or cookies were read.",
      ],
    },
    null,
    2,
  ) + "\n",
);
if (
  !["image", "pdf", "html-image", "video-direct"].every((kind) =>
    results.some(
      (item) => item.kind === kind && item.state.startsWith("downloaded"),
    ),
  )
)
  process.exitCode = 1;
