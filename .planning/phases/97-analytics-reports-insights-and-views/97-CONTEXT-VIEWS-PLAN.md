---
phase: 97-analytics-reports-insights-and-views
plan: context-views
type: execute
status: draft
draft: true
autonomous: false
wave: 1
depends_on: []
requirements: []
files_modified:
  - src/test/contextGraphSavedViewsFixture.test.ts
  - src/test/helpers/dataPlatformClassificationFixture.ts
  - src/test/helpers/missionMembershipFixture.ts
must_haves:
  truths:
    - A saved view records a versioned definition scoped to one workspace.
    - Sharing a definition does not grant access to its evidence.
    - A reader or delegated agent receives only the current evidence allowed for that use.
    - Disabled, stale, revoked or wrong-workspace updates cannot appear after a switch.
  artifacts:
    - path: src/test/contextGraphSavedViewsFixture.test.ts
      provides: Offline acceptance of saved definitions, reader projections and in-app updates
  key_links:
    - from: src/test/contextGraphSavedViewsFixture.test.ts
      to: src/test/fixtures/contextGraph/evidenceFixture.ts
      via: Reuse the Phase 96 projection and citation lookup only after exact Phase 93 source gating
    - from: src/test/contextGraphSavedViewsFixture.test.ts
      to: src/test/helpers/missionMembershipFixture.ts
      via: Recheck the authenticated human and selected workspace at the recorded delivery boundary
---

# Saved context views and in-app updates

Base `9f021496f1ba3fdef1703b6b4c668e41123ba863` already contains the Phase 96-01 fictional corpus and projection. The [animated explorer specification](../96-search-context-graph-entity-pages-and-ask/96-UI-SPEC.md), Phase 96-02 renderer and [Bastion crosswalk](../96-search-context-graph-entity-pages-and-ask/96-BASTION-CROSSWALK.md) are reference material. This fixture informs the saved-scope design. It earns no KB-13 completion credit. RAFT, timeline replay and the production explorer need separate acceptance. Independent review and the fictional-only execution decision remain required before any source extraction or test.

## Exact fixture dependencies

The base lacks two previously reviewed helpers. Before execution, verify and assemble only these disjoint test-tree files. Verify each Git blob against its listed predecessor and keep it unchanged. The direct production imports of both helpers are already present and byte-identical on the base. Do not merge either predecessor branch, copy unrelated fixture tests or replace denied authorization with a stub.

| Reviewed source | Exact file | Git blob |
| --- | --- | --- |
| `3f6c519f1eb5c462be546c884573289cbb6ce44a` | `src/test/helpers/dataPlatformClassificationFixture.ts` | `4266b4d9133c994f1a6d1ddd6561f84c042fca38` |
| `580ab33cf152f8c3b7b3c5617dc41e1760d31206` | `src/test/helpers/missionMembershipFixture.ts` | `6431243e395054d839fedc49b1930fc11e1addbe` |

## Product contract

**Saved definition.** Key each record by owning organization, workspace and stable view ID. Store a schema version, monotonic revision, author reference, private or published state, closed filter and detail selections, and a bounded view preference such as layout or zoom. Permit an optional opaque anchor only after authorizing that reference within the workspace. Keep viewer-specific layout, camera, selection and update settings private. A definition never accumulates result text, facts, source spans, labels, result counts, graph coordinates derived from evidence, event backlogs or unfiltered versions. Treat definition discovery and anchors as access-controlled data. The first fixture uses closed, neutral activity and responsibility filters. Different detail levels change presentation within the same authority and have no permission effect.

**Private and shared views.** A human saves, edits and reopens their own definition under the current workspace. Publishing creates a distinct workspace-scoped version with a signed human action bound to the exact workspace, owning hub, definition revision and digest, intended audience and current publishing authority. Require membership and definition-read authority to list a shared view. Publication and audience grants never copy the publisher's projection or confer access to a source. Use optimistic revision checks so stale edits cannot overwrite newer changes or broaden audience. Unpublish, remove an audience or revoke membership through the same authority. A receiving human can fork a definition privately only while that definition is readable.

**Human and delegated agent evidence.** Select the workspace and owning hub from the verified active session. Resolve current workspace membership and any applicable cell grant independently of source ACL and current clearance. Filter exact assessed source revisions before traversal, ranking, layout, counts or citations. Reopen saved filters and citations under current authority. Return only exact visible spans and allowed derived results. An agent needs a separate current, time-limited delegation bound to the authenticated delegator, recipient agent, workspace, revision, task and allowed evidence-read purpose. Project the intersection of its own authority, the delegation and the person's current authority. A delegated agent can suggest a private draft in its granted task; a separate authorized human action publishes, changes an audience or enables updates. Agent outputs use the same source and derived-result rules. Workbench task memory scopes and the existing team permission matrix can explain local actor/action boundaries but do not supply mission or source authority.

