---
status: awaiting_human_verify
trigger: "Kubernetes hub probably cannot start: deploy/hub/templates/statefulset.yaml mounts the hub key files with mode 0440; hub/src/secrets.ts refuses any key file group or others can read (found by reading, never run on a cluster)."
created: 2026-11-25T00:00:00Z
updated: 2026-11-25T21:30:00Z
---

## Current Focus

bug_class: Bohrbug (deterministic: every start on a cluster)
hypothesis: CONFIRMED (by render, loader repro and kubelet rules; no cluster run)
next_action: start a hub on the lab-full rig (RKE2 v1.37), record stat of /run/secrets/hub/* in the running pod (0400, uid 65532) and the hub's secrets.loaded line, then close G540

reasoning_checkpoint:
  hypothesis: "The hub cannot start on Kubernetes because the kubelet presents each projected Secret file root-owned with mode 0440 (defaultMode 0440, and fsGroup 65532 forces at least 0440 anyway), and readSecretFile refuses any file whose mode has a group or other bit, so loadSecrets throws on HUB_TLS_CERT and main exits 1."
  confirming_evidence:
    - "helm 4.3.2 render: projected volume defaultMode 0440, fsGroup 65532, runAsUser 65532, files mounted at /run/secrets/hub and named by HUB_*_FILE"
    - "hub/src/secrets.ts: (info.mode & 0o077) !== 0 -> SecretError; repro with the real loader on Node 26.13.1: 0440 refused, 0400 loaded"
    - "kubelet SetVolumeOwnership ORs roMask 0440 into read-only volume files under fsGroup; atomic-writer files are root-owned except serviceAccountToken"
  falsification_test: "A file the kubelet writes for a Secret under fsGroup being owner-only (no group bit), or the loader accepting a 0440 file; either would mean the hub starts."
  fix_rationale: "Kubernetes cannot give uid 65532 an owner-only Secret file (owner is always root; fsGroup always adds group read; KEP-5936 user fields are alpha in 1.37 and leave the fsGroup bits). An init container on the same hub image, running as 65532, copies the files into a memory emptyDir created 0400 and owned by 65532, which satisfies the loader's rule without weakening it."
  blind_spots: "Not run on a real kubelet: the emptyDir's ownership pass runs once at setup (before the init container writes), which I read from kubelet source but did not observe; the hub has never started on the site cluster, so another start problem could follow this one."
  candidate_causes:
    - "config: chart defaultMode 0440 + fsGroup (the chart's own comment chose 0440)"
    - "environment: kubelet Secret volume semantics (root owner, fsGroup group read) that no chart setting overrides"
    - "code: loader's strict owner-only rule (correct for Compose/systemd; not a defect)"
  and_gate: "yes: the failure needs both the kubelet's group-readable Secret files AND the loader's owner-only rule; the loader rule is intended (threat: other local users/groups), so the fix goes on the chart side where the environment can be shaped"

## Symptoms

expected: the hub pod starts and loads its four secret files from /run/secrets/hub
actual: (by reading) the loader refuses each mounted file because group can read it
errors: "HUB_TLS_CERT: the file is readable or writable by group or others; run chmod 600 (or 400) on it."
reproduction: render chart, deploy to a cluster; or load a root:65532 0440 file with the hub loader
started: since the chart was written (never run on a cluster)

## Eliminated

## Evidence

- timestamp: 2026-11-25T00:10:00Z
  checked: helm 4.3.2 (compliance/ci/install-tool.sh helm, sha256 d1c0278d...) render of sterling-hub with deploy/test/fixtures/site.ci.yaml through deploy/bundle/lib/render.mjs
  found: pod securityContext runAsNonRoot true, runAsUser 65532, runAsGroup 65532, fsGroup 65532; volume secrets is projected with defaultMode 0440 from hub-hub-a-tls (tls.crt, tls.key) and hub-hub-a-keys (signing.key, encryption.key), mounted read-only at /run/secrets/hub; HUB_*_FILE point there
  implication: the four secret files are 0440 in the pod

- timestamp: 2026-11-25T00:12:00Z
  checked: hub/src/secrets.ts readSecretFile
  found: fstat on the opened descriptor, refuses (info.mode & 0o077) !== 0 with "readable or writable by group or others"; main.ts loads HUB_SECRETS once at startup and exits 1 on SecretError (hub.start_refused reason secrets)
  implication: any group bit on any of the four files stops the hub before it listens; the first file checked is HUB_TLS_CERT

- timestamp: 2026-11-25T00:15:00Z
  checked: kubelet rules for secret and projected volumes under fsGroup (pkg/volume/volume_linux.go roMask 0440 / rwMask 0660; e2e test comment "setting fsGroup sets mode to at least 440"; Kubernetes projected-volume docs; KEP-5936)
  found: files written by the atomic writer are owned by root; with fsGroup set, SetVolumeOwnership chgrps them to fsGroup and ORs 0440 into the mode of read-only volumes, so defaultMode 0400 still ends as 0440; only projected serviceAccountToken files get the runAsUser as owner; KEP-5936 (user/defaultUser fields for secret, configMap, projected) is alpha in 1.37 (gate off) and does not change the fsGroup group bits; the chart renders for RKE2 v1.37.2
  implication: no defaultMode makes a Secret file owner-only for uid 65532 in this pod: with fsGroup it is root:65532 >=0440 (refused), without fsGroup it is root:root and the hub can read it only with 0444 (refused); fsGroup must stay for the state volume

- timestamp: 2026-11-25T00:16:00Z
  checked: hub/Dockerfile, deploy/bundle/install.mjs, admission policies
  found: hub image is distroless nodejs26 with ENTRYPOINT /nodejs/bin/node, USER 65532; install.mjs already runs the hub image with other args as a Job; Kyverno policies verify initContainers images the same way as containers
  implication: an init container on the same signed hub image, as uid 65532, can stage owner-only copies with node itself, no extra image

- timestamp: 2026-11-25T20:30:00Z
  checked: the real loader (hub/src/secrets.ts on Node 26.13.1) on a 0440 and a 0400 file
  found: 0440 refused "HUB_SIGNING_KEY: the file is readable or writable by group or others; run chmod 600 (or 400) on it."; 0400 loaded
  implication: the bug reproduces with the real loader

- timestamp: 2026-11-25T20:40:00Z
  checked: new render test (deploy/test/render-stateful.test.mjs, G540) against the unchanged chart
  found: RED, "securityContext: comes before initContainers:" (no init container)
  implication: the test fails for the bug's reason before the fix

- timestamp: 2026-11-25T21:00:00Z
  checked: rendered fixed chart parsed with PyYAML
  found: initContainers[0].args == ["-e", <deploy/hub/files/stage-secrets.cjs byte for byte>, /run/secrets/hub-source, /run/secrets/hub]; hub mounts only `secrets` (emptyDir Memory) read-only; `secret-files` projected 0440 mounted only by stage-secrets
  implication: toJson of .Files.Get carries the script exactly

- timestamp: 2026-11-25T21:01:00Z
  checked: container simulation in the hub's pinned build image (node 26.13.1-slim by digest), --network none, --read-only, no-new-privileges; /src laid out as the kubelet's Secret volume (root:65532 0440 behind ..data links), /dst as the memory emptyDir after the fsGroup pass (root:65532 3777); staging and loader run via setpriv as uid/gid 65532 with every capability dropped
  found: loader refuses /src with the exact HUB_TLS_CERT group-or-others message; stage-secrets (run twice) leaves four 65532:65532 0400 regular files; loader as 65532 loads all four from /dst
  implication: the fix works for the hub's user with root-owned group-readable sources; the remaining unknown is only that a real kubelet lays the volumes out this way (read from source, not observed)

## Resolution

root_cause: "AND-gate of two conditions: (1) environment/config: the kubelet writes Secret (and projected Secret) files owned by root and, with fsGroup 65532 set, ORs 0440 into their mode whatever defaultMode says, so the chart's projected volume gave the hub root:65532 0440 files; (2) code (intended): hub/src/secrets.ts refuses any key file with a group or other bit. Together the hub exits 1 at start (hub.start_refused reason secrets) on every Kubernetes start. Kubernetes 1.37 has no way to make a Secret file owner-only for a non-root user (KEP-5936 user fields are alpha and leave the fsGroup bits)."
fix: "Chart side, loader unchanged. deploy/hub/templates/statefulset.yaml adds init container stage-secrets (same hub image, its own Node, pod user 65532, read-only root, no privilege escalation, every capability dropped) that runs deploy/hub/files/stage-secrets.cjs (passed with .Files.Get | toJson) to copy each file of the Secret volume (renamed secret-files, still projected 0440, mounted only in the init container) into a memory emptyDir `secrets` created 0400 and owned by 65532; the hub mounts only `secrets`, read-only, at the same /run/secrets/hub path, so its HUB_*_FILE settings are unchanged. Reruns replace earlier copies."
verification:
  target_test: { result: pass, detail: "deploy/test/render-stateful.test.mjs G540 test red before the fix (no init container), green after; hub/test/secrets.test.ts G540 test green" }
  mutation_check: { result: pass, manual: true, reason_if_skipped: "no Stryker in the repo; seeded by hand", mutant_killed: "stage-secrets.cjs mode 0o400 -> 0o440 failed the hub G540 test ('encryption.key is owner-only'); file restored and compared" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, detail: "the only removal is the hub's direct mount of the Secret volume, replaced by the copies; the loader rule is untouched" }
  adjacent_tests: { result: pass, detail: "deploy suite 269/269, hub lint (tsc) + suite 492/492, compliance suite 614/614, docs roadToProduction 5/5, build-road-to-production --check clean; all capped, one heavy run at a time" }
  revert_reconfirm: { result: pass, detail: "red run on the unchanged chart, green after the chart change with nothing else in between that the failing assertion reached; container simulation shows the old layout refused and the copies loaded" }
  not_run: "a real kubelet (no cluster here); npm run test:container (hub image and Compose service, unchanged by this fix)"
  guardrail_verdict: accepted
  open: "G540 stays open (POA&M g540, milestone Phase 48 lab-full rig) until a hub starts on a real cluster and the pod's file modes and owner are recorded"
oracle_type: specified (the loader's documented owner-only rule and the chart's file paths)
files_changed:
  - deploy/hub/templates/statefulset.yaml
  - deploy/hub/files/stage-secrets.cjs
  - deploy/test/render-stateful.test.mjs
  - hub/test/secrets.test.ts
  - compliance/gaps.json (G540)
  - compliance/poam/g540.json
  - compliance/test/gaps.test.ts (totals 454 / 371)
  - compliance/components/hub.json (cm-06_smt.kubernetes text)
  - compliance/evidence-rules/hub.json (two rules for the G540 tests)
  - docs-site/content/security/road-to-production.md (regenerated)
