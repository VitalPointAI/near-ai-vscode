---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 14
subsystem: compliance-evidence
tags: [evidence-bundle, sha256, oscal, dashboard, redaction]
requires:
  - phase: 44-04
    provides: status engine, gap state, and tailoring rules
  - phase: 44-05
    provides: dashboard schemas and component responsibility inputs
  - phase: 44-07
    provides: local CI evidence collectors
  - phase: 44-08
    provides: GitHub-backed evidence collectors
provides:
  - verifiable redacted evidence bundles and SHA-256 manifests
  - profile-backed level definitions and dashboard aggregation
  - dashboard, validate, and word-lint commands
affects: [44-15, 44-16, 44-19, accreditation-pages]
tech-stack:
  added: []
  patterns: [write-manifest-last, allow-list-before-write, status-engine-derived-dashboard]
key-files:
  created: [compliance/src/bundle.ts, compliance/src/manifest.ts, compliance/src/redact.ts, compliance/src/profiles.ts]
  modified: [compliance/src/dashboard.ts, compliance/src/cli.ts]
key-decisions:
  - "Bundle manifests enumerate regular files only and reject symlinks, additions, removals, and byte changes."
  - "Dashboard aggregation delegates component state to the existing status engine and uses summarizeLevel for totals."
requirements-completed: [ACCR-05, ACCR-07, ACCR-08, ACCR-11]
actuals:
  tokens: 13727
  tasks: 4
  commits: 4
commits: 4
plan_head_before: d6dbdff841f29cd6bc24b47f2d574099c3098cc0
plan_head_after: 6aecf79715c90b92587a87debdf8c80e0c8fc6da
duration: 32min
completed: 2026-11-21
status: complete
coverage:
  - id: D1
    description: Redacted SHA-256-verified evidence bundle with tamper detection.
    requirement: ACCR-05
    verification:
      - kind: unit
        ref: compliance/test/bundle.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Profile-derived level rows and status-engine dashboard totals.
    requirement: ACCR-07
    verification:
      - kind: unit
        ref: compliance/test/profiles.test.ts and compliance/test/dashboardGenerator.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Local validation and claim word-lint command surface.
    requirement: ACCR-08
    verification:
      - kind: integration
        ref: node compliance/src/cli.ts validate
        status: pass
    human_judgment: false
---

# Phase 44 Plan 14: Evidence Bundle and Dashboard Summary

**Redacted, SHA-256-verifiable evidence bundles with profile-based dashboard levels and local validation commands.**

## Accomplishments

- Added `bundle --inputs <file> [--previous <dir>] --out <dir>`, which runs the stable collector registry, records collector failures, redacts observations, carries verified prior observations for unrun collectors, and writes `observations.json`, `test-rows.json`, `collectors.json`, `dashboard/dashboard.json`, and `manifest.json`.
- Added a manifest verifier that rejects modified, added, missing, escaping, and symbolic-link bundle entries.
- Added level definitions for Unclassified, Protected A, Protected B, Classified, ITSP.10.171, CPCSC Level 1, Controlled Goods, and ITAR; dashboard totals now use `summarizeLevel` and classified rows are appliance-only.
- Added profile selection, evidence-rule loading, attributed control-text generation, and `dashboard`, `validate`, and `word-lint` commands.

## Task Commits

1. Task 1 — `ef670c56` `feat(44-14): create verifiable evidence bundles`
2. Task 2 — `44f3eeef` `feat(44-14): redact and carry evidence forward`
3. Task 3 — `5a055ab0` `feat(44-14): generate profile-backed level dashboards`
4. Task 4 — `6aecf797` `feat(44-14): add compliance output commands`

## Bundle Input and Layout

Inputs are `{ repository, commit, runUrl?, kind, repoRoot, collectors }`; the optional prior bundle is passed through `--previous`. The output folder contains `observations.json`, `test-rows.json`, `collectors.json`, `dashboard/dashboard.json`, and a final `manifest.json`. The manifest covers every other regular file using relative, forward-slashed SHA-256 entries.

## Levels

`levels.json` defines four levels (`unclassified`, `protected-a`, `protected-b`, `classified`) and four overlays (`itsp-10-171`, `cpcsc-level-1`, `overlay-cgp`, `overlay-itar`). Classified is explicitly `claim: false`, forcing appliance-only Not met rows.

## Deviations from Plan

### Auto-fixed Issues

1. [Rule 3 - Verification environment] The requested `systemd-run --user` verification wrapper cannot connect to the sandbox user bus. The identical bounded lint/test command was run directly, then the complete suite was rerun with process-spawn permission.

## Verification

- `npm --prefix compliance run lint` passed.
- `npm --prefix compliance test` passed: 274 tests, 0 failures.
- `node compliance/src/cli.ts validate` passed; it reports the planned, not-yet-imported profiles without failing.

## Self-Check: PASSED

- All task commit hashes are ancestors of `HEAD`.
- Bundle, manifest, redaction, profile, level, and command files exist.
