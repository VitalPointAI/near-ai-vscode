# Scaling the Theia 1.77 workbench to thousands of users, on-premise and air-gapped

Research date: 2026-11-23. Scope: research only, no code changes. Owner constraints applied as they arrived: (1) on-premise only, customer hardware, air-gapped sites; commercial cloud never a dependency of hosting, sign-in, secrets or orchestration; (2) self-hosted Eclipse Theia Cloud approved as the primary session orchestrator; (3) sign-in by passkeys or hardware keys only, no passwords.
Marking: **[verified]** = read in source or official docs during this research; **[unverified]** = inference or not confirmed.

Repo signals (GitHub API, 2026-11-23):

| Project | Licence | Stars | Latest release | Notes |
|---|---|---|---|---|
| eclipse-theia/theia | EPL-2.0 | 21.8k | v1.77.0, 2026-11-05 | |
| eclipse-theia/theia-cloud | EPL-2.0 | 101 | 1.2.0, 2026-04-09 (1.1.2 2025-09, 1.0.0 2024-11) | last commit 2026-11-20; main = 1.3.0-next |
| eclipse-theia/theia-cloud-helm | EPL-2.0 | n/a | charts 1.3.0-next.x on main | |
| EduIDE/EduIDE-Cloud (TUM fork/derivative) | EPL-2.0 | 2 | v3.0.4, 2026-11-18 | |
| eclipse-che/che | EPL-2.0 | 7.2k | 7.125.0, 2026-11-19 | |
| coder/coder | **AGPL-3.0** (+ commercial premium) | 17.5k | v2.38.10, 2026-11-16 | flag |
| gitpod-io/gitpod | **AGPL-3.0** | 13.8k | last release 2023-06 | self-hosted discontinued; not viable |
| hashicorp/vault | **BUSL-1.1** (API shows NOASSERTION) | 36.6k | v2.2.2, 2026-11-12 | flag |
| openbao/openbao | MPL-2.0 | 9.2k | v2.7.3, 2026-11-19 (2.7.0 on 2026-09-23) | |
| openbao/openbao-helm | MPL-2.0 | 124 | openbao-0.30.8, 2026-11-19 | |
| openbao/openbao-csi-provider | MPL-2.0 | 25 | v2.0.3, 2026-07-29 | |
| openbao/openbao-k8s (agent injector) | MPL-2.0 | 28 | no GitHub releases | |
| openbao/openbao-plugins | MPL-2.0 | 69 | kms-pkcs11-v0.3.0, 2026-11-03 | |
| keycloak/keycloak | Apache-2.0 | 38.0k | 26.8.2, 2026-11-05 | CNCF |
| k3s-io/k3s | Apache-2.0 | 34.5k | v1.37.2+k3s1, 2026-11-03 | CNCF |
| rancher/rke2 | Apache-2.0 | 2.4k | v1.37.2+rke2r1, 2026-11-05 | |
| oauth2-proxy/oauth2-proxy | MIT | 15.4k | v7.15.6, 2026-11-05 | Theia Cloud pins v7.12.0 |
| cert-manager/cert-manager | Apache-2.0 | 14.2k | v1.21.3, 2026-10-23 | |
| jupyterhub/kubespawner | BSD-3-Clause | 611 | (tags only) | reference design |

---

## 1. Can one Theia backend serve many users? No.

- A Theia backend is single-user by design. Maintainers say it is not multi-tenant: settings, workspace, terminals, tasks, plugin hosts and the filesystem all run as one OS user, and state leaks between users. Example: one user's theme change applied to everyone on a shared instance. Sources: https://github.com/eclipse-theia/theia/discussions/13022, https://github.com/eclipse-theia/theia/discussions/7719, https://github.com/eclipse-theia/theia/discussions/9845 **[verified via search summaries]**.
- The plugin host runs per frontend connection, but every plugin host shares the backend's filesystem, process user and secrets. Terminals and AI agent tool calls run as the container user, so nothing isolates one user's processes from another's **[verified for the design, from the discussions above; implementation detail unverified]**.
- `KeyStoreService` is bound once per backend (`packages/core/src/node/backend-application-module.ts`, `bind(KeyStoreService).to(KeyStoreServiceImpl).inSingletonScope()`), so secrets are backend-wide, not per user **[verified]**.
- Conclusion: scale by giving each user their own backend (one container or pod per user session). That is what Theia Cloud, Che and EduIDE all do. Today's model ("one install = one person") is already right; the product needs a per-user session orchestrator, not a multi-tenant backend.

## 2. Primary option: self-hosted Eclipse Theia Cloud

