# Hosted deployment: personal information

Last reviewed: 2026-11-24

This document lists where a hosted site your organization runs holds personal information, how long it is kept and how it is disposed of, what tests use instead, and the inputs your organization's privacy impact assessment needs (PM-5(1), PM-25, SI-12). It covers the Sterling workbench at a site your organization owns: HQ and its edge sites.

The ITSG-33 Medium profile does not select the PT (personally identifiable information processing and transparency) family, so this document does not claim to meet it. Your organization's privacy office decides what its own privacy program requires; this document gives it the facts from the code. Each row names the file in this repository that sets the behaviour, so a reviewer can check it, and each retention period names the site setting that sets it.

## Personal information inventory

| Store | Personal information | Where it is held | Who can read it | Kept for | Disposed of by | Source in this repository |
|---|---|---|---|---|---|---|
| Keycloak users | Name, email, username, enrolment state and required actions | Keycloak's Postgres database on the site's encrypted storage class | Keycloak administrators; each person sees their own profile | While the person holds an account | Removing the account in Keycloak at departure, under your organization's records period | `deploy/keycloak/realm.json` (user profile: username, email, first and last name) |
| Keycloak events | The user id, client and IP address of each sign-in and of failed sign-ins; administrator events with the changed representation | Keycloak's database, then the site log store as container logs | Keycloak administrators; auditors through the log store | `eventsExpirationSeconds` in Keycloak (90 days in the example), then the log store's retention | Keycloak expires its own events; the log store follows its retention | `deploy/keycloak/realm.json` (`eventsEnabled`, `adminEventsDetailsEnabled`), `deploy/values/site.example/sterling-keycloak-realm.yaml` |
| WebAuthn credential records | Credential id, public key, authenticator model (AAGUID), sign count, attestation format, transports, the person's label | Keycloak's database at each site where the person is enrolled | Keycloak administrators | While the credential is registered | Removing the credential, or the account, in Keycloak | `deploy/keycloak/users.mjs` (`STORED_FIELDS`) |
| Signed person exports | Username, email, first and last name, enabled and email-verified flags, and the WebAuthn records above | A `sterling-users/1` file at the sending site, on the media that carried it, and at the receiving site until imported | The operators who carry and import it | Until your organization's media and records rules dispose of it | Your organization's media handling (the Phase 47 follow-up's media runbook) | `deploy/keycloak/users.mjs` |
| Roster attributes in shared staff projects | Name, role, positions and how a person serves | Signed project logs at the hubs and on members' devices; the logs cannot be edited | Project members, by key group | The life of the project | Retiring the project; its logs are kept or destroyed as a whole under your organization's records rules | `src/domain/replica/rosterView.ts` |
| Report-unable reasons (when the portfolio and assignment design lands; not on main yet) | A chosen reason (medical, compassionate, conflicting tasking, not qualified, not cleared) or free text up to 500 characters | Sealed to the personnel key group of the project (the tasker and their authority chain) | The tasker and their authority chain only | The life of the project | With the project | `.planning/research/portfolio-and-assignment/DESIGN.md` (`posting.unable`) |
| Session and Workspace records | The person's identity from sign-in (their email) as the owner of each session and workspace | The Kubernetes API (etcd, encrypted) and its audit log | Site operators with cluster rights; auditors through the log store | While the session or workspace exists | Deleting the Workspace record; the audit copies follow the log store | `deploy/rke2/audit-policy.yaml` (theia.cloud at Request level) |
| Audit logs | Usernames, request paths, client addresses and, for Theia Cloud writes, request bodies; OpenBao audit entries with secret values hashed | `audit-*` indices in the site log store, then the write-once audit archive (48.1-14) | Auditors (the log store's audit-reader role); no one can edit them | 1,825 days for every hosted audit record: 730 days online, then the write-once archive (owner decision b, 2026-11-24) | Deletion only after the archive holds the day, and the archive only after 1,825 days | `deploy/values/opensearch.yaml`, `deploy/values/openbao.yaml` (`audit "file" "stdout"`, `log_raw = "false"`) |
| Workspace volumes | The person's project files, settings and workbench state | One Longhorn volume per workspace on the encrypted class, with its replicas | The person through their session; site operators with storage rights | While the workspace exists; the class keeps a volume after its session is removed | See "A person who leaves" below | `deploy/charts/sterling-storage/templates/storageclass.yaml` (`reclaimPolicy: Retain`) |
| Per-person secrets and keys | Secrets the person stores, and their key-encryption and signing keys | OpenBao kv (`kv/users/<entity>/`) and Transit (`kek-<entity>` and the signing key), keyed by the person's OpenBao entity | Only the person's own session token; key moves need two-person approval | While the person holds an account | See "A person who leaves" below | `deploy/openbao/policies/sterling-workbench.hcl`, `deploy/openbao/enrol.mjs` |
| Backups and dumps | Copies of everything above | Longhorn snapshots and backups on the site's backup target; nightly Postgres dumps on the encrypted class | Site operators with backup rights | Snapshots 7 days and backups 14 days (`snapshot.retain`, `backup.retain`); dumps `dump.retainDays` (14) | Aged out by the recurring jobs and the dump job | `deploy/values/site.example/longhorn.yaml`, `deploy/charts/sterling-postgres/templates/backup.yaml`, `deploy/values/site.example/sterling-postgres.yaml` |

## Retention and disposal

| Store | Retention setting | Disposal |
|---|---|---|
| Keycloak users and credentials | None: kept while the account exists | Account removal in Keycloak |
| Keycloak events | `eventsExpirationSeconds` (site realm file) | Keycloak's own expiry |
| Signed person exports | Your organization's records rules | Media handling (Phase 47 follow-up) |
| Roster and report-unable reasons | The life of the project | Retiring the project |
| Session and Workspace records | While they exist | Deleting the record |
| Audit logs | 1,825 days, 730 online (owner decision b); a site may set longer, never shorter | Online indices are deleted only after the archive holds and verifies their day (48.1-14 to 48.1-16) |
| Workspace volumes | While the workspace exists (`reclaimPolicy: Retain` keeps the volume after its claim) | Deleting the claim, the volume and the Longhorn volume |
| Per-person secrets and keys | While the account exists | Deleting the entity's secrets and keys |
| Backups and dumps | `snapshot.retain`, `backup.retain`, `dump.retainDays` | The recurring jobs |

**A person who leaves.** Your organization first exports what it must keep under its records rules (the person's project files and any record it needs). Then, in this order: remove the person's Keycloak account (their credentials go with it); remove their OpenBao entity's secrets under `kv/users/<entity>/`, and their Transit keys only after no signature made with them still needs to be verified, because a deleted key can no longer verify the person's signed decisions; delete their Workspace record; delete the workspace volume's claim, then the volume and the Longhorn volume, which the storage class keeps after the claim goes. Snapshots and backups of the volume age out with `snapshot.retain` and `backup.retain`.

**The crypto-erase limit.** One LUKS class key (`longhorn-crypto`) encrypts every workspace volume, because the Theia Cloud operator creates the workspace claims itself and a per-volume key is not possible. So removing a volume does not cryptographically erase it: the data stays on the disks, encrypted with a key that still opens every other volume, until the blocks are reused. Disks that leave the site follow your organization's media handling; the Phase 47 follow-up owns that runbook, and this document plans none of it. The limit is POA&M item g363 for your organization's authorizing official to accept, or for per-person volume keys to be designed.

## Testing and training data

Tests, fixtures, the lab and the load test use generated or fictional people only, never real personal information:

- The load test makes its users with `node loadtest/src/cli.ts users`, outside the repository: `loadtest-user-NNNN` with `@loadtest.invalid` addresses and generated passwords (`loadtest/README.md`). Its realm, `loadtest/realm/loadtest-realm.json`, defines no users and exists only on the test rig; the offline bundle never carries it, because the bundle's deploy tree holds only `deploy/` without `deploy/test/` and `deploy/lab/` (`deploy/bundle/build.mjs`).
- The deploy tests use fictional or historical people at reserved example domains, for example `ada@sterling.example` in `deploy/test/federation.test.mjs`, and the CI site file `deploy/test/fixtures/site.ci.yaml` uses `site.example`.
- Training for site staff uses the lab with the same generated people. If your organization ever trains with copies of real records, its privacy office approves that first.

## Privacy impact assessment inputs

The facts your organization's privacy impact assessment needs. The assessment itself, and its decisions, are your organization's.

- **Data elements.** The inventory above: identity (name, email, username), authentication records (WebAuthn public keys, sign counts), sign-in events with IP addresses, roster and position details, report-unable reasons, project content in workspaces, per-person secrets, and audit records.
- **Purposes.** Sign-in and access control; per-person secrets and signing; staff coordination in shared projects; security audit and incident investigation; backup and recovery.
- **Flows.** Every exchange that crosses the site boundary is in the generated register [`hosted-interconnections.md`](hosted-interconnections.md), including the signed person exports between sites; flows inside the site are in the hosted section of [`data-flow.md`](data-flow.md).
- **Retention.** The retention table above, with the site setting for each.
- **Safeguards.** Encryption at rest (the encrypted storage class, etcd secrets encryption) and in transit (TLS inside and outside the cluster); per-person access in OpenBao, where a session token reaches only its owner's secrets and keys; sign-in by passkeys or hardware keys with no passwords; audit records that no one can edit, archived write-once.
- **Where data may leave the site.** Only to the model endpoints your organization's signed policy lists (egressAllow and modelServers; decision D7 of `.planning/research/multiuser-hosting/DESIGN.md`), to the site's own mail server, and by the signed files in the exchange register. Nothing is sent to the maintainers.
- **Decisions only your organization makes.** Whether a privacy impact assessment is required and at what level; the records periods for accounts, projects and exports; which model endpoints may receive project content; what people should not write in free-text fields such as report-unable reasons (for example health or family details); and whether to accept the crypto-erase limit.
