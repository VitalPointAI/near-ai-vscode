---
phase: 46-native-theia-foundation
plan: launcher-storage
subsystem: infra
tags: [workbench, launcher, docker, storage, diagnostics]
duration: not recorded
completed: 2026-11-26
---

# Workbench setup storage reading

The Linux Workbench setup check reports available storage in GiB and exact bytes for the
filesystem visible in the launcher’s mount namespace at the daemon’s configured data-root
path. Other mounts may differ. The read uses available blocks and the allocation unit,
with the documented fallback when the allocation unit is missing or zero. Unavailable
storage leaves the software prerequisite result and any readable CPU and memory data
intact. Normal launch and explicit repair retain their existing flow.

The reviewed tests-first plan covered the local amd64 and arm64 paths with a fixture.
The initial RED run had two failures because storage output was missing. The first GREEN
run passed all eight checks. Review then found that a blank CPU and memory line could hide
valid storage. The added case reproduced that failure, and the final capped Node 26.13.1
run passed all eight checks with zero skips. The suite covers distinct allocation and
block sizes, distinct available and free counts, zero space, precise large byte counts,
malformed paths, failed reads, and check-only observation. Source syntax and whitespace
checks passed. The bundled Node 26 launcher run also passed all eight checks with zero skips.
The CLI help and generated road-to-production checks passed. Verification used recording
fixtures without a live Docker engine.

## Open conditions

None.
