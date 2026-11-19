# Staff Room: UX concept for AI-augmented military staff teams

Date: 2026-11-18. Status: concept with the owner's decisions of 2026-11-18 applied (all questions in section 16 accepted as recommended). Nothing here is built yet, except the clickable prototype.

Prototype: [`prototype/war-room.html`](prototype/war-room.html). Open it in any current browser with no network. Press Play, or add `?autoplay` to the address. It runs about 75 seconds at 1x and stops twice for a person.

Inputs: research notes 00 to 09 and design note 10 in this folder; the extension's Team Live, Team Studio, chat and trust badge pages (`media/teamLive`, `media/teams`, `media/chat/trustBadge.js`) and the README sections that describe them; and the owner's mockups in VitalPointAI/ai-workbench (`Planning.html`, `Command.html`, `Globe.html`, `Main.html`, `Monitor.html`, `Approvals.html`), whose visual language this concept adopts.

Every scenario, unit, place and person in this document and in the prototype is fictional and unclassified.

---

## 1. Key points first

1. **One new panel, the Staff Room.** It is a VS Code webview like Team Live. It shows a staff run as a live war room: the planning process across the top, the staff sections as squads of agents below it, the work in the middle (threat map, COA workspace, wargame, comparison, orders), human decisions and products on the right, and the synchronization matrix along the bottom. It draws only the read models and events that design note 10 (section 4.5) already defines, so nothing on screen can drift from what the run really did.
2. **The process is not replicated; it is compressed.** Agents draft every section's estimate at once, test COAs in parallel cells, keep the wargame ledger and turn it straight into the sync matrix, DST and DSM, and check every annex mechanically. People spend their time on the moments that need judgement: releasing intelligence, choosing a COA, signing the plan. Section 7 estimates the time saved per step. These are targets to measure in an exercise trial, not results.
3. **Human authority is the brightest thing on the screen.** Gold is reserved for human decisions and nothing else. Every gate is a diamond that only a named person can open. The decision gate is a deliberate ceremony with the brief, the dissent, acknowledgements, a minimum deliberation time and a signature. Agents stop at the gate, and the screen says so in words.
4. **Motion means something, or it does not happen.** A travelling dot is a hand-off of a named product. A drawing arrow is a COA or an enemy course of action being committed to the map. A breathing ring is an agent working. Nothing moves for decoration. Under reduced motion, or with Calm on, nothing travels: links appear and fade, and every change is still shown in words and icons.
5. **It grows into the wargaming suite.** The wargame view already holds a turn ledger, action, reaction and counteraction phases, unit moves on the map, decision points and a time cursor shared with the sync matrix. Section 13 describes how that becomes the owner's full visual wargaming suite without a rewrite.

---

## 2. The experience vision: the first five minutes

A J2 officer and a planning group open the Staff Room on a projector for the first time. This is what they see and feel.

**0:00. The room wakes up.** A thin green banner reads UNCLASSIFIED // EXERCISE // FICTIONAL DATA at the top and bottom. Under the header, seven steps of the planning process sit in a row, named in their own doctrine (US Joint, US Army or NATO/Canadian). Steps 1 and 2 are green. A small gold diamond between them carries a tick and, on hover, a name and a time: the commander approved the mission analysis brief at 0840Z. Step 3 glows violet. The staff is at work.

**0:10. The squad lights up.** Below the rail, five panels hold the staff: the chief of staff cell, then J2, J5, J3 and J4. Each agent is a round token with a short role label: chief, threat, collect, red cell, review, guard. The chief of staff sends four violet dots fanning out, one to each section, each with a small label: "Step 3 tasks, due 1330Z". Each section's tag flips from "ready" to "running". The room reads like a squad briefing in a game, but every label is doctrine.

**0:20. The enemy appears.** The J2 tokens start spinning. On the map, hostile diamonds drop in one at a time with a ripple: a coastal brigade headquarters, two mechanized battalions, an armour company, artillery. An unknown sea contact appears as a yellow quatrefoil. Then a red dashed arrow draws itself: the enemy's most likely course of action. A second, thicker one follows, sweeping off the ridge toward the friendly flank: the most dangerous. The side panel reads "Likely (55 to 80 percent)" and, in a separate sentence, "Moderate confidence". Named areas of interest appear, and the collection plan fills: each priority intelligence requirement tied to an area and a latest time of value.

**1:10. A person owns intelligence.** The tradecraft reviewer signs off and the release guard clears the product. Then everything stops. A gold card appears under Human decisions: "Approve and release the JIPOE enemy COA set v2. Owner: the J2." The J2 officer, the person in the room, clicks it. Four green dots fly from the product to the two COA cells, future operations and the J4. The officer sees their own decision become the whole staff's starting point.

**1:30. Two plans grow at once.** The view slides to the COA workspace. The lead planner sends each COA cell a distinct theme: "by land, via Ashby Ford" and "from the sea". Two sketches build side by side, units placing themselves, axes of advance drawing on, statements typing in. Five validity tests tick green, except one amber triangle on COA B: feasibility depends on landing craft. The J4 sends "fuel risk at H+36"; the red team sends a challenge to the J2: "no reporting on sea mines, add a PIR". The audience sees sections arguing productively in seconds.

**2:30. The red cell fights back.** The wargame runs on the map. ACTION lights blue: the main attack seizes the ford. REACTION lights red: the J2 red cell sends the enemy armour into the flank. COUNTERACTION: fires ripple on the armour, the reserve moves, and a gold star drops on the map: decision point 1. Below, the sync matrix fills row by row as a violet time cursor sweeps from H-hour to H+30. The officers realise the matrix they normally retype for hours after a wargame has been written while they watched.

**3:30. The comparison and the gate.** Scores grow against the criteria the commander approved this morning. The staff recommendation appears in violet, labelled "drafted by agents". The red team's dissent appears beside it, unedited. Then the room dims and the decision brief opens for the commander, in gold.

**4:30. The commander decides.** The commander reads, ticks three acknowledgements, waits out a short minimum deliberation, chooses, and signs. A gold seal stamps "APPROVED, COA A, signed". The rail's gold diamond unlocks, and annexes start writing themselves in parallel, each with an owner and the right letter for the doctrine. The run stops one more time, at plan approval, waiting for a person.

What they feel: this is fast and alive, it speaks their language, and at no point did the machine decide anything.

---

## 3. The five most important design ideas

