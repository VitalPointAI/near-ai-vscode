# Phase 28 context

## Approved scope

The [roadmap](../../ROADMAP.md#phase-28-secure-development-workflow-setup-step)
and [requirements](../../REQUIREMENTS.md) provide the Phase 28 product brief. This phase
adds an optional, reopenable step to the software Project Setup path. The DevOps member
prepares a reviewable pull-request workflow kit for the selected project. CI, independent
review and an owner-approved release are the downstream result when the owner has enabled
the required repository settings.

Repository files and remote settings are separate. The step previews local changes before
applying them to the selected project. It adds missing kit files, preserves custom files by
default, and presents actual differences for conflicts. The owner carries out branch
protection, deployment environment and credential setup. The step checks actual remote state
afterward and reports unknown or missing requirements. This phase does not grant authority
to change repository settings, approve a review or release, handle tokens, or run a live trial
on this repository.

## Baseline on main

SovAI already runs its own CI, independent review and release workflows from
`.github/workflows/`. The software profile includes a DevOps member with workflow guidance.
The registered Project Setup steps on `5bfeba0af` do not yet provide a guided workflow
export for another project or verify the target repository's protections.

## Planning interpretation

Use the existing Project Setup presentation, existing DevOps role and published workflow
patterns where they fit. Preserve the current default theme. Expose the distinct states for
unstarted, skipped, reviewable proposal, locally applied, awaiting owner setup and verified.
Preview and application depend on the selected project's current files. Verification depends
on the selected repository and its current rules. Surface a stale proposal, different repository
or inaccessible remote as a recoverable state. Narrow the first implementation to one concrete
supported project profile, then cover the complete requirements on that path. The research and
plans will identify that profile and the evidence for extending support.

The planning worktree starts at `5bfeba0af`. The existing merge order and owner checkpoints
apply to any later code or live acceptance.
