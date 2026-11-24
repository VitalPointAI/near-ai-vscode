# Hosted deployment: observers

Last reviewed: 2026-11-24

An observer is someone admitted to a shared staff project to read it: an allied military officer, an industry partner, or a person from elsewhere in your organization. An observer reads what they are granted and writes only presence; the project keeps every other entry an observer writes and lets it change nothing (`src/domain/replica/verify.ts`, "observer-only"). This document is what your organization puts in place before admitting one at a hosted site: the releasability vocabulary, who sets it, the credentials and agreements an observer needs, and the rules the observer follows (AC-16, AC-21, AC-21.400, AC-21.401, PS-6, PL-4).

Access is decided by DIDs with Verifiable Credentials and enforced by the data itself, with zero trust (your organization's direction of 2026-11-24; the data-centric access research). The release check that applies these rules is built by Phase 71 (core) and used by the observer waves of Phase 33.1; until it is on `main`, the product makes no claim that it enforces them.

## Releasability tokens

Releasability says which nations or groups may receive marked content. The gate enforces this grammar (`src/domain/gate/labels.ts`):

- A token is upper-case letters and digits, with `_` and `-` allowed after the first character, at most 32 characters (`LABEL_TOKEN_PATTERN`).
- The reserved token `RELEASABLE-TO-NONE` means releasable to no one. It may only stand alone in a label, so it can never be hidden among real entries, and no clearance may list it.
- An empty releasability list means unrestricted.
- Joining two labels keeps only the tokens both allow. When they share none, the result is `RELEASABLE-TO-NONE`, never unrestricted.

The vocabulary your organization uses is ISO 3166-1 alpha-3 country codes (for example `CAN`, `USA`, `GBR`) and group tokens your organization defines and publishes with their member countries (for example a token for a standing alliance or coalition). Your organization's designated authority sets the group tokens in its signed policy.

A person's releasability is presented as a `NationalityCredential` or an `AffiliationCredential` that uses the same tokens. Everyone who holds a marked cell needs a matching one.

The gate compares tokens literally. A token outside the vocabulary, or a different spelling of one in it (`UK` for `GBR`), never matches, so the content is refused: a spelling mistake fails closed, never open.

## Authority

- **A product's releasability** is set by its originator, with your organization's foreign disclosure authority for anything released outside the nation. No agent decides releasability; a person does, and the product enforces what they decided.
- **A person's attributes** are credentials: `ClearanceCredential` (their level), `NationalityCredential` or `AffiliationCredential` (their releasability), `CompartmentCredential` and `ExportEligibilityCredential` where they apply. Officers issue them from their own sessions with their own person keys, under role credentials (for example `SecurityContactCredential`) that chain to your organization's root `did:webvh` and are listed in the signed policy's `credentials@1` section.
- **Revocation.** HQ's signed status lists say which credentials are revoked or suspended; a revoked credential fails every check from the next list a site receives (see "Stale status list at an edge" in [`hosted-incident-playbooks.md`](hosted-incident-playbooks.md)).
- **Controlled Goods and ITAR.** Eligibility for Controlled Goods or ITAR content follows [`controlled-goods-and-itar.md`](controlled-goods-and-itar.md) and your organization's officials for those regimes; it is never inferred from releasability tokens.

## Agreements and clearances

What an observer must hold depends on what they may see. The table is part of your organization's signed policy (`credentials@1`, "credentials required by sensitivity"); your organization may tighten it, never loosen it.

| What the observer may receive | Required, beside the clearance level and releasability checks |
|---|---|
| Only unmarked or public key groups | Nothing more |
| Any key group marked above public (for example Protected) | The observer's `AccessAgreementCredential` (PS-6), issued by your organization's security contact when the observer signs the access agreement, and the signed policy's `agreements[]` record for the observer's organization (an AC-21.400 agreement or an AC-21.401 arrangement), which the key group's `marking.approve` cites |
| Any key group with an ITAR, CGP or EAR compartment | The above, plus a `VisitClearanceCredential` whose window covers the release |

Every release also checks the observer's `ClearanceCredential` against the level and compartments of what is released, and their releasability credential against its releasability. The check runs at the approval, at every release and at every serve, so nothing is checked once and trusted afterwards.

`observer.approve` binds the hashes of the credentials the observer presented, with the status list checked. The credentials themselves stay in the security office's key group, so other staff see only that the observer was approved, never the observer's clearance, nationality or agreement.

## Rules of behaviour

An observer, before being admitted, reads and accepts these rules:

- Read only what you are granted, and write only your presence. Do not try to reach anything else.
- Do not copy, photograph, forward, print or export any content, by any means, unless your organization's security contact has agreed it in writing for a named item.
- Use only the device and the session your organization issued you; never share your passkey or your session.
- Acknowledge the site's sign-in notice (the system use notice from the Phase 47 follow-ups) at every sign-in.
- If you see anything you should not have seen, stop, and tell the named security contact at once. Do not discuss it with anyone else.
- Your access ends on the end date of your approval; it can be withdrawn at any time.

When a rule is broken, the staff lead withdraws the admission (the observer is removed from the roster, which rekeys the cells they held) and your organization's security contact follows the spill playbook in [`hosted-incident-playbooks.md`](hosted-incident-playbooks.md). What follows for the observer is for your organization and the observer's organization under their agreement.