1. **One clock across map, matrix and rail.** The wargame's time cursor, the sync matrix cursor, decision points on the map and the step progress on the rail are one shared timeline. Scrub one and the others follow. This is what turns a slide deck of separate products into one picture of time and space.
2. **Hand-offs are visible objects that carry a named product.** Every transfer between agents, sections, products and people is a dot with a label ("Enemy COAs v2", "DP 2", "Decision: COA A"). It uses the same grammar as Team Live (a dot with a chip, at most six at once, queued after that), coloured by meaning: violet for tasking, green for a delivered product, gold for a human decision.
3. **Products land where they are used.** Enemy COAs draw onto the map. COA sketches build on their own mini maps. Wargame moves happen on the map and fill the matrix. Annexes fill the orders tracker. The ledger on the right is the record, not the place where work hides.
4. **Gold is human authority, and the gate is a ceremony.** Gold is used only for people and their decisions: human leads, gates, decision cards, signatures. The decision gate puts the brief, the dissent, the risk and the signature in one place, with a minimum deliberation time set by the organization. Agents visibly wait at a gate and cannot pass it.
5. **Evidence is one click away from every pixel.** Every symbol, product, matrix cell and score opens its provenance: who drafted it, which version, which sources with reliability and credibility graded separately, which gates it passed (tradecraft SIGN-OFF, guard CLEARED), which model, whether that model was verified private, and its label. This is what lets a staff trust speed.

---

## 4. Where the Staff Room fits in the extension

| Entry point | What it opens |
|---|---|
| Starting a staff team run (`/team:` with a staff template, or the joint staff team of teams) | The chat shows the run as today; an **Open the Staff Room** button sits next to **Watch the team** |
| Team Studio, a staff team's card | **Open the Staff Room** while the team runs; the last run's replay when it does not |
| Command palette | **NEAR AI: Open the Staff Room** |
| Agent Activity, **Now** | **Open the Staff Room** for a staff run |

Relationship to existing pages:

- **Team Live** stays the general view of any team run. The Staff Room is the staff-specific view of the same run, adding the process rail, products, gates, the map and the matrix. Both read the same activity feed, so they always agree.
- **The trust badge** component (`media/chat/trustBadge.js`) is reused as is, on agent cards and product cards, with the same three states and words.
- **Labels and clearances** come from the Phase 70 gate. The Staff Room only displays them; it never changes them.
- **Approve, reject and release** are VS Code commands (design 10, section 4.1). The Staff Room's buttons call those commands; they are not tools an agent can reach.

### 4.1 Screens mapped to read models and events (design 10, section 4.5)

| Screen element | Read model | Events that change it |
|---|---|---|
| Process rail | Staff run (profile, level, current step per section), Step board | `staff.step.entered`, `staff.decision.recorded` |
| Gates on the rail | Decision queue, Product registry | `staff.decision.requested`, `staff.decision.recorded`, `staff.product.state` |
| Squads and tokens | Step board (lanes, member, status) | `staff.lane.started`, `staff.lane.finished`, `staff.waiting` |
| Section tag ("team: j2-intelligence, running") | Staff run (team-of-teams tree) | `staff.team.nested` |
| Hand-off dots | none (derived) | `staff.lane.started` (task out), `staff.product.state` to guard-checked or released (product back), `staff.decision.recorded` (gold) |
| Products ledger | Product registry | `staff.product.state`, `staff.gate.verdict` |
| Human decisions | Decision queue | `staff.decision.requested`, `staff.decision.recorded` |
| Threat map, COP | COP (layers, owners) | `staff.cop.updated` |
| Collection plan | Shared registers (PIR register) | `staff.product.state` on the register |
| COA workspace | Product registry (COA statements), COP plans layer | `staff.cop.updated` (plans layer), `staff.gate.verdict` |
| Wargame | Wargame ledger (in `staff-products`), COP | ledger entries (a new `staff.wargame.turn` event is proposed in section 12.5) |
| Sync matrix, DST and DSM | Shared registers | `staff.product.state` on the register |
| Orders tracker | Shared registers (annex tracker) | `staff.merge.started`, `staff.merge.conflict`, `staff.merge.resolved` |
| Waiting and RFIs | Shared registers (RFI tracker) | `staff.rfi.opened`, `staff.rfi.answered`, `staff.rfi.overdue`, `staff.waiting` |

---

## 5. Core screens

The prototype implements screens 5.1 to 5.9 and 5.11. Screens 5.10, 5.12 and 5.13 are described here and partly visible in the prototype.

### 5.1 The war room home

**Purpose:** the whole staff run in one view, readable from the back of a room.

**Layout (1280 px wide and up):**
- Classification banner, top and bottom: `UNCLASSIFIED // EXERCISE // FICTIONAL DATA`. Nothing beyond this banner is ever shown. Staff templates are capped at exercise data (design 10, section 6).
- Header: product name, operation and HQ, exercise clock (DTG) with the next decision deadline, the current beat, run controls (pause, stop all agents).
- Process rail (5.2), with the doctrine profile picker and the planning-time budget at its right.
- Squads (5.3).
- Main view with tabs: J2 threat picture, COA workspace, Wargame, COA comparison, Orders and annexes. **Follow the action** switches tabs as the work moves, like a spectator camera. Choosing a tab turns it off, and a dot on another tab says something is happening there.
- Right column: Human decisions (gold) above Products and hand-offs.
- Bottom: the synchronization matrix, collapsed to one line until there is something in it.
- Status bar: label and clearance, trust state of every agent, "gates enforced by the extension", "every version recorded", and the view controls (Calm, theme, sound, keyboard help).

**Responsive behaviour:** below 900 px of height the rail and squads go compact and each COA sketch moves its text beside the map. Narrower than 1280 px (a side panel in VS Code), the right column moves under the main view and the squads become a single row of tokens. Below 720 px wide it falls back to the existing Team Live list view plus the decision queue, because a map that small helps nobody.

### 5.2 The process rail

**Purpose:** where the staff is in the process, who is working on each step, and where the human gates are.

- One card per step, named by the doctrine profile (design 10, section 2.2): US Joint (JPP, 7 steps), US Army (MDMP, 7 steps) or NATO/Canadian (AJP-5 Edition B at strategic and operational level, APP-28 at tactical level). The level setting (strategic, operational, tactical) picks the process. US Joint at tactical level is steered to MDMP, as the design requires.
- Each card shows the step number, name, status in words (Done, Working now, Next, Waiting for a named person), a progress bar, and chips for the sections working on it. A chip lights violet while that section has an agent working.
- The decision step (COA approval) is drawn with a dashed border and a gold diamond in its title.
- **Gates** sit between steps: mission analysis brief, COA decision, plan approval. A gate is a diamond with a lock (not reached), a pulsing gold outline (waiting for a named person), a gold fill with a tick and the person's name on hover (approved), or an amber return arrow (returned to the staff with guidance).
- **Profile switch:** changing the profile renames steps, product names (JIPOE or IPB), COA tests and annex letters. Products already approved keep the profile they were approved under (design 10, section 2.1); the switch never renames anything a person signed.
- **Planning-time budget:** used time against the window, with a gold mark at one third. This is the one-third, two-thirds rule made visible: the staff can see how much time it is leaving its subordinate units.

### 5.3 The staff squads (team of teams)

**Purpose:** game-like presence for every agent, with the staff structure intact.

