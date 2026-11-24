# Enrolling a person

**What it is for.** Giving a person a Sterling account that signs in with passkeys or hardware keys only, with two keys registered, and their own signing keys in OpenBao (D-31, D-33, D-57).

**Who does it.** A site administrator, with the person present or reachable through the site's own mail server.

**What you need.** A Keycloak administrator token file and an OpenBao token file with the `enrolment` policy (tokens come from files, never from a command line); the site CA; the person's name and email.

## The steps

1. **Create the person** in the `sterling` realm, with the required action `webauthn-register-passwordless`. There is no password.
2. **Send the registration link** through the site's own mail server (Keycloak's execute-actions email), or enrol the person in person at the enrolment desk.
3. **Register the first key, then the second.** What counts depends on the site's `signInKeys`:
   - `passkeys`: any passkey. A phone passkey plus a second passkey or device counts.
   - `hardware-only`: approved hardware key models only (the AAGUIDs in `acceptableAaguids`). Synced passkeys fail the allowlist.

   Use a passkey on the same device as the browser. The cross-device QR flow needs Bluetooth and an Apple or Google internet relay, which an air-gapped site does not have; where a site is connected, use it only if your organization's policy allows that commercial cloud.
4. **Make their signing keys.** `node deploy/openbao/enrol.mjs enrol --user <username> --keycloak https://keycloak.<domain> --realm sterling --keycloak-token-file <file> --bao <address> --ca-file <site CA> --bao-token-file <file>`. It refuses until two keys are registered. Then it creates the person's OpenBao entity and their two non-exportable Transit keys. Until then the person can sign in but cannot sign.

## Adding an approved hardware key model

Under `hardware-only`, add the model's AAGUID to `acceptableAaguids` in the site file, then apply the realm again: `node deploy/keycloak/apply.mjs --site <site file> --realm-site <site folder>/sterling-keycloak-realm.yaml --keycloakx-site <site folder>/keycloakx.yaml` (or `install.mjs apply`, which runs it).
