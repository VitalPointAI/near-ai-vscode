---
phase: 68-relay-foundation
plan: 07
subsystem: infra
tags: [relay, docker, compose, distroless, hardening, container-test, readme]

requires:
  - phase: 68-06
    provides: "secrets from files (TEAMS_APP_SECRET_FILE, /run/secrets), stable phone labels, relay.listening / secrets.loaded events"
  - phase: 68-04
    provides: "state directory rules (0700 directory, 0600 files) and the store instance id"
provides:
  - "relay/Dockerfile: two stages pinned by digest (node 26.13.1-slim build, distroless nodejs26-debian13 nonroot final), /app holds only bin.mjs and app.mjs"
  - ".dockerignore: repo-root allow-list build context for the relay image"
  - "relay/compose.yaml: project near-ai-relay, hardened relay service, signal service under profile signal, teams_app_secret Compose secret"
  - "relay/test/container/container.test.ts and the npm run test:container script"
  - "relay/README.md: operator notes for the foundation"
affects: [68-08, 69, 71, 75, 76]

actuals:
  tokens: 9400
  tasks: 3
  commits: 2
plan_head_before: 9fb55fdb3d1bea60330f80f1ecf9c067ddd2b51b
plan_head_after: 01c375d8115f6a4bfb73845f469a9492b8a78efc

tech-stack:
  added: []
  patterns:
    - "Final image has no shell, so every mode is set in the build stage and copied as is (/app-skel, /state-skel)"
    - "Compose variables use the NEAR_AI_RELAY_ prefix so the relay's unknown-RELAY_-setting refusal never sees them"
    - "Container suite owns one uniquely named image, Compose project and secrets folder and removes exactly those"

key-files:
  created:
    - relay/Dockerfile
    - .dockerignore
    - relay/compose.yaml
    - relay/test/container/container.test.ts
    - relay/README.md
  modified:
    - relay/package.json

key-decisions:
  - "The code folder is staged in the build stage as /app-skel (files 0444, folder 0555) and copied without --chmod; a --chmod=0444 on the COPY also hit the /app folder and the relay could not enter it."
  - "Directory entries are excluded from the no-package-manager check: the distroless base keeps empty data folders etc/dpkg and var/lib/dpkg; files and links named sh, bash, dash, busybox, npm, npx, apt, apt-get, dpkg, curl or wget are still refused."
  - "docker build is run without --memory: BuildKit's docker build has no such flag. Every container the suite runs does carry --memory."
  - "No docker save scan: this host uses the containerd image store, whose saved layers are compressed, so a byte search there would prove nothing. The uncompressed docker export of a created container is searched instead, plus history, image config and compose logs."

patterns-established:
  - "New files for the image are allowed in through .dockerignore lines; Phase 71 adds !src/agent and what it imports."

requirements-completed: []

