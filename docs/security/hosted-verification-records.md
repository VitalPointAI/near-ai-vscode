# Hosted deployment: verification records

Last reviewed: 2026-11-23

These records settle the open verification items for the hosted deployment (the hosting design,
`.planning/research/multiuser-hosting/DESIGN.md`, sections 10 and 12). A record counts as evidence
only because it says where its facts come from and when they were read: each record below gives
the source address, the date it was checked and the source's own words, quoted exactly. An item
that a source does not confirm is not closed here. It is a gap in `compliance/gaps.json` with an
owner role and a target date in its POA&M item, and the compliance dashboard shows it as a gap
until evidence replaces it. The dashboard reads this document's review date, so the records go
stale a year after the last review.

## Section 10 conditions

One row per condition of DESIGN section 10, in its order, with a row split where the design lists
several conditions for one component. Each row names the hosted component that will carry the
statement, the kind of evidence that will prove it (a test rule on a Phase 46 or 47 test, an
observation from the deployment evidence export, or a dated document record) and the controls it
supports. Its reference is a gap until a statement with an evidence rule replaces it: a gap per
component for the conditions that wait on statements, which closes in Phase 48, and the gaps of
the verification register for conditions that wait on the rig, a purchase or an upstream build.
These are starting points, not results (D-04). Negative conditions name the component whose
rendered production profile will prove them. A hosted component with no section 10 condition is
listed too: it stays in scope and reads No statement yet until it has statements.

