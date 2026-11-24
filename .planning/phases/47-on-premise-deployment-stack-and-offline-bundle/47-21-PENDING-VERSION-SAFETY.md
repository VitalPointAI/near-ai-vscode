# PENDING: version safety amendment for plan 47-21 (guest accounts)

**Status:** pending. Apply when PR #182 (`docs/phase-47-guest-accounts`, plans 47-19 to 47-21) has merged. On 2026-11-24, when this note was written, #182 was open, so 47-21 is not on `main` and cannot be edited here. Delete this note in the commit that applies the change.

**Why:** 47-21 keeps the user export at `sterling-users/1` and adds an optional `guest` field to a person's record. A site whose import is 47-14's alone does not know that field. It would ignore it and create the guest as an ordinary member, outside the `guests` group, with no end date. Version safety (32.1 D-60, D-69 row 5; 47 D-69) closes that gap: an authoring check first, an edge refusal as the backstop.

**What 47-21 needs (all in `deploy/keycloak/users.mjs` and `deploy/test/federation.test.mjs`, the files it already changes):**

1. **The file names the feature.** An export that names at least one guest writes `requires: ["guests@1"]`. An export with no guest keeps `requires: []`, so it still imports at a site on 47-14 alone.
2. **The import reads it.** `USERS_FEATURES` (exported by `users.mjs`, empty after 47-14) becomes `["guests@1"]`. A guest record in a file whose `requires` lacks `guests@1` is refused, whole, with zero admin calls. 47-14's rule already refuses a file naming an id the import does not read, with one sentence for the administrator.
3. **The export checks the target site first.** `export --include-guests` takes `--target-site <id>`, `--sites <file>` and `--site-exports <folder>`, the same inputs as the rules tool (32.1 D-62). It refuses, writing no file, unless the target site's newest verified site evidence export, from the last 7 days, shows an import that reads `guests@1` (`reads.users` in the site's release record). No recent export counts as unknown and is refused. The refusal names the site and the release it needs. Read the export with the rules of 32.1-30's `checkTargetSites`; if the deploy tools cannot load that compiled checker, add a parity test with it.
4. **The site reports what its import reads.** At install, the site's release record (47-32, ConfigMap `sterling-release`) gains `reads.users`, taken from the bundle's own `USERS_FEATURES`. The bundle is signed, so its deploy tree is trusted. 48-11's export already copies the whole `reads` map, so HQ sees it with no new export schema. This touches 47-32's record writer and render mapping: add one behaviour line there in the same change.

**Tests to add in 47-21's federation cases:**
- An export with a named guest carries `requires: ["guests@1"]`.
- A 47-14-only import fixture (its `USERS_FEATURES` empty) refuses that file with zero admin calls.
- An export without guests imports there unchanged.
- `export --include-guests` refuses for a target site with no recent export, or one whose `reads.users` lacks `guests@1`, and writes no file.

**Threat row to add to 47-21:** Elevation of privilege. A guest imported as a full member by a site that does not read guest records. Severity critical, mitigated by items 1 to 3.
