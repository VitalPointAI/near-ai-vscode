# Phase 96. Bastion design crosswalk

The original SovAI context-graph research has no Bastion reference. This crosswalk
records a local read of Bastion at `52c50edf` and Bastion Components at `d639083`.
It uses product behavior as a design reference. Bastion's root README identifies
the project as proprietary, so this planning work carries over no code or assets.

| Bastion behavior | Local reference | SovAI requirement and acceptance |
| --- | --- | --- |
| Search and filter the graph, select a node, then inspect its details and relationships | `frontend/src/components/graph/GraphExplorer.tsx`, `NodeDetailPanel.tsx` | KB-05 entity pages open with the visible source evidence and connections. The server returns the reader's authorized view. Hidden nodes cannot affect search, counts or visible names. |
| Preserve who asserted a fact, where it came from and when it was valid. Preview source removal. | `backend/src/graph/provenance-types.ts`, `backend/src/doc-intelligence/provenance/provenance-store.ts`, `revert-service.ts` | KB-02 and KB-04 tie each assertion to an exact immutable source version and span. Show effective date and uncertainty. Invalidation rechecks dependent links without removing corroborated evidence. |
| Compare proposed entity matches beside the evidence | `frontend/src/components/plan/EntityResolutionPanel.tsx`, `backend/src/graph/resolution/resolution-service.test.ts` | KB-03 requires a reversible proposal flow with durable accept, reject and undo. Preserve underlying entities, attach both evidence versions and require visibility to both before naming the candidate. Bastion's merge and pending-list rejection do not implement this contract. |
| Save a lens, narrow a view and expand around an entity | `frontend/src/components/brain/LensSelector.tsx`, `SubspaceSidebar.tsx`, `hooks/useFocusExplosion.ts` | Carry the focused neighborhood interaction into Phase 96. Shared saved lenses and historical replay belong to Phase 97. Recompute all displays under the current reader's scope. |

Bastion Components has no context-graph implementation. Its
`docs/site/docs/concepts/capabilities-and-evidence.md` gives a related
authorization and evidence ordering reference.

## First verification slice

Use a fictional customer and internal project with two source scopes. Add an
authorized source that mentions both entities and a restricted source that
creates a candidate link and contributes another display name. Compare a view
built from the visible corpus with a view of the mixed corpus for the same
reader. Entity names, counts, relationships, source spans, suggestions and error
responses must match. Check that an authorized citation opens the exact recorded
version and span. Give the authorized reader a separate positive case so an
implementation that hides everything fails. Phase 93 remains a prerequisite for
production access enforcement, and SQL and browser acceptance must repeat the
same cases with the real authorization path.

The [Phase 96 research](../../research/data-platform/03-context-graph-analytics-knowledge-layer.md)
defines the evidence-first governed-store approach. The existing team-local
knowledge graph in `src/domain/teamKnowledge.ts` is a separate product surface
with materialized attributes and counts. Its data model does not prove
reader-relative visibility for the enterprise graph.