- One panel per section, plus the chief of staff cell. With the team-of-teams feature (design 10, section 5), each section panel is one **nested team run**. A small tag on the panel's border shows the nested run's state in words, from design 10's state machine: requested, ready, queued, running, waiting, reporting, merging, conflict, done, refused, failed, cancelled.
- The human lead's name sits in gold at the panel's top right (J2: the named J2; COS cell: the named chief of staff). The person is always on screen.
- Agent tokens: a round token with a two-letter abbreviation and a short role label. States from Team Live, each with an icon and words, never colour alone: not tasked (dimmed), working (violet, a slowly rotating arc), waiting (dashed rim, pause badge), needs a person (gold rim, alert badge), done (green tick badge), paused, stopped (red square badge).
- A status line per section: "3 working · threat-analyst > Drafting enemy COAs with ACH". The text types in quickly, which reads as live without moving anything else.
- A token opens the **agent card**: role, reports-to, current task, model tier, where it runs and its trust state, what it may read (the clearance), and the line "Drafts and recommends. Cannot approve, release or sign." It also has **Pause**, **Resume** and **Stop**.
- Only members tasked in the current step are shown as full tokens. A "+6" chip opens the rest of a section's roster (each section template has 12 members).
- With the full staff (design 10, section 5.5), the squads become a scrolling strip: COS cell, J1 to J9, special staff. The current step's primary and supporting sections come first.

### 5.4 Products and hand-offs (the ledger)

**Purpose:** the record of every product version and its place in the release state machine.

- Newest first. Each row: section, product and version, state pill, drafting agent or person, time, and a green tick when it was drafted on a verified private model.
- State pills use design 10's release state machine words exactly: `draft`, `guard-checked`, `awaiting decision`, `approved`, `rejected`, `released`, `superseded`, `withdrawn`, plus `draft (held)` after a HOLD or NOT READY verdict and `draft (tampered)` when a header claims a state the decision log does not support. `approved` and `released` are gold, because only a person can set them.
- A row opens the **product card**: owner, version, state history, who approved it (name, role, time, "signed with this device's key; identity self-declared until Phase 71"), gate verdicts on that exact version, what it depends on, who receives it, label, and graded sources.
- **Source changed:** when an approved product a row depends on changes, the row gets an amber "source changed" mark and its owner is told. The product drops back to draft only when its owner accepts the change. This is design 10's dependency propagation, made visible.

### 5.5 The J2 threat picture

**Purpose:** the J2's main product line on one screen: adversary, environment, MLCOA and MDCOA, and the collection plan.

- **Map** (5.10) with the threat layer: hostile units in APP-6 / MIL-STD-2525 frames, unknown contacts, named areas of interest, and enemy COAs as dashed red axes (dashed, because they are anticipated, not reported).
- **Layer switches** with their owning section (threat J2, own forces J3, control measures J3, logistics J4). Each layer has a single writer, as design 10 requires.
- **Enemy COA cards**, in probability order. Each card keeps the likelihood term (ICD 203 scale, with the range) and the confidence statement in separate sentences, because the tradecraft gate forbids mixing them. Sources are listed with reliability and credibility grades.
- **Collection plan:** PIR, NAI, latest time of value, and the line "J2 recommends, J3 tasks". A PIR added by another section (the red team's mine question in the demo) is highlighted when it arrives.
- **Gates for intelligence:** tradecraft SIGN-OFF first, then release-guard CLEARED, then the J2 (a person) approves and releases. The screen shows all three in order, and the release is a gold decision card.
- **Map as table** turns the map into two tables (units, graphics) with the same facts, for screen readers and for checking.

### 5.6 The COA workspace

**Purpose:** COA cells working side by side, visibly distinct.

- One pane per COA cell (two by default, matching the J5 template), each with its theme, owner and model, a sketch on its own mini map (the COP plans layer, which never merges into the current picture), the COA statement, the profile's validity tests and the supportability checks from other sections.
- **Validity tests per profile** (design 10, section 2.2): US Joint: suitable, feasible, acceptable, distinguishable, complete (JP 5-0, July 2025). US Army: feasible, acceptable, suitable, distinguishable, complete. NATO/Canadian: feasibility, acceptability, completeness and compliance, exclusivity, suitability. A failing or risky test shows an amber triangle with the reason.
- **Supportability chips** from J4 (supportable, or the risk and when) and J3 (forces available) arrive as green hand-offs and stay on the pane.
- **Distinctness check:** when two COAs drift together (the known failure of parallel COA work in JP 5-0), the lead planner's check draws both sketches overlaid and flags "not distinguishable". This is shown, not hidden.
- Up to four panes at once on a wide screen. A third COA is drafted by the design planner on request.

### 5.7 The wargame view and the synchronization matrix

**Purpose:** action, reaction and counteraction on the map, with the products written as a by-product.

- **Turn bar** over the map: the turn's title and time window, then three phase lights: ACTION (blue, friendly), REACTION (red, the J2 red cell playing to win), COUNTERACTION (blue). One lights at a time.
- **On the map:** units move along their paths with a fading trail; enemy reactions draw their axis; fires show as expanding rings on the target; decision points drop as gold stars; a unit assessed combat ineffective dims and its frame breaks.
- **At the table** panel: controller (lead planner), enemy (red cell), friendly (COA cell and future operations), sustainment (J4), recorder (plans writer). The sequence is shown: each COA against the MLCOA, then the MDCOA, so results compare (JP 5-0; note 02, Table 3).
- **Turn log:** every move in words, colour-banded by side, with a gold result card at the end of each turn. The log is the wargame ledger in `staff-products`.
- **Synchronization matrix:** rows for enemy, collection, manoeuvre, fires, sustainment and decision points; columns from H-6 to H+48. Cells appear as the turns produce them. A violet cursor shows the wargame's current time. Each row shows its owning section. Decision points become the DST and DSM entries, each tied to a PIR and a named decision maker.
- **Red team bias check** after each COA's wargame, shown as a token working and a result in words.

### 5.8 COA comparison

- Criteria and weights the commander approved at the mission analysis brief, with the approval named and timed.
- Each section scores its own criteria in parallel (J4 sustainability, J3 risk and tempo, J2 intelligence risk). The scores arrive as green hand-offs and the bars grow.
- Weighted totals count up.
- **Staff recommendation** in violet, labelled "drafted by agents", with the main risk and its mitigation.
- **Dissent** from the red team beside it, marked "unedited". Personal staff advice (legal) is also shown unedited (note 06, section 5.5, rule 4).
- A standing panel: "Who decides: the commander. Nothing after this step starts until a named person signs."

### 5.9 The decision gate

**Purpose:** a commander's decision that is informed, deliberate, recorded and plainly human.

- The room dims behind a gold-edged dialog. The staff has stopped. A line says when the staff stopped at the gate and that no agent has acted past it.
- **Left, the brief:** mission (with its approval), enemy (with who released it), both COA sketches side by side (the recommended one outlined in violet) with their totals, the staff recommendation, the dissent, the J4 sustainment risk, and the legal note that a human legal adviser must review.
- **Right, the decision:** the decision owner's name and role, "only this person can decide", and three options: approve the recommended COA, approve the other COA, or return to the staff with guidance (guidance is required).
- **Acknowledgements:** three checkboxes (dissent and risk read; residual risk accepted; decision recorded as supported by AI staff work).
- **Minimum deliberation:** a ring counts down a time set by the organization's policy (the demo uses 10 seconds). Sign stays disabled until a choice, all acknowledgements and the time are complete.
- **Signature:** signs with the device key (Phase 69), recorded in the decision log, with the existing self-declared identity wording until Phase 71. A gold seal stamps the decision with the name and the time.
- **After:** the gate diamond fills gold with the name; a gold hand-off carries the decision to the chief of staff, who fans the next tasking out. A return sends the guidance to the lead planner, the comparison re-runs as a new revision, and the gate opens again.
- "Not now" closes the dialog. The gate stays waiting, with its deadline from the battle rhythm. A gate never times out into a decision.

### 5.10 The COP and map

- One map component for the threat picture, the COP, COA sketches, the wargame and the brief thumbnails.
- **Layers** follow design 10's single-writer table: operations (J3 JOC chief), threat (J2 threat analyst), terrain (J2 GEOINT analyst), logistics (J4 JLOC chief), plans (J5 lead planner, never merged into the current picture).
- **Symbols:** APP-6 / MIL-STD-2525 frames with the standard light fills: friend (128, 224, 255), hostile (255, 128, 128), neutral (170, 255, 170), unknown (255, 255, 128). The frame shape carries affiliation (rectangle, diamond, square, quatrefoil), so colour is never the only cue. Planned or anticipated items use a dashed frame or line. Echelon marks sit above the frame and designations to the right, with a halo so they read on dark and light maps.
- **Graphics:** axes of advance (double line; filled head for the main attack, open head for a supporting attack), enemy axes dashed red, phase lines, objectives, assembly areas, NAIs as ellipses, decision points as gold stars.
- **Geography:** the starter scenario is fictional (design 10, section 8). Real-terrain training areas use offline tiles from the organization's own server. Online tiles are off by default because a tile request reveals the area of interest.
- **Selection:** a symbol opens its card: affiliation in words, type, designation, echelon, source and grade, last update, and the product it comes from.

### 5.11 Orders and annex assembly

- One row per part of the order: base plan, intelligence annex, operations annex, fires, logistics or sustainment, assessment. Each shows its owner (agent and section), progress and state. **Letters come from the profile** (design 10, section 2.3): US Joint B (Intelligence), C (Operations), D (Logistics), N (Assessments), fires as an appendix to C; US Army B, C, D (Fires), F (Sustainment), M (Assessment); NATO/Canadian D (Intelligence), A (Conduct of Operations), R (Logistics).
- Rows fill in parallel, because each section writes only its own annex in its own branch.
- **Synchronization check** by the chief of staff after the merges: conflicts (for example a J4 fuel time against a J3 timeline) are sent back to the owning sections as hand-offs, and each section's tag shows `conflict` until it returns a resolution. This is the two-level merge in design 10, section 5.3.
- **Plan approval** is the last row, gold, "waiting for" the named commander, with the line "Agents cannot mark an order as issued."

### 5.12 Trust badge, labels and clearances

The aim is elegance without hiding anything.

- **Status bar:** the label chip (green, the exercise label) with "clearance self-declared", and "Verified private model, 18 of 18 agents". Each opens a popover using the extension's existing words: what was checked (NEAR's signature over the exact request and response, a fresh Intel TDX quote binding the key, a connection proven to end in the enclave) and what was not checked in the editor.
- **Per agent and per product:** a small green tick on product rows and the full trust badge on agent cards. A helper agent without a badge says so, as the chat does.
- **When something is not verified:** the agent's token gets an outlined badge and the status bar count drops ("17 of 18"). This is shown in words, never by colour alone.
- **Labels:** if a chat's label rises because an agent read labelled content, the status bar chip changes and a one-line notice explains where content may now go. Only a person lowers a label, with a reason, through the existing command.
- **Clearance limits:** an agent card states what the agent may read. A refused read appears in the agent's status line as "Refused: label above your clearance", the same sentence the gate uses.
- **Never shown:** classification markings beyond the exercise banner. The release guard holds any product that contains them.

