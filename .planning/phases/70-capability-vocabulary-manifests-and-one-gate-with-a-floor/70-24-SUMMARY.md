---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 24
pr: 4c
subsystem: gate (refusal sentences and docs)
status: complete
tags: [gate, routing, docs, CLAS-06, CLAS-07, CLAS-02, D-23, D-27, D-30, D-32, D-40, D-60]
requires: ["70-23"]
provides:
  - "routing.ts: route.deny, route.no-local-model, route.local-host-not-local, route.not-tee and route.connection-not-bound name NEAR AI: Lower This Chat's Label"
  - "gateAdapter.ts: NETWORK_AT_MARK_TEXT names it too"
  - "gateCommands.ts: POLICY_ROUTING_TEXT (replaces POLICY_ROUTING_NOT_LIVE_TEXT)"
  - "SECURITY.md: section Classification labels and routing, six Known limitations rows; README labels bullet"
affects: [70-28c]
tech-stack:
  added: []
  patterns: ["docs pinned to code constants by gateDocs, order and table checked"]
key-files:
  created: []
  modified: [src/domain/gate/routing.ts, src/agent/gateAdapter.ts, src/services/gateCommands.ts, SECURITY.md, README.md, src/test/gateRouteTiers.test.ts, src/test/gateCommands.test.ts, src/test/gateLabelCommands.test.ts, src/test/gateDocs.test.ts]
decisions:
  - "The D-60 text moved from the policy section into the new section, beside the strict-label refusal it extends"
  - "The section is a ### heading after the policy section, so the policy section's own checks read only the policy section"
metrics:
  completed: 2026-11-17
  tasks: 2
estimate:
  tokens: 34018
actuals:
  tokens: 14000
  tasks: 2
  commits: 2
plan_head_before: 201fa74180fb4c0139caecc0d4778fc2a4381cd6
plan_head_after: 2eda13d642482c5771e57e037c04389538abec41
---

# Phase 70 Plan 24: Refusals that name the way out, and what labels and routing guarantee Summary

Every refusal at a strict label now names NEAR AI: Lower This Chat's Label (route.no-local-model still says to add a local model, and none says to start a new chat), Show Policy says each chat's label decides where its content is sent, and SECURITY.md and README say exactly what labels and routing do in PR 4c and what they do not, word for word with the code.

Commits: `6c9f34ba` (Task 1), `2eda13d6` (Task 2).

## What was built

- **Task 1 (`6c9f34ba`).** The five route refusals and `NETWORK_AT_MARK_TEXT` name the Lower command "if what this chat read allows it" (each under 400 characters, no em-dash). `POLICY_ROUTING_TEXT` ("This version checks the clearances below when an agent reads a labelled file. Each chat's label decides where its content is sent, by the routing tiers below. In this version, levels that need an attested cloud stay on this computer.") replaces `POLICY_ROUTING_NOT_LIVE_TEXT` in Show Policy; `grep -c POLICY_ROUTING_TEXT src/services/gateCommands.ts` is 2. gateRouteTiers gains the scripted chat that reads a Restricted file with only a NEAR AI Cloud client: the request is refused before a second fetch, and the sentence the page gets names the Lower command and still says to add a local model.
- **Task 2 (`2eda13d6`).** The new section and rows below. The policy section's model-request bullet and labels bullet point to it instead of saying a label does not change where content is sent. README names Lower This Chat's Label and links the section. gateDocs pins the three constants (imported) in order, the order of the section's parts, the routing table level by level against `DEFAULT_ROUTING`, the rows, README's first sentence and command names, and that Set Label shows the constant itself.

### SECURITY.md section (in full)