| # | Component | Condition | Evidence kind | Controls | Reference |
|---|---|---|---|---|---|
| 1 | rke2 | FIPS build with Canal and the bundled FIPS components | deployment observation (version, host FIPS mode), document record | sc-13, sc-12 | gap G334 |
| 2 | rke2 | STIG profile | test rule (rendered RKE2 configuration), deployment observation | cm-06 | gap G334 |
| 3 | rke2 | Kubernetes audit policy | test rule (policy file), deployment observation (audit stream present) | au-02, au-12 | rule rke2.au-02.audit-policy |
| 4 | rke2 | k3s is lab and demo only: no k3s in production | test rule (rendered production profile) | cm-07, sc-13 | rule rke2.cm-07.no-k3s |
| 5 | keycloak | FIPS strict mode with BC-FIPS on a FIPS host, OpenJDK 21 | deployment observation (strict mode, host FIPS mode), document record (BC-FIPS certificate) | sc-13 | gap G332 |
| 6 | keycloak | A version with CVE-2026-6856 fixed | deployment observation (version at or above the recorded minimum), document record | si-02 | rule keycloak.si-02.version-fixed |
| 7 | keycloak | Password and OTP authenticators disabled | test rule (realm as code), deployment observation (live realm) | ia-02, ia-05 | rule keycloak.ia-02.realm-flows |
| 8 | keycloak | Events shipped to the audit store | deployment observation (listener enabled, events counted) | au-02, au-12 | rule keycloak.au-12.events-shipped |
| 9 | theia-cloud | Rebuilt from source by us on a FIPS-capable JRE (UBI 9) | test rule (build job), deployment observation (image digest) | sc-13, sa-10 | gap G336 |
| 10 | theia-cloud | Signed, with SBOM and provenance | deployment observation (signature, SBOM and provenance per image digest) | sr-03, sr-11, si-07 | rule theia-cloud.si-07.signed |
| 11 | theia-cloud | oauth2-proxy defaults fixed in the Theia Cloud chart | test rule (rendered manifests) | sc-08, sc-23 | rule theia-cloud.sc-23.sidecar-defaults |
| 12 | theia-cloud | Kubernetes audit on Session and Workspace records | test rule (audit policy), deployment observation | au-02, au-12 | rule theia-cloud.au-12.live-audit |
| 13 | theia-cloud | Pinned to the commit we assessed | test rule (chart lock and image digests) | cm-02 | rule theia-cloud.cm-02.pinned-images |
| 14 | oauth2-proxy | Rebuilt by us with the Go FIPS module | test rule (build job with the pinned module version) | sc-13 | gap G337 |
| 15 | oauth2-proxy | TLS verify on | test rule (rendered manifests) | sc-08 | rule oauth2-proxy.sc-08.tls-verify |
| 16 | oauth2-proxy | Secure cookies | test rule (rendered manifests) | sc-23 | rule oauth2-proxy.sc-23.secure-cookies |
| 17 | oauth2-proxy | A real client secret | test rule (rendered manifests: no sample secret) | ia-05 | rule oauth2-proxy.ia-05.client-secret |
| 18 | oauth2-proxy | Token forwarding | test rule (rendered manifests) | ia-02 | rule oauth2-proxy.ia-02.forwarded-identity |
| 19 | openbao | Keys held in a CMVP-validated HSM through External Keys, or a self-built FIPS binary with the module certificate checked | deployment observation (seal type, plugin checksum), document record (HSM certificate) | sc-12, sc-13 | gap G324 |
| 20 | openbao | Audit device to a tamper-evident store | deployment observation (device enabled); tamper evidence waits on the audit sink | au-09 | gap G2 |
| 21 | openbao | A documented key ceremony | document record with a review date, attestation | sc-12 | gap G338 |
| 22 | hsm | A model with a FIPS 140-3 Level 3 certificate in approved mode | document record (certificate of the chosen model) | sc-12, sc-13 | gap G324 |
| 23 | hsm | The `kms-pkcs11` plugin tested before use | rig experiment record | sc-12 | gap G326 |
| 24 | hsm | Export-controlled hardware handled under your organization's Controlled Goods and ITAR procedures | document record (your organization's procedure) | sr-05 | gap G339 |
| 25 | ingress | HAProxy is FIPS only when linked against a validated OpenSSL provider on a FIPS host | deployment observation (image base, host FIPS mode) | sc-13, sc-08 | gap G340 |
| 26 | ingress | RKE2 Traefik: a FIPS build from RKE2 | document record | sc-13 | gap G325 |
| 27 | ingress | RKE2 Traefik works with Theia Cloud only through explicit annotations (untested) | rig experiment record | sc-08 | gap G325 |
| 28 | ingress | No ingress-nginx (archived, no further patches) | test rule (rendered production profile) | cm-07 | rule ingress.cm-07.no-ingress-nginx |
| 29 | image-registry | Harbor: signature-enforced import and admission | deployment observation (admission enforcing, unsigned images admitted counted), test rule | si-07 | rule image-registry.si-07.admission-policy |
| 30 | image-registry | Harbor: scanning | deployment observation | ra-05 | gap G341 |
| 31 | image-registry | Harbor: SBOM storage | deployment observation | cm-08 | gap G341 |
| 32 | image-registry | Harbor: OIDC to Keycloak | test rule (rendered configuration) | ia-02 | gap G341 |
| 33 | image-registry | Harbor: audit log | deployment observation | au-12 | rule image-registry.au-12.registry-audit |
| 34 | image-registry | Harbor: no FIPS build documented | document record | sc-13 | gap G333 |
| 35 | image-registry | Zot (small sites): the same import rules | deployment observation, test rule | si-07 | rule image-registry.si-07.admission-policy |
| 36 | image-registry | Zot: a FIPS build with `GOFIPS140` | document record, build evidence | sc-13 | gap G333 |
| 37 | rke2 | UBI 9 base images: the host in FIPS mode | deployment observation (host FIPS mode per node) | sc-13 | rule rke2.sc-13.fips-hosts |
| 38 | workbench | UBI 9 base images: the RHEL OpenSSL FIPS provider | document record (certificate), deployment observation | sc-13 | rule workbench.sc-13.provider-record |
| 39 | theia-cloud | No Debian or Alpine bases at Protected B | test rule (rendered production profile) | cm-07, sc-13 | gap G336 |
| 40 | workbench | UBI 9 base | test rule (image build) | cm-02 | gap G342 |
| 41 | workbench | Node with OpenSSL 3 and the FIPS provider on a FIPS host | test rule (P4 tests), deployment observation (FIPS mode reported by Node) | sc-13 | rule workbench.sc-13.fips-provider |
| 42 | workbench | Our signing and unwrapping go through OpenBao or the HSM | test rule (P4 tests) | sc-12 | rule workbench.sc-12.sign-after-step-up |
| 43 | cert-manager | Not assessed: the fit check before use; a CA issuer chained to the OpenBao PKI, no ACME | test rule (rendered manifests: no ACME issuer) | sc-12, sc-23 | rule cert-manager.sc-12.issuers |
| 44 | hub | Re-assessed for Kubernetes deployment | test rule (hub and Phase 47 manifest tests) | cm-06 | rule hub.cm-06.kubernetes |
| 45 | hub | Several hubs per site, each serving a set of projects | test rule, deployment observation (hub workload settings) | ac-03 | rule hub.sc-07.separate-hubs |
| 46 | hub | Session keys with a site-issued certificate | test rule (hub tests) | ia-05.02 | gap G344 |
| 47 | keycloak | Its Postgres: the fit check before use, TLS to Postgres, encryption at rest | test rule, deployment observation | sc-08, sc-28 | rule keycloak.sc-08.postgres |
| 48 | site-storage | The storage class: the fit check before use, encryption at rest declared | test rule (install check for the storage class) | sc-28 | rule site-storage.sc-28.encrypted-class |
| 49 | site-logging | Logs and metrics: the fit check before use; a log store that is not AGPL (Loki is not chosen) | test rule, deployment observation | au-09 | rule site-logging.au-09.store |
| 50 | offline-bundle | no section 10 condition | none | | none |