### Design [verified from repo docs and source]
- A Java operator (fabric8) watches three CRDs. `AppDefinition` sets the image, uid, port, CPU and memory requests and limits, `minInstances`/`maxInstances`, `timeout`, `mountPath`, and a `monitor.activityTracker` with `timeoutAfter`/`notifyAfter`. `Workspace` is the user plus app definition plus storage, i.e. a PVC. `Session` carries the user, workspace, `envVars`, `envVarsFromConfigMaps`, `envVarsFromSecrets` and `lastActivity`. Source: `documentation/Architecture.md` and `AppDefinitionV1beta9Spec.java`, `SessionV1beta7Spec.java`.
- A Theia Cloud Service (Java REST API) creates and stops sessions and workspaces for authenticated users. A landing page (optional) sits on top of it.
- Per session, the operator creates a Deployment whose pod holds the Theia container plus an **oauth2-proxy sidecar**, along with a Service and an ingress rule. Ownership is enforced by `--authenticated-emails-file` (a per-session ConfigMap holding the owner's email) and `--skip-auth-route=/monitor/*`. The user is passed into the container as the env var `THEIACLOUD_SESSION_USER` (source: `templateDeployment.yaml`).
- Operator flags include `--keycloak`, `--sessionsPerUser`, `--bandwidthLimiter` and `--eagerStart`. Architecture.md lists `--eagerStart` as "not fully supported at the moment", though the helm chart exposes `operator.eagerStart` and EduIDE documents a working prewarm pool (https://eduide.github.io/Docs/developer/platform/session-prewarming).
- Durable volumes: one workspace PVC per Workspace on the configured `storageClassName`, `requestedStorage` defaulting to 250Mi. The landing page defaults to `ephemeralStorage: true`, so persistence has to be turned on.
- Idle handling: an app-definition `timeout` (default 30 min) plus the activity-tracker monitor (a VS Code extension or Theia extension inside the image) that reports activity and stops idle sessions.

### Air-gap audit [verified by reading theia-cloud and theia-cloud-helm main, 2026-11-20 commit]
- **Telemetry or phone-home:** none found in the operator, service or monitor. The only "telemetry" hit is the monitor listening to `onDidChangeTelemetryEnabled` as an activity signal. The landing page contains only user-clickable links (theia-cloud.io, GitHub issues). No licence check exists (EPL-2.0).
- **Images to mirror** (Docker Hub `theiacloud/*` and quay.io): `theia-cloud-operator`, `theia-cloud-service`, `theia-cloud-landing-page`, `theia-cloud-conversion-webhook`, `theia-cloud-wondershaper` (only if that limiter is used), and `quay.io/oauth2-proxy/oauth2-proxy:v7.12.0`. The chart has explicit override values for these ("Override this to pull from a private registry in air-gapped or corporate networks"). Also mirror Keycloak, cert-manager, the ingress controller, OpenBao, and our workbench image. Note: chart defaults `imagePullPolicy: Always`; set it to `IfNotPresent` or point it at the mirror.
- **Charts:** helm repo `eclipse-theia.github.io/theia-cloud-helm`. Vendor the chart tarballs into an internal OCI or helm repo, or into Git for Argo CD/Flux.
- **TLS:** the `theia-cloud-base` chart defaults to a **Let's Encrypt ACME** ClusterIssuer (`letsencrypt-prod`, `issuer.email`) and uses the http01 solver. That needs internet, so disable it and use the chart's `clusterissuer-for-ca` or self-signed issuer, backed by the organization CA (ideally an OpenBao PKI intermediate).
- **Accreditation findings in default config:** the oauth2-proxy config template sets `ssl_insecure_skip_verify=true` (no TLS verification to Keycloak) and `cookie_secure="false"`, and the sample `clientSecret` is the public string "publicbutoauth2proxywantsasecret". All three must be overridden or patched for any accredited deployment. The template does not set `pass_access_token`/`set_xauthrequest`, so the Theia container gets the user identity only as an env var and never receives a token. That matters for per-user secrets (section 4).
- **Inside the workbench image (our responsibility):** Theia's Open VSX plugin registry URL, the Theia AI provider endpoints and any extension update checks must point at internal mirrors or be disabled. Theia Cloud has no control over these.
- **Keycloak** is the only supported identity provider (oauth2-proxy `keycloak-oidc` provider). It runs on-prem with no outbound calls required (see section 3).

### Maturity, governance and risk [verified numbers; judgement marked]
- Eclipse Foundation project (EPL-2.0, vendor-neutral IP). Contributors are concentrated: jfaltermeier 199 commits, lucas-koehler 96, sgraband 75, martin-fleck-at 22, then fewer than 10 each. The leading contributors appear to be EclipseSource staff **[unverified affiliation]**. **Bus factor is about 3.**
- The README promises a release every three months, but the last stable release is 1.2.0 from April 2026, seven months ago. Main is 1.3.0-next. Each commit publishes a `-next` pre-release, so we would pin to a release or to our own build.
- Adopters: TUM's Artemis/EduIDE runs it in university production (theia.artemis.cit.tum.de) and maintains a derivative, EduIDE-Cloud (https://eduide.github.io/Docs/admins/intro). EclipseSource offers commercial support **[unverified scope]**. The GitHub "Used by" list is empty.
- **No published scale numbers.** The closest are EduIDE sizing examples (a 300-student cohort at 2000M per session is about 600 Gi of memory requests) and a TUM scale-test project for "hundreds of concurrent IDE instances" (https://eduide.github.io/Docs/developer/projects/theia-scale-tests, TUM 2025 load-testing thesis). **Nobody has publicly shown 1000+ concurrent sessions on Theia Cloud.** We must load-test ourselves.
- Scaling concerns to test **[unverified]**: (a) the operator is a single Java controller, so check reconcile throughput when 500+ sessions start in a burst; (b) session ingress rules are added to one shared Ingress object (`ingressname`), and thousands of rules in one object may hit etcd object-size limits (around 1.5 MiB) and slow controller reloads; (c) each session adds a Deployment, Service and ConfigMap, adding etcd load (Che reports 6,000 DevWorkspaces used about 2.5 GB of etcd).
- **Mitigation for the dependency risk:** the codebase is small (a Java operator library plus a default operator and an `oauth2-proxy` sidecar pattern) and designed to be extended. Forking or vendoring is feasible, and we can stay on the CRD contract.
- **Eager start and per-user secrets conflict [inference]:** prewarmed pool pods start before a user is known, so per-user env, secrets and volumes cannot be in the pod spec. Secrets must be fetched by the backend after the session is claimed, which favours a pull model (section 4).

### Alternatives (comparison)
| | Theia Cloud | Eclipse Che / Red Hat Dev Spaces | Coder |
|---|---|---|---|
| Licence | EPL-2.0 | EPL-2.0 (Dev Spaces is a Red Hat subscription) | **AGPL-3.0** core plus commercial premium (SSO groups, quotas, HA, etc.) |
| Runs Theia | Yes, built for Theia products | Not the default since 2022 (Che-Code, a VS Code fork); Theia possible as a custom editor **[unverified effort]** | Any container via Terraform templates |
| Air gap | Yes, with the mirroring and ACME/TLS fixes above | Documented "restricted environment" install with `prepare-restricted-environment.sh` image mirroring and GitOps (https://eclipse.dev/che/docs/next/install/proc_installing-che-in-a-restricted-environment/). Woopra telemetry plugin is optional **[default state unverified]** | Documented (https://coder.com/docs/install/airgap). Telemetry is **on by default** (`CODER_TELEMETRY_ENABLE=false`), plus `CODER_UPDATE_CHECK=false` and `CODER_DISABLE_TEMPLATE_BUILDER=true`. Licence keys are validated offline. The AI Governance add-on reports usage by default |
| Scale evidence | None published | Red Hat Developer Sandbox runs several clusters behind a redirector. One Che per cluster. Guidance: no more than about 10k namespaces, etcd 8 GB max (https://eclipse.dev/che/docs/next/install/running-at-scale/) | Vendor claims of large enterprise deployments **[unverified]** |
| Weight | Light (operator, service, oauth2-proxy) | Heavy (OLM, DevWorkspace operator, a namespace per user, dashboard, gateway) | Medium (Go server and Postgres; provisioners) |
| Risk | Small team, slipping releases | Red Hat-driven, monthly releases, large community; editor mismatch | AGPL; premium features needed at enterprise scale |

## 3. Disconnected operation (edge sites)

- **Kubernetes distribution:** RKE2 (Apache-2.0) is the stronger fit for defence. It is designed for FIPS 140-2 and CIS/DISA STIG compliance **[from RKE2 docs; not re-verified today]**, has a documented air-gap install (image tarball or private registry via `registries.yaml`), and ships embedded etcd and containerd. k3s (Apache-2.0) is lighter (single binary; can use SQLite or embedded etcd) for very small sites. Both support air-gap tarball installs (https://docs.rke2.io/install/airgap, https://docs.k3s.io/installation/airgap **[URLs not fetched today]**).
- **Edge footprint estimate [inference]:** 3 control-plane/etcd nodes (or 1 at a small site), 1 OpenBao node per control node (Raft), 1 to 3 Keycloak replicas with Postgres, and the sync hub. Workers are sized at about 1 to 2 GiB RAM and 0.25 to 1 vCPU per active session (more for AI agents running local tools). 50 concurrent users ≈ 100 GiB plus platform overhead of about 16 to 24 GiB.
- **Image mirroring:** a private OCI registry at each site (Harbor, Apache-2.0, or the distribution registry). Images move from HQ by signed bundle (for example `oras`/`skopeo copy` to an OCI layout on media), verified with cosign or our own signature before import. Charts go in the same bundle.
- **Keycloak offline:** Keycloak needs no internet. Run one Keycloak (and realm) per site with its own Postgres. Keycloak's multi-site mode (two sites sharing a database or Infinispan) needs low-latency links, so it is not suitable for edge. For HQ federation use one of:
  (a) identity brokering: the edge realm trusts HQ as an OIDC IdP when connected, while local users and credentials keep working when disconnected;
  (b) periodic signed user and credential export from HQ, imported at the edge (realm partial export does not include users; use the admin REST API or a user-storage SPI) **[unverified detail]**.
- **Theia Cloud at the edge:** the same chart with the same mirrored images and a CA issuer. No extra dependencies.

## 4. Secrets and KMS, on-premise only

**Recommendation: OpenBao** (MPL-2.0, Linux Foundation/OpenSSF, about 9.2k stars, frequent releases). HashiCorp Vault is BUSL-1.1, so flag it and avoid it. Cloud KMS is excluded unless policy allows.

- **HSM auto-unseal [verified]:** the PKCS#11 seal arrived in 2.2.2 (2025-05) and KMIP auto-unseal in 2.3.1 (2025-06). **In 2.7.0 the PKCS#11 seal was moved out to an external KMS plugin** (`openbao-plugins`, `kms-pkcs11-v0.3.0`, 2026-11-03), and the separate HSM build was discontinued. Vendor guides exist for Utimaco, Nitrokey NetHSM (open source), Securosys and DuoKey (https://openbao.org/docs/configuration/seal/pkcs11/, https://openbao.org/community/release-notes/2-7-0/). Shamir unseal remains the fallback for sites without an HSM, using a key-ceremony runbook.
- **2.7.0 features relevant to us [verified]:** "External Keys", so Transit and PKI can operate on keys kept in a KMS or HSM plugin without storing them in OpenBao; **ML-DSA** (FIPS 204) in Transit and PKI; post-quantum TLS; Control Groups (two-person approval on a path); and PostgreSQL read scalability. Namespaces shipped in 2.3.1 (2025-06), so each organization or site can get its own namespace.
- **HA and scale:** integrated Raft storage, standby nodes serving reads since 2.5 (https://openbao.org/blog/improved-horizontal-scalability/). **No cross-cluster replication** (Vault Enterprise's performance and DR replication have no OpenBao equivalent; the openbao-operator lists multi-cluster replication as a non-goal). So **each site runs an independent OpenBao cluster.** HQ↔edge federation happens at the application and PKI level, not by replication:
  - HQ holds an offline root CA. Each site's OpenBao PKI is an intermediate cross-signed by HQ, so certificates and signatures from an edge site verify at HQ and vice versa with no live link.
  - Per-user keys are "homed" at one site. Moving a user exports a wrapped key under Transit's BYOK import/export and a two-person Control Group approval **[design inference]**.
- **Per-user keys with Transit [verified capability; design inference]:**
  - **Signing keys:** a Transit key per user (`ed25519`/`ecdsa-p256`, ML-DSA as an option), marked non-exportable. The workbench calls `transit/sign/<user>`, so the private key never enters the Theia pod. This fits the signed replication log, but needs the sync hub to accept signatures produced by the key service.
  - **Per-cell encryption keys:** envelope encryption. Use `transit/datakey/wrapped/<user-or-cell-kek>` to get a DEK, keep only the wrapped DEK next to the cell, and unwrap it by calling `transit/decrypt`. Rotation is `transit/keys/<k>/rotate` plus `rewrap`.
  - **Policy:** a templated ACL such as `path "transit/sign/{{identity.entity.name}}"`, so a user can use only their own keys.
- **How a session authenticates to OpenBao as the user:**
  1. Preferred: the user's Keycloak access token reaches the workbench backend (needs oauth2-proxy `pass_access_token=true`/`set_xauthrequest=true` in the Theia Cloud oauth2-proxy config, not in the default template). The backend logs in to OpenBao with **auth/jwt** (OIDC/JWT role, `bound_audiences`, `user_claim=sub`) and gets a short-lived token whose entity is the person.
  2. Defence in depth: also require the pod identity, using **auth/kubernetes** with a per-session ServiceAccount. Theia Cloud uses a shared one, so this would need an operator extension **[unverified]**.
  3. Injection options: the openbao-k8s agent injector (sidecar) or openbao-csi-provider (volume) work for **static, per-app** secrets (model API keys, sync hub client certificates). They suit eager/prewarmed pods poorly, because per-user identity arrives after the pod starts. Use the backend pull model for per-user keys.
- **Theia integration point [verified in Theia source]:**
  - `KeyStoreService` (`packages/core/src/common/key-store.ts`; methods `setPassword/getPassword/deletePassword/findPassword/findCredentials/keys`) is the backend RPC service at `/services/keyStore`. `KeyStoreServiceImpl` uses keytar (OS keyring), which is not available in a headless container.
  - The browser `CredentialsService` wraps it, and plugin `SecretStorage` (`packages/plugin-ext/src/main/browser/secrets-main.ts`) goes through `CredentialsService`. Theia AI packages (ai-mcp, ai-copilot, ai-chatgpt credential stores) also use `KeyStoreService`.
  - **One backend contribution, `rebind(KeyStoreService).to(OpenBaoKeyStoreService)`, moves every extension secret and every Theia AI credential to OpenBao KV v2** at `kv/users/<entity>/<service>/<account>`, durable and per user.
  - Signing and per-cell keys should **not** go through KeyStoreService as exported secrets. Add a small backend `KeyService` that calls Transit sign, datakey and decrypt.
  - On a desktop or single-node install, the same interface can fall back to keytar/OS keyring (the owner's sidecar preference).

## 5. Sign-in: passkeys and hardware keys only (Keycloak, on-prem)

- **Passkeys and FIDO2 [verified]:** Keycloak has WebAuthn passwordless authentication. Passkeys (including conditional/autofill UI) have been officially supported since **26.4** (https://www.keycloak.org/2025/09/passkeys-support-26-4). Enable them in the "WebAuthn Passwordless Policy" ("Enable Passkeys" is off by default). Build a browser flow without a password step (username-less passkey login, or username then WebAuthn-passwordless). Set user verification to `required` (PIN or biometric on the key).
- **Hardware-key-only policy offline [verified]:** set attestation conveyance to `direct`, import the vendor attestation root CAs (for example Yubico's FIDO root) into the Keycloak truststore, and set **"Acceptable AAGUIDs"** to the approved models. **Keycloak does not fetch the FIDO MDS online.** Its `WebAuthnMetadataService` reads a bundled `keycloak-webauthn-metadata.json` derived from passkey-authenticator-aaguids, used for display names (source read). So it works air-gapped as-is. For MDS3-grade checks, extract the approved authenticators' roots from an MDS blob downloaded on the connected side and import them.
  - **Caveat:** CVE-2026-6856 (Red Hat Bugzilla), an AAGUID-allowlist bypass when the authenticator returns self-attestation without x5c, affects RHBK 26.4 and Keycloak 26.6 with a patch in progress. Earlier: CVE-2025-12150 (attestation verification bypass). Pin a patched 26.8.x and verify **[fix version unverified]**.
  - Synced passkeys (phone or cloud) can't produce attestation and won't match a hardware AAGUID allowlist. A defence policy of "hardware keys only" is enforceable this way; "passkeys" would then mean device-bound passkeys only.
- **PKI smart cards (PIV/CAC-style) [verified]:** Keycloak's X.509 client certificate authenticator checks revocation by CRL file (works offline; "CRL abort if non updated" option), CRL distribution point or OCSP; checks key usage and extended key usage; and maps the certificate (for example SAN UPN or subject) to a user. Caveats: large CRLs are slow and memory-heavy and are not auto-refreshed (RHBK-2080), so run a local OCSP responder at the site or refresh CRLs on a schedule. The ingress must request client certificates and forward them, and Keycloak must be configured with the matching `x509cert-lookup` provider (nginx, haproxy, envoy, etc.). Card middleware must be on the client OS. It can be combined with WebAuthn as an alternative flow.
- **Enrolment and recovery without passwords [partly verified]:**
  - Enrolment: an admin creates the user with the required action `webauthn-register-passwordless` and sends "execute actions" through the site's internal SMTP; the link is a time-limited action token. An admin-generated link without email needs a small extension **[unverified that none exists natively]**. For a stronger option, enrol in person with the card (X.509) and then register the security key.
  - Policy: require **two registered keys** per user (primary and backup) before access to signing keys.
  - Recovery: an admin-attested re-enrolment that revokes the old credentials and also rotates or re-wraps the user's OpenBao entity bindings. Avoid recovery codes if the policy is "hardware only".
- **Binding to the product's device identity and keys [design]:**
  - Keycloak `sub` maps to the OpenBao entity (jwt auth alias), which owns the user's Transit signing and KEK keys.
  - The session backend gets an OpenBao token only from a fresh WebAuthn-authenticated Keycloak token. Require Keycloak's `acr`/LoA step-up for signing, since `acr` values per flow are configurable.
  - Today's per-install device identity becomes a per-session or per-device sub-key, certified by the user's long-term key. The sync hub verifies the chain from user key to device key.
  - **RP ID:** WebAuthn credentials are bound to the RP ID (the domain). For a key to work at both HQ and the edge, the sites must share an RP ID (a common parent domain), and the user's WebAuthn public-key credential records must exist in each site's Keycloak (replicated by signed export). Otherwise each site needs separate registration.
- **Theia Cloud limitations for these flows [verified from chart; impact inferred]:** none block WebAuthn, because the ceremony happens on Keycloak's pages and oauth2-proxy only does the OIDC code flow. Limitations:
  1. the token is not passed to the workbench by default;
  2. insecure defaults (`ssl_insecure_skip_verify`, `cookie_secure=false`);
  3. no step-up or re-authentication hook; the workbench must trigger an OIDC re-auth with `acr_values`/`max_age` itself;
  4. X.509 needs ingress-level client-certificate handling, which the Theia Cloud chart does not configure;
  5. session access is by email allowlist, so emails must be unique and immutable in Keycloak.

## 6. Recommended reference architecture

Per site (HQ and each edge site alike; connected and disconnected are the same stack):
- **RKE2** (k3s for tiny sites), air-gap installed from a signed bundle; a site-local **OCI registry** (Harbor).
- **Ingress:** HAProxy Kubernetes Ingress, which is Theia Cloud's default controller (`ingress.controller: haproxy`). Alternatively, RKE2's FIPS-built Traefik with `controller: null` and explicit annotations **[unverified with Theia Cloud]**. Do **not** use ingress-nginx: the repo has been archived since its final release in 2026-03 (see section 7). Pair the ingress with **cert-manager** with a CA issuer chained to the site's **OpenBao PKI** intermediate (HQ offline root). No ACME.
- **Keycloak 26.8.x** with Postgres: WebAuthn passwordless, attested hardware keys, AAGUID allowlist, X.509 smart-card flow, no passwords; HQ brokering when connected.
- **Theia Cloud** (pinned release or our build): one AppDefinition for the workbench image. Each session gets its own pod (Theia plus oauth2-proxy with `pass_access_token`, TLS verification on, secure cookies), a workspace PVC on a CSI storage class (Longhorn/Ceph/NFS), an idle timeout through the monitor, and an optional prewarm pool.
- **OpenBao** 3-node Raft cluster with HSM auto-unseal (PKCS#11 KMS plugin) or Shamir. Namespaces per organization. KV v2 for extension secrets, Transit for per-user signing and KEKs, PKI for TLS and device certificates, jwt auth bound to Keycloak.
- **Sync hub** (existing): signed replication log. Store-and-forward to HQ when links are up, and merge on reconnect (Yjs CRDT plus a signed log). Trust is PKI-based, so it needs no live HQ call.
- Monitoring and logging (Prometheus/Loki, Apache-2.0/AGPL; check Loki's AGPL) are site-local.

**Product changes (backend contributions):**
1. an `OpenBaoKeyStoreService` that rebinds `KeyStoreService` (all SecretStorage and Theia AI credentials go to per-user KV);
2. a `KeyService` for Transit sign, datakey and decrypt (signing keys never leave OpenBao), with a desktop fallback to the OS keyring;
3. a session-identity contribution that reads the forwarded Keycloak token and `THEIACLOUD_SESSION_USER`, logs in to OpenBao through jwt auth, renews the token, and triggers step-up re-auth for signing;
4. device-key certification by the user key for the sync hub;
5. registry, Open VSX and model endpoint URLs configurable to internal mirrors, with all update checks and telemetry off.

**Deployment-only changes:**
- the helm values overrides listed above (mirrored images, CA issuer, persistent storage, oauth2-proxy hardening);
- Keycloak realm-as-code;
- OpenBao policies-as-code;
- the signed offline bundle pipeline;
- load testing to 1,000+ sessions on our own hardware before committing to a capacity figure.

**Fallback if Theia Cloud fails an air-gap or accreditation check:**
- **Own broker:** a small operator or session broker on stock Kubernetes, modelled on JupyterHub's KubeSpawner (BSD-3-Clause; spawner, proxy and idle-culler design). It needs: an authenticated create/stop API, a Deployment plus Service plus PVC per user, routing (Gateway API or configurable-http-proxy), an idle culler, and oauth2-proxy or the broker itself enforcing ownership. Estimate **about 2 to 4k lines of code plus Helm, 4 to 8 engineer-weeks** to reach Theia Cloud's feature level **[estimate]**, and then we own it entirely. Forking Theia Cloud's EPL operator library is the cheaper path to the same result.
- **Small edge sites without Kubernetes:** Podman or Docker with the same broker driving the container API, Caddy/Traefik for routing, systemd for supervision, and a single OpenBao node with Shamir or HSM unseal. Good for up to a few dozen users per host **[estimate]**.

## 7. Compliance fit of each candidate

Target: the ITSG-33 / ITSP.10.033 Medium profile (Protected A and B), the ITSP.10.171 overlay, CPCSC Level 1, and the Controlled Goods (CGP) and ITAR overlays (repo `compliance/levels.json`). Today the product's components are extension, model-endpoints, relay, hub and release-pipeline. The appliance is used only for Classified, where the product makes no claim. Each item adopted here would become a new OSCAL component (`compliance/components/*.json`), with evidence rules in `compliance/evidence-rules/`.

Shared references:
- **Crypto:** ITSP.40.111 Version 5 (2026-05-29) lists RSA, ECDSA and EdDSA (section 6.4). ML-DSA is the intended replacement for the classical signature schemes for most uses (https://cyber.gc.ca/en/guidance/cryptographic-algorithms-unclassified-protected-protected-b-information-itsp40111). Ed25519, ECDSA P-256/P-384, AES-GCM, SHA-2 and ML-DSA are acceptable **[exact v5 tables not read]**.
- **FIPS 140-3:** the Go native FIPS module (Go 1.24+, `GOFIPS140=v1.0.0`, runtime `GODEBUG=fips140=on|only`) per https://go.dev/doc/security/fips140. Its CMVP certificate status needs checking at build time **[unverified]**.
- **Rule for every item below:** "pass" requires the condition to be met in our deployment and evidence collected automatically. Nothing in this section counts toward the product claim until it is added to `compliance/` and assessed.

### 7.1 Theia Cloud operator, service and oauth2-proxy sidecar
| Area | Fit |
|---|---|
| IA-2, IA-2(1)/(2), IA-8 | Delegates authentication to Keycloak (OIDC) through oauth2-proxy. MFA strength comes from Keycloak, not Theia Cloud |
| AC-3, AC-6, AC-12 | Per-session owner allowlist (authenticated-emails-file). `sessionsPerUser`. Idle timeout through `timeout` plus the activity monitor (AC-12/AC-11 session termination). Operator and service RBAC roles are in the chart (least privilege must be reviewed) |
| AU-2/3/12 | Operator and service logs plus Kubernetes events and the Session CR `lastActivity`. **No dedicated audit log or export**: collect with the k8s audit policy on Session/Workspace CRs and log shipping |
| SC-8, SC-23 | TLS at ingress. **Defaults fail:** `ssl_insecure_skip_verify=true`, `cookie_secure=false`, a public sample `clientSecret`. Pod-internal hop is HTTP 127.0.0.1 (acceptable inside the pod) |
| SC-13 | Java operator and service run on Temurin 21 JRE Alpine, **not in FIPS mode**. The landing page uses nginx-unprivileged Alpine |
| SC-28 | Workspace PVCs. Encryption at rest depends on the storage class (LUKS/Ceph encryption), not on Theia Cloud |
| CM/SA/SR (SBOM, signing, provenance) | CI publishes Docker Hub images with docker/build-push-action. **No cosign signatures or image SBOMs** found in workflows. npm packages use `NPM_CONFIG_PROVENANCE` [verified by reading the workflows]. Chart and images are pinned by tag only |
| SI-2 | No security advisory history found. Release cadence slipped (1.2.0 in 2026-04, nothing since) |
| CP-9/10 | State is CRDs and PVCs. Back up with Velero or etcd snapshots plus storage snapshots |
| Licence/phone-home | EPL-2.0; no telemetry or licence check found |
| Evidence | Session/Workspace CR listings, oauth2-proxy access logs, k8s audit events, rendered values (config baseline) |
| **Verdict** | **Pass with conditions:** (1) rebuild the operator, service and webhook from source in our pipeline on a FIPS-capable JRE (for example UBI9 OpenJDK with the host in FIPS mode, or BC-FIPS), signed with SBOM and provenance; (2) override the oauth2-proxy insecure defaults (TLS verify, secure cookies, a real secret, `pass_access_token`); (3) collect audit events from the k8s audit policy; (4) pin to the commit we assessed. Also rebuild or replace oauth2-proxy (Go, so `GOFIPS140` is possible) |

### 7.2 Keycloak (Apache-2.0, 26.8.2, CNCF)
| Area | Fit |
|---|---|
| IA-2(1)/(2), IA-2(8) replay-resistant, IA-5 | WebAuthn passwordless with attestation, AAGUID allowlist and UV-required meets phishing-resistant MFA. X.509 smart cards, with CRL/OCSP checking (IA-5(2) PKI-based auth). OTP and passwords can be disabled in flows |
| AC-2, AC-7, AC-12 | User lifecycle, groups and roles, brute-force detection, session idle and max lifetimes, admin REST for account review |
| AU-2/3/6/12 | Login events and admin events (stored, retention configurable), exportable via the admin REST API or an event listener SPI to syslog/SIEM |
| SC-13 | **FIPS mode** with BouncyCastle FIPS jars that we must supply (not shipped), `fips-mode=strict`, BCFKS keystores. Keycloak docs describe it as **FIPS 140-2**. BC-FIPS has a CMVP cert (Chainguard cites #4616); BC-FIPS 140-3 status **[unverified]**. Use OpenJDK 21, not 25, for FIPS (https://www.keycloak.org/server/fips). Red Hat build of Keycloak is the supported FIPS option on RHEL |
| SC-8 | TLS; supports mTLS to the database |
| SC-28 | Credentials in Postgres (WebAuthn public keys only, no secrets for hardware-key users). Encrypt at rest at the database/storage layer |
| SI-2 | Frequent releases and published CVEs (for example CVE-2026-6856 AAGUID allowlist bypass, CVE-2025-12150): good response cadence, but patching must be timely |
| SR/CM | Official images on quay.io. Signing and SBOM status of upstream images **[unverified]**; rebuild or verify in our pipeline |
| CP-9 | Postgres backup plus realm export (realm-as-code) |
| Evidence | Event and admin-event export, realm JSON export (config baseline), WebAuthn policy settings, FIPS mode flag in the startup log |
| **Verdict** | **Pass with conditions:** FIPS strict mode with BC-FIPS on a FIPS host; patched 26.8.x (check the CVE-2026-6856 fix); password and OTP authenticators disabled; events shipped to the audit store |

### 7.3 OpenBao (MPL-2.0, 2.7.3)
| Area | Fit |
|---|---|
| IA-5, IA-5(2) | Short-lived tokens, jwt/oidc, kubernetes and cert auth, PKI secrets engine for device and TLS certificates |
| AC-3, AC-6, AC-5 | Path ACLs with identity templating, namespaces, **Control Groups (2.7)** for two-person approval of sensitive paths |
| AU-2/3/9/12 | Audit devices (file, syslog, socket) log every request and response with HMACed secrets. Tamper-evidence still needs a WORM or hash-chained sink |
| SC-12, SC-13 | Transit, PKI, ML-DSA (2.7). **No official FIPS 140-3 build** (issue openbao/openbao#1409 open since 2025-06; wolfSSL evaluating). Options: self-build with `GOFIPS140=v1.0.0`, or keep all key operations in a CMVP-validated HSM through **External Keys / PKCS#11 KMS plugin (2.7)**, so the validated boundary is the HSM. SHA-1 token-accessor hashing is still being removed (issues #4292, #4357, #4223) |
| SC-28 | Barrier encryption (AES-GCM) of all storage. Root of trust is the HSM seal |
| SI-2 | Active security releases (2.7.1 to 2.7.3 in 2 months). Linux Foundation governance |
| SR/CM | Signed releases and container images **[signing method unverified]** |
| CP-9/10 | Raft snapshots (`bao operator raft snapshot`). Shamir recovery keys. No cross-site replication, so per-site backup is mandatory |
| Evidence | Audit device logs, `sys/policies`, `sys/auth`, `sys/mounts` dumps, seal status, snapshot records |
| **Verdict** | **Pass with conditions:** HSM-backed keys (CMVP-validated HSM) or a self-built FIPS binary with the module certificate checked; audit device to a tamper-evident store; documented key ceremony. HashiCorp Vault (BUSL-1.1) is excluded by the licence rule, not on technical grounds |

### 7.4 HSM / PKCS#11 path
| Area | Fit |
|---|---|
| SC-12, SC-13 | Use only HSMs with a **FIPS 140-3 Level 3 CMVP certificate** (for example Thales Luna 7, Entrust nShield 5, Utimaco u.trust; exact cert numbers **[unverified]**). Nitrokey NetHSM (open source) is not FIPS-validated **[unverified]**, so it is acceptable for labs only |
| SC-28, AC-5 | Keys are non-exportable and HSM roles split duties (crypto officer and auditor) |
| AU | HSM audit logs (vendor-specific; most export via syslog) |
| CGP/ITAR | Export-controlled hardware. Procurement and record-keeping fall under the customer's Controlled Goods and ITAR procedures |
| **Verdict** | **Pass with conditions:** a CMVP-validated model in approved mode. Plugin path: `openbao-plugins` `kms-pkcs11` v0.3.0 (young, 2026-11-03), so test it before relying on it. Shamir is the fallback, with a documented key-custodian procedure |

### 7.5 k3s vs RKE2 (both Apache-2.0, v1.37.2)
| Area | RKE2 | k3s |
|---|---|---|
| SC-13 FIPS | Built with the FIPS Go toolchain (BoringCrypto). SUSE publishes a FIPS 140-3 enablement page and links the CMVP cert. Covers control plane, kubelet, Canal CNI and the Traefik chart; Calico, Cilium and Multus are **not** rebuilt (https://documentation.suse.com/cloudnative/rke2/latest/en/security/fips3_support.html) | No FIPS build |
| CM-6/CM-7 hardening | DISA **RKE2 STIG** (V-254553 etc., version 2026-02-13). CIS profile option (`profile: cis`) **[not re-verified today]** | CIS hardening guide exists; no STIG **[unverified]** |
| AU | Kubernetes API audit policy (both) | Same |
| SR | SUSE/Rancher Government Solutions signed images **[unverified]** | Same vendor |
| **Verdict** | **Pass (preferred)**, with Canal and the bundled FIPS components | **Pass with conditions** only for non-Protected-B lab or demo edge kits; **fail** where FIPS-validated crypto is required |

### 7.6 Ingress
| Candidate | Fit |
|---|---|
| ingress-nginx | **Fail:** the repo was archived after its final release (controller-v1.15.1, 2026-03-19), so it gets no SI-2 patches. Theia Cloud still has nginx annotations as an option |
| HAProxy Kubernetes Ingress (Theia Cloud's default controller) | Pass with conditions: FIPS only when linked against a validated OpenSSL provider on a FIPS host. HAProxy Technologies sells FIPS builds **[unverified]** |
| Traefik (MIT, v3.8.0), bundled FIPS-built in RKE2 | Pass with conditions: the FIPS build comes from RKE2. Theia Cloud has no first-class Traefik support (use `controller: null` plus explicit annotations) **[untested]** |
| Envoy Gateway (Apache-2.0, v1.10.0) | Not supported by Theia Cloud today (Ingress or OpenShift Routes only) |
| All | Access logs cover AU-12; TLS 1.2+/1.3 with ITSP.40.062-approved suites (SC-8); mTLS client-certificate forwarding is needed for X.509 sign-in |

### 7.7 Container registry and mirror
| Candidate | Fit |
|---|---|
| Harbor (Apache-2.0, CNCF graduated, v2.15.5, 29.8k stars) | Pass with conditions: cosign/notation signature-enforcement policy (SR-4, SI-7, CM-14), Trivy scanning (RA-5), SBOM storage, RBAC and OIDC to Keycloak (IA, AC), audit log of pulls and pushes (AU), replication for air-gap import. No FIPS build documented **[unverified]**. Heavier (about 8 components) |
| Zot (Apache-2.0, CNCF, v2.1.23) | Pass with conditions for small edge sites: single Go binary, OCI-native, cosign and notation verification, OIDC, can be built with `GOFIPS140` **[FIPS build unverified]** |
| Both | Images enter only through a signed offline bundle; signatures are verified on import and again at admission (Kyverno or the sigstore policy-controller) |

### 7.8 Base images (workbench, Keycloak, operator)
| Candidate | Fit |
|---|---|
| Red Hat UBI 9 (freely redistributable, UBI EULA) | Pass with conditions: RHEL 9 OpenSSL FIPS provider (CMVP validated **[cert number unverified]**) is active when the **host** is in FIPS mode. Node.js and OpenJDK packages use system crypto. Red Hat publishes signed images, VEX and errata (SI-2). The licence is not OSI, but redistribution is permitted |
| Debian/Alpine (current Theia Cloud bases) | Fail for SC-13 at Protected B (no validated module) unless the crypto boundary is moved elsewhere |
| Chainguard FIPS images (commercial) | Pass, but it is a commercial subscription and its supply chain is a cloud dependency for updates. Only usable if policy allows mirrored updates |
| Workbench (Theia on Node.js) | Node must run with OpenSSL 3 and the FIPS provider (`--enable-fips` or `--force-fips`) on a FIPS host. Our own sign and decrypt operations go through OpenBao Transit or the HSM, which keeps the product's crypto boundary in validated modules |

### 7.9 Summary
| Item | Verdict |
|---|---|
| RKE2 | Pass (k3s: lab only) |
| Keycloak | Pass with conditions (FIPS strict, patched, passwordless-only flows, event export) |
| OpenBao + CMVP HSM | Pass with conditions (HSM-held keys or a self-built FIPS binary, tamper-evident audit sink) |
| Theia Cloud | Pass with conditions (rebuild, sign and SBOM ourselves; fix oauth2-proxy defaults; k8s audit for sessions; FIPS JRE) |
| HAProxy or RKE2 Traefik ingress | Pass with conditions; **ingress-nginx fails** (archived) |
| Harbor (HQ) / Zot (edge) | Pass with conditions (signature-enforced import and admission) |
| UBI 9 bases | Pass with conditions (FIPS host) |

**Open evidence work:**
- a new OSCAL component for each item;
- evidence rules for the Keycloak event export, OpenBao audit, k8s audit and Harbor audit;
- an SBOM, signature and provenance pipeline for every image we rebuild (extends gap G4);
- the hash-chained audit sink (extends gap G2).
