# Sterling site runbooks

These runbooks are for the people who install and run a Sterling site: site operators, site administrators and key custodians. Each one starts with what it is for, who does it, and what they need before starting. Every command named in them exists in this repository or in the pinned tools that come with the bundle.

## The runbooks

| Runbook | What it covers |
|---|---|
| `site-install.md` | Installing a site from the signed offline bundle on air-gapped hardware |
| `bundle-update.md` | Updating a site with a newer bundle, and going back to the previous one |
| `key-ceremony.md` | The HQ offline root, a site intermediate, the HSM or Shamir unseal, your organization's signing keys, escrow custody |
| `enrolment.md` | Enrolling a person with two keys |
| `guest-accounts.md` | Guest accounts for people from outside your organization: turning guests on, creating, enrolling, extending, ending, a guest at another site, and removing their records |
| `re-enrolment-and-recovery.md` | Replacing a lost key after an administrator confirms the person in person (no recovery codes) |
| `moving-a-person.md` | Moving a person and their keys between sites with two-person approval |
| `backup-and-restore.md` | What is backed up, where, and how to restore each part |
| `recovery-plan.md` | The recovery order, the RTO and RPO settings, degraded modes and the restore drill |
| `session-states.md` | What each session state means and what to do about it |
| `maintenance.md` | Patching, RKE2 upgrades, certificates, HSM firmware and maintenance records |

## The order a new site uses them

1. `key-ceremony.md`, part 1: your organization's signing keys exist and the public key is on the install media.
2. `site-install.md`, from the bundle check to `install.mjs retire-bootstrap`. It stops twice for `key-ceremony.md`: the OpenBao initialisation and unseal, and the site intermediate.
3. `enrolment.md` for every person; `guest-accounts.md` for guests, only once guests are turned on; `re-enrolment-and-recovery.md` and `moving-a-person.md` when needed.
4. `backup-and-restore.md` and `recovery-plan.md`: confirm the schedules with `drill.mjs plan` and run the first drill.
5. `bundle-update.md` and `maintenance.md` from then on.
