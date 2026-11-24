---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 07
subsystem: deploy
status: complete
tags: [openbao, kms-pkcs11, softhsm2, raft, jwt, transit, control-groups, step-up]
requires: [47-04]
provides:
  - "deploy/images/openbao and openbao-softhsm build definitions (image.json)"
  - "policies sterling-workbench, sterling-workbench-sign, key-move, enrolment, install"
  - "deploy/openbao/apply.mjs (--addr, --ca-file, --token-file, --site, --jwt-pubkey, --dry-run; planApply, applyPlan, openbaoClient)"
  - "deploy/openbao/enrol.mjs (enrol, rebind; enrolPerson, rebindPerson, countPasswordlessKeys)"
  - "deploy/values/openbao.yaml and deploy/values/site.example/openbao.yaml (server.ha.replicas, sterling.seal, sterling.pkcs11.*)"
  - "deploy/test/openbao.test.mjs"
affects: [47-08, 47-12, 47-13, 47-14, 47-16, 47-17, 47-18]
tech-stack:
  added: []
  patterns:
    - "Server configuration rendered with helm tpl from values: the seal stanza only for a pkcs11 site, one retry_join per replica"
    - "apply.mjs reads before it writes and skips what already agrees, so a second run writes nothing"
key-files:
  created:
    - deploy/images/openbao/image.json
    - deploy/images/openbao-softhsm/image.json
    - deploy/openbao/policies/sterling-workbench.hcl
    - deploy/openbao/policies/sterling-workbench-sign.hcl
    - deploy/openbao/policies/key-move.hcl
    - deploy/openbao/policies/enrolment.hcl
    - deploy/openbao/policies/install.hcl
    - deploy/openbao/apply.mjs
    - deploy/openbao/enrol.mjs
    - deploy/values/site.example/openbao.yaml
    - deploy/test/fixtures/openbao-shamir.yaml
    - deploy/test/openbao.test.mjs
  modified:
    - deploy/images/openbao/Containerfile
    - deploy/images/openbao-softhsm/Containerfile
    - deploy/images/README.md
    - deploy/values/openbao.yaml
    - deploy/values/openbao.release.json
key-decisions:
  - "Spike S5 passed: OpenBao 2.7.3 with kms-pkcs11 v0.3.0 auto-unseals from a SoftHSM2 2.7.0 token after a restart with no key entered (Seal Type pkcs11, Recovery Seal Type shamir)"
  - "A template inside a longer path segment (kek-{{identity.entity.id}}, person-{{identity.entity.id}}) works in OpenBao 2.7.3 ACLs (research A13), so enrolment writes no per-person policy"
  - "The audit device is declared in the server configuration: OpenBao 2.7 refuses to enable audit devices through the API"
  - "OpenBao 2.7.3's policy parser rejects controlled_capabilities and self_authorization inside control_group; key-move.hcl uses factor blocks only, and self-approval behaviour is left to the key ceremony lab check"
  - "A control-grouped request without X-Vault-Wrap-TTL answers 200 with no data and no request id to approve; the key-move runbook must send a wrap TTL"
  - "openbao-softhsm builds on the same pinned upstream base as openbao (plugin copied the same way), not on our image, because deploy-images.yml builds every image in parallel from image.json alone"
  - "The SoftHSM2 root key is 32 random bytes imported with softhsm2-util --import-type aes; OpenSC is not needed"
  - "The upstream openbao-ubi 2.7.3 image is RHEL 10.3 based (UBI 10), not UBI 9"
requirements-completed: [DEP-05]
duration: ~1h20m
completed: 2026-11-24
estimate:
  tokens: 90000
  tasks: 3
actuals:
  tokens: 15500
  tasks: 3
  commits: 3
plan_head_before: 3a5e2c5c
plan_head_after: 85f05549
---

# Phase 47 Plan 07: OpenBao as code (seal, policies, enrolment) Summary

