---
phase: 98-model-factory-v1-first-specialist-from-chat-and-run-logs
plan: 01
type: execute
wave: 1
depends_on: []
autonomous: false
requirements: [FAC-04, FAC-05, FAC-06, FAC-08]
files_modified:
  - src/test/helpers/modelFactoryPassportFixture.ts
  - src/test/modelFactoryPassportFixture.test.ts
estimate:
  tokens: 14007
  raw_tokens: 14000
  tasks: 2
  confidence: high
must_haves:
  truths:
    - "A bounded fictional evaluation can support an inactive version only when its evidence and exact candidate artifacts match."
    - "The same signed immutable version tuple and each signed stage transition bind one non-empty controlled mark, including handling; a missing or substituted mark grants nothing."
    - "A detached approval or a matching passport alone cannot advance a version. Shadow and canary require two explicit signed human decisions carried by verified policy."
    - "A passport is current only while issuedAt <= now < expiresAt, independently of passportCovers; a missing clearance, changed artifact or expired or mismatched evidence prevents the corresponding simulated transition."
    - "A correctly signed decline records no activation or stage transition."
  artifacts:
    - path: src/test/helpers/modelFactoryPassportFixture.ts
      provides: "In-memory report-to-version checks and a recorder for authorized offline stage changes"
    - path: src/test/modelFactoryPassportFixture.test.ts
      provides: "Independent positive and denial evidence at the fictional version and policy boundaries"
  key_links:
    - from: src/test/helpers/modelFactoryPassportFixture.ts
      to: src/domain/gate/policyDocument.ts
      via: "verifyPolicyLayer for the independently trusted exact installed organization layer"
    - from: src/test/helpers/modelFactoryPassportFixture.ts
      to: src/domain/gate/models.ts
      via: "the exact policy-resolved passport hash and passportCovers before the recorder"
    - from: src/test/helpers/modelFactoryPassportFixture.ts
      to: src/domain/gate/dominance.ts
      via: "an explicit non-empty controlled mark check before markDominated"
---

# Phase 98-01 — Verify evidence for one fictional model version

<objective>
Take one invented artifact version from a signed fictional evaluation to an inactive passport candidate. Record shadow and canary eligibility only after separate signed human selections and verified policy adoption. Use an in-memory receiver and no model execution. This tests part of the four listed requirements.
</objective>

<context>
@.planning/phases/98-model-factory-v1-first-specialist-from-chat-and-run-logs/98-01-PASSPORT-READINESS-DRAFT.md
@.planning/research/model-provenance/DESIGN.md

Local checkpoint `c13559834e024b2095cf6a7b9aa29d536b935782`. Accepted readiness digest `04f7ea260dd9a6e6c33e174e723c3dc84b52ddec085a6ae478967045772e9cfd`. The dependency list describes only an offline fixture on checked-in functions.
</context>

<execution_preflight>
HOLD. Independently check this exact draft before requesting permission to implement only the two named test-tree files and run their fictional offline checks with generated keys. Recommend that bounded fixture. It uses a controlled clock, invented digests and records, and an in-memory recorder. It grants no actual model selection, evaluation on real weights, training, data access, source or host approval, model registration, installation, inference, network requests or product changes. Keep this draft unregistered and leave source and tests untouched until the exact review and separate owner approval are recorded.
</execution_preflight>

<tasks>
<task type="tracer" tdd="true">
  <name>Bind a checked evaluation to the exact inactive passport version</name>
  <files>src/test/helpers/modelFactoryPassportFixture.ts, src/test/modelFactoryPassportFixture.test.ts</files>
  <read_first>src/benchmark/graders.ts, src/test/evalGraders.test.ts, src/domain/team/canonical.ts, src/domain/gate/models.ts, src/test/gatePassports.test.ts</read_first>
  <behavior>
    - The control uses the existing deterministic `gradePlan` on invented held-out answers. A trusted signed report for the candidate/incumbent pair supports exactly one matching inactive version. Its signed immutable tuple contains the base digest, adapter digest, quantization, exact served-weight digest and one non-empty controlled mark with its scale, level, compartments, releasability and handling. That record permits no dispatch or stage transition.
    - Expected digests, the controlled mark and approval conditions come from independent fixture inputs. Tamper with the report, substitute a validly signed report for another candidate or evaluation split, substitute the base, adapter, quantization or exact served-weight identity one at a time, omit the mark, or replace only its handling or another mark component. Each independent negative fails with zero inactive records and no route. An accepted report does not activate or register the version outside the in-memory fixture.
  </behavior>
  <action>
