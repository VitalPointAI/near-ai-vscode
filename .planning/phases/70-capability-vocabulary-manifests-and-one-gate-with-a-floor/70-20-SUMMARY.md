---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 20
pr: 4b
subsystem: gate (labels)
status: complete
tags: [gate, labels, CLAS-01, CLAS-02, CLAS-03, CLAS-07, GATE-07, D-53, D-59]
requires: ["70-28a (PR #81, merged as 9e430e2)"]
provides:
  - "src/gate/labelMapStore.ts: LABEL_MAP_FILE, LABEL_MAP_LOCK_FILE, LABEL_MARKERS_DIR, readLabelMap, updateLabelMap, LabelMapError, LabelReader, readLabelMarker, raisingOnly, hostlessLabelReader, the sentences LABEL_MAP_UNREADABLE_TEXT, LABEL_MAP_ROLLED_BACK_TEXT, LABEL_MAP_UNVERIFIED_TEXT"
  - "src/domain/gate/labelMap.ts: revision and removed in the payload, PROJECT_ENTRY_KEY, labelMapRevision, labelMapKeys, nextRevision, withRevision, LABEL_MAP_STATES, LabelView, LabelSource"
  - "src/agent/gateLabels.ts: labelVerdictFor, labelReadFilter, namedPaths, commandWords, FAILED_CLOSED_LABEL_TEXT, notCoveredSentence"
  - "GateHost.labelsFor, labelPolicy, changeLabels, recordLabelEvent, followRename; GateRuntime.labels (per folder); LabelVerdict.label"
  - "decide(): the label verdict in the unknown-effects branch"
  - "ToolContext.canRead, used by Glob and Grep"
  - "CommandClassification.moves / movesUnfollowable, followCommandMoves"
  - "command nearAi.label.set (Set Label) with an explorer/context entry; rename tracking through workspace.onDidRenameFiles"
affects: [70-21, 70-22, 70-23, 70-24, 70-28b]
tech-stack:
  added: []
  patterns: ["caller-side label verdict, decide() pure", "last-verified marker in extension storage (D-59)", "raise-only resolution over the last verified entries", "lock, check, sign, write, read back, then marker"]
key-files:
  created: [src/gate/labelMapStore.ts, src/agent/gateLabels.ts, src/test/gateLabelStore.test.ts, src/test/gateLabelReads.test.ts, src/test/helpers/labelMapChild.ts]
  modified: [src/domain/gate/labelMap.ts, src/domain/gate/decide.ts, src/gate/host.ts, src/agent/gateAdapter.ts, src/agent/commandSafety.ts, src/agent/loop.ts, src/agent/tools.ts, src/services/gateCommands.ts, package.json, src/test/helpers/gatedRuns.ts, src/test/helpers/vscodeStub.ts, src/test/gateDecide.test.ts]
decisions:
  - "D-59 (new, PR #78 review): a deleted or rolled-back label map holds reads; the marker lives in the gate folder of this extension's storage and keeps the verified payload"
  - "GateRuntime.labels is a function of the folder, so a sub-agent in its own worktree reads that worktree's label file"
  - "A runtime with no label source reads the folder's file trusting no key (fail closed), rather than taking the default label everywhere"
metrics:
  completed: 2026-11-17
  tasks: 3
estimate:
  tokens: 98049
actuals:
  tokens: 40673
  tasks: 3
  commits: 3
plan_head_before: 0b975ab7c6273fd94d5a57c38b01408b7f9b3068
plan_head_after: 0a897d1cddffc3577926aeb8480b61b041789bbd
---

# Phase 70 Plan 20: Labels Summary

A signed label map per project (`.planning/.near-ai/labels.json`, purpose `label-map`), NEAR AI: Set Label from the Explorer and the Command Palette, and a clearance check on every path an agent reads (file tools, Glob and Grep, the words of a shell command, commands nobody can read, a broken policy, cyber steps), with maps nobody here signed only ever raising, unreadable maps holding reads, and, under the new D-59, deleted or rolled-back maps holding reads too.

PR4B_BASE: `01c0b18` (the tip of `feat/gate-route-check` when this branch was made). PR 4a then merged as `9e430e2` and was merged into this branch as `1055a08` (no rebase), so this branch now sits on `origin/main`.

## What was built