> ### Classification labels and routing
>
> **What a label is.** A label is a level on a scale (for example `org/Confidential`),
> with optional compartments and handling flags. **NEAR AI: Set Label** labels a
> file, a folder or the project; the labels are kept in
> `.planning/.near-ai/labels.json`, signed with your device key, and travel with
> the project, so anyone who can read the project can read its labels.
>
> **Scales.** Four scales ship with the policy: `org` (Public, Internal,
> Confidential, Restricted), `ca-protected` (Protected A, B and C),
> `ca-classified` (Confidential, Secret, Top Secret) and `nato` (NATO
> Unclassified to Cosmic Top Secret). The NATO levels come from secondary copies, and treating the Canadian Protected and Classified families as two scales is how NEAR AI reads them. Your organization's security officer should confirm both before you rely on them.
>
> **Clearances.** An agent reads a labelled file only when a clearance in your
> policy covers its label; add one with **NEAR AI: Edit Policy** and **NEAR AI:
> Apply Policy Draft**. Until verified credentials arrive, your clearance comes from your own policy file, which your own device key signs, so it is self-declared. It is not an enforced clearance boundary.
>
> **The chat's label.** Each chat has a label that rises with what its agents,
> helpers included, read: reading a Confidential file makes the chat
> Confidential. It is kept with the chat and synced with it, encrypted like the
> rest of the chat. A sync never lowers a chat's label: two copies merge to the
> higher label. Only you lower it, with **NEAR AI: Lower This Chat's Label** and
> a reason that is recorded. A lowering reaches your other computers only as a
> declassification signed with your device key that they can check, and only
> when it undoes no raise made there; outside Team Mode your other computers
> cannot check it yet, so the higher label stays there and the chat says why.
>
> **What a labelled chat writes.** A file a labelled chat writes takes the chat's
> label in the label file, never a lower one, so a later chat that reads it is
> labelled too. A label file that is not signed by this computer is never signed
> again for this without you: you are asked once, with Sign Again.
>
> **Routing tiers.** Each level maps to one tier:
>
> | Tier | What it allows | Levels by default |
> | --- | --- | --- |
> | any-cloud | any model you have set up | `org/Public` |
> | attested-cloud | a private model on NEAR AI Cloud, over a connection proven to end inside its private hardware | `org/Internal`, `org/Confidential`, `ca-protected/Protected A`, `nato/NATO Unclassified` |
> | local-only | a model on this computer | `org/Restricted`, `ca-protected/Protected B`, `ca-protected/Protected C`, `ca-classified/Confidential`, `ca-classified/Secret`, `ca-classified/Top Secret`, `nato/NATO Restricted`, `nato/NATO Confidential`, `nato/NATO Secret`, `nato/Cosmic Top Secret` |
> | deny | no model | none by default |
>
> A chat that holds labels on several scales goes by the strictest tier among
> them.
>
> **Attested cloud in this version.** Levels whose tier is attested-cloud
> (Internal, Confidential, Protected A and NATO Unclassified by default) need a
> private NEAR AI Cloud model reached over a connection proven to end inside its
> private hardware. This version cannot prove that yet, so content at these
> levels stays on this computer: a local model serves it, and with no local model
> the request is refused. Protected B stays on this computer because no CCCS
> Medium assessment of NEAR AI Cloud was found, unless your organization changes
> its policy.
>
> **Local means this computer.** Local-only means a model on this computer
> (localhost, 127.0.0.1 or [::1]) unless your organization names another host in
> its policy.
>
> **Calls that could send data off this computer.** While a chat's label is
> local-only or deny, a web fetch, a web search, an add-on server call or a
> command that could send data off this computer is refused, whatever the mode,
> and a refused request names **NEAR AI: Lower This Chat's Label** as the way out
> when what the chat read allows it. While a chat holds content whose label may not go to any cloud (Internal, Confidential or higher by default), NEAR AI keeps fingerprints of the labelled text its agents read, never the text itself, only in memory and never in a record, and refuses a web fetch, a web search, an add-on server call or a command that could send data off this computer when what it would send carries some of that text. This catches labelled text copied or quoted into a request. It does not catch a paraphrase, an encoding such as base64, or a program the agent starts that reads the file and sends it itself; the sandbox planned for Phase 72 is the stronger fix.
>
> Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary.

### Known limitations rows added (in full)

| Limitation | Plan |
| --- | --- |
| Shell reads and network exits are checked from a command's text: a path built in a variable, or a program that reads a labelled file and sends it itself, is not seen | The planned sandbox (Phase 72) |
| Local-only trusts the address your local runtime is configured with, unless it is loopback | Name only hosts you control in the policy |
| Labels and the policy are signed by your own key, so they protect against mistakes, not against you | Verified credentials and organization-signed policies are planned |
| An MCP server's and the cybersecurity host tools' effects are their declarations | A server or tool that does more than it declares is not seen |
| The label file is readable by anyone who can read the project | Do not use a compartment name that is itself secret |
| The outbound check catches labelled text copied into a network call, not a paraphrase or an encoding | The planned sandbox (Phase 72) |

## Red first

Task 1: with routing.ts and the adapter at the previous commit, 2 of 11 gateRouteTiers tests failed. Task 2: with SECURITY.md and README at the previous commit, 9 of 27 gateDocs tests failed.

## Tests

- gateRouteTiers: 2 tests added (11 in all). gateDocs: 5 tests added (27 in all).
- Task 1 verify set (gateRouteTiers, gateRouting, gateCommands, gateMark, gateRouteGuard, gateLabelCommands): 109, 0 fail. Every `gate*` test after Task 2: 700, 0 fail.

## Existing tests changed (intended)

- `gateCommands.test.ts` (Show Policy): `POLICY_ROUTING_NOT_LIVE_TEXT` is now `POLICY_ROUTING_TEXT` in the same assertions, and the assertion `/does not change where content is sent yet/` now reads `/Each chat's label decides where its content is sent/` (the plan's intended change).
- `gateLabelCommands.test.ts` ("Show Policy says what is live"): the same rename and changed phrase, plus a check that the 4b constant is gone and the page no longer says "does not change where content is sent yet"; its title now says each chat's label decides where its content is sent.
- `gateDocs.test.ts`: the pinned phrases "does not change where content is sent yet" (policy section), "A label does not change where content is sent yet, so every request is at the policy's default label" (model requests) and "A label does not change where content is sent yet" (labels bullet) now pin the sentences that replace them; the README test names the Lower command and the new link instead of the 4b sentence; two test titles changed with them.

## Deviations from Plan

1. **The D-60 paragraph (plan 22 Task 4) moved into this section**, after the strict-label refusal it extends; gateDocs' D-60 test reads SECURITY.md whole, so it is unchanged.
2. **A sixth Known limitations row** for the D-60 limits (copied text only).
3. **The section is `###`**, after the policy section, so the policy section's own checks end where it begins.

## Threat Flags

None.

## Self-Check: PASSED

Commits `6c9f34ba` and `2eda13d6` are ancestors of HEAD; `grep -c "Classification labels and routing" SECURITY.md` is 3.