## Verification register

One row per item of DESIGN section 12, in its order, then the three desk items D-24 adds. A row
reads closed when a dated record settles it, decided when the design already settled it and an
evidence rule will prove the configuration, and open when it waits on the rig, a purchase or an
upstream source. A row that is closed for one part and open for another names both its record and
its gap.

| # | Item | State | Reference |
|---|---|---|---|
| 1 | No public proof of a Theia Cloud deployment at the target session count: a load test on our own hardware to the target, with start bursts, operator reconcile rate, the shared Ingress object's size against etcd's request limit, etcd load per session, ingress reload time and cold-start time | open | gap G322 |
| 2 | Hub capacity at its per-hub target (MUS 10.9): several hubs per site, measured under the same load test | open | gap G323 |
| 3 | Keycloak CVE-2026-6856 (acceptable AAGUID bypass with self-attestation): the fixed version to pin | closed | Record: Keycloak CVE-2026-6856 fix version; gap G321 |
| 4 | HSM certificates: the FIPS 140-3 certificate numbers of the HSM models | closed | Record: HSM FIPS 140-3 certificates; gap G324 |
| 5 | Go FIPS module: its CMVP certificate status at build time | closed | Record: Go Cryptographic Module certificates |
| 6 | Traefik with Theia Cloud: untested, and HAProxy stays the default until it is tested | open | Record: Traefik and the Theia Cloud chart; gap G325 |
| 7 | OpenBao `kms-pkcs11` plugin (v0.3.0): tested against the chosen HSM before relying on it | open | Record: OpenBao kms-pkcs11 plugin release; gap G326 |
| 8 | Theia Cloud project health: small maintainer group, last stable release; we pin, and fork the operator library only if needed | closed | Record: Theia Cloud project health |
| 9 | Prewarm pool with personal volumes: how a pooled pod gets the person's volume at claim; the pool stays at 0 until shown | open | Record: Prewarm pool and personal volumes; gap G327 |
| 10 | Step-up re-authentication through the sidecar: the workbench forces a fresh WebAuthn step and sees the new `acr` | open | gap G328 |
| 11 | Synced passkeys: accepted under `signInKeys: passkeys`, refused under `hardware-only`, which requires attestation, an AAGUID allowlist and device-bound keys and is the recommended production setting for defence sites | decided | rule keycloak.ia-05.sign-in-keys |
| 12 | Cross-device (hybrid) passkey sign-in: needs Bluetooth and an Apple or Google internet relay, so it is unavailable air-gapped; same-device passkeys need no internet | decided | rule keycloak.ia-05.sign-in-keys |
| 13 | Shared relying-party ID across sites: the DNS layout per deployment (O3) | decided | gap G330 |
| 14 | Large smart-card revocation lists: a local OCSP responder or a scheduled CRL refresh at each site | open | gap G331 |
| 15 | Theia 1.77 supported Node range, before settling P11 | closed | Record: Theia 1.77 supported Node range |
| 16 | UBI 9 OpenSSL FIPS provider: its certificate number (D-24) | closed | Record: RHEL 9 OpenSSL FIPS provider certificate |
| 17 | BC-FIPS for Keycloak strict mode: the module certificates and the version Keycloak accepts (D-24) | closed | Record: Bouncy Castle FIPS Java certificates; gap G332 |
| 18 | Harbor and Zot FIPS builds (D-24) | open | Record: Harbor and Zot FIPS builds; gap G333 |

The decided rows are not reopened here (D-26). Which `signInKeys` level a site runs is that
site's setting: `passkeys` is the default for development and the lab, and `hardware-only` is the
recommended setting for defence production. Their gaps close in Phase 48 when the evidence rules
that prove each level's configuration from the realm as code, and the shared relying-party ID,
exist. SoftHSM2 on a lab rig proves the HSM wiring only and is never evidence for a FIPS claim.

## Keycloak CVE-2026-6856 fix version

