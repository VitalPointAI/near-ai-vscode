# Re-enrolment and recovery

**What it is for.** Getting a person back in after they lose a key, without weakening sign-in (D-09). **No recovery codes exist.** A lost key is replaced only after an administrator confirms the person's identity in person.

**Who does it.** A site administrator, with the person present.

**What you need.** The same Keycloak and OpenBao token files as for enrolment (`enrolment.md`), and your organization's identity check (for example the person's identity card).

## A lost key, the account kept

1. **Confirm the person in person**, by your organization's identity check. Never over the phone or by email alone.
2. **Remove the lost credential** in Keycloak (the person's Credentials tab), so it cannot be used if it is found.
3. **The person registers a replacement** (`enrolment.md`, step 3), so they again have two keys.
4. **Check** with `node deploy/openbao/enrol.mjs enrol --user <username> ...` (same flags as enrolment). A second run changes nothing; it confirms the two keys and that their entity and keys are in place.

## The account had to be recreated

If the person's Keycloak account was recreated (for example both keys were lost and the account was removed), their OpenBao entity, secrets and keys still belong to the old Keycloak id. After the new account has two keys:

`node deploy/openbao/enrol.mjs rebind --user <username> --from-sub <old Keycloak user id> ...`

It moves the person's sign-in alias to the new account, so the same entity, secrets and keys stay theirs.

## Suspected compromise

If a key or a device may be in someone else's hands, rotate the person's Transit keys in OpenBao (a key custodian does this). Re-wrapping the person's data keys under the new key is the workbench's job (Phase 46); the person's data stays readable.
