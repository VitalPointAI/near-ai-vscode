# Phase 32.1 deferred items

## Gate checks failing on the integration branch (found 2026-11-24 while closing plans 12, 13 and 21)

These five tests fail on `feat/phase-32.1-engine` both before and after plans 12 and 21. They come from Codex's integration commits on `feat/phase-32.1-get-started`, not from these plans. Each is a security or architecture check, so the integration PR must not merge until they pass. Fixing them is not a matter of editing the tests: each one needs a reviewed decision.

| Test | What fails | Likely cause | Decision needed |
|---|---|---|---|
| `gateEnumeration.test.ts` "no production file under src imports child_process or execa except the listed ones" | `src/services/setup/networkFacts.ts starts processes and is not on the list` | `3b79b639` added the macOS and Windows network readers (fixed arguments, no shell) | Approve the file with a reason on the list, or move the readers behind an existing listed runner |
| `gateRouteGuard.test.ts` "CLAS-06: every model request call site runs inside a session route" | `localServersOption.ts` and `testRequest.ts` call a model request method outside the list of request sites | Plans 03 and 04 added the setup test request (one fixed prompt to a just-identified server) | Decide whether the setup test request runs inside a session route or is a listed site with a reason. It sends a fixed prompt and no user content |
| `gateRouteGuard.test.ts` "CLAS-06: a request entry is checked wherever it is reached" | Same cause as the row above | Same as above | Same as above |
| `gateRouteTiers.test.ts` "the local runtime prompt says that only a runtime on this computer counts as local (D-37)" | `the prompt still accepts the same URLs` | `88b93ca5` changed the prompt's `validateInput` from `isSecureEndpoint` to `validEndpoint` | Confirm that `validEndpoint` accepts no URL that `isSecureEndpoint` refused, then update the source assertion |
| `gateActivation.test.ts` "a start that throws does not stop activation: the gate fails closed" | The state is `valid` where `failed-closed` was expected | The clock is now first read outside `ensurePolicyBundle`, probably by the project routing activation (`8f47866f`) | Make the activation order fail closed again; do not move the fault injection |

Owner of the fix: plan 24 (front door activation in `src/extension.ts`), or a fix plan before it. Plans 12, 13 and 21 did not touch these files. The one exception is plan 21's hosted rule in `localServersOption.ts`, which skips the loopback probe and adds no request site.