**OpenBao 2.7.3 unsealed itself from a SoftHSM2 token through the kms-pkcs11 plugin after a restart; person A read and wrote only their own secrets and key-encryption key while B got 403 on A's paths; only a step-up login with the step-up acr could sign, and that token stopped working after the window; enrolment refuses below two distinct passwordless keys before any OpenBao call.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Spike S5 end to end (tracer): images, seal, policies, apply.mjs | done; tracer gate re-ran apply and the ACL proof end to end before expanding | `9729f9ba` |
| 2. Enrolment two-key gate, re-bind, key-move Control Groups (TDD) | done, 7 tests | `9b5048a0` |
| 3. Cluster values, the full apply, seal invariants | done, 4 more tests | `85f05549` |

## Spike S5

All under the heavy-run lock with podman. The images were built from copies of the two build contexts, with the pins fetched by
`install-tool.sh` (`kms-pkcs11` into `plugins/`, `softhsm2` into `softhsm/`).

```
/openbao/plugins/openbao-plugin-kms-pkcs11  root:root 0755, sha256 96fefa80e721551725ea01be79b0dae0f3951f15f01291fd87846d5e45475be6 (= binSha256 of the pin)
/usr/lib64/softhsm/libsofthsm2.so           root:root (stripped, 886 KB); softhsm2-util --version -> 2.7.0
softhsm2-util --init-token --free --label OpenBao ...      -> The token has been initialized and is reassigned to slot 1819011744
softhsm2-util --import <32 random bytes> --import-type aes --token OpenBao --label bao-root-key --id 01
```

Stanzas that worked (spike config; the production template is `deploy/values/openbao.yaml`):

```hcl
plugin_directory = "/openbao/plugins"
plugin "kms" "pkcs11" {
  command   = "openbao-plugin-kms-pkcs11"
  version   = "v0.3.0"
  sha256sum = "96fefa80e721551725ea01be79b0dae0f3951f15f01291fd87846d5e45475be6"
}
seal "pkcs11" {
  lib         = "/usr/lib64/softhsm/libsofthsm2.so"
  token_label = "OpenBao"
  key_label   = "bao-root-key"
  mechanism   = "AES_GCM"
}
audit "file" "stdout" { options { file_path = "stdout"  log_raw = "false" } }
```

```
log: Auto Seal: pkcs11 (builtin: false, lib: "/usr/lib64/softhsm/libsofthsm2.so", mechanism: "CKM_AES_GCM", ...)
bao operator init -> recovery shares: 5, unseal keys: 0
bao status        -> Seal Type pkcs11, Recovery Seal Type shamir, Initialized true, Sealed false, Version 2.7.3
podman restart s5-bao; bao status -> Sealed false   (no key entered)
bao audit list -detailed -> stdout/  file  file_path=stdout log_raw=false   (declared in the config)
```

### ACL proof (apply.mjs with a test RSA key in jwt_validation_pubkeys; step-up window 20 s in the spike site file)

```
apply.mjs run 1 and run 2 -> 15 unchanged, 0 written (after the comparison fix below)
login A, B (role sterling-workbench)              -> 200, 200; A policies sterling-workbench; ttl 900 s, renewable
A writes and reads kv/data/users/<A>/mail/work    -> 200, 200 (value a-secret)
B reads A's path; B lists A's metadata            -> 403, 403
A reads kv/data/apps/x                            -> 403
A lookup-self, renew-self                         -> 200, 200
A creates transit/keys/person-<A>                 -> 403 (no session creates keys)
A base token signs with person-<A>                -> 403
A datakey/wrapped/kek-<A>, decrypt/kek-<A>        -> 200, 200   (template inside a path segment works: research A13)
B datakey/wrapped/kek-<A>                         -> 403
step-up login with acr "1"                        -> 400 claim "acr" does not match any associated bound claim values
step-up login with acr webauthn-fresh             -> 200; same entity as A: true; policies sterling-workbench, sterling-workbench-sign; ttl 20 s
step-up token signs with person-<A>               -> 200
step-up token signs with person-<B>               -> 403
step-up renew-self (increment 3600)               -> ttl 19 s, explicit_max_ttl 20 s (cannot outlive the window)
step-up token signs after 22 s                    -> 403 permission denied
A revoke-self; A reads after revoke               -> 204; 403
```

### Control Groups

