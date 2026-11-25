# Guest accounts

**What it is for.** Giving a person from outside your organization a Sterling account for a fixed time, so they can observe shared work and give feedback, and ending it again (D-58 to D-64).

**Who does it.** A lead asks, a security contact approves, the site operator creates and ends the account, two key custodians approve any removal, and a security officer removes an ended guest's secrets. Section 1 says who does what.

**What you need.**
- A Keycloak administrator token file and an OpenBao token file with the `guest-operator` policy. Tokens come from files, never from a command line.
- The site CA, and the site's trust folder: your organization's signed rules, identity logs and status lists.
- The realm site file (`<site folder>/sterling-keycloak-realm.yaml`, written from `deploy/values/site.example/sterling-keycloak-realm.yaml`).
- The security contact's written approval, filed under a reference (for example `VR-002`).

The connection flags below are the same for every `guests.mjs` command:

```
--keycloak https://keycloak.<domain> --keycloak-token-file <file> --bao <OpenBao address> --ca-file <site CA> --bao-token-file <file>
--realm-site <site folder>/sterling-keycloak-realm.yaml
```

## 1. What a guest account is for

Guests are people from industry, allied military or other organizations who observe shared work and give feedback. In a shared project they hold an Observer position (Phase 33.1), which limits what they can do there.

- A **lead** at your organization asks for the guest.
- A **security contact** approves allied military and industry guests. They hold a `SecurityContactCredential` from your organization's issuer. They also issue the guest's own credentials, in their own session.
- The **site operator** creates, extends and ends the account, and enrols the guest.
- Two **key custodians** (the OpenBao group `key-custodians`) approve any removal of the guest's keys and records.
- A **security officer** removes an ended guest's secrets after your organization's retention period.

A guest can never hold an administrator role, and can never decide, approve or post anyone. Keycloak keeps only the account's dates and approvals. How the guest serves, their nationality, their organization, their access agreement and their visit clearance are credentials the security contact issues to the guest. They are never typed into Keycloak.

## 2. The states of a guest account

| State | What it means | What moves it on |
|---|---|---|
| requested | A lead has asked, in writing, for a named person, a purpose and an end date. | The security contact approves it, or refuses. |
| approved | The security contact has approved it in writing, under a reference. Allied military and industry guests always need this. | The site operator runs `guests.mjs create`. |
| created | The account exists in the group `guests`. The registration link is out. The guest has fewer than two keys, so they can sign in but cannot sign. | The guest registers two keys, then the operator runs `enrol.mjs enrol`. |
| enrolled | Two keys are registered and the guest has their own OpenBao entity `guest-<id>`. | The security contact issues the guest's credentials in their own session. |
| active | The guest works as an observer. | The end date passes, or someone ends the guest early. |
| overdue | The end date has passed but the automatic end has not run yet. `guests.mjs list` shows it. | The automatic end, or `guests.mjs expire` by hand. |
| ended | The account is disabled and every token it held has stopped. Its records are kept. | `guests.mjs extend` with a new approval, or removal after the retention period. |
| removed | The guest's keys, secrets and account are gone. Only the removal step does this. | Nothing. |

No state waits forever. A guest who never registers keys or never enrols is still ended at their end date.

## 3. Turning guests on at a site

1. Check that your release can issue and revoke a guest's credentials. A guest's credentials are issued by the security contact in their own session, and an early end puts a request on the revocation card. Without that card a guest holds no credentials, and `guests.mjs create` refuses any guest.
2. In the realm site file, set under `guests`:
   - `maxDays`: the longest a guest's end date may be from the day it is set. `0` turns guests off.
   - `checkMinutes`: how often the automatic end looks for guests past their end date.
   - `retentionDays`: your organization's retention period for an ended guest's records.
   - `sessionsNamespace`: where the Theia Cloud session records are (`theia-cloud` by default).
3. Apply the realm again: `node deploy/keycloak/apply.mjs --site <site file> --realm-site <site folder>/sterling-keycloak-realm.yaml --keycloakx-site <site folder>/keycloakx.yaml`.
4. Check that the automatic end is installed: `kubectl get cronjob sterling-guest-expiry -n sterling-identity`. Do not create guests until it is.

