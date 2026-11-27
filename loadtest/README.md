# Load test

The load-test harness for a hosted Sterling workbench site on Theia Cloud. It starts real sessions through the Theia Cloud service on a rig,
in stages, reads every figure from the cluster's own records and the site's metrics store, and writes one hashed run file per run to
`loadtest/runs/`. The capacity page, `docs/hosting/capacity.md`, is generated from those files, and the docs check
(`docs-site/test/capacityFigures.test.mjs`) refuses a capacity figure anywhere else in the documentation.

It runs only on your organization's own hardware: no commercial cloud, no managed Kubernetes service and no cloud load generator, for the rig,
the generator host or the metrics store. The harness has no dependencies; it runs on Node 24 or later, and type checking uses the TypeScript
that `compliance/` already installs (`npm --prefix compliance ci --ignore-scripts`, then
`node compliance/node_modules/typescript/bin/tsc -p loadtest/tsconfig.json`). Tests: `node scripts/run-tests.mjs loadtest/test/*.test.ts`.

## What the harness measures

Each stage ramps to its target, waits for the pods, holds a steady state while the sessions report activity, then starts a burst on top,
measures it and stops it. The first stage that is not reached ends the run; it and every later stage are recorded as not reached with the
reason, and nothing is extrapolated.

| Figure | Where it comes from |
| --- | --- |
| Session start: operator reconcile | Session creation to Deployment creation, from `kubectl get <session resource>,deployments -o json` |
| Session start: Pod Ready | Session creation to the Pod's `Ready` condition transition time |
| Session start: first response | Session creation to the first 2xx answer the harness saw at the session address, with the owner's token, polled at `pollIntervalMs` (labelled harness-observed) |
| Cold or warm | Cold when the pod has a `Pulling` image event; warm otherwise |
| Operator throughput | Deployments created per 10-second window during the burst (the operator has no metrics endpoint) |
| Per-person CPU and memory | Prometheus cAdvisor series (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`) per session pod, averaged over the hold, for the active sample only |
| Sessions with no frontend | The same series for the other sessions, shown apart and never as the per-person figure |
| Workspace volume use | `kubelet_volume_stats_used_bytes` for each active-sample session's workspace claim |
| Shared Ingress | Size in bytes and rule count of the AppDefinition's `ingressname` object, sampled while waiting for pods and at each steady state |
| Route propagation | First sample whose Ingress holds a session's rule to that session's first response; a session that answered before a sample showed its rule is counted as not measured |
| etcd | Database size and stored objects, from the first metric name the live server has (`etcd_mvcc_db_total_size_in_bytes`, `apiserver_storage_size_bytes`, ...; `apiserver_storage_objects`, `etcd_object_counts`) |

Every query and its time range are stored in the run file. Kubernetes times have one-second resolution, so start durations are whole seconds
in milliseconds; keep the generator host's clock synchronised with the cluster (a negative duration from clock skew is left out). The active
sample represents sessions with a completed browser activity profile during the hold. The ordinary rig command currently records
`activeSample` as 0 and the per-person rows print "no samples". Rig browser and hub measurements are tracked under G322 and G323.

## Tools on the rig

| Tool | Used for | Version recorded |
| --- | --- | --- |
| `kubectl` | Nodes, AppDefinition, operator Deployment, Sessions, Deployments, Pods, Events and the shared Ingress, read-only | The cluster versions go in the run file (`rke2` from the kubelet version) |
| Prometheus | `/api/v1/query_range` and `/api/v1/label/__name__/values` on the site's own metrics store | The query texts go in the run file |
| A browser build | The active sample (48-04) | In the run file once 48-04 lands |

These tools are on the rig, not in this repository, so the resource checker cannot discover them and they are not registered in
`compliance/resources.json`; each run records what it ran against instead.

## Run order on the rig

1. Import `realm/loadtest-realm.json` into the rig's Keycloak as a separate realm, on the rig only, and point a copy of the production
   AppDefinition (identical except for a longer `timeout`) and the service at it. Set the client's redirect address to the rig's site.
2. Generate the synthetic users outside the repository and keep the file in the rig's secret store:
   `node loadtest/src/cli.ts users --count <top stage plus burst plus spare> --out <path outside the repository>`. The file is created with
   mode 0600, is never overwritten, and holds generated passwords for `loadtest-user-NNNN` with `@loadtest.invalid` addresses (no real person).
   Import it into the test realm (Keycloak partial import).
3. Copy `config.example.json` outside the repository and fill in the rig's addresses, the users file path, the hardware notes and the stages.
   Set `THEIA_CLOUD_APP_ID` in the environment to the service's app id; it is never read from or written to a file.
4. Shake down with a dry-run: `node loadtest/src/cli.ts run --config <file> --kind dry-run --stages 5`. A dry-run is never a capacity source.
5. Run the stages: `node loadtest/src/cli.ts run --config <file> --kind load`. A load run is refused unless the operator runs
   `--sessionsPerUser 1`, the AppDefinition image is referenced by digest, and the operator image digest is the one in
   `deploy/bundle/images.lock.json`. Ctrl-C stops every started session and still writes the run file, with the current stage recorded as
   interrupted.
6. Check three sessions by hand against the cluster (creation, Ready and address times), then commit the run file, run
   `node loadtest/src/cli.ts capacity` and commit the regenerated page.

## One-shot local browser fixture

The Phase 48-04 local command is `node loadtest/src/cli.ts sample --no-auth --once`. It requires a separately authorized test-created
v0.4.41 Workbench fixture and the already verified Chromium 1254 executable. The launcher supplies the absolute path to its mode-0600
`fixture.json` in `SOVAI_SAMPLE_FIXTURE`. Its fields are `containerId`, `hostNamespace` from the launcher before joining the fixture,
and the absolute `chromiumExecutable` path. The command checks the live container, private namespace, dedicated workspace, pinned
image and browser, and resource caps before taking a one-time claim. The fixture marker prevents use of the ordinary `run` command,
including dry-run. Review the signed artifact and fixture evidence before an authorized trial.

Workbench uses literal `127.0.0.1:3000` with no sign-in. A separate server bound to `127.0.0.1:3001` uses `localhost` as the WebAuthn
relying party for disposable virtual passkey registration and sign-in. The checksummed activity profile opens three synthetic documents,
edits and saves one, runs a fixed terminal echo and waits briefly. The command refuses redirects and outside origins. It prints
Get Started, step and standalone sign-in timings as JSON, with a configured sample count and stage total of one. It creates no rig run file.

## The test realm

`realm/loadtest-realm.json` defines the realm `loadtest-sterling` with one public client, `loadtest-client`, and no users. It differs from the
production realm on purpose, and each run records the differences:

- direct access grants (the password grant) are on for `loadtest-client`, so the harness can mint tokens for synthetic users;
- WebAuthn attestation is not required and there is no AAGUID allowlist, so the browser sample's virtual authenticator can sign in.

The production realm keeps passwords and every non-WebAuthn flow off. The test realm is never imported into production and never goes into the
offline bundle. The harness mints tokens only from a realm whose name starts with `loadtest-`, refusing any other before a request is made,
holds them in memory only, and renews them before they expire, so a burst measures Theia Cloud rather than password hashing.

## Run files and the capacity page

A run file is `loadtest/runs/<UTC start yyyymmddThhmmssZ>-<rig>.run.json`, of kind `load`, `experiment` or `dry-run`, schema 1. It holds the
inputs, the hardware (nodes with role, CPU, memory and `maxPods`, storage class, whether images were preloaded, network notes), the versions
(workbench image digest, Theia Cloud chart, commit and operator digest, Keycloak, OpenBao, ingress, RKE2, hub), and per stage the raw values the
page's figures come from, all as non-negative integers (ms, bytes, millicores) in ascending order. Its hash is the SHA-256 of the canonical JSON
(sorted keys) of everything else. The reader refuses an unknown key, a missing field, a fraction or a negative number; the writer creates the
file exclusively, refuses anything secret- or token-shaped, and caps it at 5 MiB.

Capacity figures appear only on the generated page. It prints percentiles by nearest rank: p50 from one sample, p95 from 20, p99 from 100, and
"n too small" below that; the run file always keeps n. `node loadtest/src/cli.ts verify --all` checks every run file and
`node loadtest/src/cli.ts capacity --check` checks the page.