```
key-move operator: POST transit/keys/kek-<A>/config {exportable:true} with X-Vault-Wrap-TTL 10m
  -> 200 with wrap_info (accessor); sys/control-group/request -> approved false, authorizations [], request_path transit/keys/kek-<A>/config
  -> the key stays exportable false
without X-Vault-Wrap-TTL -> 200, data null, wrap_info null (nothing happens and there is no request to approve)
sys/control-group/authorize with the root token -> 500 "empty entity ID" (approvers must be entities, as the design says)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The audit device moved from apply.mjs to the server configuration**
- Found during: Task 1. `sys/audit/stdout` -> 400 "cannot enable audit device via API; use declarative, config-based audit device
  management instead". The `audit "file" "stdout"` stanza is in `deploy/values/openbao.yaml` and proven in the spike. The acceptance line
  "apply.mjs contains an audit device of type file" is met by the values file instead.

**2. [Rule 3 - Blocking] Control group keys OpenBao 2.7.3 rejects**
- `controlled_capabilities` and `self_authorization` inside `control_group` are "invalid key" in 2.7.3. Removed; the factor with
  `approvals = 2` stays. Whether a requester who is also a custodian can approve their own request is a check for the key ceremony lab
  (47-17, 47-18).

**3. [Rule 1 - Bug] apply.mjs was not idempotent on PEM text and durations**
- OpenBao returns durations in seconds and PEM without its last newline, so the second run rewrote three items. Values are compared as
  trimmed strings and the PKI roles' `max_ttl` is in seconds (7776000, 90 days). Both runs then: 15 unchanged.

**4. [Rule 3 - Blocking] SoftHSM2 library path**
- `softhsm2-util` looks for the library at its compiled path; the build now uses `--libdir=/usr/lib64` and `make install-strip`, and the
  library lives at `/usr/lib64/softhsm/libsofthsm2.so`.

**5. [Rule 3 - Blocking] openbao-softhsm does not build on sterling/openbao**
- The CI build job (`deploy-images.yml`) builds each image alone from its `image.json`, with build arguments passed as written, so
  `FROM ${OPENBAO_IMAGE}` cannot name an image the same run is building. `OPENBAO_IMAGE` is the pinned upstream base and the plugin is
  copied in the same way as in `openbao`. README updated.

**6. Sequencing**
- `apply.mjs`'s policy list named `key-move`, `enrolment` and `install` from Task 1 (the spike applied them); their files were committed with
  Tasks 2 and 3. Task 2's tests were written against an `enrol.mjs` already drafted, so there was no separate RED run.

### Settings chosen

- Base session token 15 minutes, renewable to 8 hours; `token_no_default_policy` on both roles (the policies carry the self paths).
- PKI roles `ingress` (subdomains of the site domain) and `hub` (also `sterling-hubs.svc`), EC P-256, 90 days.
- Site example sized for an HQ of about 400 people with sign-in bursts of about 200: 3 nodes, 10Gi Raft volume, 256Mi request and 1Gi
  limit per node (provisional until Phase 48; no capacity is claimed).

## For Phase 46 (unchanged from the plan)

Signing is refused by OpenBao until the workbench logs in again to `sterling-workbench-stepup` with the step-up token and signs with that
short token; this was proven to be the only path to `transit/sign`. Sign is never granted to the base role.

## For the gate follow-up (not changed here)

- The register describes the OpenBao base as UBI; the upstream `openbao-ubi:2.7.3` is RHEL 10.3 (UBI 10). The SoftHSM2 build stage is UBI 9;
  the library runs there (glibc is newer), but a matching UBI 10 build stage would need a new pinned base and register entry.

## Verification

- `deploy/test/openbao.test.mjs` + `deploy/test/render.test.mjs` with the pinned helm, under the memory cap: 18 run, 18 pass (11 of them added
  by this plan, all in openbao.test.mjs).
- `node scripts/resource-check.mjs`: passed, 123 resources.
- `node deploy/openbao/enrol.mjs --help` lists `enrol` and `rebind`; `key-move.hcl` contains `control_group` and `approvals = 2`.

## Threat Flags

None beyond the plan's threat model.

## Known Stubs

None. The site example's `pkcs11.lib` is an example path; the site's HSM library and volume are a site decision (D-38).

## Self-Check: PASSED

- All 12 created files exist; commits `9729f9ba`, `9b5048a0`, `85f05549` are ancestors of HEAD.