### 5.13 Catch-up replay and after-action review

- Every Staff Room session can be **replayed** from the activity feed: "Show the last 40 minutes in 60 seconds." Replay uses the same animations at speed, with the gates as fixed stops. This is how an officer coming on shift catches up, and how the demo runs without a live model.
- **After-action view:** the timeline of the run with every decision, hand-off, verdict and conflict, filterable by section. It exports to the existing document tools for an after-action report.

---

## 6. State machines the Staff Room shows

The Staff Room draws four machines that design 10 defines or the extension already has. It adds none of its own except two short animation states (a dot travelling out, a dot travelling back), which, as in Team Live, can never get stuck because they are not part of the run's truth.

| Machine | Source | How it is shown | Stuck or ambiguous states and how the screen handles them |
|---|---|---|---|
| Product release (draft to released) | Design 10, section 4.1 | Ledger pills, product card history, gold for human transitions | `awaiting decision` with no person: the decision card shows its deadline from the battle rhythm and turns amber after it; it never decides by itself. `draft (tampered)`: a red "tampered" pill and the record that disagrees |
| Gate | Decision queue | Diamonds on the rail; decision cards; the gate dialog | A gate with a closed dialog stays `waiting`; the rail says for whom. A returned gate shows the return arrow and the revision number |
| Nested team reference | Design 10, section 5.4 | Section tag on each squad panel | `waiting` shows what it waits for and the suspense; past the suspense it moves to `failed` with a report (design 10). `awaiting-consent` shows a gold "needs your consent" chip that opens the existing consent question |
| Agent | Team Live `LiveState` | Tokens, status lines, agent cards | Interrupted by a reload: shown as interrupted, never as working (as in Team Live) |

Two transitions the screen must make impossible to miss: an agent stopping at a gate, and a person's decision being recorded. Both use gold, words and (outside Calm) motion.

---

## 7. How AI augmentation multiplies the staff's efficiency

Baseline today: a planning group working in slides, spreadsheets, chat and email, with a recorder retyping the wargame and each section integrating its estimate by hand. The times below are **design targets and estimates**, built from the step structure in notes 02, 03 and 05 and typical staff practice. None has been measured. Measure them in an exercise trial before quoting them to a client.

