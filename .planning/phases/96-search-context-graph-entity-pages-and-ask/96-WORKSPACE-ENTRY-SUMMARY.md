---
phase: 96-search-context-graph-entity-pages-and-ask
plan: workspace-entry
completed: 2026-11-28
---

# Context Graph workspace entry

Context Graph opens as one native main-area tab from the right-hand rail next to Data Management. The English and French landing focuses its heading on activation, explains the view's purpose, and shows that a governed graph source is unavailable. Its Documentation action opens the existing Workbench page.

The workspace entry leaves authorized exploration and source citations in Phase 96's governed data work. Versioned saved views, subscriptions and shared workspace defaults remain Phase 97 follow-ons.

## Verification

- On the earlier private native build, the new keyboard test reached the rail and failed because Context Graph was absent. RED log SHA-256 `6b68f092ec134879389d83b11529abb5b66abd66016fe06758325072d5791a91`.
- Both Workbench typechecks and the fresh production Workbench build passed from exact archived source `cdee8167513757f1561c2dc120343d591fd37a95` on Node 26.13.1 with lock-identical read-only caches and network disabled. Build log SHA-256 `37ef1411410160e397967bcfea977ffd6a4ce78ee697a305856aa638be72b88b`.
- Cached Chromium revision 1254 (`158.0.8127.18`) passed both the Context Graph keyboard journey and the adjacent rail regression with zero skips. The disposable native instance used a fresh profile, an empty workspace and a network namespace containing only loopback. The graph journey verified English Enter and French Space, heading focus, one tab, the unavailable status, Documentation, and returning to Get Started. The first build's French test selector matched both the graph tab and a selected Settings tab in a separate pane. The final test selects the localized tab by name and retains the focus and singleton assertions. Final browser log SHA-256 `0b5114bcbb6d2b14ed5d1436e9241e27f53d21c2ae297b1ffeab23b2100ba5c7`.

## Open conditions

- **G461 and G464.** Production graph data requires organization-set classification rules and extraction evidence for hidden content in ingested sources. The governed provider also needs current workspace and source authorization, revocation, and exact citation evidence before supplying records.
- **G561.** Qualified Canadian French terminology review remains open. The browser check covered keyboard interaction and live locale switching in the disposable native Workbench.
