# Phase 47: On-premise deployment stack and offline bundle - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning. Decided on the owner's behalf from the accepted hosting design; nobody could be asked questions during planning. The owner's decisions D1 to D11 and the defaults O2 to O6 (DESIGN.md sections 2 and 14) were accepted on 2026-11-23 and are binding here. Points the design leaves open are decided below with the recommended default and listed at the end under "For the owner to confirm".
**Source:** written by hand from `.planning/research/multiuser-hosting/DESIGN.md` sections 2, 4 to 8, 10, 11 and 14 and `RESEARCH.md` beside it. The GSD ADR ingest (`--ingest ... --ingest-format narrative`) parsed DESIGN.md but found **0 decisions** (the decisions are in tables), so the express path would have fallen back to discuss-phase; the coordinator approved writing this file by hand instead. Also read: the Phase 47 entry in `.planning/ROADMAP.md`, `compliance/README.md` ("Adding a resource"), `compliance/resources.json` and `compliance/schemas/resources.schema.json`, `scripts/resource-check.mjs`, `relay/compose.yaml`, `hub/Dockerfile`, and `.planning/research/multiuser-sync/DESIGN.md` section 10 (the sync hub).

<domain>
## Phase Boundary

Phase 47 makes the Sterling workbench installable and runnable for many people at a site your organization owns, connected or fully air-gapped, from one signed offline bundle. It owns **deployment**: charts and values, realm and policy as code, the offline bundle pipeline, the rebuilt third-party images, the hub on Kubernetes, the compliance fit entries for every new component, and the runbooks. Everything goes under a new top-level `deploy/` folder, except the fit register and its checker (`compliance/resources.json`, `compliance/schemas/resources.schema.json`, `scripts/resource-check.mjs`) and CI workflow jobs.

In scope (DESIGN.md section 8 "Deployment work", section 11 hardening list, sections 4 to 7, section 10 verdicts):
- The per-site stack of section 4: RKE2, Harbor (HQ and large sites) or Zot (small edge sites), HAProxy Kubernetes Ingress, cert-manager with a CA issuer chained to the site's OpenBao PKI intermediate, Keycloak 26.8.x with Postgres, self-hosted Theia Cloud, OpenBao 3-node Raft with HSM auto-unseal (or Shamir), the sync hub, a CSI storage class with encryption at rest, site-local metrics and logs.
- HQ and edge federation through PKI and signed bundles only (section 5).
- The deployment half of identity and key flow (section 6): realm, WebAuthn policy, AAGUID allowlist, OpenBao jwt auth, templated ACLs, Transit keys, Control Groups, enrolment and recovery procedures.
- The deployment half of the session lifecycle (section 7): `sessionsPerUser: 1`, timeouts, idle settings, prewarm pool at 0, persistent workspace volumes, backups.
- Theia Cloud hardening items 1 to 12 (section 11).
- A passing compliance fit entry for every component, image and chart (section 10, D9).

