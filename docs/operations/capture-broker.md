# Private capture broker (Task 12a source contract)

The API remains the sole SQLite/queue/blob owner. Its capture runtime only connects to a local Unix domain socket. The broker alone controls Docker. Neither the broker nor its worker/proxy/guard mounts the database, capture key or blob store. The broker is a trusted Docker controller; this is not a claim that a compromised broker is harmless to its Docker host.

## Operator entrypoints

Build with the existing `pnpm build:server` command. It emits `dist-server/capture-broker.mjs` and `dist-server/capture-remote.mjs` separately from the API CLI. No dependency or package script was added.

Prepare a short, absolute socket directory owned by the broker with mode `0750`, and a private scratch parent. Give the API the directory's shared group. The broker creates its socket with mode `0660`. The API should mount that directory read-only; the broker mounts it writable. Actual Linux read-only UDS connectivity is an external deployment check in Task 12b.

Example broker arguments (replace the example image with an independently verified local ID or repository digest and choose the matching platform):

```sh
node dist-server/capture-broker.mjs \
  --socket /run/workbench/capture.sock \
  --image sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --platform linux/arm64 \
  --deployment-id personal-workbench \
  --scratch-dir /var/lib/workbench-capture-scratch
```

All five flags are required. Images are verified locally before readiness and never pulled. Valid platforms are `linux/amd64` and `linux/arm64`. Deployment IDs contain 1–48 lowercase letters/digits/hyphens and start with a letter/digit. Use one active broker/socket per deployment ID. An active socket, symlink, foreign owner or unsafe directory fails startup. Only stale refused socket inodes are removed; the socket is reserved before Docker startup.

The existing API `serve` arguments gain `--capture-socket /run/workbench/capture.sock`. With `--capture on`, both `--capture-key-file` and `--capture-socket` are required. There is no fallback to Docker. `RemoteCaptureRuntime.stop()` aborts that API's requests and does not stop the broker.

Protocol v1 has only `GET /ready` and `POST /acquire` over UDS. Requests cannot select an image, command, environment, Docker operation, host path or network. Input is capped at 32 KiB, result header at 64 KiB, file at 1 GiB, active acquisitions at two, pending bodies at eight and connections at sixteen. Image/PDF and video worker budgets remain 5/30 minutes; the broker independently enforces the hard 30-minute acquisition/stream ceiling. Unknown fields, URL credentials, non-HTTPS/non-443 URLs, raised budgets, malformed framing, unapproved MIME types and incorrect hashes/lengths fail closed. No transparent transport retry is added.

Docker resources carry fixed owner, deployment, instance and role labels under `org.workbench.capture`. Restart reconciles only the matching owner+deployment; graceful shutdown cleans only its instance. Existing unlabelled development resources are excluded. Scratch lives in the broker-owned `workbench-broker-<deployment-id>` subdirectory and is cleaned on cancellation/completion/restart. Provision a quota-limited scratch volume (two 1 GiB results plus filesystem overhead); the source cap is not a filesystem quota or production deployment acceptance.

## Executable integration checks (operator only)

Root owns image builds and actual Docker/deployment evidence. The following commands are available; unit tests do not prove real container isolation.

```sh
WORKBENCH_CAPTURE_IMAGE=sha256:<verified-local-image-id> \
  node scripts/verify-capture-broker.mjs

WORKBENCH_CAPTURE_IMAGE=sha256:<verified-local-image-id> \
  WORKBENCH_CAPTURE_EGRESS=1 node scripts/verify-capture-broker.mjs
```

The first runs a positive capture through broker + UDS + remote adapter and independently verifies its bytes, then exercises loopback IPv4/IPv6/mapped IPv4 and metadata URLs through `/acquire`. The second also runs the existing direct socket, proxy and Python-helper bypass probes in the **broker-created guard's netns** while an acquisition requested through UDS is active. This is an operator-only command-adapter hook in the temporary verification harness, never an acquisition API feature. The original egress script retains its standalone mode; in broker mode it creates/removes only its own canary and leaves the broker's proxy/guard/network to their owner.

`WORKBENCH_CAPTURE_INPUT_JSON` may replace the positive input with a permitted WorkerInput object. `WORKBENCH_CAPTURE_NEGATIVE_INPUTS_JSON` may replace the four negative probes with up to 20 `{name,input}` objects; names use lowercase letters/digits/hyphens (maximum 60). Each negative must yield `PRIVATE_TARGET`, `EGRESS_DENIED` or `HTTPS_REQUIRED`. Use this for independently controlled DNS-rebinding and HTTPS-redirect fixtures; no successful DNS-rebinding/redirect real-world evidence is implied by the built-in literal-address probes. Raw input URLs are not printed by the harness.

For disk-backed queue/blob/restart verification against an independently running broker:

```sh
WORKBENCH_CAPTURE_SOCKET=/run/workbench/capture.sock \
  WORKBENCH_CAPTURE_IMAGE=sha256:<verified-local-image-id> \
  node scripts/verify-capture-persistence.mjs
```

Without that socket flag the persistence/source-check scripts retain an explicit development-only direct runtime, resolving their local image to a pinned ID/platform. The production API never imports it.

Remaining Task 12 gates include actual Linux broker/API container mounts and identities; no Docker access from API; no external broker route/TCP port; Docker-host isolation/restart/cancellation probes; production image digest/platform selection; HTTPS/cloud independent operation; consistent online backup and isolated restore; release identities/signing/licenses; and three-platform actual installation, upgrade and cross-device/device-notification acceptance. None is established by a local UDS test or build.