| Step | Today (typical, estimate) | With the Staff Room (target) | What still takes a person's time | Why it is faster |
|---|---|---|---|---|
| Initiation: timeline, warning order, tasking | 1 to 2 hours | 10 to 20 minutes | Commander's initial guidance | Timeline from the one-third rule, warning order drafted from the higher directive, sections tasked at once |
| Mission analysis: section estimates | 4 to 8 hours per section, integrated in sequence | 20 to 40 minutes for all sections in parallel, plus review | Reviewing estimates; approving the restated mission, CCIRs and criteria | All estimates at once; facts and assumptions ledger built as they go |
| J2 adversary COA set, situation templates, collection plan | 6 to 12 hours | 30 to 60 minutes to a gated draft | J2 review and release | Parallel lanes (threat, collection, red cell); tradecraft lint and guard run mechanically |
| COA development (two or three COAs) | 2 to 4 hours per COA, in slides | 20 to 30 minutes per COA, in parallel | Choosing which COAs go forward | Parallel cells with distinct themes; J3 and J4 checks arrive while the sketch is drawn |
| Wargame and its products | 3 to 6 hours of gaming, then 2 to 4 hours retyping the matrix, DST and DSM | Gaming time set by the people at the table; products written during play | The wargame judgement itself | The ledger produces the sync matrix, DST and DSM directly |
| Comparison and decision brief | 3 to 6 hours of deck building | 20 to 30 minutes | Commander's decision | Scores arrive from each section; the brief assembles from approved products with dissent attached |
| Orders and annexes | 1 to 2 days, with consistency errors found late | Hours, with conflicts found in minutes | Legal review, commander's signature | Annexes written in parallel; letters from the profile; mechanical cross-checks |
| Change propagation (an assumption fails) | Often missed until the next brief | Seconds to mark every dependent product | Owners accept or reject the change | Dependency tracking on every product |

What this buys, in the staff's own terms: in a 24-hour planning window, the staff might use 4 to 6 hours instead of 8 (the one-third mark), giving subordinate units more of their two thirds. Command time, the scarcest resource, goes to decisions instead of slides.

---

## 8. Motion design

### 8.1 Principles

1. **Movement is information.** Each motion answers one question: who handed what to whom, what was just committed to the map, who is working, what a person just decided.
2. **One focal motion at a time where it matters.** The gate ceremony and the wargame phase changes do not compete with hand-off dots. During the gate, nothing else moves.
3. **State is never only in motion.** Every animated change also exists as words, an icon or a value that stays after the motion ends. An animation can be missed or turned off without losing anything.
4. **Only cheap properties animate:** transform, opacity and stroke-dashoffset. No layout properties animate.
5. **Interruptible and short.** Animations never block input. The run never waits for an animation.

### 8.2 Motion tokens

| Token | Duration | Easing | Use |
|---|---|---|---|
| `quick` | 200 ms | `cubic-bezier(.2, 0, 0, 1)` (standard) | Tab cross-fade, popover in, chip appear |
| `move` | 450 ms | standard, or `cubic-bezier(.34, 1.4, .64, 1)` (settle) for things landing | Symbol drop, ledger row in, pill change |
| `handoff` | 700 to 1,400 ms, scaled by distance (520 ms + 0.8 ms per pixel) | `cubic-bezier(.45, 0, .2, 1)` (travel) | Hand-off dots |
| `draw` | 1,100 ms | standard | Axis and arrow draw-on |
| `unit-move` | 1,200 ms | travel | Wargame unit moves |
| `ceremony` | 1,600 ms in total | standard and settle | Gate seal and burst |
| `breathe` | 1,600 ms loop (rotation) | linear | Working ring on a token |

Demo speed (1x, 2x, 4x) shortens every duration in proportion, so a fast replay stays coherent.

### 8.3 What animates and why

| Element | Motion | What it tells the viewer | Reduced motion and Calm (equal clarity) |
|---|---|---|---|
| Hand-off | Dot with a label and a short comet tail along a curved path; the target pulses on arrival. At most 6 at once, 12 queued (Team Live values) | A named product or task moved between two named parties | A still dashed line between the two, with the label at the target, fading after 1.8 s; a polite screen-reader announcement |
| Agent working | Rotating arc around the token | This agent is working now | Static arc and the word "working" |
| Symbol placed | Drops 16 px with a slight settle and one ripple | New information on the map, and where | Appears in place |
| Enemy COA or friendly axis | Draws from start to arrowhead; the head and label appear last | Direction and commitment of a course of action | Appears whole |
| Wargame unit move | Glides along its path; a dashed trail remains | Where a force went in this turn | Jumps; the trail remains, so the move is still visible |
| Fires | Three expanding rings on the target | Fires delivered at this place | Two static rings, faded |
| Decision point | Gold star drops and settles | A decision the commander will face, here | Appears |
| Wargame phase | The phase light glows in its side's colour | Whose move it is | Border and text change only |
| Matrix | Cells grow from their start time; the cursor slides | What happens when, as the game produces it | Cells and cursor appear in place |
| Rail progress | Bar fills | How far this step has got | Bar set without transition |
| Gate waiting | Diamond pulses slowly | A person is needed here | Static gold outline and the words "Waiting for" with a name |
| Signature | Seal scales in with a ring burst | The decision is made and recorded | Seal appears; announced assertively |
| Section status text | Types in at about 100 characters a second | Live activity | Appears whole |

### 8.4 Reduced motion and Calm

- Honour `prefers-reduced-motion: reduce` from the system, and a **Calm** toggle on the page (remembered), as Team Live does.
- In both, nothing travels, spins or scales. Opacity changes are kept short and are not essential to meaning.
- High-contrast themes drop all glows and use theme contrast borders and 3 px borders for the current step and waiting gates.

---

## 9. Visual language

### 9.1 Themes

The owner's mockups set the tone: deep navy surfaces, gold accent, a green classification banner, IBM Plex type. The Staff Room ships three palettes and picks one from the VS Code theme class on the page body.

| Palette | When | Character |
|---|---|---|
| Night ops | `vscode-dark` (default for demos) | Navy surfaces, a faint grid, soft glows |
| Day ops | `vscode-light` | White and pale grey surfaces, darker gold and violet for contrast, a light map |
| High contrast | `vscode-high-contrast` and `vscode-high-contrast-light` | Black, white borders, no glows, the theme's focus colour |

Where a token has an obvious VS Code equivalent (focus border, button colours, fonts, scrollbars), the extension build maps it to the `--vscode-*` variable so the page also follows custom themes. The map and the semantic colours below stay fixed, because their meaning must not change with a theme.

### 9.2 Colour tokens and their reserved meanings

| Token | Night | Day | Reserved for |
|---|---|---|---|
| `--human` | #D9B44A | #9A7412 | Human authority only: gates, decision cards, signatures, human leads' names |
| `--ai` | #9D8CFF | #5B4BD6 | Agent activity: working tokens, tasking hand-offs, the current step, recommendations drafted by agents |
| `--ok` | #4CC38A | #1F8A57 | Delivered products, passed checks, done |
| `--risk` | #F59E5B | #B85A12 | Risk and warnings (never red, so it cannot be read as hostile) |
| `--bad` | #F06A5F | #C2372C | Failures and Stop only, always with an icon and words, never on the map |
| `--cls` | #1E7B34 | #1E7B34 | The classification banner and label chip |
| Surfaces | #0A1220, #0E192B, #111E34, #16253F | #E9EEF5, #F5F7FB, #FFFFFF, #F2F5FA | Background, panels, cards |
| Text | #E6ECF5, #A9B8CF, #7F91AC | #0E1B2E, #43546D, #5F7089 | Primary, secondary, faint |

