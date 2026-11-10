---
phase: 26-performance-faster-agent-and-research-runs
plan: 02
requirements: [PERF-01]
status: complete
commit: e514008
---
# 26-02 Summary: Approvals without stalls

- `src/agent/unattended.ts`: classifier-`safe` commands, and verification scripts inside the root that are named like a check (or by the task) and pass a static content check, run without a card for sub-agents in auto and mostly-autonomous. Network commands, `risky` verdicts, scripts outside the root and scripts changed after outside content still ask.
- `decidePermissionAsync` consults it only after the deny list, emergency stop and the tainted holds, and only upgrades "ask".
- Sub-agent approvals wait `subagentApprovalWaitSeconds` (20), then return `Awaiting approval:`; the card stays queued; a late allow grants the command for the run and notifies the lead. Three in a row pause the run (`approvalTimeoutsBeforePause`); an answer, Resume or a message resumes.
- Tests: `src/test/unattendedApproval.test.ts` (7), `src/test/approvalStalls.test.ts` (2).