**In-app updates.** Each person can enable or disable updates per view. Start disabled. When enabled, bind the subscription to the principal, selected workspace, exact definition revision and a session generation. Compare only consecutive authorized projected results. Deduplicate equivalent authorized deliveries within that generation and respect the view cap. Send only bounded visible changes to the current in-app session. Hidden updates must be indistinguishable from absent updates in payload, timing, counters, notice and animation. On disable, workspace switch, view replacement, unpublish, expired delegation or access uncertainty, cancel the old subscription, destroy pending messages, dedup state and stale renderer state, and invalidate already queued snapshot, delta and source responses. Recheck current scope after asynchronous projection and again before delivering or applying it. Re-enable or revisit by starting from a fresh authorized projection. Animation pause remains separate from update delivery. No external notification, portable evidence snapshot or cross-hub sharing in this plan.

<tasks>
<task type="tdd">
  <name>Save, share, reopen and subscribe in a fictional workspace</name>
  <files>src/test/contextGraphSavedViewsFixture.test.ts, src/test/helpers/dataPlatformClassificationFixture.ts, src/test/helpers/missionMembershipFixture.ts</files>
  <behavior>Extend fictional Lumen and Project Fern with two invented workspaces, two human readers and a named fictional read-only assistant. Assert a current human may save and publish the exact definition, stale edits and unauthorized publication fail, and a second human with access to the definition sees a different authorized projection. For the same source, allow v1 and deny v2 under an independent ACL even when the label matches. Repeat at citation open. Assert an agent receives a strict authorized subset and loses access when either actor authority or its delegation expires or is withdrawn. Pause projection or delivery to exercise stale responses.</behavior>
  <action>After approval, write behavioral assertions first in the one new fixture test. Assemble only the two pinned helpers above. Use Phase 93 `assessFictionalItem` and `projectFictionalCard` against the current signed marking policy and checked wallet and ACL. Bind each corpus row to the exact trusted source item, source ID and version, text hash, assessment and source revisions, and policy hash. A matching verified card is required per row before calling `projectFixtureGraph`. Phase 96's source-ID permission list cannot admit a denied version. At citation open reauthorize that exact row under current source, reader and workspace authority before `openFixtureCitation` can return its span. Check allowed v1 exact text and separate denial of v2 for the same ID. Retain the two Phase 96 readers and the independent same-compartment ACL refusal.

    Use Phase 104 `recordMissionUse` to bind the selected workspace generation, owning hub and current signed human membership to the fixture effect. It supplies the human membership witness only. For agent use, add a closed, canonical signed fixture delegation named `sterling.fixture-context-view-delegation.v1` whose generated delegator key is independently bound to the verified human. Bind the exact organization, owning hub, workspace, delegator subject, agent subject, view ID, definition revision and digest, fixture task ID, read-only purpose, allowed evidence references, validity interval and grant ID. Resolve actor and current grant evidence from trusted fixture state. Refuse wrong subject, task, view revision or workspace, invalid proof, expired or withdrawn grant, and an independently unauthorized delegator. Intersect the agent's separately checked evidence access with its bound grant and the human's current access. Use existing pure canonical and signature verification. Do not give an agent publication, audience or subscription authority through the fixture delegation.

    Prove save, publication, reopen and stale revision handling. Use a deterministic recorded in-app queue to compare authorized projections before scheduling, then re-read the exact workspace generation, view revision, both actors' applicable permissions and source and delegation evidence after each injected pause and immediately before the synchronous delivery or citation recorder. Test human membership or source access revoked during the pause, delegation expiry or withdrawal, disable with work queued, switch away and back, and unpublish. Assert old data remains cleared, re-enable starts with a fresh authorized view, and duplicate visible updates deliver once. Compare a limited reader's recorded payload, counts and scheduled events with the equivalent corpus physically missing hidden changes. This deterministic run cannot establish production timing isolation. Add no renderer, RPC, production persistence, message transport, or data-source connection.</action>
  <verify>
    <automated>npm run compile &amp;&amp; node --test dist/test/contextGraphSavedViewsFixture.test.js dist/test/contextGraphFixture.test.js</automated>
    <fails_when>A named case fails or skips, a helper differs from its pinned blob, denied v2 of an allowed source enters projection or citation, a shared definition expands authority, wrong-scope or expired delegated work reaches an effect, a hidden change alters the recorded delivery trace, or old or duplicate queued results deliver.</fails_when>
  </verify>
  <done>Record test-only proof and exact assembled prerequisite blobs. KB-13 and production follow-ons stay open. This draft itself grants no execution approval.</done>
</task>
</tasks>

## Production dependencies

- Phase 88 must prove live source ACL inheritance and revocation. Phase 92 and G464 cover supported extraction, hidden content and exact source provenance. Phase 93 and G565 require current signed item labels, separate clearance and ACL checks, and authorized citations and derived results under the applicable signed policy in G461.
- Phase 104 and G564 require verified workspace membership, owning-hub transport trust and a current scoped grant. A project role or the presence of a hub supplies no substitute. Shared publication authority, agent delegation issuance and durable in-app subscription persistence need the actual governed sources and a separate reviewed product plan. Phase 96 must provide the authorized projection before Phase 97 enables any live reader. The landing can progress independently with an unavailable governed-data state.