Not in this phase:
- Product code: the Theia extension package, backend JSON-RPC pattern, `OpenBaoKeyStoreService`, `KeyService`, session identity, session sub-keys, hub roster changes, mirror-configurable addresses inside the image, the Sterling image build and its release pipeline (P1 to P11: Phase 46, and P6/P7 with Phase 33). Phase 47 consumes Phase 46's interface (below).
- The load test, measured capacity figures, OSCAL components and evidence rules (Phase 48). Phase 47 records verdicts and conditions in `compliance/resources.json` only.
- Hub-to-hub federation (L5). Until then, HQ and edge hubs exchange sealed bundle files (MUS section 9), which already exist.
- Traefik (O2: HAProxy until Traefik is tested; testing Traefik is Phase 48's verification item, not built here).
- k3s for production (lab and demo kits only, never in the bundle's production profile).
</domain>

<decisions>
## Implementation Decisions

### Accepted owner decisions that bind this phase (owner, 2026-11-23)
- **D-01 (owner, D2):** On-premise only, including fully air-gapped sites. Hosting, sign-in, secrets and session management never depend on the internet. Commercial cloud only for what your organization's signed policy allows (for example an approved model endpoint), never for the stack itself.
- **D-02 (owner, D3):** Hundreds to thousands of concurrent people per site, connected HQ and disconnected edge. Charts are sized by per-site values; no capacity figure is stated until Phase 48 measures it.
- **D-03 (owner, D4):** Self-hosted Eclipse Theia Cloud is the session orchestrator, one session per person (`sessionsPerUser: 1`).
- **D-04 (owner, D5):** OpenBao (MPL-2.0), never HashiCorp Vault (BUSL-1.1). One OpenBao cluster per site, no cross-site replication.
- **D-05 (owner, D6):** Sign-in by hardware security keys or device-bound passkeys only, through Keycloak WebAuthn passwordless. No password or OTP authenticator in any flow. PKI smart cards are an optional hardware flow.
- **D-06 (owner, D9):** Nothing is used until it has a passing entry (`pass` or `pass-with-conditions` with conditions written) in `compliance/resources.json` and `node scripts/resource-check.mjs` passes.
- **D-07 (owner, O2):** HAProxy Kubernetes Ingress is the ingress. ingress-nginx is never used (archived, fit `fail`). Traefik stays out until tested.
- **D-08 (owner, O3):** One shared WebAuthn relying-party ID across sites: a common parent domain set per deployment (`rpId` is a site value, default the parent domain of the site host names). Credential records reach other sites by signed user export.
- **D-09 (owner, O4):** Recovery is administrator-attested re-enrolment that revokes old credentials and re-binds the person's OpenBao entity. No recovery codes where policy says hardware only (the default realm has none at all).
- **D-10 (owner, O5):** Pin Theia Cloud upstream at an assessed release or commit and rebuild it ourselves; fork only if a needed fix cannot land upstream. Never a `-next` pre-release.
- **D-11 (owner, O6):** Workspace volume size and idle timeout are per-site values set after the load test. Until then the chart values carry placeholders that a site must set: `requestedStorage` has no silent 250Mi default (the install check refuses an unset value), and idle values default to the design's Theia Cloud defaults (`timeout` 30 min) marked "provisional until Phase 48".
- **D-12 (owner, D1):** The Sterling image is published by digest. Every image in the bundle is referenced by digest, never by tag alone.

### Site stack and layout
- **D-13:** All deployment sources live under `deploy/`: `deploy/charts/` (vendored upstream chart tarballs, each with its source URL, version and SHA-256 in a lock file `deploy/charts/charts.lock.json`), `deploy/values/` (our values per component, with `site.example.yaml` for per-site settings), `deploy/keycloak/` (realm as code), `deploy/openbao/` (policies, auth, mounts, Transit and PKI as code), `deploy/bundle/` (bundle build, sign, import and check scripts), `deploy/images/` (Containerfiles for rebuilt third-party images), `deploy/hub/` (hub manifests), `deploy/rke2/` (RKE2 config, audit policy, registries), `deploy/runbooks/` (operator runbooks). Exact file names are the planner's; the folder split is fixed.
- **D-14:** RKE2 is the production Kubernetes: FIPS build with Canal, `profile: cis`, the DISA STIG settings applied, a Kubernetes audit policy that records Session, Workspace and AppDefinition records plus Secrets metadata, air-gap install from the bundle's RKE2 image tarball and `registries.yaml` pointing only at the site registry. k3s appears only in a lab profile, never in production values.
- **D-15:** Registry: Harbor at HQ and large sites, Zot at small edge sites. Images enter only by bundle import; signatures are checked at import and again at admission by one admission controller (the research step picks Kyverno or the sigstore policy-controller by fit, air-gap and FIPS; one only).
- **D-16:** Certificates: cert-manager with a `ClusterIssuer` of type CA whose key pair is the site's OpenBao PKI intermediate (issued under the HQ offline root). No ACME issuer exists anywhere in the rendered manifests; Theia Cloud's `letsencrypt-prod` issuer is disabled.
- **D-17:** Storage: one CSI storage class with encryption at rest is a site choice (Longhorn, Ceph or NFS). The bundle ships values for one reference class picked by the research step for fit and air-gap, and the install check refuses a storage class without encryption at rest declared. No secret is stored on a workspace volume.
- **D-18:** Postgres for Keycloak: one site-local Postgres per site, deployment method picked by the research step for fit, air-gap and image provenance (an operator such as CloudNativePG, or a plain StatefulSet on a UBI 9 Postgres image). TLS between Keycloak and Postgres; encryption at rest by the storage class.
- **D-19 (owner, 2026-11-23):** Metrics and logs: Prometheus-compatible metrics, and a log store that is **not** AGPL; Loki is not used. The research step chooses the store against the compliance fit check: a permissive or weak-copyleft licence (Apache-2.0, MIT, MPL-2.0, BSD), runs on-premise and air-gapped on RKE2, and can serve as the AU audit and log store (retention, access control, and tamper-evidence or export to a tamper-evident store). It compares at least OpenSearch (Apache-2.0) and VictoriaLogs (Apache-2.0) as the store and Fluent Bit (Apache-2.0) as the shipper, and records the choice with its fit verdict and conditions in RESEARCH.md and `compliance/resources.json`. Keycloak events, OpenBao audit, Kubernetes audit and registry audit logs go to that site-local store. Tamper-evidence of the audit sink remains gap G2 (a condition on the entry), not solved here.

### Theia Cloud (section 11 hardening list, all 12 items)
- **D-20:** Every image is mirrored into the site registry and referenced by digest: operator, service, conversion webhook, oauth2-proxy, landing page if used, wondershaper only if the bandwidth limiter is on (default off, so not bundled). `imagePullPolicy: IfNotPresent` everywhere (hardening 1).
- **D-21:** The Theia Cloud charts (`theia-cloud-base`, `theia-cloud-crds`, `theia-cloud`) are vendored as tarballs at a pinned version; no Helm repository is fetched at install (hardening 2, 11).
- **D-22:** oauth2-proxy settings: `ssl_insecure_skip_verify=false`, `cookie_secure=true`, a real client secret generated per site and held in a Kubernetes Secret written from OpenBao (never the sample `publicbutoauth2proxywantsasecret`), `pass_access_token=true`, `set_xauthrequest=true`, a pinned current release in place of v7.12.0 (hardening 4, 5). If the chart template cannot express these, we carry a patched template in our values or a small post-render patch, recorded with the reason.
- **D-23:** We rebuild, sign and SBOM the Theia Cloud operator, service and conversion webhook on UBI 9 with a FIPS-capable OpenJDK, and oauth2-proxy with the Go FIPS module (`GOFIPS140`), each from the pinned upstream source commit, in a CI workflow job, signed with your organization's key (no keyless signing), with a CycloneDX SBOM and GitHub artifact attestations (hardening 6).
- **D-24:** Persistence on (`ephemeralStorage: false`), one workspace volume per person on the encrypted storage class, size per site (D-11) (hardening 7).
- **D-25:** `sessionsPerUser: 1`; `timeout` and the activity monitor `notifyAfter` and `timeoutAfter` per site; operator eager start off and the prewarm pool at **0** until Phase 48 shows how a pooled pod gets a person's volume (hardening 8; section 7).
- **D-26:** Kubernetes audit on Session and Workspace records shipped to the site log store (hardening 9; in the RKE2 audit policy, D-14).
- **D-27:** The operator and service RBAC are reviewed for least privilege; any narrowing we apply is in our values and recorded with what upstream grants (hardening 10).
- **D-28:** Keycloak keeps emails unique and immutable for people (realm setting: duplicate emails off, email edit off for users), because session ownership is an email allowlist (hardening 12).
- **D-29:** One AppDefinition for the Sterling image, referenced by digest from Phase 46's release, with the environment Phase 46 needs (see "Interface with Phase 46"). The site's capacity limit is the AppDefinition `maxInstances`; the session start timeout is set so no session waits silently (section 7).

### Keycloak realm as code (section 6)
- **D-30:** One realm per site, as code in `deploy/keycloak/`, imported at install and re-applied on update. Version: a Keycloak 26.8.x release with CVE-2026-6856 fixed; the exact patched version is checked by the research step and pinned; if no fixed release can be confirmed, the entry is `pass-with-conditions` with "fixed version unverified" and Phase 48 closes it.
- **D-31:** Browser flow without a password step: username-less WebAuthn passwordless (or username then WebAuthn passwordless). The WebAuthn Passwordless Policy: user verification `required`, attestation conveyance `direct`, the vendor attestation roots imported into the truststore, **Acceptable AAGUIDs** set to the approved models (a site value list, empty refuses everyone), passkeys enabled only as device-bound (synced passkeys cannot attest and fail the allowlist), `rpId` from D-08. Password, OTP and recovery-code authenticators are removed from every flow and their required actions disabled.
- **D-32:** Optional X.509 smart-card flow as an alternative browser flow, off by default; when a site turns it on, revocation by a local OCSP responder or a scheduled CRL refresh (site value), and the ingress must request and forward client certificates.
- **D-33:** Enrolment: an administrator creates the person with the required action `webauthn-register-passwordless`; the action link goes through the site's own mail server, or the person enrols in person. Two registered keys are required before signing keys are usable: the realm enforces it with a second required registration, and OpenBao's jwt role only issues a token whose claims show two credentials (or, if Keycloak cannot express this as a claim, the runbook check plus a Phase 46 note; research decides which and records it).
- **D-34:** Step-up: the realm defines `acr` levels (Level of Authentication mapping) so a fresh WebAuthn ceremony yields a distinct `acr` and a new `auth_time`; `KeyService` (Phase 46) refuses signing without them. The OIDC client for oauth2-proxy allows `acr_values` and `max_age` requests.
- **D-35:** Events: login and admin events on, stored and shipped to the site log store via an event listener (syslog or JSON log) with retention set per site.
- **D-36:** Federation (section 5): when linked, the edge realm may broker HQ as an OIDC identity provider (off by default). A signed user export carries people and their WebAuthn credential records from one site to another (realm partial export omits users, so the export uses the admin REST API in our bundle scripts; research confirms the credential record fields survive import).

### OpenBao policies as code (section 6)
- **D-37:** 3-node Raft cluster per site (1 node at a small site), TLS from the site PKI, audit device on and shipped to the log store.
- **D-38:** Seal: the `kms-pkcs11` external KMS plugin (openbao-plugins v0.3.0 or newer, pinned by checksum) against the site HSM; **development and CI use SoftHSM2 through PKCS#11**, no hardware HSM required; the real HSM model is a site decision (FIPS 140-3 Level 3 in approved mode is the fit condition). Sites without an HSM use Shamir with the key ceremony runbook.
- **D-39:** Auth: `auth/jwt` bound to the site Keycloak (`oidc_discovery_url` or JWKS from the site's Keycloak, CA from the site PKI), role `sterling-session` with `bound_audiences` set to the oauth2-proxy client, `user_claim=sub`, short token TTL with renewal, and the Keycloak `sub` as the entity alias.
- **D-40:** Mounts and policies: KV v2 at `kv/` with a templated ACL so a person reaches only `kv/data/users/{{identity.entity.id}}/*` (and metadata); Transit at `transit/` with one non-exportable signing key and one key-encryption key per person, created at enrolment by an administrator script (names `<entity-id>-sign` and `<entity-id>-kek` unless Phase 46 states otherwise), templated ACL on `transit/sign/<own>`, `transit/datakey/wrapped/<own-kek>`, `transit/decrypt/<own-kek>`; PKI intermediate at `pki_int/` with roles for ingress TLS (cert-manager) and hub TLS; Control Groups requiring two approvers on Transit key export and import paths used for moving a person between sites.
- **D-41:** Static per-application secrets (oauth2-proxy client secret, hub key files) come from OpenBao into Kubernetes Secrets at install by our scripts (or the OpenBao CSI provider if research shows it is the leaner fit). Per-person secrets are never injected into pods; Phase 46's backend pulls them after sign-in.

### Sync hub on Kubernetes (section 4; MUS 10.1, 10.9)
- **D-42:** Each hub is its own single-replica workload with its own persistent volume (SQLite cannot be shared), several per site, each serving a set of projects (MUS 10.9: 10 projects, 150 people per hub). The design says "a Kubernetes Deployment"; a StatefulSet of one or a Deployment with `strategy: Recreate` and its own PVC both satisfy it; the planner picks one and states why.
- **D-43:** Same hardening as Compose: `runAsUser`/`runAsGroup` 65532, `runAsNonRoot`, `readOnlyRootFilesystem`, all capabilities dropped, `allowPrivilegeEscalation: false`, seccomp `RuntimeDefault`, a memory limit, an `emptyDir` `/tmp` of 16Mi, the health check `/nodejs/bin/node /app/bin.mjs --healthcheck` as liveness and readiness probe. Environment `HUB_HOST`, `HUB_PORT=8443`, `HUB_STATE_DIR=/var/lib/near-ai-hub`, `HUB_PUBLIC_ADDRESS`, and the four `*_FILE` settings pointing at a per-hub Secret mounted read-only with mode 0400 (`HUB_TLS_CERT_FILE`, `HUB_TLS_KEY_FILE`, `HUB_SIGNING_KEY_FILE`, `HUB_ENCRYPTION_KEY_FILE`). The TLS certificate is issued from the site PKI.
- **D-44:** The hub ends TLS itself (MUS 10.1): the ingress passes TCP through (HAProxy TCP mode or a `LoadBalancer`/`NodePort` Service), never terminates. Sessions reach the hub by cluster address.
- **D-45:** The hub image today is `gcr.io/distroless/nodejs26-debian13`, which fails the Protected B row for Debian bases (section 10). Its fit entry is recorded as `pass-with-conditions` with the condition "Protected B needs a UBI 9 base with the OpenSSL FIPS provider on a FIPS host; rebase coordinated with Phase 46 (P11, one Node major)". Phase 47 does not change `hub/Dockerfile`; it consumes whatever image the release publishes, by digest.
- **D-46:** `relay/compose.yaml` keeps working unchanged for single-machine and small installs; the Kubernetes manifests are an addition, not a replacement.

### Offline bundle (sections 5, 8)
- **D-47:** One bundle format for first install and every update: an OCI image layout holding every image (by digest), the vendored chart tarballs, the RKE2 air-gap artifacts, the realm and policy files, the plugin binaries (`kms-pkcs11`), and a manifest listing each item with its digest. The bundle is signed with your organization's key (cosign with a key pair, or our own signature; no keyless signing, which needs the internet). Copy tools (`oras` or `skopeo`) and the signer each get a fit entry; the research step picks the smallest set.
- **D-48:** Import refuses a bundle whose signature or any item digest does not verify, before anything reaches the registry or the cluster. The same check runs at admission (D-15).
- **D-49:** The same signed-file mechanism carries revocation lists, the signed Keycloak user export (D-36) and the PKI intermediate certificate between HQ and edge.

### PKI and federation (section 5)
- **D-50:** HQ holds an offline root CA kept off the network (created in a key ceremony, on an HSM or offline machine). Each site's OpenBao PKI intermediate is signed by that root offline and carried by signed file. No shared database between sites, ever.

### Compliance fit (section 10, D9)
- **D-51:** Every new component, image, chart and build tool gets an entry in `compliance/resources.json` with the section 10 verdict and conditions, and `node scripts/resource-check.mjs` passes. Components covered: RKE2, Harbor, Zot, the admission controller, HAProxy Kubernetes Ingress, cert-manager, Keycloak, Postgres, Theia Cloud operator/service/webhook, oauth2-proxy, OpenBao, the `kms-pkcs11` plugin, SoftHSM2 (test scope only), the storage class, the metrics and log stores, UBI 9 bases, the bundle tools, the sync hub image (re-assessed for Kubernetes, D-45). ingress-nginx, k3s in production and Debian/Alpine bases at Protected B are recorded as decisions in conditions, not adopted.
- **D-52:** The checker today discovers images only in `hub/Dockerfile`, `relay/Dockerfile` and `relay/compose.yaml`, and its schema allows only the kinds `npm`, `image`, `action`, `vendored`. One plan extends `scripts/resource-check.mjs` and `compliance/schemas/resources.schema.json` with a `chart` kind (id prefix `chart:`) discovered from `deploy/charts/charts.lock.json`, and discovers images from `deploy/` (values files' digest-pinned image references and `deploy/images/*/Containerfile` `FROM` lines), failing on any unpinned image there. **The register and the checker are gate files: this plan needs the owner's gate approval before merge.**
- **D-53:** The component id for new entries is a new value per area (for example `deploy-platform`, `deploy-identity`, `deploy-sessions`, `deploy-secrets`); because the checker validates component ids against `compliance/components/*.json`, the plan either reuses an existing component id where honest (`hub` for the hub) or adds minimal component files only if the checker requires them. OSCAL component content and evidence rules are Phase 48, not here.

### Runbooks (section 8)
- **D-54:** Runbooks under `deploy/runbooks/`: site install from the bundle (air-gapped), bundle update, key ceremony (HQ offline root, site intermediate, HSM initialisation or Shamir unseal with key custodians), person enrolment (two keys), administrator-attested re-enrolment and recovery (revoke credentials, re-bind entity, rotate or re-wrap Transit keys), moving a person between sites (Control Group approval), backup and restore (RKE2 etcd snapshots, OpenBao Raft snapshots, Keycloak Postgres backups, workspace volume snapshots, hub SQLite and blob folder per MUS 10.9), and the session states operators see (section 7). Plain words, "your organization", Sterling naming.

### Verification
- **D-55:** A lab end-to-end install on an air-gapped test cluster (no egress route; an egress-deny NetworkPolicy plus a check of the egress logs) from the signed bundle proves success criterion 1. CI can only render and statically check; the full install is a documented, repeatable lab script that runs under the project's memory caps (`systemd-run` MemoryMax, `choom`, `timeout`). The end-to-end sign-in and session run uses Phase 46's image when it is available; until then a placeholder image proves the stack, and the plan records that the Phase 46 run is pending.
- **D-56:** Static checks in CI: render every chart with our values offline (no repository fetch) and assert the hardening invariants on the rendered output (no ACME issuer, no `ingress-nginx`, no image without a digest, no `imagePullPolicy: Always`, oauth2-proxy flags as D-22, `sessionsPerUser: 1`, persistence on, prewarm 0, no password or OTP authenticator in the realm, OpenBao ACLs templated). Tests are added only for these invariants and for the extended resource checker; no tests restate schemas.

### Claude's Discretion
- Exact file names under `deploy/`, script language (Node scripts in the repository's style preferred, no new runtime), and how plans split the work into waves.
- Which of Kyverno or the sigstore policy-controller, which Postgres method, which reference storage class, which non-AGPL log store and shipper (within D-19's criteria), which bundle copy tool: decided by the research step on fit, air-gap, FIPS and footprint, one each, recorded in RESEARCH.md.
</decisions>

<interface_with_phase_46>
## Interface with Phase 46 (assumptions to reconcile)

Phase 46 (native Theia foundation) is being planned at the same time. Phase 47 builds against these assumptions; if Phase 46 states something different, the Phase 46 statement wins and the Phase 47 values change to match.

1. **Image:** the Sterling workbench is one container image published by digest (`<registry>/sterling-workbench@sha256:...`), UBI 9 based, listening on one HTTP port (assumed 3000), running as a non-root uid set in the AppDefinition, with the Theia Cloud activity monitor extension built in. Phase 47 references it only by digest in the AppDefinition and the bundle.
2. **Signed-in person:** the backend reads `THEIACLOUD_SESSION_USER` (set by Theia Cloud) and the forwarded access token from oauth2-proxy (`pass_access_token=true`, `set_xauthrequest=true`; the token arrives on the proxied request as `X-Forwarded-Access-Token`, user and email as `X-Auth-Request-User` and `X-Auth-Request-Email`). The backend checks they name the same person.
3. **OpenBao login:** `auth/jwt` at mount path `jwt`, role `sterling-session`, `bound_audiences` = the oauth2-proxy client id, `user_claim=sub`; the OpenBao address and CA come from environment variables (assumed `BAO_ADDR`, `BAO_CACERT`, `BAO_JWT_ROLE`) set in the AppDefinition.
4. **Secrets path:** `OpenBaoKeyStoreService` reads and writes KV v2 at `kv/users/<entity>/<service>/<account>` (API path `kv/data/users/...`), where `<entity>` is the OpenBao entity id; the ACL template uses `{{identity.entity.id}}`.
5. **Keys:** `KeyService` calls `transit/sign/<person-key>` and `transit/datakey/wrapped/<person-kek>` and `transit/decrypt/<person-kek>`; key names `<entity-id>-sign` and `<entity-id>-kek` unless Phase 46 names them differently. Keys are created by Phase 47's enrolment script, non-exportable.
6. **Step-up:** `KeyService` refuses long-term signing unless the token's `acr` is the realm's step-up level and `auth_time` is within a window Phase 46 sets; the realm (D-34) supplies both claims and accepts `acr_values` / `max_age` re-authentication requests.
7. **Mirrors:** the image takes the registry, Open VSX and model server addresses from environment variables (names Phase 46 defines; Phase 47 sets them in the AppDefinition from site values) and has every update check and telemetry off, so the egress-deny lab check passes.
8. **Hub:** sessions reach the hub by cluster address `https://<hub>.<namespace>.svc:8443`; the hub trust anchors are static per-application values (env or a mounted file) Phase 46 names.

Not assumed: session sub-keys and hub roster changes (P6, P7) are not needed for Phase 47's success criteria.
</interface_with_phase_46>

<canonical_refs>
## Canonical References

- `.planning/research/multiuser-hosting/DESIGN.md` — sections 2 (D1 to D11), 4 (stack), 5 (federation), 6 (identity and keys), 7 (session lifecycle), 8 (deployment work), 10 (fit verdicts), 11 (hardening list), 12 (risks), 14 (O2 to O6)
- `.planning/research/multiuser-hosting/RESEARCH.md` — sections 2 (Theia Cloud air-gap audit), 3 (disconnected operation), 4 (OpenBao), 5 (Keycloak), 7 (fit per candidate)
- `.planning/research/multiuser-sync/DESIGN.md` section 10 — the hub's service design, TLS, scaling, backup and restore
- `compliance/README.md` "Adding a resource"; `compliance/resources.json`; `compliance/schemas/resources.schema.json`; `scripts/resource-check.mjs`
- `relay/compose.yaml` (hub service, hardening, secrets) and `hub/Dockerfile` (image, uid 65532, state directory)
- `.planning/ROADMAP.md` Phase 46, 47, 48 entries
</canonical_refs>

<specifics>
## Specific Ideas

- Requirement IDs DEP-01 to DEP-12 (defined here; ROADMAP references them):
  - **DEP-01** Signed offline bundle: build, sign, import with refusal on any bad signature or digest; one format for install and update; carries images by digest, vendored charts, RKE2 air-gap artifacts, realm and policy as code, plugins.
  - **DEP-02** Site base: RKE2 (FIPS, CIS profile, STIG settings, audit policy incl. Session and Workspace records, registries only the site registry) and the site registry (Harbor or Zot) with signature checks at import and at admission.
  - **DEP-03** Ingress and certificates: HAProxy Kubernetes Ingress; cert-manager CA issuer chained to the site's OpenBao PKI intermediate; no ACME anywhere; TCP passthrough for the hub.
  - **DEP-04** Keycloak realm as code and its Postgres: passwordless WebAuthn only, UV required, attestation direct, AAGUID allowlist, shared rpId, two keys, enrolment action, unique immutable emails, step-up `acr`, events shipped, optional X.509 flow, optional HQ brokering.
  - **DEP-05** OpenBao: Raft cluster, PKCS#11 KMS seal (SoftHSM2 in dev and CI) or Shamir, jwt auth bound to Keycloak, templated per-person KV and Transit ACLs, PKI intermediate and roles, Control Groups for key moves, audit device.
  - **DEP-06** Theia Cloud values: hardening items 1, 2, 3, 4, 5, 7, 8, 10, 11, 12; AppDefinition for the Sterling image by digest; session lifecycle settings (timeouts, idle, prewarm 0, capacity).
  - **DEP-07** Rebuilt images: Theia Cloud operator, service, webhook on UBI 9 FIPS-capable OpenJDK and oauth2-proxy with the Go FIPS module, from pinned commits, signed with your organization's key, CycloneDX SBOM and attestations (hardening 6).
  - **DEP-08** The sync hub on Kubernetes: one workload and volume per hub, several per site, hardening as Compose, per-hub Secret, TLS from the site PKI, TCP passthrough; Compose path unchanged.
  - **DEP-09** HQ and edge federation: offline root and site intermediates by signed file, signed user export and import, revocation lists by signed file, optional brokering; no shared database.
  - **DEP-10** Compliance fit: an entry for every component, image, chart and tool; resource checker extended with the `chart` kind and `deploy/` discovery (gate files, owner approval).
  - **DEP-11** Runbooks: install, update, key ceremony, enrolment, re-enrolment and recovery, moving a person, backup and restore, session states.
  - **DEP-12** Verification: CI render-and-assert of the hardening invariants, and a repeatable air-gapped lab install from the bundle with an egress-deny check; end-to-end sign-in with Phase 46's image when available.
- Session lifecycle mapping (section 7) for deployment: `requested`→`refused` is Theia Cloud refusing at `maxInstances` (the message text "All sessions are in use. Try again in a few minutes, or ask your administrator." is set where Theia Cloud lets us; if the landing page or service cannot be configured, it is recorded as a Phase 46 or upstream item); `starting`→`failed` uses the operator's start timeout; `identity` is Phase 46; `idle-warned`/`stopping` use `notifyAfter`/`timeoutAfter`; `stopped` keeps the volume.
</specifics>

<deferred>
## Deferred Ideas

- Traefik ingress (until tested; Phase 48 verifies).
- Prewarm pool above 0 (until Phase 48 shows volume attach at claim).
- Hub-to-hub live federation (L5).
- Own session broker or a Theia Cloud fork (only if pinning upstream fails, O5).
- Per-session ServiceAccount with `auth/kubernetes` as defence in depth (needs an operator extension; not in the design's must list).
- OSCAL components, evidence rules, load test, capacity figures (Phase 48).
</deferred>

<scope_fence>
## Scope Fence

- No change under `src/`, `media/`, `hub/src/`, `relay/src/` or the Theia extension package (Phase 46 and later).
- No change to `hub/Dockerfile` or `relay/compose.yaml` (D-45, D-46).
- No internet fetch at install or in CI render checks; build-time fetches happen only in the connected bundle build.
- No Loki or other AGPL log store, no ingress-nginx, no HashiCorp Vault, no k3s in production values, no ACME, no password or OTP authenticator.
</scope_fence>

## Success Criteria (from ROADMAP Phase 47)
1. A site installs from one signed offline bundle on air-gapped hardware, and nothing in the running stack calls out.
2. A person signs in with a hardware security key or device-bound passkey, never a password; a lost key is replaced by administrator-attested re-enrolment; two keys are registered per person.
3. Each person gets their own Theia session with a durable workspace volume; idle sessions stop; per-person secrets come from OpenBao, unsealed by an HSM (or Shamir).
4. Theia Cloud runs from images we rebuilt, signed and published with an SBOM, oauth2-proxy defaults fixed, the sign-in token forwarded.
5. HQ and an edge site trust each other through PKI and signed bundles only; the hub runs as a Kubernetes workload, several per site.
6. Every component has a compliance fit entry; key ceremony and recovery runbooks exist.

## Risk Summary
- Theia Cloud project health (bus factor about 3, last stable release 2026-04): pinned, rebuilt, fork only if needed.
- Keycloak CVE-2026-6856 fixed version unverified.
- `kms-pkcs11` plugin young (v0.3.0): tested against SoftHSM2 here; the real HSM is a site test.
- Go FIPS module and HSM certificate numbers unverified (Phase 48 closes).
- Debian-based hub image fails Protected B until rebased (D-45).
- Step-up through the oauth2-proxy sidecar unverified (Phase 46 drives it; the realm supplies the claims).

## For the owner to confirm

Each has the default the plans use.
(Decided by the owner on 2026-11-23 and moved to D-19: a non-AGPL log store, not Loki.)
1. **Gate approval for the resource checker change** (D-52): the plan extending `scripts/resource-check.mjs` and the schema waits on your gate approval at merge.
2. **Admission controller, Postgres method, reference storage class, bundle copy tool:** default: the research step's pick, one each, by fit entry.
3. **Two-key rule enforcement** (D-33): default realm enforcement plus a runbook check; a token claim only if Keycloak can express it.
4. **Refusal message at capacity:** default set where Theia Cloud allows; otherwise recorded as a follow-up.
5. **The parent domain for the shared rpId** (D-08): a site value; no default domain is shipped.
</content>
</invoke>