Upstream Keycloak fixed CVE-2026-6856 in 26.6.2, and the fix commits are in every 26.8 release.
The two related WebAuthn fixes, CVE-2026-37982 and CVE-2026-8830, are also in every 26.8
release. The Red Hat build of Keycloak is not confirmed for the release line a site would run, so
that part stays open as gap G321.

Source: https://www.keycloak.org/2026/05/keycloak-2662-released
Checked: 2026-11-23

```text
Keycloak 26.6.2 released
"datePublished":"2026-05-19T08:00:00Z"
#48388 [CVE-2026-6856] Acceptable AAGUID policy bypass via packed self-attestation in WebAuthn registration authentication/webauthn
#49112 [CVE-2026-37982] Execute-actions token replay allows unauthorized WebAuthn credential enrollment on victim account
```

Source: https://github.com/keycloak/keycloak/issues/48388
Checked: 2026-11-23

```text
title: [CVE-2026-6856] Acceptable AAGUID policy bypass via packed self-attestation in WebAuthn registration
state: closed
closed_at: 2026-04-27T11:52:26Z
```

Source: https://github.com/keycloak/keycloak/compare/3ba245c39ce5cc8c26f3fdcad57f93cb09db5366...26.8.0
Checked: 2026-11-23

The commits that name issue 48388 (GitHub commit search `repo:keycloak/keycloak 48388`), each
compared with the release tags through the GitHub compare API:

```text
3ba245c39ce5cc8c26f3fdcad57f93cb09db5366 Make acceptable AAGUID ckeck in WebAuthn stricter
e03bc86579be441526508e90d00d4026d1f04e9f Changes for rebase and review.
ff8937e00b45b472b368886de6e3b3a6ee1b9eb6 Check Acceptable AAGUIDs sets a attestation preference different to None in admin console
against 26.8.0: "status": "ahead", "behind_by": 0 (each of the three)
against 26.8.2: "status": "ahead", "behind_by": 0 (each of the three)
against 26.6.2: "status": "diverged" (each of the three; 26.6.2 carries its own backport)
```

Source: https://github.com/keycloak/keycloak/releases/tag/26.6.3
Checked: 2026-11-23

```text
#49133 [CVE-2026-8830] Missing server-side WebAuthn validations during credential registration authentication/webauthn
```

Source: https://github.com/keycloak/keycloak/compare/47b9aef70948564151af85fd52e0d7e508c76490...26.8.0
Checked: 2026-11-23

The fix commits for the two related CVEs (GitHub commit search for issues 49344 and 49112), each
compared with the release tags through the GitHub compare API:

```text
47b9aef70948564151af85fd52e0d7e508c76490 [CVE-2026-8830] Missing server-side WebAuthn validations during credential registration (#49344)
2d1a24f501454a44c52daa62855419b31dc499c1 Make all required actions one time action by default ... Closes CVE-2026-37982
against 26.8.0: "status": "ahead", "behind_by": 0 (each of the two)
against 26.8.2: "status": "ahead", "behind_by": 0 (each of the two)
```

Source: https://github.com/keycloak/keycloak/releases
Checked: 2026-11-23

```text
26.8.2 published 2026-11-05T16:00:19Z
26.8.1 published 2026-10-13T08:58:15Z
26.8.0 published 2026-10-01T05:57:20Z
```

Source: https://bugzilla.redhat.com/show_bug.cgi?id=2460004
Checked: 2026-11-23

Read through the Bugzilla REST interface (`/rest/bug/2460004` and its comments):

```text
"summary":"CVE-2026-6856 keycloak: keycloak: acceptable AAGUID policy bypass via packed self-attestation in WebAuthn registration"
"status":"NEW" "resolution":"" "cf_fixed_in":"" "last_change_time":"2026-04-22T12:29:58Z"
2026-04-21: "Affects RHBK 26.4 and Keycloak 26.6. Patch in progress."
```

Source: https://access.redhat.com/hydra/rest/securitydata/cve/CVE-2026-6856.json
Checked: 2026-11-23

```text
affected_release: "Red Hat build of Keycloak 26.4.12" release_date 2026-05-20T00:00:00Z advisory RHSA-2026:19596
package_state: "Red Hat Build of Keycloak" fix_state "Affected" package_name "keycloak-services"
```

Source: https://access.redhat.com/hydra/rest/securitydata/cve/CVE-2026-8830.json
Checked: 2026-11-23

```text
affected_release: "Red Hat build of Keycloak 26.6.3" release_date 2026-06-10T00:00:00Z advisory RHSA-2026:25098
affected_release: "Red Hat build of Keycloak 26.4.13" release_date 2026-06-25T00:00:00Z advisory RHSA-2026:30049
```

