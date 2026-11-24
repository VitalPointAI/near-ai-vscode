# Hosted deployment: continuous monitoring

Last reviewed: 2026-11-24

This is the continuous monitoring strategy for hosted sites your organization runs: HQ and its edge sites, connected or disconnected (CA-7). It says what is monitored, how often, by whom, how a disconnected edge reports to HQ, and what triggers a reassessment. It uses the evidence windows the dashboard already enforces, so a missed check shows as Stale or failing rather than as an old pass.

## What is monitored

- **The hosted rows of the dashboard.** Each site's controls read their evidence from the signed site evidence export (`compliance/site-export/collect.sh` and `node compliance/src/cli.ts site-export`; see "Hosted deployment evidence" in `compliance/README.md`): the realm's sign-in flows, audit events shipped to the log store, nodes in FIPS mode, the signature, SBOM and provenance of every image in the lock list, sessions with the FIPS provider on, the OpenBao seal type, the audit policy and the component versions.
- **Alerts.** The rules in `deploy/values/prometheus-alerts.yaml`: OpenBao sealed or failing to audit, audit shipping failing or audit records not reaching the store (48.1-02), and certificate expiry, backup failure and refused unsigned images (48.1-12), each with a guard so a missing input raises an alert.
- **Image scanning.** The scan of the bundle's images from the Phase 47 follow-ups, so a new advisory against a pinned image is seen between releases.
- **Certificates and revocation lists.** cert-manager's certificates (alerted), and the HQ root, the site intermediates and the revocation lists' next-update times (monthly checklist below).
- **Keys.** The key inventory and its checks against the code (48.1-08): every key's holder, rotation and expiry.
- **Documents.** Each SA&A document's review date, within its 365-day window, and the generated blocks of the hosted documents, checked in CI.
- **Credential status.** At sites that use the data-centric access design (Phase 71 core), the age of each site's credential status lists against the policy's limits.

## Cadence

| What | How often | Who |
|---|---|---|
| Alerts | Continuously; mail to the site setting `alertRecipients` | Your organization's security operators |
| Site evidence export | At least weekly, inside its 7-day window: an export older than 7 days reads Stale | The site operator makes it; the security officer reviews the dashboard |
| Credential status lists | Refreshed within the policy's time to live (example: 15 minutes at a connected HQ) | Automatic at a connected site; see "Disconnected sites" |
| Monthly checklist | Monthly, and after every key rotation | The site operator, signed off by the security officer |
| Access review | Quarterly, against the roles and separation of duties matrix (`hosted-roles-and-duties.md`, 48.1-10) | The security officer with the staff leads |
| Documents | Each within its 365-day review window | The document's owner |
| Reassessment | Yearly, and on any trigger below | Your organization's authorizing official, with the security officer |

The monthly checklist covers what no alert covers: the HQ root and site intermediate expiry dates; the revocation lists' next-update times against how long media takes to reach each edge (`crlExpiry`); the HSM's health and its backup; and the escrow of the RKE2 token and encryption configuration, which are node files no in-cluster check can read: run `escrow-node.sh check` from the Phase 47 escrow work on each server node, and again after every key rotation.

## Disconnected sites

A disconnected edge site keeps the same cadence by file:

- The edge operator makes the signed evidence export on site at least weekly and carries it to HQ by file under your organization's media rules. HQ reads it in its own organization view with its own trust list of site signing keys; the public dashboard never sees it.
- The edge operator carries HQ's signed export back, with fresh credential status lists, within the policy's maximum offline age for each level (examples: Protected A 7 days, Protected B 72 hours, classified 24 hours; your organization's security officer sets them in the signed policy). Past that age, releases at that level stop at the edge until a fresh list arrives (the stale status list playbook in `hosted-incident-playbooks.md`).
- A late file shows as Stale at HQ rather than an old green, because each export is judged on its own signed time.
- Alerts still mail the edge's own security operators through the edge's mail server; an edge with no mail server on site keeps the alert history in its Prometheus and the operator reviews it when making the weekly export.

## Reviews and triggers

- **Who reviews.** Your organization's security officer reviews the dashboard after each export and signs off the monthly checklist; site operators act on alerts and make the exports; auditors review the audit store (the review runbook in `hosted-audit.md`, 48.1-12); the authorizing official decides on reassessment and on POA&M items.
- **What triggers a reassessment.** A new component, exchange or external service (a change to `compliance/resources.json` or `compliance/hosted/exchanges.json`); a key compromise or any incident in the hosted playbooks; a major version of any stack component (RKE2, Keycloak, OpenBao, Theia Cloud, OpenSearch); a change to the signed policy's sensitivity table or agreements; repeated admission refusals of unsigned images; and an evidence export that stays Stale or failing past one cycle.
