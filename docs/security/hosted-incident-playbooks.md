# Hosted deployment: incident playbooks

Last reviewed: 2026-11-24

These playbooks are for a hosted site your organization runs: HQ and its edge sites. They cover the incidents that hit the trust the site is built on: its keys, its certificate authority, its hardware security module, its seal, people's passkeys, releases to observers and the credentials behind them (IR-4, IR-8). The maintainers' own process for a problem in the product is the [incident response plan](incident-response.md); a site incident whose cause is in the product also goes to the maintainers through private vulnerability reporting.

Each playbook has the same five parts: how the incident is detected, how it is contained, how service is restored, who is told, and what evidence is kept. Steps that the Phase 47 runbooks own (the key ceremony, enrolment and re-enrolment, moving a person, backup and restore, media handling) are cited by path; until a runbook exists, the playbook names the plan that writes it. Reporting to anyone outside your organization (the Canadian Centre for Cyber Security, an empowered official for ITAR, a designated official for Controlled Goods, a privacy regulator) is your organization's decision and its own step; the product never reports for it.

The alerts named below are the rules in `deploy/values/prometheus-alerts.yaml` (48.1-02, with more from 48.1-12); the evidence is the site's audit store, its write-once archive (48.1-14) and the site evidence export.

## Signing key compromise

Today one cosign key pair signs everything that crosses between sites: our released and rebuilt images (in the protected `container-release` environment of `.github/workflows/deploy-images.yml`), every image re-signed at bundle build, the bundle manifest (`deploy/bundle/build.mjs`), person exports (`deploy/keycloak/users.mjs`), certificate requests and revocation lists (`deploy/openbao/pki-files.mjs`). Admission (`deploy/charts/sterling-admission/templates/image-policies.yaml`) and every import check against `organizationPublicKey` in the site file. By owner decision a (2026-11-24) this becomes two keys, a supplier release key and an organization site key; 48.1-21 splits this playbook when 48.1-17 has landed.

No timestamp authority dates our signatures (the cosign signing configuration is empty: no transparency log, no timestamp authority, `deploy/bundle/lib/cosign.mjs`). After a compromise, a signature made before it cannot be told apart from one made after, so every signature that key ever made is treated as suspect and every signed item is re-issued (POA&M item g404).

