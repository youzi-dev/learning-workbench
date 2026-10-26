import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist-server', { recursive: true });
await build({
  entryPoints: {'app':'server/app.ts', 'cli':'server/cli.ts', 'schemas':'server/schemas.ts', 'capture-broker':'server/capture/broker-cli.ts', 'capture-remote':'server/capture/remote-runtime.ts', 'backup':'server/backup-cli.ts', 'deploy':'server/deploy-entry.ts', 'offhost':'server/offhost-entry.ts'},
  outdir: 'dist-server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
await cp('server/migrations', 'dist-server/migrations', { recursive: true });
