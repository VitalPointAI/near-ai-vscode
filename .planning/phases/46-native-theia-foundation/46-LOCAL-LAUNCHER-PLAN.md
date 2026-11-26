---
phase: 46-native-theia-foundation
plan: local-launcher
type: execute
wave: 1
depends_on: [46-01, 46-03, 46-06]
files_modified:
  - scripts/launch-local-workbench.mjs
  - workbench/test/local-workbench-launch.test.mjs
autonomous: true
requirements: []
must_haves:
  truths:
    - "The launcher validates the local host, Docker engine and exact release image before creating a volume or starting a container."
    - "A repeat keeps the same owned image and workspace; readiness follows the checked loopback health response."
  artifacts:
    - path: scripts/launch-local-workbench.mjs
      provides: local Workbench first launch and safe retry
  key_links:
    - from: workbench/test/local-workbench-launch.test.mjs
      to: scripts/launch-local-workbench.mjs
      via: injected system, Docker and HTTP observations
---

# Phase 46 local Workbench launcher

<objective>
Give an operator one host-side command to open the same-machine Sterling preview from an approved release digest and retain its workspace through retries. Keep host installation and shared-work setup in their existing separate work.
</objective>

<context>
Use the isolated `feat/theia-local-launcher` worktree at `d28a50124`. The existing Linux amd64 workflow verifies the bundled VSIX, builds the release image, checks image user `10001:0`, starts the image with the two local preview flags and publishes `127.0.0.1::3000`. The published `sterling-image.txt` gives `ghcr.io/vitalpointai/near-ai-vscode@sha256:<digest>`. The entry point opens `/home/sterling/workspace`. The backend's `GET /healthz` returns exactly 200 and body `ok` and does not establish authentication or model readiness. [Release recipe](../../../.github/workflows/release.yml) · [Image](../../../workbench/Dockerfile) · [Startup](../../../workbench/bin/start.mjs) · [Local setup](../../../docs-site/content/using/getting-started.md)