**Affiliation colours on the map** (MIL-STD-2525 and APP-6, as implemented in milsymbol 3.0.5):

| Affiliation | Frame fill (light) | Graphic line on Night | Graphic line on Day (dark set) | Frame shape |
|---|---|---|---|---|
| Friend | rgb(128, 224, 255) | #33BDF0 | rgb(0, 107, 140) | Rectangle (land), circle (sea surface) |
| Hostile | rgb(255, 128, 128) | #FF4D4F | rgb(200, 0, 0) | Diamond |
| Neutral | rgb(170, 255, 170) | | | Square |
| Unknown | rgb(255, 255, 128) | | | Quatrefoil |

Rules:
- Affiliation colours appear **only on the map and in map-derived elements** (matrix rows for enemy and friendly, COA keys). Interface states never use blue or red, so nobody confuses a warning with a hostile unit.
- Frames keep their black outline on every theme. Echelon and text modifiers use a halo (`paint-order: stroke`) in the map background colour.
- Control measures (phase lines, objectives, NAIs) are drawn in a near-white ink on Night and a near-black ink on Day.

### 9.3 Typography

- **IBM Plex Sans** for interface text and **IBM Plex Mono** for DTGs, step numbers, codes, state pills and tabular numbers (both SIL Open Font License 1.1, bundled as WOFF2). Fallback to the VS Code font.
- Sizes: 11, 12, 13, 15 and 18 px. Body 13 px at 1.4 line height. Headings 600 weight; body 400.
- Uppercase with letter spacing only for small kickers and the banner. Tabular numerals for every number that changes.

### 9.4 Iconography

- Section glyphs on a 16 px grid with a 1.5 stroke, same style as Team Live: chief of staff (hub), J2 (eye), J5 (compass), J3 (chevrons), J4 (crate). Further sections follow the same grid.
- State icons are Team Live's set, so a state looks the same in both views.
- Military symbols come only from the symbology standard (milsymbol in the product), never from a general icon set.

### 9.5 Sound

Off by default. When a person turns it on: one short two-note tone when a decision needs a person, and a three-note chord when a decision is signed. Nothing sounds for routine agent activity. Sound never carries information that is not also on screen.

---

## 10. Accessibility and keyboard flow

- **Landmarks and order:** header, process rail, squads, main view (tabs), synchronization matrix, decisions and products, status bar. Tab moves between regions in that order. Inside a region, arrow keys move (roving tab index): between tokens in a section, between tabs, and between steps on the rail.
- **Shortcuts** (listed under `?`, and each can be turned off, as WCAG 2.1.4 requires for single-key shortcuts): Space play or pause (demo and replay), N next beat, 1 to 5 views, D jump to the decision waiting for a person, C Calm, T theme, Escape to close a card or dialog and return focus to what opened it.
- **Screen readers:** hand-offs, decisions needed, and endings are announced politely, batched so they never flood. A decision needed and a signature are announced assertively. Moment-to-moment typing is not announced (as in Team Live). Every token, symbol, gate and matrix cell has an accessible name in words.
- **Map equivalence:** **Map as table** lists every unit and graphic with affiliation in words. Symbols are focusable and named ("Hostile armour company, 3-41 ARMD").
- **The gate dialog** is modal with a focus trap; Escape closes it without deciding; the Sign button explains why it is disabled.
- **Colour:** never the only cue. Affiliation is carried by frame shape; states by icon and words; the human decision colour is paired with the word "person" or a name.
- **Contrast:** text meets WCAG AA on all three palettes; the Day palette darkens gold and violet for this reason.
- **Zoom and reflow:** usable at 200% zoom by switching to the narrow layout.

---

## 11. Developer experience: how section teams plug in

Goal: a new section team (J6, special staff, a fires cell) appears in the Staff Room without anyone writing webview code.

1. **A section is a team file**, as today, plus one optional frontmatter block that the Staff Room reads (proposed):
   ```yaml
   staff:
     section: j6
     glyph: antenna            # from the shared glyph set
     human-lead: J6 director   # role; the person's name comes from the run
     steps: { 2: primary, 3: supporting, 4: supporting, 7: primary }
     products: [j6-running-estimate, annex-cis]
     layers: [cis-nodes]        # COP layers this section writes
   ```
   Without it, the section still appears, with a generic glyph, and with steps and products inferred from its products.
2. **Products are typed by kind.** Each product kind (estimate, enemy COA set, COA statement, register, annex) has a JSON Schema in `staff-products` (design 10, WP-0). A kind declares its renderer: `card` (always), plus optionally `map-layer` (GeoJSON features with a symbol identification code), `matrix-rows`, `table` or `document`. The Staff Room ships these renderers. A section only emits data.
3. **Map content is GeoJSON with symbol codes** (`sidc` property, MIL-STD-2525E or APP-6E). The map renders whatever arrives in a layer the section owns. Writes to a layer the section does not own are refused by `cop-map`, and the Staff Room shows the refusal.
4. **Doctrine words come from the profile file**, never from the page: step names, product names, COA tests and annex letters (design 10, WP-0). A new profile is data.
5. **Events, not polling.** The page receives the read models once and then the events in design 10, section 4.5, as diffs, the way Team Live does today ("the host sends the whole picture and what changed").
6. **A playground.** **NEAR AI: Open the Staff Room Playground** replays a recorded run fixture (the same fixture format as the demo), so developers build and test views without running models. Fixtures double as visual regression inputs and as the demo itself.
7. **Contract tests** for each new section: its products validate against their schemas; its layer writes stay in its own layers; its doctrine words resolve under every profile; the page draws every one of its states with words and icons.

---

## 12. Technical approach inside VS Code webviews

### 12.1 Architecture

- One webview panel (`Staff Room`), retained only while visible. When hidden, it keeps no animation running and rebuilds from the host's snapshot when shown again. This matters for code-server, where a hidden tab can lose its extension host after about five minutes: the page must always be able to rebuild completely from host state plus the activity history.
- The host builds pure read models from the activity feed and the `staff-products` registers (no DOM, unit-tested like `teamLiveState.ts`). The page lays them out and animates. The page never decides state.
- Approve, reject and release buttons post a message; the host runs the VS Code command, which signs and records; the page shows the result when the event comes back. There is no optimistic "approved" state.
- Every text goes in with `textContent`. The page receives display data only, never credentials or raw context (as the chat view does today).

### 12.2 Libraries

The prototype uses **none**: it draws the symbols with hand-made SVG and animates with the Web Animations API, so it runs offline in any demo room. The product uses the libraries below, vendored into `media/vendor/` at exact versions, with licences recorded, reviewed before adoption, and never fetched at run time.

