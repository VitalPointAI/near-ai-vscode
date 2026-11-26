---
phase: 46-native-theia-foundation
plan: same-machine-guide
type: execute
wave: 5
depends_on: [46-launcher-guide]
files_modified:
  - docs-site/content/using/getting-started.md
autonomous: true
requirements: []
must_haves:
  truths:
    - "A developer can follow the documented path to run the Workbench and an optional hub on the same Linux x86-64 machine."
    - "The hub and Workbench have separate state and health checks, and the guide makes no claim of project pairing."
  artifacts:
    - path: docs-site/content/using/getting-started.md
      provides: Same-machine developer setup using the launcher and the existing hub Compose profile
---

# Run the Workbench and hub on the same machine

<objective>
Give developers one place to find the steps for a local Workbench and a separately running hub. Keep the Workbench usable on its own throughout setup.
</objective>

<tasks>

<task type="auto">
  <name>Document the optional same-machine development path</name>
  <files>docs-site/content/using/getting-started.md</files>
  <read_first>Compare the reviewed launcher branch at `dedd1624f` with `origin/main` at `a1f72d9f`. Read `46-LAUNCHER-GUIDE-SUMMARY.md`, `scripts/launch-local-workbench.mjs`, `relay/compose.yaml`, the hub Compose and health sections of `relay/README.md`, and the required secret list in `hub/src/secrets.ts`. Wait for the launcher PR to land before final validation against the merged base.</read_first>
  <action>
  Add a short development subsection under the optional hub instructions. Reuse the launcher and its exact approved x86-64 image reference. Require an already prepared, approved local hub image under a dedicated development tag and a separate operator-prepared directory with the four required secret files. Link directly to the operator guide's secret-preparation section only.

  Run the documented hub commands from the repository root in an isolated subshell. Unset `DOCKER_CONTEXT`, `DOCKER_HOST`, `DOCKER_TLS`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_API_VERSION` and `DOCKER_DEFAULT_PLATFORM`, then use `docker --host unix:///var/run/docker.sock compose -f relay/compose.yaml -p <dedicated-project> --profile hub` for every hub command. Explicitly export all five settings inside that subshell so inherited values and `.env` cannot select different resources. Set `NEAR_AI_HUB_PUBLISH_ADDRESS=127.0.0.1`, `NEAR_AI_HUB_PUBLIC_ADDRESS=''`, `NEAR_AI_HUB_IMAGE` to the dedicated approved local tag, `NEAR_AI_HUB_PUBLISH_PORT` to an available host port, and `NEAR_AI_HUB_SECRETS_DIR` to the separate absolute directory. Use `up -d --no-build --pull never hub`, `ps hub` and `stop hub` with the same prefix and settings. Reuse the start command for restart.

  Point to the launcher browser address for Workbench readiness and the hub's Compose health status for hub readiness. Keep the launcher workspace separate from the Compose hub-state volume. Explain that this setup runs two independent services. Leave enrollment and editor pairing outside the workflow.
  </action>
  <verify>
    <automated>Once the launcher PR lands, record its exact merged commit in `launcher_merge_sha` and run `git diff --check "$launcher_merge_sha" -- docs-site/content/using/getting-started.md` from the repository root.</automated>
    <manual>Have an independent reviewer trace start, status, stop and restart against the guide, launcher, Compose file, operator guide and secret definitions at the exact merged base. Walk through conflicting inherited Docker selectors and all five hub values, confirming that the documented shell and prefix override them for every command. Check separate images, project, secret files, volumes and readiness outcomes by source inspection. This walkthrough uses no tests, local launches, package or image actions, or secret access or changes.</manual>
    <fails_when>Any hub command can use another daemon, project, image, secret directory or public address through inherited settings, pull or build an image, select the relay, publish beyond loopback, mix health or state, or imply enrollment or editor pairing.</fails_when>
  </verify>
  <done>The guide gives a same-machine path with concrete inputs and independent readiness checks. Independent review records the merged base and verifies the commands match it. Record the docs-only result in the SUMMARY and retain the existing conditions for live setup and pairing.</done>
</task>

</tasks>
