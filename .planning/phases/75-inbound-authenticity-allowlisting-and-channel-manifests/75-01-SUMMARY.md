---
phase: 75-inbound-authenticity-allowlisting-and-channel-manifests
plan: "01"
completed: 2026-11-26
---

# Clear acknowledged relay payloads

The relay now clears a claimed message's payload in the same SQLite update that marks it done. The tenant and claimed-state checks still guard the transition. After restart, a delivery with the same dedupe key returns the original message and run IDs, and the payload stays blank. Queued and recovered messages retain their text until they are acknowledged.

The tests-first run reproduced the retained payload. The corrected implementation passed all 47 SQLite contract checks, relay type checking and all 176 relay unit checks with zero skips under the shared cap. Coverage includes the wrong-tenant refusal, duplicate acknowledgement, restart, duplicate delivery with a different body, and claimed-message recovery. Independent plan and source review passed.

This applies IN-04 to each successful acknowledgement going forward. Completed rows from before the change retain their stored payloads. The change establishes logical blanking in the queue. The broader channel and credential work remains in its existing phases.

## Open conditions

None.