| Library | Version checked | Licence | Size (measured, gzip -9 of the published build) | Use | Loading |
|---|---|---|---|---|---|
| Web Animations API | built in | none | 0 KB | All motion | Always |
| SVG and Canvas 2D | built in | none | 0 KB | Rail, tokens, hand-off layer, matrix, COA sketches | Always |
| milsymbol | 3.0.5 | MIT | 197 KB (862 KB minified) | MIL-STD-2525E and APP-6E symbols as SVG or canvas | Lazy, on first map; symbols cached by code |
| MapLibre GL JS | 6.19.0 | BSD-3-Clause | 298 KB main, 157 KB worker, 10 KB CSS | The COP and real-terrain maps (WebGL) | Lazy, only for real-terrain maps; fictional maps use SVG |
| d3-scale | 4.0.2 (4.0.3 current) | ISC | 4.9 KB | Time scales for the matrix and the wargame clock | With the matrix |
| d3-shape | 3.2.1 | ISC | 7.6 KB | Smooth paths for axes and trails | With the map |
| d3-selection | 3.0.1 | ISC | 4.3 KB | Optional, for the matrix only | Optional |
| mgrs | 2.1.0 (2.2.0 current) | MIT | 2.7 KB | MGRS grid references in cards (design 10, cop-map) | With the map |
| IBM Plex Sans and Mono | current | SIL OFL 1.1 | About 20 to 30 KB per WOFF2 weight (estimate; subset to Latin) | Typography | Always |

Considered and not chosen:

| Library | Licence | Why not |
|---|---|---|
| Motion (`motion` 14.14.0) | MIT | 64.5 KB gzip for the full build; the Web Animations API covers our needs. Revisit only if spring physics become necessary |
| vis-timeline 8.5.6 | Apache-2.0 or MIT | 77 MB unpacked package and a heavy DOM; our matrix is a simple fixed-row grid |
| frappe-gantt 1.2.2 | MIT | 13.4 KB gzip and fine, but the annex tracker is a progress list, not a Gantt chart |
| PixiJS 8.23.0 | MIT | WebGL sprite engine; only worth it if a full-staff floor ever animates hundreds of tokens. Measure first |
| Leaflet | BSD-2-Clause | Good, but raster-first; MapLibre handles vector, offline tiles and rotation better for a COP |

Total on first open, before any map: our own code (budget below) plus fonts. The map bundle (about 670 KB gzip with milsymbol and MapLibre) loads only when a real-terrain map opens.

### 12.3 Content Security Policy

Today's extension pages use `default-src 'none'; style-src ${cspSource}; script-src 'nonce-…'` (Team Studio adds `img-src data:`). The Staff Room needs a little more, and nothing that weakens script safety:

```
default-src 'none';
script-src 'nonce-{nonce}';
style-src {cspSource};
img-src {cspSource} data: blob:;
font-src {cspSource};
worker-src blob:;
connect-src {cspSource} {orgTileServer, only if the organization configured one};
```

Notes:
- **No inline style attributes in markup** (style-src has no `'unsafe-inline'`). Positions and transforms are set through the CSSOM (`element.style.transform = …`), which the policy allows, as Team Live does today.
- **No `'unsafe-eval'`.** MapLibre must run without it. Its worker is created from a blob URL built from the vendored worker file (webview resources are served from another origin, so `new Worker(url)` on the resource URL fails). This needs `worker-src blob:` and `connect-src {cspSource}` to fetch the worker file. Verify this in a short spike before WP-COP starts.
- **No CDN** in the product. The prototype also needs none.
- **Glyphs for map labels:** MapLibre text needs glyph files. Bundle a small Latin range locally, or draw labels as HTML markers.
- **Map tiles:** offline by default. An organization tile server is allowed only when configured, and only for the levels the policy allows (the request reveals the area of interest).

### 12.4 Performance budgets

| Budget | Target |
|---|---|
| First paint of the chrome after the panel opens | Under 300 ms |
| Interactive (rail, squads, ledger) | Under 1 s |
| Map ready (SVG fictional map) | Under 500 ms; MapLibre real-terrain map under 1.5 s on first open |
| Our own JavaScript and CSS | Under 120 KB gzip, before the map bundle |
| Frame time during animation | 60 fps on a mid-range laptop; no long task over 50 ms |
| Concurrent hand-off dots | 6, then queued (12), then dropped with the announcement kept |
| Host to page messages | At most 10 a second, as diffs; the host coalesces bursts |
| Memory | Under 150 MB for the panel with the map open |
| Hidden panel | No animation frames, no timers; rebuild from the snapshot on show |

The prototype stays inside these with no libraries: it is about 160 KB uncompressed in one file, including all data, styles and logic.

### 12.5 Small additions to design 10

- An event `staff.wargame.turn` (run, COA, enemy COA, turn, phase, moves, results, decision points) so the wargame view and replay need no parsing of the ledger file.
- A `staff` frontmatter block on team files (section 11, item 1).
- A product kind field in the product header (`kind:`), to pick the renderer.

---

## 13. Growing into the full visual wargaming suite

The owner's future direction is a full, robust, visual wargaming suite used during planning. The wargame view in this concept is designed as its first slice, so the suite grows from it without a rewrite.

