# Moving a person between sites

**What it is for.** Moving a person, with their passkeys and their signing keys, from one Sterling site to another, with two-person approval for the keys (D-36, D-40, D-49).

**Who does it.** A site administrator at each site, and two key custodians at each site.

**What you need.** Both sites use the same relying-party id (`rpId`, D-08), or the person's keys will not work at the destination. Your organization's site key in the HSM (`key-ceremony.md`), the public key from the install media, Keycloak and OpenBao token files at each site, and approved media for carrying files (the media handling runbook).

## The steps

1. **Export the person at the source.** `node deploy/keycloak/users.mjs export --users <username> --out <file> --key <site key> --site <site file> --keycloak https://keycloak.<domain> --token-file <file>`. Pass the site key's PKCS#11 URI as `--key`: user exports, CSRs and revocation lists are signed with the site key in the HSM, never a key file.
2. **Carry the signed file** to the destination on approved media.
3. **Import at the destination.** `node deploy/keycloak/users.mjs import --in <file> --public-key <public key> --site <site file> --keycloak https://keycloak.<domain> --token-file <file>`. It checks the signature and the relying-party id before any change.
4. **Move their keys** through the key-move policy only:
   - at the source, an operator with the `key-move` policy requests the export of the person's Transit keys; OpenBao holds it as a Control Group request;
   - two key custodians approve it (OpenBao does not notify them: tell them the request's accessor);
   - the wrapped export travels to the destination as a signed file;
   - at the destination, the import is again a Control Group request with its own two approvals.
5. **Bind the entity at the destination.** `node deploy/openbao/enrol.mjs enrol --user <username> ...` at the destination.
6. **Retire the person at the source**: disable the account, and remove their keys there through the same two-person approval.