Start with compile-safe failing assertions at the fixture recorder. Keep the bounded artifact manifest and report shapes in the test tree. Compare an independently expected immutable version tuple (base digest, adapter digest, quantization, served weights digest, controlled mark) to the report's signed tuple and proposed passport evidence. Treat the mark as required and non-empty before calling `markDominated`, because `markDominated([], [], context)` is true for an empty mark; compare every label field including handling, not only its scale/level key. Bind the incumbent identity, workload, held-out and rubric digests and the deterministic scores to the same report. Use an appropriately small fictional held-out set and report only what the fixture measured. Use `canonicalBytes` and `verifySignature` to verify a test-only report signed under its own fixed fixture label with an independently selected active evaluator key. Match its canonical hash to the expected evaluation hash and `Passport.evaluation.sha256`. Use `passportHash` and an exact model-version match. Preserve the passport's exact-weights meaning and carry any composed-version tuple as linked evidence. Hold when a report, version, mark or scope is missing or mismatched. Do not append a production signing purpose or policy field.
  </action>
  <verify>
    <automated>mkdir -p "$PWD/.scratch" && phase_scratch=$(mktemp -d "$PWD/.scratch/98-01-report.XXXXXX") && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_scratch" sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/modelFactoryPassportFixture.test.js dist/test/evalGraders.test.js dist/test/gatePassports.test.js'</automated>
    <fails_when>The exact valid control cannot record inactive, or substituted artifact, report or controlled-mark evidence, including a missing mark or handling-only substitution, can do so.</fails_when>
  </verify>
  <done>Record intended RED and GREEN, exact hashes, zero skips and one matching inactive record with no dispatch.</done>
</task>

<task type="auto" tdd="true">
  <name>Require separate signed shadow and canary selections and verified policy adoption</name>
  <files>src/test/helpers/modelFactoryPassportFixture.ts, src/test/modelFactoryPassportFixture.test.ts</files>
  <read_first>src/domain/gate/policyDocument.ts, src/domain/gate/proposal.ts, src/domain/team/signedPayload.ts, src/domain/gate/models.ts, src/domain/gate/dominance.ts, src/test/helpers/policyFixtures.ts, src/test/gateBundleV2.test.ts</read_first>
  <behavior>
    - A signed shadow selection with no verified installed adoption leaves the version inactive. Verified adoption of that exact choice records shadow, with the incumbent still designated for the user-visible result. A separate authorized canary selection and its own verified adoption record canary eligibility only.
    - Each signed shadow or canary transition binds the complete immutable version tuple, including the exact non-empty controlled mark and its handling, the predecessor and intended next state, report and passport digests, role/use and expiry. Missing or substituted transition marks are refused independently.
    - The policy-resolved passport is independently current only when `Date.parse(issuedAt) <= now && now < Date.parse(expiresAt)`; test just before issuance and exactly at expiry with every other input valid. This explicit gate applies even at T0, where `passportCovers` alone can return covers for an expired passport.
    - A direct canary request while inactive, a replayed or substituted selection, a signed decline, the wrong, report-mode, not-yet-issued or expired layer/passport, a matching passport without the proposal binding, a revoked selection or insufficient model-label clearance leave zero further effects. In each refusal, keep unrelated inputs valid. No simulated state implies a live route.
  </behavior>
  <action>
Add failing cases before wiring the final fixture checks. Use separately signed fictional human decisions for shadow and canary with an explicit select-or-decline value. A signed decline is terminal for that request and writes neither an activation nor a stage record, even when the other evidence is valid. Bind each signed selection to the exact inactive or shadow predecessor, intended next state, complete immutable version tuple including its non-empty controlled mark and handling, report and passport digests, permitted fictional role/use, and expiry. Verify the signing key against the independently approved role fixture, verify current validity, and require matching policy adoption. Use the existing repository `signOrganizationLayer` fixture and `verifyPolicyLayer` for purpose `org-policy-layer`. Require a valid v2 organization document in models `enforce` mode from the independently trusted active issuer and expected installed hash. Resolve the passport only from that verified document's models section with `resolvePassport`. Require the policy passport and exact stored hash, with no shipped fallback for this candidate. Before `passportCovers`, independently parse and require the passport interval `issuedAt <= now < expiresAt`; do not inherit its T0 exception. Reuse `passportCovers` for the permitted use/hosting. Require the bound controlled mark to contain at least one label before calling `markDominated`, then use an independently supplied current fictional clearance to check every label's scale, level, compartments and releasability. Preserve and exact-match handling in the signed tuple and transition even though `markDominated` does not enforce handling. Actual routing enforcement of handling stays outside this fixture.