What the record settles: pin upstream Keycloak 26.8.2 or later; no 26.8 release lacks the three
fixes. What stays open (gap G321): Red Hat's data names Red Hat build 26.4.12 as fixed for
CVE-2026-6856 while it still lists the Red Hat build as affected, names no fixed 26.6 or later
Red Hat build for it, and Bugzilla still reads NEW. A site that runs the Red Hat build instead of
the upstream pin confirms the fixed release with Red Hat first.

Minimum upstream version: 26.8.0

## HSM FIPS 140-3 certificates

The candidate models' certificates, as NIST shows them. They are candidates only: the certificate
that counts is the one that matches the model, hardware version, firmware and approved mode your
organization buys, so the chosen model stays open as gap G324. SoftHSM2 never stands in for it.
The Utimaco u.trust General Purpose HSM Se-Series is not named on any active NIST certificate
found, and #5223 (u.trust Anchor) is not assumed to cover it.

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4684
Checked: 2026-11-23

```text
Certificate #4684
Module Name Thales Luna K7 Cryptographic Module
Standard FIPS 140-3
Status Active
Sunset Date 4/1/2029
Overall Level 3
Caveat When operated in approved mode
Hardware Versions 808-000048-002, 808-000048-003, 808-000066-001, 808-000073-001, 808-000073-002
Firmware Versions 7.8.4 with bootloader version 1.1.1, 1.1.2, 1.1.4 or 1.1.5; 7.8.5 with bootloader version 1.1.1, 1.1.2, 1.1.4 or 1.1.5
Validation history: 4/2/2024 Initial; 7/7/2025 Update
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5329
Checked: 2026-11-23

```text
Certificate #5329
Module Name nShield 5s Hardware Security Module
Standard FIPS 140-3
Status Active
Sunset Date 8/18/2029
Overall Level 3
Caveat When installed, initialized and configured as specified in Section 11.3 of the Security Policy
Validation history: 6/15/2026 Initial; updates 6/22/2026, 6/29/2026, 8/26/2026, 9/11/2026, 11/10/2026
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4745
Checked: 2026-11-23

```text
Certificate #4745
Module Name nShield 5s Hardware Security Module
Standard FIPS 140-3
Status Active
Sunset Date 7/30/2029
Overall Level 3
Caveat When installed, initialized and configured as specified in Section 11.3 of the Security Policy
Hardware Versions PCA10005-01 revision 03 and 04; PCA10051-01 revision 01
Firmware Versions primary-version 13.2.4; recovery-version 13.2.4; uboot-version 1.1.0, uboot-version 1.4.1 and uboot-version 14.2.2
Validation history: 7/31/2024 Initial; updates 4/1/2025, 9/8/2026, 9/23/2026
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4765
Checked: 2026-11-23

```text
Certificate #4765 Historical - The referenced cryptographic module should not be included by Federal Agencies in new procurements.
Module Name nShield 5s Hardware Security Module
Status Historical
Historical Reason Replaced by certificate #5329
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5223
Checked: 2026-11-23

```text
Certificate #5223
Module Name u.trust Anchor
Standard FIPS 140-3
Status Active
Sunset Date 3/31/2031
Overall Level 3
Caveat When operated in approved mode. When installed, initialized and configured as specified in Section 11.1 of the Security Policy. No assurance of minimum security of SSPs (e.g., keys, bit strings) that are externally loaded, or of SSPs established with externally loaded SSPs.
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/validated-modules/search?SearchMode=Basic&Vendor=Utimaco&CertificateStatus=Active&ValidationYear=0
Checked: 2026-11-23

```text
5223 Utimaco IS GmbH u.trust Anchor Hardware 04/01/2026
4992 Utimaco Inc. Atalla Cryptographic Subsystem (ACS) Hardware 03/25/2025
```

## Go Cryptographic Module certificates

Both Go Cryptographic Module versions have active FIPS 140-3 certificates. The mapping from
module version to certificate comes from go.dev; the NIST pages do not show the module version.
Go keeps an older module version only until a newer one is validated, so every rebuild job that
uses the module pins the Go toolchain and the `GOFIPS140` module version and records both.
Go+BoringCrypto is not an alternative: it does not work with the native FIPS 140-3 mode.

Source: https://go.dev/doc/security/fips140
Checked: 2026-11-23

```text
Go Cryptographic Module v1.26.0 was frozen in early 2026 from Go 1.26. It is available from Go 1.26.12, Go 1.27.5, and Go 1.28. Previous versions of Go 1.26 and Go 1.27 include an earlier iteration of Go Cryptographic Module v1.26.0. It is covered by CMVP Certificate #5581 and CAVP Certificate A8028 .
Go Cryptographic Module v1.0.0 was frozen in early 2024 from Go 1.24. It is available from Go 1.24.8, Go 1.25.2, and Go 1.26. Earlier versions of Go 1.24 and Go 1.25 include an earlier iteration of Go Cryptographic Module v1.0.0. It is covered by CMVP Certificate #5247 and CAVP Certificate A6650 .
Older Go Cryptographic Module versions continue to be supported and available for as long as a more recent version has not obtained a CMVP validation certificate. Once a more recent version has obtained a CMVP validation certificate, older versions will be removed.
NOTE: Simply using a FIPS 140-3 compliant and validated cryptographic module may not—on its own—satisfy all relevant regulatory requirements.
Go+BoringCrypto is incompatible with the native FIPS 140-3 mode.
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5247
Checked: 2026-11-23

