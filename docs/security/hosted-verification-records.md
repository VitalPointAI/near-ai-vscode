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

## Verification register

| # | Item | State | Reference |
|---|---|---|---|
| 3 | Keycloak CVE-2026-6856 (acceptable AAGUID bypass with self-attestation): the fixed version to pin | closed | Record: Keycloak CVE-2026-6856 fix version; gap G321 |

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