| What the concept has now | What the suite adds | Why the concept already fits |
|---|---|---|
| Turn ledger with action, reaction, counteraction, results and decision points | Branching: fork a turn to try another reaction; compare branches side by side; promote a branch to the plan's branches and sequels list | The ledger is append-only and versioned; a fork is a new ledger from a turn |
| One shared clock for map, matrix and rail | A full time scrubber with play, step and replay over the whole operation; keyframes per phase | Every element already reads its position from the shared time |
| Units moving between positions | Movement along routes on real terrain (routing from the J4 `logistics` server), with timing from distances and rates the user enters | Moves are already paths with durations; real routes replace straight paths |
| Fires as rings at a point | Effects areas, ranges and coverage fans; line of sight and viewshed (as in the owner's Globe mockup) | Layers are GeoJSON; analysis results are just more layers |
| J4 consumption per phase as a matrix row | Live sustainment overlays: fuel and ammunition per unit over time, culmination warnings | The J4 calculator already produces numbers with formulas; the view draws them |
| Red cell as an agent playing to win | Several red cells (MLCOA and MDCOA played at once), and humans able to take any seat (friendly, enemy, sustainment) with agents filling the rest | Seats are already explicit ("At the table"); a seat is a member or a person |
| Decision points as stars tied to PIRs | A live DST and DSM: indicators firing at NAIs during play, the decision prompt raised to the commander's seat | DPs, PIRs and NAIs are already linked |
| Recorded wargame becomes the sync matrix | Adjudication rules and probability tables a person can see and change; outcomes shown with their uncertainty; Monte Carlo runs of a turn for a spread of results | The result card already separates the move from the judgement; adjudication becomes a visible, versioned input |
| 2D SVG map | 2D and 3D terrain (MapLibre terrain), multi-domain layers (air, maritime, space, cyber, information) as stacked lanes in time | The map component is already one component behind a layer interface |
| One COA at a time on the map | Side-by-side or overlaid COA runs against the same enemy COAs, with a difference view | The comparison already requires the same enemy COAs for every COA |
| After-action replay | Exercise control: an exercise director can inject events, pause the game for a teaching point, and export the game for a lessons-learned report (J7) | Replay and injection both read and write the same event stream |

Principles that carry over unchanged: people adjudicate and decide; every computed outcome shows its inputs and uncertainty; the enemy is played to win; nothing real is ever loaded; and every move, roll and decision is in the record.

Suggested path: (1) ship the wargame view as in this concept with drop 2 of design 10; (2) add branching, the time scrubber and human seats; (3) add real-terrain movement, effects and sustainment overlays with the J4 tools; (4) add adjudication tables and multiple runs; (5) add 3D and multi-domain lanes. Each stage is useful on its own.

---

## 14. Demo script: five minutes, led by the J2

For the owner's product demos. Order: J2, then J5, then J3, then J4. The presenter plays the J2 and, at the gate, hands the mouse to someone playing the commander (or plays both, saying so). The prototype supports this script beat for beat; use 2x speed for a tight five minutes, 1x for a relaxed one.

| Time | Beat | On screen | Presenter says (in plain words) | What the audience should feel |
|---|---|---|---|---|
| 0:00 to 0:30 | The room | The rail, step 3 glowing; the squads; the gold tick on the mission analysis gate. Chief of staff sends four tasking dots | "This is a joint staff on an exercise. Every token is an AI staff officer working privately. Gold is always a person. The commander approved the mission at 0840." | Oriented, curious |
| 0:30 to 1:20 | **J2** builds the threat picture | Enemy units drop onto the map; MLCOA and MDCOA draw; NAIs appear; the collection plan fills | "My J2 section is building the enemy picture in parallel: order of battle, both enemy courses of action, collection. Note the wording: likely, 55 to 80 percent, and confidence in a separate sentence. That is enforced." | "That would take my cell most of a day" |
| 1:20 to 1:40 | **J2** gates and release | Tradecraft SIGN-OFF, guard CLEARED, then the gold card. Presenter clicks **Approve and release** | "Nothing leaves the J2 until it passes tradecraft, the release guard, and me. I release it." Four green dots fly | Control; the person matters |
| 1:40 to 2:30 | **J5** builds two COAs | COA workspace; two sketches building; validity tests; J4 fuel risk arrives; red team adds a PIR | "The J5 gives each COA cell a different theme, so we do not get two versions of the same plan. J3 and J4 check them while they are drawn. The red team just made my J2 add a requirement." | Sections talking in seconds, not meetings |
| 2:30 to 3:30 | **J3** wargame | Phase lights; units move; the red cell counterattacks; fires; DP 1 star; the matrix fills under the time cursor | "The wargame is played on the map. My red cell plays the enemy to win. Watch the matrix at the bottom: it is being written as we play. No one retypes it tonight." | The future |
| 3:30 to 3:50 | **J4** sustains it | J4 counteraction: fuel at 82 percent of forecast; DP 2 from logistics; comparison scores arrive from J4, J3, J2 | "The J4 runs the logistics wargame alongside. Every number comes from a calculator with its formula shown. Their decision point goes straight into the commander's decision support." | Trust in the numbers |
| 3:50 to 4:40 | The gate | The room dims; the decision brief; dissent unedited; acknowledgements; deliberation ring; **Sign: approve COA A**; the gold seal | "Now the staff stops. Only the commander can pass this gate. The machine recommends; the red team's disagreement is shown unedited; the commander signs with their own key." | Relief and respect: AI that knows its place |
| 4:40 to 5:00 | Orders | Annexes fill in parallel with the right letters; two conflicts found and sent back; plan approval waits in gold. Switch the profile to NATO/Canadian to show the letters change | "Annexes write in parallel, each by its owner, with the correct letter for our doctrine. And the plan waits for the commander's signature. It never issues itself." | "When can we have it?" |

Backup moves: if time is short, press **Next** to skip a beat (it stops at every human gate). If someone asks "what if the commander says no?", choose **Return to the staff with guidance**: the comparison re-runs as revision 2 and returns to the gate.

---

## 15. The prototype

[`prototype/war-room.html`](prototype/war-room.html), one self-contained file, about 160 KB.

- **What it shows:** the process rail with gates and the profile switch (US Joint, US Army, NATO/Canadian); five squads with 18 agents and nested-team tags; the J2 threat picture with correct APP-6 frames, MLCOA and MDCOA, NAIs and the collection plan; the J2 release decision; two COA cells building in parallel with profile-specific validity tests; the wargame with action, reaction and counteraction, decision points and the sync matrix; the comparison with recommendation and dissent; the decision gate ceremony (approve A, approve B, or return with guidance); orders assembly with profile-specific annex letters, a synchronization check and plan approval waiting for a person; agent and product cards; the trust and label popovers; Stop all agents.
- **Controls:** Play or pause, Next beat (stops at human gates), 1x, 2x, 4x, Restart; Calm, theme (Night, Day, High contrast), sound (off by default), keyboard help.
- **Checked** in headless Chromium at 1280 by 800 and 1920 by 1080: no console errors; no horizontal scrolling at 1280 px; every button has an accessible name; the full flow through both human decisions completes; the return-to-staff path loops back to the gate; under `prefers-reduced-motion` nothing travels and every change still shows in words.
- **What is faked:** the agents (a scripted timeline stands in for the run's events); the signature (no key is used); the trust and label states (sample values); all scenario data (fictional: EXERCISE IRON LANTERN, the Kestrel Peninsula, TF ANVIL, the 41st Coastal Brigade, and role-players named Col A. Demo, Lt Col K. Sample and Lt Col R. Example).
- **No network:** no fonts, libraries or tiles are fetched.

---

## 16. Owner decisions on the open questions

The owner accepted every recommendation below on 2026-11-18.

| # | Question | Who | Recommendation | Decision |
|---|---|---|---|---|
| U1 | Is the Staff Room its own panel, or a mode of Team Live? | Owner | Its own panel, sharing Team Live's state code and visual grammar | Accepted (owner, 2026-11-18) |
| U2 | Minimum deliberation time at a gate: organization policy, per gate? | Owner | Yes, in the signed policy bundle, per gate kind, default 60 s for a COA decision and 0 for a J2 release | Accepted (owner, 2026-11-18) |
| U3 | Should the Staff Room demo mode ship in the extension (replaying a recorded fixture with no model)? | Owner | Yes: it is also the developer playground and the visual test input | Accepted (owner, 2026-11-18) |
| U4 | Real-terrain maps for demos: which offline tile source can be bundled or hosted? | Owner | Fictional SVG maps for the public demo; an organization tile server for client pilots | Accepted (owner, 2026-11-18) |
| U5 | Human seats in the wargame (people playing a side alongside agents) in the first release, or with the suite? | Owner | With the suite (section 13, stage 2) | Accepted (owner, 2026-11-18) |
| U6 | Persona names for agents | Owner | None: role slugs only (notes 00 and 05); the game feel comes from tokens, states and motion, not characters | Accepted (owner, 2026-11-18) |