```text
Certificate #5247
Module Name Go Cryptographic Module
Vendor Geomys LLC
Standard FIPS 140-3
Status Active
Sunset Date 4/26/2031
Overall Level 1
Caveat When operated in approved mode. No assurance of the minimum strength of generated SSPs (e.g., keys). No assurance of minimum security of SSPs (e.g., keys, bit strings) that are externally loaded, or of SSPs established with externally loaded SSPs.
Validation history: 4/27/2026 Initial; 7/7/2026 Update
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5581
Checked: 2026-11-23

```text
Certificate #5581
Module Name Go Cryptographic Module
Vendor Geomys LLC
Standard FIPS 140-3
Status Active
Sunset Date 11/12/2031
Overall Level 1
Caveat When operated in approved mode. No assurance of minimum security of SSPs (e.g., keys, bit strings) that are externally loaded, or of SSPs established with externally loaded SSPs.
Validation history: 11/13/2026 Initial; 11/20/2026 Update
```

## Traefik and the Theia Cloud chart

What the desk can settle before the rig experiment. The Theia Cloud chart supports HAProxy and
nginx annotations and otherwise only annotations set explicitly, so Traefik works only through
explicit annotations. RKE2 makes Traefik the default ingress for new clusters, but its FIPS page
names its NGINX ingress, not Traefik, as the FIPS-built ingress. So both the Traefik experiment and
a FIPS build of RKE2's Traefik stay open as gap G325.

Source: https://github.com/eclipse-theia/theia-cloud-helm/blob/7687955f5dd8936a313c940ac42550f1fb331db6/charts/theia-cloud/values.yaml
Checked: 2026-11-23

```text
# -- The ingress controller to use. Currently supported: "nginx", "haproxy", or null
# Determines controller-specific default annotations and ingress class name to use.
# Using null or an unknown value results in only explicitly specified annotations being used.
controller: haproxy
# false uses an explicit host for each service
usePaths: false
```

Source: https://github.com/eclipse-theia/theia-cloud/issues/464
Checked: 2026-11-23

```text
title: Move away from nginx-ingress-controller
state: closed
closed_at: 2026-04-09T11:26:33Z
```

Source: https://docs.rke2.io/networking/networking_services
Checked: 2026-11-23

```text
Ingress NGINX went End-of-Life in March 2026 . Starting with v1.36, Traefik is the default for new clusters.
ingress-nginx went EOL in March 2026. No new images or fixes are expected.
In v1.36, RKE2 still includes ingress-nginx but with a deprecated status. In v1.37, ingress-nginx is removed
```

Source: https://docs.rke2.io/security/fips_support
Checked: 2026-11-23

```text
FIPS 140-2 Enablement
RKE2 supports selecting a different CNI via the --cni flag and comes bundled with several CNIs including Canal (default), Calico, Cilium, and Multus. Of these, only Canal (the default) is rebuilt for FIPS compliance.
RKE2 ships with FIPS compliant NGINX as its default ingress provider.
(The page body does not mention Traefik.)
```

## OpenBao kms-pkcs11 plugin release

The plugin is still at v0.3.0, the newest `kms-pkcs11` release. It is tested against the chosen
HSM on the rig before OpenBao relies on it (gap G326).

Source: https://github.com/openbao/openbao-plugins/releases
Checked: 2026-11-23

```text
kms-pkcs11-v0.3.0 2026-11-03T09:05:33Z
kms-pkcs11-v0.2.1 2026-09-23T19:07:16Z
kms-pkcs11-v0.2.0 2026-09-08T15:06:40Z
kms-pkcs11-v0.1.0 2026-06-18T08:37:52Z
```

## Theia Cloud project health

Refreshed: the project is active and its licence is unchanged, the last stable release is still
1.2.0, and a few maintainers do most of the work. The decision stands: pin the assessed release or
our own build of an assessed commit, and fork the operator library only if needed (D-06).

Source: https://github.com/eclipse-theia/theia-cloud
Checked: 2026-11-23

```text
pushed_at: 2026-11-20T13:37:46Z
archived: false
license: EPL-2.0
contributors by commits (top four): jfaltermeier 199, lucas-koehler 96, sgraband 75, martin-fleck-at 22
commits since 2026-05-23 by author: lucas-koehler 4, ANAMASGARD 4, jfaltermeier 1, Krutskik 1, ndoschek 1
```

Source: https://github.com/eclipse-theia/theia-cloud/releases
Checked: 2026-11-23

```text
1.2.0 2026-04-09T09:12:21Z
1.1.2 2025-09-29T07:24:16Z
1.1.1 2025-08-01T13:44:32Z
```

## Prewarm pool and personal volumes

The desk part: neither upstream Theia Cloud nor EduIDE gives a pooled pod a person's saved
workspace volume. EduIDE serves only temporary workspaces from its pool, and upstream eager start
is not fully supported. So the pool stays at 0 for persistent workspaces. The rig part, cold-start
time measured against the owner's cold-start threshold with and without image preloading, is gap
G327.

Source: https://github.com/EduIDE/Docs/blob/a9c4cf548fd834f7e3bd359ba140e6820238f1af/docs/developer/platform/session-prewarming.md
Checked: 2026-11-23

The source of the EduIDE session prewarming page (`eduide.github.io/Docs/developer/platform/session-prewarming`):

```text
A saved workspace (`volume`) always starts cold, because Kubernetes cannot attach a volume to a running pod. A pool serves temporary workspaces (`none`) only.
```

Source: https://github.com/eclipse-theia/theia-cloud/blob/main/documentation/Architecture.md
Checked: 2026-11-23

```text
the following options are not fully supported at the moment:
--eagerStart | boolean | Whether sessions will be created before there is a user to speed up starts
minInstances | integer | Instances that should be started eagerly without an existing user
```

Source: https://github.com/eclipse-theia/theia-cloud-helm/blob/7687955f5dd8936a313c940ac42550f1fb331db6/charts/theia-cloud/values.yaml
Checked: 2026-11-23

```text
# Currently only false is fully supported.
eagerStart: false
```

## Theia 1.77 supported Node range

Theia 1.77.0 requires Node 24 or later and its own CI tests Node 24 and Node 26, so P11 can settle
on Node 26. Phase 46 has not recorded this item, so it is recorded here. The workbench's native
addons still need Phase 46's build proof.

Source: https://github.com/eclipse-theia/theia/blob/v1.77.0/package.json
Checked: 2026-11-23

```text
"engines": {"node": ">=24"}
```

Source: https://github.com/eclipse-theia/theia/blob/v1.77.0/.github/workflows/ci-cd.yml
Checked: 2026-11-23

```text
72:        node: [24.x, 26.x]
release v1.77.0 published 2026-11-05T19:31:06Z
```

## RHEL 9 OpenSSL FIPS provider certificate

The RHEL 9 OpenSSL FIPS provider has an active FIPS 140-3 certificate, #5573, which replaced
#4857. It is validated only in approved mode, and Red Hat lists it for RHEL 9.0 to 9.8. Red Hat's
page does not discuss UBI container images, so the conditions stay as section 10 states them: a
host in FIPS mode and the RHEL provider in the image.

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5573
Checked: 2026-11-23

```text
Certificate #5573
Module Name Red Hat Enterprise Linux 9 - OpenSSL FIPS Provider
Standard FIPS 140-3
Status Active
Sunset Date 10/28/2029
Overall Level 1
Caveat When operated in approved mode. The module generates SSPs (e.g., keys) whose strengths are modified by available entropy. No assurance of minimum security of SSPs (e.g., keys, bit strings) that are externally loaded, or of SSPs established with externally loaded SSPs.
Validation history: 11/9/2026 Initial
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4857
Checked: 2026-11-23