Your organization's issuer gives each security contact a `SecurityContactCredential`. There is no Keycloak group for security contacts.

## 4. Creating a guest

```
node deploy/keycloak/guests.mjs create --user <username> --email <address> --first <given name> --last <family name> --until <UTC time>
  --requested-by <lead> --approved-by <security contact> --approver-credential <file> --trust <folder> --approval-ref <reference> [--no-link]
  <connection flags>
```

- **The end date** is a UTC time ending in `Z`, for example `2026-12-31T17:00:00Z`. It must be in the future and within `maxDays`.
- **The approval.** `--approver-credential` is the security contact's `SecurityContactCredential` file. The script checks it against the trust folder for the security contact's own DID. It refuses, before any change, when the lead or the security contact is missing, disabled or a guest, or when the credential does not hold.
- **File the written approval** under the reference you gave with `--approval-ref`.
- **The guest's details** (how they serve, nationality, organization, access agreement, visit clearance) are credentials. The security contact issues them to the guest in their own session after enrolment. Never put them in Keycloak.

**Enrolment, in person by default.**
1. The guest comes to the enrolment desk. Check their identity against the visit request.
2. Send the registration link to a site-issued guest address, read at the desk. `create` sends it through the realm's mail settings (`smtp` in the realm site file). With `--no-link`, or when sending failed, the account stays and you send it again with `guests.mjs link --user <username> <connection flags>`.
   - "this realm has no mail server": set `smtp` in the realm site file and apply the realm again.
   - "Keycloak did not send the registration link": check the site mail server first, then the realm's `smtp` settings.
   - The link works for 24 hours.
3. The guest registers two keys. At an air-gapped site, use site-issued security keys, or a passkey on the same device as the browser. The cross-device QR flow needs an internet relay, which an air-gapped site does not have (D-57).
4. Run `node deploy/openbao/enrol.mjs enrol --user <username> --keycloak https://keycloak.<domain> --realm sterling --keycloak-token-file <file> --bao <OpenBao address> --ca-file <site CA> --bao-token-file <file>`. It refuses until two keys are registered.
5. The security contact issues the guest's credentials in their own session.

## 5. Extending, and ending early

- **Extend:** `node deploy/keycloak/guests.mjs extend --user <username> --until <UTC time> --requested-by <lead> --approved-by <security contact> --approver-credential <file> --trust <folder> --approval-ref <reference> <connection flags>`. It needs the same approvals as `create`. It enables an ended guest again, with their OpenBao entity. It refuses a guest who holds a role, another group or an OpenBao policy.
- **End early:** `node deploy/keycloak/guests.mjs end --user <username> --reason <text> <connection flags>`. The account is disabled, its sessions end, the OpenBao entity is disabled (every token stops at once) and the guest's Theia sessions stop. Nothing is deleted.

An early end puts a revocation request in the site's revocation inbox. The revocation card shows each officer who issued the guest a credential, the security contact among them, the credentials they issued. They revoke them in their own session. A guest's credentials also end on their own at the end date.

## 6. The automatic end

The CronJob `sterling-guest-expiry` in `sterling-identity` runs the same end as `guests.mjs expire` every `checkMinutes`. For each guest past their end date it:
- disables the account and ends its Keycloak sessions;
- disables the OpenBao entity `guest-<id>`;
- stops the guest's Theia sessions.

It keeps the workspace volume and every record. It also ends, early, any guest found holding a role, another group or an OpenBao policy, and that guest gets the same revocation request in the site's revocation inbox.

- See its runs and failures: `kubectl get cronjob,jobs -n sterling-identity`, then the log of a job: `kubectl logs -n sterling-identity job/<job name>`. Failed runs stay listed.
- See anyone overdue: `node deploy/keycloak/guests.mjs list <connection flags>`. A guest shown as `overdue` means the job has not run, or failed.
- Run the same end by hand: `node deploy/keycloak/guests.mjs expire <connection flags>`. It exits with an error when any side failed; run it again after fixing the cause.