coverage:
  - id: D1
    description: "The image's final stage is distroless nodejs26 nonroot pinned by digest; it has no shell or package manager (sh fails with executable file not found), user 65532:65532, and /app holds exactly bin.mjs and app.mjs"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/container/container.test.ts#every Dockerfile FROM is pinned by digest and the final image is distroless Node 26 nonroot"
        status: pass
      - kind: integration
        ref: "relay/test/container/container.test.ts#no shell: running sh in the image fails with \"executable file not found\""
        status: pass
      - kind: integration
        ref: "relay/test/container/container.test.ts#exported filesystem: no shell or package manager, only bin.mjs and app.mjs in /app, and no fake secret in any byte"
        status: pass
    human_judgment: false
  - id: D2
    description: "Under Compose the relay runs read-only, CapEff 0, NoNewPrivs 1, uid 65532, /tmp as tmpfs, state volume the only writable path, port published on 127.0.0.1 only, Teams secret as a Compose secret"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/container/container.test.ts#Compose config: read-only root, all capabilities dropped, no-new-privileges, uid 65532, loopback publish, /tmp tmpfs, Teams secret"
        status: pass
      - kind: integration
        ref: "relay/test/container/container.test.ts#running container: read-only root, writable /tmp, no capabilities, no-new-privileges, uid 65532, private state"
        status: pass
    human_judgment: false
  - id: D3
    description: "The Compose healthcheck reports healthy and GET /healthz on host loopback returns exactly the five D-12 fields"
    requirement: RELAY-02
    verification:
      - kind: integration
        ref: "relay/test/container/container.test.ts#Compose up: healthy, /healthz on loopback has the five fields, the logs name the secret but never show it"
        status: pass
    human_judgment: false
  - id: D4
    description: "After kill -s KILL and up, the relay logs the same instanceId and answers /healthz; every state file is 0600 inside a 0700 directory owned by 65532"
    requirement: RELAY-03
    verification:
      - kind: integration
        ref: "relay/test/container/container.test.ts#a hard kill of the container keeps the instance id and the relay serves /healthz again"
        status: pass
      - kind: integration
        ref: "relay/test/container/container.test.ts#running container: read-only root, writable /tmp, no capabilities, no-new-privileges, uid 65532, private state"
        status: pass
    human_judgment: false
  - id: D5
    description: "A fake secret planted in relay/secrets before the build and supplied at run time appears in no image history entry, image setting, environment variable, exported file byte or log line"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/container/container.test.ts (image, exported filesystem and Compose up tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The Signal sidecar exists only under profile signal, pinned by tag and sha256 digest, publishes no port, and the file records the 2026-12-10 re-check date; the default Compose services list is only relay"
    requirement: RELAY-04
    verification:
      - kind: integration
        ref: "relay/test/container/container.test.ts#the Signal sidecar is only in profile signal, pinned by tag and digest, and publishes no port"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-11-14
status: complete
---

# Phase 68 Plan 07: Hardened relay image, Compose project and container suite Summary

**The relay now ships as a shell-less distroless container (both base images pinned by digest) with a Compose definition that runs it read-only, capability-free and loopback-only; `npm run test:container` builds the image from the repo root and proves the hardening, the healthcheck, the absence of secrets and state survival across `kill -s KILL` on a real running container.**

## Accomplishments

- `relay/Dockerfile`: build stage `node:26.13.1-slim@sha256:e6bedef2...` runs `npm ci --ignore-scripts`, `tsc` and `build.mjs --app-only`, then stages `/app-skel` and `/state-skel`; the final stage `gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8...` copies only those, sets `RELAY_STATE_DIR`, `RELAY_HOST=0.0.0.0`, `RELAY_PORT=8080`, user 65532:65532, entrypoint `/nodejs/bin/node`, command `/app/bin.mjs`.
- Root `.dockerignore` is an allow-list (`*` plus six `!relay/...` lines); `relay/state`, `relay/secrets`, `.git` and `.planning` never enter the context.
- `relay/compose.yaml` follows D-14, D-15, D-16: read_only, `cap_drop: [ALL]`, no-new-privileges, pids 128, memory 512m, `127.0.0.1` publish, `/tmp` tmpfs, healthcheck `node /app/bin.mjs --healthcheck`, Teams file secret (no uid, gid or mode keys), `signal` under profile `signal` with tag, digest, no ports and the 2026-12-10 Phase 75 re-check comment.
- `relay/test/container/container.test.ts` (10 tests, one suite): static pin checks, `.dockerignore` allow-list, `compose config` hardening and sidecar profile, image inspect and history, `docker run --entrypoint sh` failing with "executable file not found", `docker export | tar -t` file list plus a chunk-boundary-safe byte search for the fake secret, `compose up --wait` healthy, `/healthz` field check, log checks, an exec probe of EROFS, `/tmp`, CapEff, NoNewPrivs, uid and state modes, and the hard-kill restart.
- `relay/README.md`: operator notes (requirements, commands, settings, state directory, secrets, Compose, health, Signal sidecar, known limits including the Phase 71 single-instance limit).

## Task Commits

1. **Tasks 1 and 2: image, `.dockerignore`, Compose, `test:container` script and the whole container suite** - `ba13f9d` (feat). The tracer and the hardening tests live in one test file and were written and first run together, so they are one commit.
2. **Task 3: operator README** - `01c375d` (docs)

**Plan metadata:** committed separately after this summary (docs).

## Verification

Node and cap wrapper as in earlier plans: `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" ...` (`timeout 900` for the unit suite).

- Container suite, run after the last code commit: `... npm run test:container --prefix relay`: 10 tests, 10 pass, 0 fail, 0 skipped, 0 cancelled (about 15 s with the base images cached by digest).
- Full relay suite: `... env NEAR_AI_RELAY_OLD_NODE=$HOME/.nvm/versions/node/v24.22.2/bin/node npm test --prefix relay`: 147 tests, 147 pass, 0 fail, 0 skipped (the container suite is not part of it). `npm run lint --prefix relay` clean.
- Acceptance: `grep -c "^FROM .*@sha256:[0-9a-f]\{64\}" relay/Dockerfile` is 2; `.dockerignore` has one `*` line and one `!relay/src` line; `grep -c "executable file not found"` and `grep -c kill` on the test file are at least 1; `docker compose ls --all` lists no `near-ai-relay-test` project and `relay/secrets` does not exist after the run; README: 0 em-dashes, "your organization" present, "Phase 71" present, the Task 3 verify command exits 0.
- Docker objects: before and after lists of images, volumes, containers and networks were compared; the only difference was the `node:26.13.1-slim` base pulled by digest, which was removed by its exact ID after the final run. Nothing else is left.

## Files Created/Modified

- `relay/Dockerfile`, `.dockerignore`, `relay/compose.yaml`, `relay/test/container/container.test.ts`, `relay/README.md` - new
- `relay/package.json` - `test:container` script

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `/app` was copied with mode 0444 and the relay could not enter it**
- **Found during:** Task 1 first run (container unhealthy, restarting; reproduced by hand: `Cannot find module '/app/bin.mjs'`)
- **Issue:** `COPY --chmod=0444` of the two files into `/app/` also applied to the `/app` folder, so user 65532 had no execute bit on it.
- **Fix:** the build stage stages `/app-skel` (files 0444, folder 0555) and the final stage copies it with only `--chown=0:0`. The files are still root-owned and read-only; the folder is root-owned and enterable.
- **Files modified:** `relay/Dockerfile`
- **Commit:** `ba13f9d`

### Test assertions corrected against the real image (not weakened)

- The `compose config` secret entry also carries `target: /run/secrets/teams_app_secret`; the assertion now pins exactly `{source, target}`, which still proves no `uid`, `gid` or `mode` key is present.
- The tool-name check covers files and links only; `etc/dpkg/` and `var/lib/dpkg/` are empty data folders of the base image, not a package manager. A file or link named `sh`, `dpkg` and the rest is still refused.

### Notes (not deviations)

- The plan's behavior line says builds get a memory limit "too"; `docker build` (BuildKit) has no `--memory` flag, so the build runs uncapped. Every container the suite runs (`chown` helper, `run`, `create`) has `--memory`, and the Compose service has `mem_limit: 512m`.
- The plan asks for the fake secret to be absent from "every exported image file". The export of a created container is searched byte for byte. A `docker save` scan was left out because the host's containerd image store writes compressed layers there, so it could not find anything.
- Task 2 was not a separate RED/GREEN step: its tests passed on the first run once the `/app` fix was in, and no assertion was changed to get there.

## Issues Encountered

The first container run failed 5 of 10 (the `/app` mode bug above plus the two assertion corrections); the next run and the final run are green. A debugging image and a scratch secrets folder made by hand were removed by exact name.

## Known Stubs

None.

## Threat Flags

None. T-68-23 (no shell, no package manager, asserted), T-68-24 (uid, caps, no-new-privileges, read-only, limits read from inside the running container), T-68-25 (both FROM lines and the sidecar pinned; the final Node passes `checkNodeVersion`), T-68-26 (allow-list context; fake secret absent from history, config, export and logs), T-68-27 (loopback publish asserted from `compose config`), T-68-28 (profile off by default, tag plus digest, no ports, re-check date recorded), T-68-29 (state volume pre-created 0700 for 65532; instance id survives `kill -s KILL`) and T-68-SC (`npm ci --ignore-scripts` from the lockfile in a digest-pinned image) are mitigated and tested. The sidecar was never started and no number was registered; only its profile and pin were checked through `docker compose config`.

## Next Phase Readiness

Plan 68-08 can build on `npm run test:container` and on the image layout (`/app/bin.mjs`, `/app/app.mjs`). RELAY-02, RELAY-03 and RELAY-04 are not ticked here; the orchestrator ticks requirements at phase end. CI wiring for the container suite (the research's `relay` job) is not part of this plan.

## Self-Check: PASSED

- Created files found: `relay/Dockerfile`, `.dockerignore`, `relay/compose.yaml`, `relay/test/container/container.test.ts`, `relay/README.md`.
- Commits found: `ba13f9d`, `01c375d` are ancestors of HEAD.