The no-sign-in image includes a terminal. Docker servers below 28.0.0 can expose localhost publications to hosts on the same network segment. This slice trusts an administrator-controlled local rootful Unix daemon with ordinary Linux bridge publication. It makes no claim about isolation from the host administrator, other local processes or custom daemon routing. [Docker port publication](https://docs.docker.com/engine/network/port-publishing/)
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Validate the host and open the exact local release with a persistent workspace</name>
  <files>scripts/launch-local-workbench.mjs, workbench/test/local-workbench-launch.test.mjs</files>
  <read_first>Read release.yml's release target and smoke steps, Workbench Dockerfile, bin/start.mjs, bin/healthcheck.mjs and workbench/test/helpers/docker.ts waitHealthy. Reuse the flags and protocol without importing the test helper's build or cleanup operations.</read_first>
  <behavior>
    - In one injected launcher scenario, an exact preloaded image on a supported daemon starts once. Readiness follows 200 with body ok and a second check of the same running ID and loopback publication. Repeat with the same owned container and named volume. A compatible stopped record can restart by its inspected ID even if it has no live port mapping before restart. A collision or misconfiguration prevents even an optional repair pull.
    - Exercise requirement failures at the same boundary. Unsupported host or daemon architecture, a remote selector, unavailable local engine or an old or unreadable server version must not pull, create, or start. Missing image in normal mode asks for the exact digest. Explicit repair can only request that digest, and a mismatched reinspection must stop before container or volume mutation. Use injected Docker and HTTP ports for every case. Import the CLI without executing its main routine, including when the Workbench runner bundles it into the test entry point.
  </behavior>
  <action>
Check an operator-supplied canonical `--image` release digest, Linux x86-64 host and the supported Node runtime before mutation. State the Node requirement in the invocation/help and how to recognize a missing node executable at the shell. Use the fixed `unix:///var/run/docker.sock` on this host with a socket type check and a fixed Docker `--host` on every call. Refuse ambient host or context selectors inconsistent with this scope, and prevent Docker environment options from selecting a different endpoint. Pass argument arrays without a shell. Distinguish missing Docker CLI, missing or inaccessible socket, unreachable daemon and incompatible daemon from one another. Read and parse the actual server OS, architecture and version before mutating anything. Require Linux amd64 and at least stable 28.0.0, refusing unclear versions. Report a hardware mismatch with the required OS and architecture. Report available memory or storage only when a defensible observation is available and report concrete capacity failures by their actual signal. Do not invent numerical minimums. Installing or upgrading Docker is later platform-specific remediation with a reviewed package source and user authorization.

Before any optional repair pull, look up the stable distinct container and workspace volume names. Verify the dedicated launcher ownership labels, the container's desired-digest label and its `Config.Image` exactly matching the requested immutable reference. A present volume must have the expected ownership, local driver and default options. A present container must have just the expected writable volume at `/home/sterling/workspace`, the released user, entry point and command, the two preview flags, the default bridge mode and no extra mounts, networks or privileged mode. Verify its configured `HostConfig.PortBindings` has only `3000/tcp` published with host IP `127.0.0.1`. A stopped container may have no live mapping. A present container with a missing or mismatched volume, foreign ownership, extra configuration, ambiguous lookup or inconsistent state is a refusal before any mutation.

Inspect the already-loaded image by exact digest. Require the matching repository digest and local image ID, Linux amd64 and `10001:0`. Compare a reusable container's actual image ID with the inspected image ID before start or reuse. By default image acquisition stays local. After resource preflight passes, explicit `--repair` may pull the exact digest once if the image is demonstrably absent; repeat the full image inspection and resource checks before mutation. A supplied digest selects bytes. Signature or provenance verification remains the operator's separate release step. Launch with `--pull=never` and no tag fallback.

Create only the dedicated labeled volume and container if absent. Use the released preview flags and one dynamic `127.0.0.1::3000` publication. Start a compatible stopped container by its verified ID. Preserve the same container, immutable image and named workspace on retry. Older containers and volumes are outside this launcher. No host mounts, Docker socket mounts, deletion, recreation or upgrade. Keep failed owned state available for retry.

For the same inspected running container ID, verify the live port publication has exactly one endpoint `127.0.0.1:<valid-port>` and probe that literal endpoint without a proxy or redirects. Reuse the existing bounded health contract (120-second overall budget and 3-second individual request timeout). After the successful health response, verify the same container ID is still running and its exact live publication still matches. Show the localhost browser URL only after these checks. A timeout or changed publication returns a precise current step for retry and preserves the owned runtime state. The command does not configure credentials, a model, a hub or workstation enrollment. The direct-execution guard must compare the current module URL to the URL for `argv[1]` and require that its basename is exactly `launch-local-workbench.mjs`. The Workbench test bundle is also an entry point, so `import.meta.main` alone is insufficient. No Docker contact, host installation or live launch is part of this development session.
  </action>
  <verify>
    <automated>Under the shared heavy lock and normal memory cap, run pinned Node 26.13.1 node --test workbench/test/local-workbench-launch.test.mjs. Run the tests before source to observe their expected failed behavior, then replay once on the exact implementation. The existing Workbench unit runner already discovers test/*.test.mjs.</automated>
    <fails_when>Readiness precedes verified health, a refused precondition has a side effect, reuse changes the approved image or workspace, or the test uses a real Docker or network port.</fails_when>
  </verify>
  <acceptance_criteria>Exact local release starts in the recording fixture once, reaches checked readiness and safely retries. An explicit repair uses only its already approved digest, and invalid host or existing resources are preserved.</acceptance_criteria>
</task>

</tasks>

<verification>
Use the shared `flock -o "$HOME/.cache/claude-code-tmp/heavy.lock" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300` wrapper. Preserve workflow and release files. Independent review precedes source.
</verification>

<output>
Record the local fixture results separately from any future owner-approved real host validation. This supplement does not change the existing Phase 46 plan sequence or require Gate 2 or editor-to-hub binding.
</output>
