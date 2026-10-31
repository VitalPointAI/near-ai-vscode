# Requirements: Near AI for VSCode — v0.6.0 Team Mode

**Defined:** 2026-10-31
**Core Value:** Several people, each running their own private NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding, overspending or leaking secrets.
**Source:** `.planning/research/v0.6.0-team-mode-addendum.md` section 9 (verbatim). Where this file and the spec differ, the spec wins.

## v1 Requirements

### Team and identity

- [ ] **TEAM-01**: A lead can enable Team Mode on an initialised project; solo projects behave exactly as before.
- [ ] **TEAM-02**: A lead can invite a person by email with role and allocation; the invitee joins with a single-use code and gets their own NEAR access and key.
- [ ] **TEAM-03**: A lead can remove a member; their claims, leases and allocations are released and later events from their keys are rejected.
- [ ] **TEAM-04**: Every client verifies every coordination event's signature and the author's permission at that point in the log.

### Team Board

- [ ] **BOARD-01**: The board reflects GSD milestones, phases, plans and tasks, re-imports idempotently, and shows dependencies, scope, estimate and state.
- [ ] **BOARD-02**: Board changes from any member appear on every other member's board within the poll interval (git) or within 2 s (relay).
- [ ] **BOARD-03**: Moves are permission-checked and only follow permitted transitions.
- [ ] **BOARD-04**: A milestone card shows progress, burn, forecast and a release readiness checklist and can start milestone completion.

### Dispatch and assignment

- [ ] **ASSIGN-01**: The dispatcher computes ready items and eligible members and offers or assigns per policy.
- [ ] **ASSIGN-02**: `Next Task` claims the best eligible item and prepares its workspace and chat session in one action.
- [ ] **ASSIGN-03**: Sub-agents in a claim receive disjoint sub-leases and honour plan waves.

### Claims and deconfliction

- [ ] **CLAIM-01**: Two members can never hold active claims on the same item.
- [ ] **CLAIM-02**: Two active claims (or sub-agents) can never hold overlapping path leases.
- [ ] **CLAIM-03**: Agent file writes outside the lease set are refused with an explanation and a way to request the lease.
- [ ] **CLAIM-04**: Expired claims return to ready with prior work preserved on their branch.
- [ ] **CLAIM-05**: Duplicate cards and duplicate code are detected and must be resolved before proceeding.

### Integration

- [ ] **INTEG-01**: All code reaches the integration branch only through the merge train (or PR mode).
- [ ] **INTEG-02**: Each merge candidate is rebased, scope-checked, verified and reviewed by someone other than its author before merge.
- [ ] **INTEG-03**: STATE.md progress is regenerated from the log; members never edit it by hand in Team Mode.

### Budgets

- [ ] **BUDGET-01**: Leads set team budget and member allocations; members request more; decisions are logged.
- [ ] **BUDGET-02**: Member spend is capped at the provider via per-key spend limits when a NEAR organization is configured.
- [ ] **BUDGET-03**: A run's effective cap is the minimum of run, daily, member and ring-fence remaining.
- [ ] **BUDGET-04**: Spend is reconciled with NEAR per member; differences above tolerance are flagged.
- [ ] **BUDGET-05**: Alerts fire at 50, 80 and 100% of member, ring-fence and team budgets.

### Metrics

- [ ] **METRIC-01**: Per-member, per-agent and per-milestone metrics in section 6.11 are available and exportable without prompts or code.

### Collaboration

- [ ] **COLLAB-01**: Comments, mentions, handoffs, blockers and approval routing work across members.
- [ ] **COLLAB-02**: Team memory is written only through approved proposals and lands through integration.

### Security

- [ ] **SEC-01**: No secret is written to the log, team.json, settings or audit.
- [ ] **SEC-02**: A team-wide stop halts every member's agents; only a lead resumes.
- [ ] **SEC-03**: Teammate-authored text reaches agents only as untrusted data.
- [ ] **SEC-04**: Role permissions in section 6.3 are enforced on write and on read.

## Future Requirements

None deferred. The spec allows Phase 67 to be split by the planner; the relay transport is separable and can ship last within this milestone.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Real-time co-editing of the same file (Live Share style) | Spec section 1: out of scope; leases and per-claim worktrees prevent simultaneous edits instead |
| Hosted SaaS operated by VitalPoint | Spec section 1: teams use their own git remote or a self-hosted relay |
| Mobile clients | Spec section 1 |
| Keystroke or screen activity tracking | Spec section 6.11: metrics are for planning and coaching, never surveillance |
| Managing git remote access | Spec section 6.2: outside the extension's control; removal shows a checklist instead |

## Traceability

Phases are numbered 60 to 67; spec phase 25 is Phase 60, and so on in order.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TEAM-01 | Phase 60 | Pending |
| TEAM-04 | Phase 60 | Pending |
| SEC-01 | Phase 60 | In Progress |
| SEC-04 | Phase 60 | In Progress |
| TEAM-02 | Phase 61 | Pending |
| TEAM-03 | Phase 61 | Pending |
| BOARD-01 | Phase 62 | Pending |
| BOARD-02 | Phase 62 | Pending |
| BOARD-03 | Phase 62 | Pending |
| CLAIM-01 | Phase 63 | Pending |
| CLAIM-02 | Phase 63 | Pending |
| CLAIM-03 | Phase 63 | Pending |
| CLAIM-04 | Phase 63 | Pending |
| CLAIM-05 | Phase 63 | Pending |
| ASSIGN-03 | Phase 63 | Pending |
| ASSIGN-01 | Phase 64 | Pending |
| ASSIGN-02 | Phase 64 | Pending |
| INTEG-01 | Phase 65 | Pending |
| INTEG-02 | Phase 65 | Pending |
| INTEG-03 | Phase 65 | Pending |
| BUDGET-01 | Phase 66 | Pending |
| BUDGET-02 | Phase 66 | Pending |
| BUDGET-03 | Phase 66 | Pending |
| BUDGET-04 | Phase 66 | Pending |
| BUDGET-05 | Phase 66 | Pending |
| METRIC-01 | Phase 67 | Pending |
| COLLAB-01 | Phase 67 | Pending |
| COLLAB-02 | Phase 67 | Pending |
| SEC-02 | Phase 67 | Pending |
| SEC-03 | Phase 67 | Pending |
| BOARD-04 | Phase 67 | Pending |

**Coverage:**
- v1 requirements: 31 total
- Mapped to phases: 31
- Unmapped: 0 ✓

---
*Requirements defined: 2026-10-31*
*Last updated: 2026-10-31 after milestone v0.6.0 Team Mode start*
