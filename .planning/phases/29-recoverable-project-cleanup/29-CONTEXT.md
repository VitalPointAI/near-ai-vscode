# Phase 29 context

## Approved scope

[Phase 29](../../ROADMAP.md#phase-29-a-cleanup-member-with-a-safe-cleanup-tool)
and CLEAN-01 through CLEAN-05 in the [requirements](../../REQUIREMENTS.md)
define this feature. A restricted software team member can show a dry run for recorded
agent-created artifacts or reviewed known-disposable locations. The floor and a scoped
file operation enforce all never-touch rules. The feature uses recoverable quarantine,
an operation record, and restore. Permanent purge requires explicit human approval
and the retention window.

The dependency is Phase 70. Verified main `5bfeba0af` includes the Phase 70 verification
record from #216, including the floor and action-decision paths for GATE-05 and GATE-06.
Main has no registered CleanUp tool or Phase 29 plan.

## Boundaries

Keep candidate discovery, quarantine, restore and permanent purge distinguishable.
Candidate evidence and approval must remain bound to the selected workspace and item
through each operation. An unavailable check, ambiguous provenance, filesystem mismatch
or active use remains visible to the operator. Evidence of recent activity or restricted
location refuses the move. The cleanup role gets read-only tools and the scoped CleanUp
capability. It cannot call a general shell or file writer.

Never test against real user files, keys, secrets, containers, shared projects or host
cleanup targets. Research and planning have no filesystem effects on a target project.
Fixture acceptance uses a private synthetic workspace and the applicable process or
filesystem proof. Any actual permanent purge needs the owner-authorized action and target.
Do not infer a new user decision from this planning record.