- **Task 1 (tracer), `43fc28b2`.** `labelMapStore.ts` (read, verify with this install's key history, write under one lock per project in `<globalStorage>/gate/locks`, read back); `GateHost.labelsFor` keeps one `LabelReader` per project, released with the logs and read again only when the file or its marker changes; every runtime the host gives carries `labels` (one reader per folder); the adapter works out the label verdict (`gateLabels.ts`) and hands it to decide() as `labelVerdict`, decide() stays pure; refusals record the label and `clearanceFailure`; Set Label (`nearAi.label.set`, `explorer/context` entry, checked with `node -e`: `{"command":"nearAi.label.set","title":"Set Label","category":"NEAR AI"}` and `[{"command":"nearAi.label.set","group":"7_modification"}]`) shows `LABELS_NOT_ACCREDITATION_TEXT` before the first pick and `SCALE_PRESETS_CAVEAT_TEXT` beside the ca-protected, ca-classified and nato scales, refuses a label the person's own clearance does not cover with the Edit Policy hint, asks a reason to lower, and records `label.set`.
- **Task 2, `a5560360`.** Unverified maps resolve raise-only over the entries this computer last verified, told once per window; Set Label asks "Sign it again with this computer's key, keeping only the labels that raise?" (Cancel writes nothing) and keeps the verified entries plus only the raises; automatic writes never sign such a map. Unreadable maps (a merge conflict) hold every agent read in the project with the plan's sentence. **D-59:** a marker per project in `<globalStorage>/gate/label-markers/<projectLogKey>.json` (envelope hash, revision, signing time, entry count, verified payload); a missing map with a marker, a lower revision, the same revision with another hash, or a newer verified map that drops a key without naming it in its signed `removed` list is `rolled-back` and holds every read with `LABEL_MAP_ROLLED_BACK_TEXT`; Set Label offers to sign the last verified labels again; Set Label's Remove choice signs a removal that names the key. VS Code renames move entries (a folder its subtree); an agent's `mv`, `git mv` and `git -C . mv --` move them when the classifier's own parse gives one source and one target and the source is gone. Gone paths are reported once and kept; a write over `MAX_LABEL_MAP_BYTES` and a secret-like path are refused, naming the path; two writers in two processes both land.
- **Task 3, `0a897d1c`.** decide()'s unknown-effects branch reads the verdict right after the floor's refusals by name; a shell command's words are checked from the shell's folder and any folder the line `cd`s into, links followed within the bound the credential-read check now shares (`commandWords`, `linkResolver`); a failed-closed policy refuses anything above the shipped default label with `FAILED_CLOSED_LABEL_TEXT`; Glob and Grep leave out what the clearances do not cover and say how many they hid; cyber steps get the same verdict through `gateStep`.

## Red first

Task 1's tracer was written with the code. For Tasks 2 and 3 the code was held back from the earlier commit, the tests were run red, then the code was restored: Task 2 had 8 failing tests (raise-only over the marker, D-59 deletion, replay and removal, VS Code and agent renames), Task 3 had 6 (the decide() unknown-effects case, Grep and Glob filtering, shell words, a failed-closed policy, cyber steps, the unknown-effects command).

## Tests

- `gateLabelStore.test.ts`: 20 tests. `gateLabelReads.test.ts`: 6 tests. `gateDecide.test.ts`: 1 test added, none changed.
- Plan verify sets passed inside the cap (gateLabelStore, gateDecide, gateEnumeration, gateRecordIds, agentLoop; gateLabelMap, commandEffects, gateFloorRuns; gateLabelReads, gateCyberStep, gateCredentialReadHold, agentTools, gateRefusalRecords). A broad run of `gate*`, `agent*`, `command*` and `cyber*` after Task 3: 1002 tests, 1000 pass, 0 fail, 2 skipped (both skipped before this plan).
- Existing tests changed by this plan: none. The vscode stub gained `showQuickPick`, `onDidRenameFiles`, `getWorkspaceFolder`, `Uri.file` and `messageOptions` (additive), and `testGateRuntime` / `testGateHost` take an optional `labels`.

## Deviations from Plan

1. **[Rule 2] `GateRuntime.labels` is `(root) => LabelSource`, not one reader.** A sub-agent in its own worktree calls with that worktree as its root; one reader for the run's root would have checked the wrong file.
2. **[Rule 2] A runtime with no label source reads the folder's file trusting no key** (`hostlessLabelReader`), so a run with no gate host still refuses what a label raises above its clearances. The plan had every path take the shipped default label there.
3. **[Rule 1, D-59] The marker keeps the verified payload.** One project file cannot be both the verified base and the edited copy, so without a stored verified copy a hand edit could lower a label (the plan's own behaviour item). The label map payload gains optional `revision` and `removed` fields (the parser accepts them; no map was ever written before this PR).
4. **[Rule 2] Shell words are also read from folders the line `cd`s or `pushd`es into**, and each word is checked as a file and as a folder, so `cd secret && cat plan.md` and `ls secret` are seen.
5. **Structure.** The label logic is in a new `src/agent/gateLabels.ts` (the adapter was over 1,000 lines); the shared word split moved there. `readLabelMap(root, scales, options)` replaces the plan's `(root, identity, secrets)`. An agent's rename is read through a new `moves` fact the classifier records in its own `mv` and `git mv` branches (no second parser).
6. **Set Label judges lowering against the resolved label** (folder and project included), and offers "Remove this label" when the path has its own entry.
7. **Acceptance wording.** The labels.json floor ask in every mode is shown in `gateLabelStore.test.ts` (and pinned in `gateFloor.test.ts`); `gateFloorRuns.test.ts` is unchanged and passes.

## Known limits (documented, tested)

- A read a command's text does not show (a path built in a variable, a recursive search) is not seen; `gateLabelReads` pins it as the documented gap.
- A read in a trusted folder outside the project (the Open-GSD runtime) is judged at the project's label, as the adapter already treats it as a project-wide read.

## Threat Flags

None beyond the plan's register and T-70-135 (D-59).

## Self-Check: PASSED

Files exist (`src/gate/labelMapStore.ts`, `src/agent/gateLabels.ts`, `src/test/gateLabelStore.test.ts`, `src/test/gateLabelReads.test.ts`, `src/test/helpers/labelMapChild.ts`); commits `43fc28b2`, `a5560360`, `0a897d1c` are ancestors of HEAD.
