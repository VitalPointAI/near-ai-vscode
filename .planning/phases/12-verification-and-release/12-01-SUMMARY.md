# Phase 12 summary: end-to-end verification, security review, release candidate

**Completed:** 2026-10-26, except the live checks that need the user's NEAR AI key (below).

## Built and verified

- **Extension-host tests** (`npm run test:e2e`, `src/test/e2e/`). They launch a
  real VS Code (1.143.1) under xvfb, once in a NEAR AI project and once in an
  unrelated folder. 7/7 pass:
  - the extension activates;
  - every contributed command has a handler;
  - the sidebar script runs under its CSP and round-trips messages;
  - a local runtime's models appear;
  - a reply streams;
  - a Write asks, applies on approval, and Revert removes it;
  - in an unrelated folder the extension does not activate at startup, and
    opening the sidebar writes nothing.
  
  The suite caught a release-blocking bug from Phase 11: `chat.js` read
  `ICONS` before defining it, so the sidebar's script crashed on load. Fixed.
- **Per-response verification** (`src/services/attestation.ts`, the **Verify
  signature** action on private answers). It follows NEAR's reference
  verifier: request and response hashes, EIP-191 signature recovery, and
  `report_data` binding of the signing address and a fresh nonce.
  - TDX quotes are verified natively (no dependencies): quote signature, QE
    report signature, QE binding of the attestation key, and PCK chain to the
    pinned Intel SGX Root CA (fingerprint `44:A0:19:6B…74:D3`, fetched from
    certificates.trustedservices.intel.com).
  - Keccak-256 and secp256k1 recovery are checked against ethers 5.7.2
    vectors. Quote parsing matches Phala's dcap-qvl on its real Intel sample
    quotes (v4, v5, TD 1.5), and tampering is caught.
  - Not checked, and stated in the result: TCB status and revocation, enclave
    measurements, and NVIDIA's verdict.
- **Opt-in live tests** (`src/test/live.test.ts`):
  - `NEAR_AI_API_KEY`: a GLM 5.3 tool round trip, Verify on a real response,
    and billing.
  - `NEAR_LIVE_EVAL=1`: GLM 5.3 vs Kimi K3 vs DeepSeek V4.1 Flash on three
    fixed coding tasks.
  - `NEAR_LIVE_GSD=1 NEAR_GSD_HOME=…`: `/gsd-map-codebase` end to end (RUN-06).
- **Screenshots** were regenerated from the real sidebar with current messages
  (agent run with Verify, approval card, GSD question with agents, command
  menu).
- **Release candidate.** `near-ai-vscode-0.4.0.vsix`, 103 files, no runtime
  dependencies; `verify:release` passes; CHANGELOG added. Not published.

## Security review (independent reviewer), all fixed with regression tests

| Finding | Fix |
| --- | --- |
| Critical: a newline bypassed the command allow list (`ls\ncurl … \| sh` auto-ran) | Allow only plain-word commands, checked on the raw text; grants match the exact text |
| Critical: allow-listed git flags could write or read outside (`--output=`, `--no-index`, `branch -D`) | Risky git options and absolute, `~` and `..` paths ask |
| High: sub-agents could use forwarded models in TEE-only mode | Delegated models must be on the same route and at least as private (`modelsAsPrivateAs`) |
| High: `$ARGUMENTS` could inject `@.env` includes; includes followed symlinks | Includes expand before arguments, by real path, never from credential files |
| High: a dangling symlink let Write escape the workspace | Dangling links refused |
| High: the profile file in the workspace chose where the API key was sent | Keys are bound to their endpoint in SecretStorage; legacy keys are released only to NEAR's default |
| Medium: credential check sidestepped by `.env/`, symlinks, or Grep | Checked on the normalized and resolved path; Grep hides credential files |
| Medium: WebFetch SSRF through redirects | Manual redirects, https and a public address at every hop |
| Medium: "signed" overstated an unverified quote | The quote is now verified to Intel's root; remaining gaps are listed |
| Medium: image model ignored TEE-only | Same delegation rule |
| Low: revert wrote through swapped symlinks; deny list dodged by quotes | Fixed |
| Low: Remember not reviewed, spend checked per message, transcripts unencrypted | Documented in SECURITY.md known limitations |

Writes into `.git/` and `.planning/.near-ai/` now always ask, even after
"allow edits for this run". Otherwise a write to `.git/config` followed by
the auto-allowed `git status` could run code.

## Live results (user's key, 2026-10-26)

- `live.test.js` passes against NEAR. A GLM 5.3 tool round trip works, and
  Verify returns "signed". The signer is **NEAR AI's gateway key**
  (`0xb98a…e779`), found in `gateway_attestation`. The first run failed
  because only `model_attestations` was searched, as in NEAR's reference
  verifier; fixed in `1a01b15`. The genuine Intel TDX quote binds the key with
  a fresh nonce. Billing reported $0.0036 for the run.

- **Model evaluation** (`NEAR_LIVE_EVAL=1`). Three fixed tasks (implement,
  fix-bug, refactor), each judged by its own `node --test`. All 9 runs passed.

  | Model | Privacy | Time (3 tasks) | Cost (3 tasks) | Turns |
  | --- | --- | --- | --- | --- |
  | z-ai/glm-5.3 | TEE | 41 s | $0.056 | 24 |
  | moonshotai/kimi-k3 | TEE | 685 s | $0.188 | 36 |
  | deepseek/deepseek-v4.1-flash | forwarded | 76 s | $0.011 | 30 |

  Decision: **GLM 5.3 stays the default**: private and the fastest, with
  equal correctness. Kimi K3 is as correct but about 17× slower and 3× the
  cost. DeepSeek V4.1 Flash is the cheapest but forwarded, so it is not
  eligible as a private default. The sample is small: it confirms the default
  works, and is not a benchmark.

## Live GSD run (RUN-06)

Passed against Open-GSD 1.19.0 with GLM 5.3: `/gsd-map-codebase` on the sample
repository wrote all seven documents (ARCHITECTURE, CONCERNS, CONVENTIONS,
INTEGRATIONS, STACK, STRUCTURE, TESTING) in about 48 minutes. The test then
kept the process open because it never disposed the conversation's shell; the
test now disposes it. The extension disposes conversations itself.

## Still needs the user

- Repackage 0.4.0 (`npm run verify:release`) and publish.

## Verification

`npm run check`: 283 tests, 279 pass, 4 opt-in skipped. `npm run test:e2e`:
7/7. `npm run verify:release`: passes.