```text
Certificate #4857 Historical
Module Name Red Hat Enterprise Linux 9 - OpenSSL FIPS Provider
Status Historical
Historical Reason Replaced by certificate #5573
Software Versions 3.0.7-395c1a240fbfffd8
```

Source: https://access.redhat.com/compliance/fips
Checked: 2026-11-23

```text
RHEL 9.8 ... Cryptographic Module Module Version Associated Packages Validation Status Certificate OpenSSL 3.0.7-395c1a240fbfffd8 openssl-fips-provider-3.0.7-6.el9 (1) Active #5573
RHEL 9.0 ... OpenSSL 3.0.1-3f45e68ee408cd9c openssl-3.0.1-46.el9_0.3 Active #5573
```

## Bouncy Castle FIPS Java certificates

BC-FJA 2.0.0 and 2.1.x have active FIPS 140-3 certificates (#4743 and #4943). Keycloak's FIPS
guide asks for bc-fips 2.1.3, which Bouncy Castle describes as a patch release going into
submission, so no certificate names the version Keycloak 26.8 asks for. That coupling is gap
G332. The guide also says the Bouncy Castle FIPS library is validated with OpenJDK 21, not 25,
which matches the OpenJDK 21 condition in section 10.

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4743
Checked: 2026-11-23

```text
Certificate #4743
Module Name BC-FJA (Bouncy Castle FIPS Java API)
Standard FIPS 140-3
Status Active
Sunset Date 7/28/2029
Overall Level 1
Caveat When operated in approved mode. No assurance of the minimum strength of generated SSPs (e.g., keys).
Software Versions 2.0.0
```

Source: https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4943
Checked: 2026-11-23

```text
Certificate #4943
Module Name BC-FJA (Bouncy Castle FIPS Java API)
Standard FIPS 140-3
Status Active
Sunset Date 1/16/2030
Overall Level 1
Caveat Interim Validation. When operated in approved mode. The module generates SSPs (e.g., keys) whose strengths are modified by available entropy
Software Versions 2.1.1
Validation history: 1/17/2025 Initial; updates 11/14/2025, 11/10/2026
```

Source: https://www.bouncycastle.org/download/bouncy-castle-java-fips/
Checked: 2026-11-23

```text
BC-FJA 2.1.0/2.1.3 The 2.1.0 release, BC-FJA 2.1.0 ( Certificate #4943 ) , is certified for use on Java 8, Java 11, Java 17, and Java 21. The 2.1.3 release is a patch release on 2.1.0/2.1.1/2.1.3, going into submission.
```

Source: https://www.keycloak.org/server/fips
Checked: 2026-11-23

The guide at its current-version address on the checked date, when 26.8.2 was the latest release:

```text
The supported BCFIPS bits needed are: bc-fips version 2.1.3. bctls-fips version 2.1.25. bcpkix-fips version 2.1.13. bcutil-fips version 2.1.8.
Keycloak FIPS 140-2 integration is tested with OpenJDK 25, however the underlying BouncyCastle FIPS library is not officially validated with OpenJDK 25. Hence for FIPS 140-2 compliance, it is still recommended to use Keycloak on OpenJDK 21.
The more secure alternative is to use --features=fips --fips-mode=strict in which case BouncyCastle FIPS will use "approved mode".
```

## Harbor and Zot FIPS builds

Neither project publishes a build made with a validated module. Zot documents a FIPS 140-3 mode
switched on at run time, which uses whichever Go Cryptographic Module the binary was built with;
its releases do not say they were built with a validated module version. Harbor documents no FIPS
build. So the choice between running them under conditions and rebuilding them is gap G333, an
owner decision.

Source: https://github.com/project-zot/project-zot.github.io/blob/main/docs/general/whats-new.md
Checked: 2026-11-23

```text
## [v2.1.9](https://github.com/project-zot/zot/releases/tag/v2.1.9)
### FIPS 140-3 Compliance
On Linux, zot can be deployed in FIPS 140-3 mode (in terms of cryptographic protocols used) by setting the environment variable [`GODEBUG="fips140=only"`](https://go.dev/doc/security/fips140).
```

Source: https://github.com/project-zot/zot/blob/main/test/blackbox/helpers_pushpull.bash
Checked: 2026-11-23

```text
if [ "${PUSHPULL_FIPS_MODE:-0}" = 1 ]; then
    export GODEBUG="fips140=only"
fi
```

Source: https://github.com/search?q=org%3Agoharbor+FIPS&type=code
Checked: 2026-11-23

GitHub code search through the API (`search/code?q=org:goharbor+FIPS`), and the same search of
the Harbor website repository:

```text
org:goharbor FIPS: total_count 2 (src/pkg/reg/adapter/awsecr/adapter.go, src/pkg/reg/adapter/awsecr/adapter_test.go)
repo:goharbor/website fips: total_count 0
```