## 7. A guest at another site

Guests stay at their site unless you name them. The guest's keys in OpenBao never move.

1. **At the source**, export the guest by name:
   `node deploy/keycloak/users.mjs export --users <username> --include-guests <username> --target-site <site id> --sites <sites file> --site-exports <folder> --bao <OpenBao address> --bao-token-file <file> --out <file> --key <site key> --site <site file> --keycloak https://keycloak.<domain> --token-file <file> --ca-file <site CA>`.
   - The export refuses a guest you did not name, and an ended guest.
   - It needs a signed site evidence export from the destination, less than 7 days old, showing that its user import reads guest records (`guests@1`). Without one it refuses, names the site and says what it lacks. The fix is for that site's administrator to update the site and send a fresh site evidence export.
2. **Carry two files** on approved media: the signed user export, and your organization's trust export `.near-trust-export`, which holds the identity logs, status lists and signed rules the destination needs to check credentials offline.
3. **At the destination, import the trust export first**, in the site's hub: copy the file into the hub pod (`hub-<name>-0` in `sterling-hubs`), then run `node /app/bin.mjs --trust-import <file>` there with `kubectl exec`.
4. **Import the guest**, with the destination's own lead and security contact:
   `node deploy/keycloak/users.mjs import --in <file> --public-key <public key> --include-guests <username> --realm-site <site folder>/sterling-keycloak-realm.yaml --requested-by <lead> --approved-by <security contact> --approver-credential <file> --trust <folder> --approval-ref <reference> --bao <OpenBao address> --bao-token-file <file> --site <site file> --keycloak https://keycloak.<domain> --token-file <file> --ca-file <site CA>`.
   - The guest arrives in the group `guests`, with an end no later than the source's and within this site's `maxDays`.
   - It refuses, before any change, a guest you did not name, and a guest this site's rules do not allow.
5. **Enrol the guest here** with `enrol.mjs enrol`, as in section 4. The security contact here issues the guest's credentials to the DID the import printed.

## 8. Collecting site-issued security keys

At the end of a visit, collect every site-issued security key from the guest and record it against the visit request. If a key is missing, end the guest now with `guests.mjs end`, and report the missing key to the security contact.

## 9. Removing a guest's records

Only after your organization's retention period, and only in this order.

1. **Written approval** from the security contact and the site administrator, filed with the visit request.
2. **The guest's keys and entity, with two key custodians.** An operator holding the `guest-removal` policy makes each request; OpenBao holds it as a Control Group request until two members of `key-custodians` approve it. OpenBao does not notify them: tell them each request's accessor.
   - First, `deletion_allowed` on the guest's two Transit keys (`person-<entity id>` and `kek-<entity id>`), through the `key-move` policy.
   - Then the deletes in `guest-removal`: the two Transit keys and the entity `guest-<id>`.
   - **Before approving each request, the custodians check that the entity id in its path belongs to an entity named `guest-<id>`.** OpenBao cannot limit the Transit and KV delete paths to guests, so this check is the guard (T-47-76).
3. **The guest's secrets, by a security officer.** A security officer runs "Remove ended guests' secrets" in the workbench after a passkey step-up, and picks from the guests past `retentionDays`. Until they do, the alert `GuestSecretsAwaitRemoval` and the workbench notice repeat (D-84).

   **The one remaining risk, stated plainly.** For the step-up window, the officer's token can delete any guest's secrets. It can never delete a staff member's, which sit under `kv/users/`. So a hand-made request in that window could remove the secrets of a guest who is still active. The workbench refuses anything but a disabled guest past retention, and OpenBao's audit log records every request with the officer's identity (T-47-140, accepted under D-84).
4. **Then the account and the workspace.** Delete the guest's Keycloak account in the administration console. With a cluster administrator, delete the guest's Workspace record and its volume in the sessions namespace.

The guest's signed comments in a shared project's log stay. That log cannot be edited.
