---
phase: "96"
slug: "search-context-graph-entity-pages-and-ask"
status: approved
reviewed_at: "2026-11-26"
shadcn_initialized: false
preset: none
created: "2026-11-26"
---

# Phase 96 — Context Graph Explorer

The explorer shows how evidence becomes part of a graph while people continue to work with it. Use the owner’s motion direction, the [Bastion design crosswalk](96-BASTION-CROSSWALK.md), and the [context graph research](../../research/data-platform/03-context-graph-analytics-knowledge-layer.md). This contract covers the graph, its evidence inspector, and the interactions that lead between them under KB-02, KB-03, KB-05, KB-07, KB-08 and KB-15. Production uses Phase 93’s authorization path.

## Design System

| Property | Value |
| --- | --- |
| Tool | none |
| Preset | Not applicable |
| Component library | Existing Workbench and webview patterns. Use native controls for search, menus and focusable results. |
| Icon library | Workbench Codicons, including the Welcome view’s pause and play icons. Include visible labels where space permits and accessible names at every size. |
| Font | Inherit the Workbench UI font from the host. |

Reuse the theme boundary in `media/shared/base.css` and the focus and detail panel patterns in `workbench/extension/src/browser/sterling-work-areas.css`. The local graph in `media/teams/network.css` provides a precedent for theme-aware edge drawing and reduced motion. The Welcome view in `workbench/extension/src/browser/sterling-welcome-module.ts` supplies the pause control pattern. Keep the team data model separate from the reader-relative enterprise graph. Renderer selection remains open. The existing research names Cytoscape.js and Sigma.js. Evaluate position control and interaction performance against the same fixture if a renderer choice is needed. [Cytoscape position and layout API](https://js.cytoscape.org/#layouts/preset) · [Sigma rendering](https://www.sigmajs.org/concepts/rendering/)

## Spacing Scale

| Token | Value | Usage |
| --- | ---: | --- |
| xs | 4px | Icon and label gaps |
| sm | 8px | Toolbar groups and evidence metadata |
| md | 16px | Surface padding and evidence row gaps |
| lg | 24px | Gaps between evidence sections |
| xl | 32px | Canvas clearance at initial fit |

Use 44px touch targets for toolbar and list actions when a coarse pointer is detected. Apply 8px corner radii to the inset canvas and inspector. Defaults are scoped to this phase.

## Typography

| Role | Size | Weight | Line height |
| --- | ---: | ---: | ---: |
| Graph and evidence label | 12px | 400 | 1.4 |
| Controls and evidence body | 14px | 400 | 1.5 |
| Entity and inspector heading | 18px | 600 | 1.25 |

Keep graph labels at a readable screen size when visible. At wide zoom, give the selected entity and its neighborhood priority. The item list and inspector retain full names at every zoom.

## Color

| Role | Theme value | Usage |
| --- | --- | --- |
| Dominant (60%) | Editor background and foreground | Graph canvas and base text |
| Secondary (30%) | Editor widget background, border and description foreground | Inspector, toolbar and quiet edge strokes |
| Accent (10%) | Theme chart blue | Selected node ring and bounded new-evidence highlight |
| Destructive | Existing Workbench error foreground | Error text only. This explorer has no destructive action. |

Use one low-contrast dot grid under the graph, with no grid labels. Render relationship lines softly, with a distinct stroke and visible directional arrowhead when direction is meaningful. Reserve the host focus-border token for semantic keyboard focus. Use a solid focus outline and an explicit **Updated** label as non-color cues. Use the host’s high-contrast tokens where available. Give labels and controls the existing Workbench contrast requirements. Keep update blue separate from operational health status, classification markings, and warning colors.

## Workspace and interaction

Use a full editor-area view with an inset, quiet canvas as the main surface. Place search, current scope and filters in one wrapping toolbar. Keep **Zoom in**, **Zoom out**, **Fit view**, **Pause motion** and a **Graph / List** switch within reach. Keep the toolbar separate from the inspector so keyboard focus stays visible. At 960px pane width and above, show a 320px evidence inspector alongside the canvas. Below that, place the same inspector after the graph in normal scroll order. At 640px or below prioritize the search, fit, motion and view controls, put secondary canvas controls in a named menu, and avoid horizontal scrolling. Use the list as an equivalent route on a narrow pane.

Start with the selected entity and its immediate authorized neighborhood. Use restrained visual hierarchy. Make the selected entity larger, give its neighbors lightweight rings and reveal full labels for the current focus. A user can select any visible node to inspect it, open its evidence, or choose **Expand neighborhood**. Select an edge to see the relationship and its source evidence. Preserve the current camera, selection, focus and inspector scroll on background updates. Fit, expand, or recenter only from an explicit interaction. Keep attached labels, hit areas and selection aligned during layout and camera changes. Provide pan by dragging blank canvas or by arrow keys while canvas navigation is focused, zoom with the named controls or `+` and `-`, and reset with **Fit view**. Keep wheel scrolling available outside the graph. Pointer interactions stay responsive while evidence is settling.

Make the list a keyboard-accessible representation of the same authorized nodes and relationships, sorted by the visible view contract. Use native focus navigation, visible focus indicators and `Enter` to inspect the focused result. Restore focus to the initiating row or control when closing an inspector. If a focused result disappears, move focus to the next available row or the stable search control. Use normal `Tab` navigation to leave the explorer. Dragging has named, keyboard-operable alternatives. [WCAG 2.2 keyboard, focus and dragging](https://www.w3.org/TR/WCAG22/)

The inspector shows the entity or relationship name, visible facts and linked entities, and each assertion’s authorized source name, exact version and span. Show effective date and uncertainty when present in the authorized payload. Use **Open source** to take the person to the exact cited span. Keep conflicting evidence side by side. A proposed entity match is labeled **Proposed match** and retains both underlying entities until the Phase 96 review action succeeds. Open its existing reversible review flow from the inspector. Shared saved views and historical playback follow Phase 97.

## Motion and authorized updates

Design defaults below describe presentation timing. Ingestion, access enforcement and evidence acceptance own their existing clocks.

| Event | Treatment | Behavior |
| --- | --- | --- |
| First load, search, filter or scope change | Briefly reveal the admitted view together | First view fits once. A filter retains zoom and surviving coordinates. A fresh scope discards prior anchors and any pending animation. Initial results do not pulse as new evidence. |
| Newly admitted entity | Fade in over 180ms near a visible connected entity, with an ease-out settle over 260ms into a free position | For an admitted isolated entity, reveal it in place. Hit areas follow the visible positions. Existing nodes keep their graph coordinates. |
| Newly admitted relationship | Draw the relationship toward its endpoint over 280ms | Start when both endpoints are visible. Keep the line attached through settling. For an undirected edge reveal the line symmetrically. Keep its label legible after drawing. |
| New visible evidence on a node or relationship | One low-amplitude halo on affected nodes and an accented stroke on the affected link, fading over 440ms | Start the highlight alongside settling and drawing. A brief **Updated** cue appears in the list or inspector. The pulse means newly visible evidence arrived. |
| Burst of visible changes | Coalesce into a 160ms presentation batch and keep only one active animation per changed element | Above 12 changed elements in a batch, settle the full authorized projection once and highlight the affected visible neighborhood as a group. End an ordinary batch’s decoration within 700ms. Use one polite status announcement per authorized batch with no unrelated counts. |
| Pause or reduced motion | Snapshot immediately to final positions with equivalent static updated styling | **Pause motion** only pauses decorative animation and cancels current transitions. Authorized updates and evidence inspection continue. **Resume motion** affects future batches. Operating-system reduced motion applies on load and live changes, including automatic camera transitions. Updates are never replayed to catch up. |
| Removed or no longer accessible item | Remove immediately, invalidate affected details and stop transitions | Leave no ghost, stale caption, retained layout hole, tooltip, notification or count naming the removed item. The user can continue from a surviving selected entity or the stable search control. |

Pan and zoom change the camera without restarting graph layout. A visible update can continue settling while the user navigates. During active pointer gestures postpone only a camera action the user requested, such as an explicit fit. Never defer delivery, activation of new hit areas or removal of inaccessible evidence for motion. For busy views prefer static settled placement to dropping valid gestures or queueing old transitions. Render and hit-test only the current authorized, capped projection. Show its page or cap, never a total for data outside it.

### Security and decision boundaries

Use the governed host bridge as the boundary. The webview receives only capped, already authorized snapshots and deltas under its current scope and generation. It performs no direct connector fetches. Preserve the strict CSP. Compute update cadence from authorized projection changes. Raw ingestion events, global queue depth, pre-filter counts and unrelated store revision numbers are outside the view contract. The fixture with hidden data and the otherwise identical fixture with those rows absent must produce the same layout, labels, update schedule, accessible tree, status and evidence route for the same reader. A change outside that scope cannot schedule a render, reset a batch, change a counter, affect positions or trigger a repaint cue. Empty authorized projections do not reveal whether other data exists. Reject out-of-date and wrong-generation bridge results without announcing hidden activity.

When visibility shrinks or is uncertain, invalidate affected client data and pending interactions immediately. Reset selection and scope-local layout anchors only as needed, and require the current authorized snapshot before rebuilding the view. KB-15’s approved existence-only notice belongs on its authorized search or entity surface. It does not become a graph node, relationship, animated update or topology input. Keep the default disabled under organization policy.

## Copywriting Contract

| Element | Copy |
| --- | --- |
| Primary CTA | **Explore graph** |
| Graph actions | **Expand neighborhood**, **Fit view**, **Open source** |
| Motion | **Pause motion** / **Resume motion** |
| Evidence update | **Updated**. Screen-reader summary: **Graph updated** for a grouped authorized change. |
| No initial results | **Choose an entity**. Search for a person, organization or project to open its graph. |
| No matching search results | **No matching entities**. Try a different term or filter. |
| No connections | **No connections in this view**. Change a filter or choose another entity. |
| Loading | **Loading graph** |
| Load or revalidation error | **Graph unavailable**. **Try again**. Preserve the search and filters. |
| Source no longer available | **Source unavailable**. Return to the graph to see current evidence. |
| Capped view | **More connections available** only if the authorized view reports another page. **Show more** requests the next bounded view. |
| Destructive confirmation | None. Review proposals through their existing separate action. |

## UI Considerations

Applicable state considerations resolved: 7 covered, 1 backstop, 0 unresolved.

| Category | Element(s) | Status | Resolution / Reason |
| --- | --- | --- | --- |
| Empty | Search results, entity neighborhood | ✅ covered | Separate no-selection and empty-neighborhood views using the documented copy. |
| Loading | Graph and inspector | ✅ covered | Show status with a stable frame. Keep search, motion controls and current authorized evidence usable through ordinary refresh. |
| Error | Host query and source requests | ✅ covered | Keep inputs, use the corresponding error action, and clear evidence without current authorization. |
| Populated | Graph, list and inspector | ✅ covered | Current node and relationship selection opens the same authorized details in either view. |
| Partial | Evidence fields and approved projections | ✅ covered | Missing optional fields have no invented value. A capped view describes additional authorized pages only. |
| Overflow | Canvas, long lists, toolbar and inspector | 🧪 backstop | Real pane resize retains fit, motion, source and focus controls and provides an equivalent list without horizontal overflow. |
| Zero-one-many | Nodes and relationships | ✅ covered | One node is readable without an edge. Groups use only the currently authorized results and the same controls. |
| Long-text | Entity names, labels and source text | ✅ covered | Graph labels may ellipsize. The selected inspector and result detail retain the full wrapping text. |

## Browser acceptance

1. Use two fictional readers from [96-01](96-01-SUMMARY.md). Feed a deterministic authorized sequence with an isolated entity, a new related entity and a new assertion for an existing edge. With a controllable clock, observe entry, settle and one pulse on the affected visible elements. Verify the final exact graph, live status and cited source version and span. Verify the other authorized reader sees its additional evidence so suppressing all changes fails.
2. During an authorized burst, zoom, pan, filter, change selection and open a source. Assert untouched surviving coordinates and stable selection and focus while the pointer moves. Measure a representative fixture of 200 visible nodes and 400 visible relationships on the agreed Workbench test rig. Record browser and viewport details. At 60Hz target p95 input-to-next-painted-response within 50ms during the scripted update and interaction. Report this as fixture evidence with a separate production performance measurement when the authorized deployment rig is known.
3. Drive the exact same scenario with operating-system reduced motion, explicit pause, keyboard-only, narrow and wide panes, and light, dark and high-contrast themes. Confirm no automatic spatial motion or pulse while paused or reduced. Confirm identical current graph, equivalent updated cues and source access. Toggle motion during an active pulse and require immediate settlement without replay. Check focus visibility, full names in list and detail, and directed edges without reliance on color.
4. Repeat the lower-clearance scenario with hidden data physically absent and with it present, including same-label source denial. Under the same controlled event schedule and visible requests, compare authorized bridge payloads, geometry, render events and their timing, list and inspector, announcements, counters and denied source behavior. Run with motion on and off. Test KB-15 separately and assert approved placeholder notices stay out of graph layout and updates. Reject old scope snapshots and deltas. Revoke the selected evidence mid-animation and assert it disappears immediately from graph, list, inspector and pending work, without a notification naming it. Compare the surviving geometry to a fresh projection at the reduced authority, removing any layout anchors derived from revoked evidence.

A prototype may use deterministic synthetic snapshots and deltas from the local Phase 96 fixture for demonstration and browser design checks. Production acceptance repeats the positive and indistinguishability cases through the real Phase 93 authorization path and governed store. A local prototype cannot establish production access control, performance or latency guarantees.

## Registry Safety

| Registry | Blocks Used | Safety Gate |
| --- | --- | --- |
| None | None | Existing local Workbench patterns only. |

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS
- [x] Dimension 7 Inventory Provenance: PASS

**Approval:** Independently checked for planning on 2026-11-26.
