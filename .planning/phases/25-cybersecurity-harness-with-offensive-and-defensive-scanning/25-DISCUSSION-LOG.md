# Phase 25 — Discussion Log

**Phase:** 25, Cybersecurity harness with a target picker, offensive and defensive scans
**Date:** 2026-10-30
**Mode:** default (interactive), existing brief context updated rather than replaced

Human reference only. Downstream agents read `25-CONTEXT.md`.

## Areas discussed

Panel & entry · Targets & sandbox · Legal gate · Tools & models · Reporting & evidence (opened at the owner's request)

## Questions and answers

### Panel & entry
| Question | Options | Chosen |
|---|---|---|
| Where should the cybersecurity UI live? | Dedicated panel / Sidebar view / Both | **Dedicated panel** |
| How does a scan start? | Button in the panel / Hand off to chat / Panel run, chat mirror | **Hand off to chat** |
| What should the live run view show? | Step timeline / Raw stream / Timeline + stream tabs | **Step timeline** |
| How should intrusive actions get approved? | Per-step cards / One card per engagement run / Card per phase | **One card per engagement run** |
| After Run hands off to chat, where does the user end up? | Focus the panel / Stay in chat / Background panel | **Focus the panel** |
| Where do engagement records and findings live? | In the repo / Extension storage / Repo, ignored | **Extension storage** |

### Targets & sandbox
| Question | Options | Chosen |
|---|---|---|
| Which target kinds ship first? | URL/host/IP, Workspace, CIDR, Container/git repo | **All four** |
| Where should offensive payloads execute? | Container, else temp / Temp only / User runs the PoC | **Container, else temp** |
| How should address ranges be bounded? | Cap at /24 / Budget, no cap / No ranges yet | **Budget, no cap** |
| How is cleanup proven? | Snapshot diff / Ephemeral container / Both | **Both** |
| How far should post-exploitation go? | Minimal proof / Deeper proof / Model-led | **Model-led** (read-only, no persistence, no lateral movement) |
| How should external tooling be handled? | Detect / Built-ins only / Detect + offer install | **Detect + offer install** |

### Legal gate
| Question | Options | Chosen |
|---|---|---|
| How strong should the legal gate be? | Once per engagement / Every run / Once per workspace | **Once per engagement** |
| Which regions ship? | Six + other / Single statement / Twelve, auto-detected | **Twelve, auto-detected** |
| Public-sector and critical-infrastructure targets? | Default deny / Deny list + editable / Warn only | **Warn only** |
| Should the disclaimer travel with exports? | Always embedded / Markdown only / Opt-in | **Always embedded** |
| Who accepted? | Name required / Auto details / Optional field | **Name required** (+ OS user, machine, version, time) |
| When must the user accept again? | On scope change / Scope or version / Never | **Scope or version** |

### Tools & models
| Question | Options | Chosen |
|---|---|---|
| How should the harness talk to the model? | JSON-in-text always / Native with JSON fallback / Native only | **JSON-in-text always** |
| How should the four roles be staffed? | One model, four prompts / Two models split / Per-role setting | **One model, four prompts** |
| Which model runs a scan by default? | Chat model / Panel model / Strongest available | **Panel model** |
| What may the critic do with an unverifiable finding? | Verify, label rest / Drop unverified / Verify and re-probe | **Verify and re-probe** |
| How should the offensive path pick an exploit? | Known, then custom / Custom-first / Known-CVE only | **Known, then custom** |
| How is a failed exploit reported? | Four verdicts / Binary + note / Verdicts + one retry | **Four verdicts** |
| How much should depth vary? | Three profiles / Two profiles / Knobs, no profiles | **Three profiles** |

### Reporting & evidence (added after the owner's steer)
The owner noted the module must let someone "properly audit and report findings to the level expected of a pen tester", with suitable report and evidence export, captured approvals, and operation within legal bounds. This opened the reporting area.

| Question | Options | Chosen |
|---|---|---|
| What reporting standard? | PTES + OWASP WSTG / PTES + WSTG + CWE-CVE / Findings list | **PTES + OWASP WSTG** (with CVSS 3.1 per finding) |
| Which evidence must a finding capture? | HTTP captures / Raw tool output / Access proof / Visual captures | **All four** |
| How should the report prove evidence is unaltered? | Hash chain / Evidence hashes / Signed export | **Hash chain** |

## Noted for later

- Multi-user engagement sharing and a hosted report portal
- Scheduled/recurring scans and continuous monitoring
- Automatic remediation pull requests
- Publishing engagements to `.planning/security/` for team sharing
- Ed25519-signed report bundles (the hash chain was chosen instead)
- Cloning arbitrary git remotes / pulling container images: network allowlist entry to be researched

## Claude's discretion

Panel layout and step-timeline treatment; built-in probe set; JSON step schema, repair heuristics, retry and compaction numbers; CVSS derivation detail where evidence is ambiguous; evidence-blob placement and pruning inside globalStorage; exact wording of the twelve regional statements (owner review before release).
