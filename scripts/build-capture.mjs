import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("deploy/capture-dist", { recursive: true });
await build({
  entryPoints: { worker: "worker/main.ts", proxy: "worker/proxy-main.ts" },
  outdir: "deploy/capture-dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
});