- **Detection.** A signature nobody expected (an image, bundle or file signed outside a planned build); a bundle import or file import refused or not explained by an operator; admission refusing or accepting an image no build produced; a report that the key or its password leaked (a secret scan, the `container-release` environment's history, a lost build host).
- **Containment.** Stop every bundle build and import, and every person export, certificate request and revocation list exchange. Remove the key from the `container-release` environment and from every build host; revoke access to wherever its password was kept. Leave admission running with the old public key until the new one is installed, so nothing new is admitted that the old key did not already admit; review recent admissions.
- **Recovery.** Make a new key at a key ceremony (`deploy/runbooks/key-ceremony.md`, 47-17). Put the new public key in every site file as `organizationPublicKey` and in admission. Re-sign every image, rebuild and re-sign every bundle, and re-issue every signed file still in use: person exports, the site intermediates (new signed certificate files) and the revocation lists. Each site re-verifies the image digests it imported against HQ's bundle manifests signed with the new key.
- **Who is told.** Your organization's security officer and its authorizing official; every site's operators; the maintainers through private vulnerability reporting if the cause is in the product or its release pipeline.
- **Evidence.** Bundle manifests and their signatures, import records, admission decisions and the Kubernetes audit log in the audit store and its archive, the `container-release` environment's deployment history, and the key ceremony record.

## HQ root or intermediate compromise

HQ's offline root signs each site's intermediate in the key ceremony, and each site's OpenBao intermediate (`pki_int`) issues its server and session certificates through cert-manager (`deploy/openbao/pki-files.mjs`, D-49, D-50). People's signing keys live in OpenBao Transit, not in the PKI, so their signatures are not affected.

- **Detection.** A certificate nobody issued (in a TLS handshake, a scan or the issuer's records); the root's offline host or media found tampered; an intermediate's key exposed (OpenBao audit entries reading or exporting `pki_int` that no operator made).
- **Containment.** For an intermediate: revoke it at HQ and carry the revocation list to every site as a signed file (`pki-files.mjs export-crl` and `import-crl`); stop the site's cert-manager issuers. For the root: stop trusting it at every site by removing it from the site CA chain (ConfigMap `sterling-site-ca`) once a replacement is ready.
- **Recovery.** For an intermediate: the site makes a new key and a signed certificate request (`pki-files.mjs csr`), HQ's root signs it in the key ceremony, the site imports it (`import-intermediate`), and cert-manager re-issues every leaf certificate. For the root: a new root ceremony (`deploy/runbooks/key-ceremony.md`, 47-17), the new root to every site on install media, every intermediate re-issued, then every leaf.
- **Who is told.** Your organization's security officer and authorizing official; every site's operators; anyone outside your organization who trusts the root.
- **Evidence.** The key ceremony records, the revocation lists, OpenBao's audit of `pki_int`, cert-manager's certificate records, and the audit store.

## HSM loss or tamper

At a production site the HSM holds OpenBao's seal key (the PKCS#11 seal in `deploy/values/openbao.yaml`) and, by owner decision a, the organization site key. Losing it, or finding it tampered, stops OpenBao from unsealing.

- **Detection.** The `OpenBaoSealed` alert, or `OpenBaoMetricsTargetDown` while OpenBao is sealed and its metrics cannot be read; the HSM's own tamper alarm or log; an HSM missing or its seals broken at an inspection.
- **Containment.** Treat a tampered HSM as compromised: take it out of service, keep it for investigation under your organization's handling of export-controlled hardware, and treat every key it held as exposed (the signing key playbook above for the site key). Do not try to unseal with a tampered module.
- **Recovery.** Restore the seal key from the HSM's backup to a replacement HSM, then restart OpenBao; the key plan (48.1-08) requires that backup and its off-site copy (owner decision d). Without a backup of the seal key, the site's OpenBao data cannot be unsealed: every secret and every person's key at that site is lost, and the site is rebuilt and people re-enrolled (`deploy/runbooks/re-enrolment-and-recovery.md`, 47-17).
- **Who is told.** Your organization's security officer and authorizing official; the site's operators and the people whose sessions stopped; the HSM's supplier under your organization's support contract.
- **Evidence.** The HSM's logs, the inspection record, OpenBao's server logs and the seal alert history, and the chain of custody of the replaced module.

## Unseal failure

OpenBao starts sealed and unseals itself from the HSM (the PKCS#11 seal), or by custodians' key shares at a Shamir site. While it is sealed, sessions stop at the identity state and show Retry (DESIGN section 7): nobody can read secrets or sign.

- **Detection.** The `OpenBaoSealed` alert or `OpenBaoMetricsTargetDown`; sessions stuck at the identity state; OpenBao's server log naming the seal error.
- **Containment.** Nothing to contain unless the cause is tampering (then the HSM playbook above). Tell people that signing is unavailable rather than letting them retry.
- **Recovery.** At an HSM site: check that the HSM is reachable from the OpenBao nodes, that the slot and token label match the site file, and that Secret `openbao-hsm-pin` holds the right PIN; then restart the OpenBao pods. At a Shamir site: the custodians bring their shares and unseal each node. If the seal key itself is gone, the HSM playbook applies.
- **Who is told.** The site's operators and the people whose sessions stopped; your organization's security officer when the cause is not a simple outage.
- **Evidence.** OpenBao's server logs, the alert history, and a note of who unsealed and when (custodians at a Shamir site).

## Person key or passkey compromise

A person's passkey (a phone or hardware key) is lost or stolen, or their OpenBao keys are suspected used by someone else. Signing needs a fresh passkey ceremony (step-up), and each person's keys are reachable only by their own session (`deploy/openbao/policies/sterling-workbench.hcl`).

- **Detection.** The person reports a lost device or key; a sign-in or signature at a time or place the person disputes (Keycloak events, OpenBao audit entries for their entity); a staff lead questions a signed decision.
- **Containment.** Remove the credential in Keycloak and end the person's sessions; if the person's own computer is at risk, disable the account until they are re-enrolled in person.
- **Recovery.** Attested re-enrolment with a new passkey (`deploy/runbooks/re-enrolment-and-recovery.md`, 47-17). Review OpenBao's audit for signatures by the person's entity in the window of doubt, and rotate their Transit signing key to a new version so later signatures are distinct. Decisions signed in the window are reviewed by the staff leads who relied on them.
- **Who is told.** The person; the staff leads whose decisions the person signed in the window; your organization's security officer.
- **Evidence.** Keycloak events for the person, OpenBao's audit entries for their entity, the re-enrolment record, and the list of decisions reviewed.

## Spill to an observer

An observer read content outside its releasability: a marked cell released to someone without the matching credentials, or material an observer should never have seen. The observer rules are in [`hosted-observers.md`](hosted-observers.md).

- **Detection.** The observer or a member reports it (the rules of behaviour require the observer to report at once); a review of releases finds a release the policy did not allow; the hub's or the audit store's records show a read outside the grant.
- **Containment.** Remove the observer from the project's roster, which rekeys the affected cells so later content is out of reach; end the observer's session. Establish from the hub's records and the audit store exactly what the observer could read and when.
- **Recovery.** Rekey every affected cell, correct the grant or marking that allowed the release, and review the policy's sensitivity table and agreements for the observer's organization before admitting anyone from it again.
- **Who is told.** Your organization's security officer and its foreign disclosure authority; for Controlled Goods or ITAR content, the officials who decide on any disclosure (a designated official, an empowered official), whose duty to report outside your organization is theirs to judge (`controlled-goods-and-itar.md`); the observer's organization under the agreement that admitted them.
- **Evidence.** The roster history, the release and approval entries (including the credential hashes `observer.approve` bound), the hub's records, the audit store and its archive.

## Credential issuer or status-list key compromise

In the data-centric access design (Phase 71 core), officers issue people's credentials with their own person keys under role credentials chained to your organization's root, and HQ signs credential status lists with the OpenBao Transit key `status-list-<site>`. A compromised issuer could issue false credentials; a compromised status-list key could un-revoke a credential. The commands named here arrive with Phase 71 (core); this playbook describes the response from the design.

- **Detection.** A credential nobody issued, found at a release check or in an audit; a status list that does not match HQ's records; OpenBao audit entries signing with `status-list-<site>` outside the scheduled refresh.
- **Containment.** For an issuer: revoke the issuer's role credential, so every credential it issued fails the chain check. For the status-list key: rotate the Transit key, publish a fresh status list signed with the new version, and stop accepting lists signed with the old one.
- **Recovery.** Re-issue the affected people's credentials from a trusted issuer; publish fresh status lists to every site (by file to disconnected edges); rekey the cells whose releases relied on a credential in doubt.
- **Who is told.** Your organization's security officer and the officers who issue credentials; every site's operators; the observers' organizations whose people hold re-issued credentials.
- **Evidence.** The issued credentials and status lists, OpenBao's audit of the Transit key, the release checks that relied on them, and the audit store.

## Stale status list at an edge

An edge site decides releases with the newest signed status list it has. When an edge has been offline longer than the policy's maximum offline age for a level (examples: Protected A 7 days, Protected B 72 hours, classified 24 hours; your organization's security officer sets them in its signed policy), releases at that level stop until a fresh list arrives.

- **Detection.** Releases at a level refused at the edge with the status list's age as the reason; the continuous monitoring checks (`hosted-continuous-monitoring.md`) showing an edge's list older than its limit.
- **Containment.** None needed: refusing is the safe state. Nobody lifts the limit locally; the signed policy is HQ's.
- **Recovery.** The edge operator carries HQ's signed export, with the fresh status lists, to the edge by file under the media rules and imports it; releases resume once the list verifies.
- **Who is told.** The edge's staff leads (whose releases are waiting) and HQ's operators; your organization's security officer when an edge stays stale past a planned resupply.
- **Evidence.** The refused release checks with their reasons, the import record of the fresh list, and the edge's evidence export.
