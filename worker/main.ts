import { workerMain } from "./runner";
workerMain().catch(() => {
  process.stdout.write('{"state":"failed","errorCode":"WORKER_FAILED"}\n');
  process.exitCode = 1;
});