The current v2 document carries passport data and has no Factory stage proposal field. Model verified adoption at a separate test-only, organization-signed installation witness bound to the verified layer hash and the exact signed selection digest. Independently verify its signature, current status and purpose under a fixed fixture label. A detached selection, verified layer alone, matching passport or stale witness grants no transition. This tests composition and supplies no product proposal encoding or claim that the current policy schema already carries it. Production must enforce provenance DESIGN section 11.5 through the applicable verified installed layer carrying the signed proposal. Keep any authorized self-signed personal path outside this fiction. Compare all current references again immediately before writing the in-memory stage result.
  </action>
  <verify>
    <automated>mkdir -p "$PWD/.scratch" && phase_scratch=$(mktemp -d "$PWD/.scratch/98-01-stage.XXXXXX") && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_scratch" sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/modelFactoryPassportFixture.test.js dist/test/evalGraders.test.js dist/test/gateBundleV2.test.js dist/test/gatePassports.test.js dist/test/gateDominance.test.js'</automated>
    <fails_when>A decision advances without the second human selection and verified adoption when required, a signed decline writes any activation or stage effect, or a missing/substituted mark, non-enforcing v2 layer, not-current passport or insufficiently cleared candidate advances.</fails_when>
  </verify>
  <done>Record intended RED and GREEN, exact identities and zero skips. Observe shadow then canary with the exact authorized chain and zero activation or stage effects for each denied transition, including the signed decline.</done>
</task>
</tasks>

## Evidence limits and open prerequisites

FAC-04 covers a synthetic signed report binding, not live held-out, golden, regression, memorization, speed or cost acceptance. FAC-05 covers an inactive fictional version with an exact passport, not sealed production registration, lineage custody or deletion. FAC-06 covers ordered authorization and verified layer composition, not actual canary traffic, live promotion, automatic transitions or Factory rollback. FAC-08 covers an offline dominance and passport decision, not an enforced serving route or outage fallback. Reuse the current backup path only after independently verifying the eligible incumbent. Record unresolved conditions under existing assigned gaps or reserve a gap before using a new ID.

Phase 74 still owns verified signed contracts and Phase 74.1 the enforced installed passport gate. Phase 85 still owns qualified trainer/serving host evidence. G554 holds the named host's optional local training pending the authorized installed supervisor, runner, service identity, resource, interruption and bypass evidence. Landed #227 permits planning on suitable approved network targets only and does not grant authority for any job. The first specialist's approved chat/run role evidence and the classification adviser's frozen Phase 85 rubric remain distinct. Neither is evaluated, selected or authorized here.

<threat_model>
| Threat ID | Category | Boundary | Severity | Disposition | Mitigation |
| --- | --- | --- | --- | --- | --- |
| T-98-01 | S/T | Evaluation and artifact identity | high | mitigate | Independently trusted signature, exact digest and version comparison, zero record on substitution |
| T-98-02 | E/T | Approval and installed policy | high | mitigate | Distinct signed selections, verified layer and exact verified adoption witness, predecessor and expiry checks |
| T-98-03 | E/I | Label and route eligibility | high | mitigate | Existing passport and dominance functions against current fixture authority, zero protected effects on refusal |
| T-98-SC | T | Dependencies | high | mitigate | Existing pinned repository tools and no dependency acquisition |
</threat_model>

<verification>
After scoped approval, review the exact test-only diff and logs independently. Check fixture signature and policy evidence boundaries and confirm no production consumer imports the helper. Record exact results on the reviewed worktree without real artifacts, data, credentials or network.
</verification>

<success_criteria>
The same fictional version binds the approved evaluation, non-empty controlled mark (including handling) and current enforced passport and can reach both authorized simulated stages. Tampering, mark omission/substitution, a passport outside `issuedAt <= now < expiresAt`, a signed decline, incomplete adoption and insufficient authority leave no unauthorized record. Operational holds remain open.
</success_criteria>

<output>
After approved execution and independent source verification, write `98-01-SUMMARY.md` next to this plan with exact review and evidence. End with `## Open conditions` citing applicable assigned gap IDs. No new gap is assigned in this draft.
</output>
