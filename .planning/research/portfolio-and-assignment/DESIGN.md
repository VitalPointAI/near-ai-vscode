# Design: assigned positions, organization modes and the portfolio view

Date: 2026-11-20. Status: design and phase proposal, no code changed. Read against `origin/main` at d8862260.

Owner requests of 2026-11-20, accepted with the recommendations in the brief: (A) assigned positions, because military tasking is not an invitation; (B) organization modes that change vocabulary and default behaviour together; (C) mixed organizations rolled up into one portfolio view for prioritization and resource allocation.

Inputs: the multi-user staff design (`.planning/research/multiuser-sync/DESIGN.md`, cited "MUS"), the roster code (`src/domain/replica/roster.ts`, `rosterMembers.ts`, `rosterCells.ts`, `invite.ts`, `safetyCode.ts`), the doctrine table (`src/domain/staff/doctrine.ts`), the staff teams design (`.planning/research/staff-teams/10-STAFF-TEAMS-DESIGN.md` and note 07 on J1 and J8), the capital projects design (`.planning/research/capital-projects/DESIGN.md`, cited "CAP"), the data platform design (`.planning/research/data-platform/00-DESIGN.md` and note 02, cited "DP"), guided onboarding (`.planning/research/guided-onboarding/DESIGN.md`, cited "GUIDE"), the model provenance and Cohere Model Vault designs, and the roadmap (Phases 30 to 37, 70, 71, 93, 97, L4, L5).

Words used here:
- A **position** is a seat in an organization that exists whether or not anyone holds it: "J2 Chief", "Watch Officer, night", "Project Leader, fleet replacement".
- A **posting** places one person in one position from a start date. Other modes call it an assignment or an appointment (section 5).
- A **tasker** is a person who holds the authority to post people.
- A **holder** is the person whose posting to a position is in effect.
- A **unit** is one organization unit inside a portfolio, with its own mode: a command, a branch, a project office.
- A **publication** is a signed, labelled item that a unit releases upward (or a portfolio releases downward). It is the only way information crosses between units.
- The **portfolio office** is the people who run the portfolio view. In P3O terms it is the permanent portfolio office.

---

## 1. Key points first

1. **People are posted, not invited, in military and public-service work.** A position exists on its own and keeps its history across rotations. An authorized tasker posts a person to it with a start date. The person cannot decline. They can only report for duty, or report that they are unable, with a reason that goes back to the tasker. The tasker then confirms, defers or reassigns. Today's invite-and-accept flow stays for software teams.
2. **Posting is a signed authority, not a menu item.** The staff lead holds it and may delegate it, for example to J1 personnel staff or J3, limited to some positions and for a time. Every posting records who ordered it, under whose authority, and when.
3. **Proving the computer is still required, and it is key delivery, not consent.** The six-word safety code makes sure the keys reach the posted person's own machine. Nothing in that step lets them say no.
4. **A position is never held by two people and never left empty by a handover.** The outgoing holder's authority ends at the exact roster entry where the incoming holder reports for duty. The keys for new work move at the same point, because the tasker prepares the next key epoch in advance.
5. **One table sets an organization's words and its default behaviour together.** There are four modes: Military, Public service, Corporate and software, and Capital projects. Each mode decides the words on screen (billet or position or team or role, posted or assigned or invited or appointed) and the joining model (assignment, invitation or appointment). It generalizes the doctrine profiles in `doctrine.ts`. Your organization's signed policy sets the default mode, and projects choose within what it allows. The guided setup's role question suggests one.
6. **A defence portfolio mixes modes, and each unit keeps its own.** A command posts people, a branch assigns them, a project office appoints them, and a software cell invites them. All of them can still roll up into one strategic portfolio view, because they publish to it in one neutral format.
7. **The portfolio never gets anyone's cells.** Units release signed publications upward: status, milestones, risks, issues, resource demand and supply, spend, benefits, capability and results links, and gate state. Each publication is sealed to a write-only intake key of the portfolio, so a unit can publish without being able to read anything else there.
8. **Each publication carries its own label, and the view is labelled as a whole.** The view takes the highest label among its inputs, raised further by signed aggregation rules in the policy, because many Protected B items together can be more sensitive than any one of them. A viewer who is not cleared for the whole sees only the views whose aggregate they are cleared for. They are never told that more exists, which is the data platform's strict default. Only a person can make a lower-labelled summary, with a sanitization note.
9. **People decide and agents draft.** Agents score against the portfolio office's weighted criteria with cited evidence, model scenarios, compute the efficient frontier and capacity against demand, and write the portfolio brief. Priorities, allocations and gate outcomes are signed person decisions, and can be contested under the same rules as staff products.
10. **One hub first, federation later.** A pilot portfolio of a few units fits on one hub, which takes about 10 projects and 150 people. Publications are self-contained sealed envelopes, so from Phase 34 they can also move between hubs by file. Live roll-up across hubs, sites and organizations needs L5 federation and Phase 71 identities.
11. **Placement.**
   - **Modes:** inside Phase 32.1.
   - **Assigned positions:** a small inserted Phase 33.1 right after drop A. Its "require this feature" check should land in Phase 33 so that older clients fail safe.
   - **Portfolio view:** a group of three 0.4.x phases (38 to 40) after drop B, on fictional data, on one hub.
   - **Later work:** real data and the knowledge base views come with v0.6.0 (Phases 93 and 97). Cross-hub roll-up comes with L5.

---

## 2. Where we are (audit of `origin/main`)

| Area | Today | Gap for this request |
|---|---|---|
| Roster membership | `member.invite`, `member.admit`, `member.update`, `member.remove` (`rosterMembers.ts`). A member has one `seat` string, `roles`, `clearance` and agent seats. Invite and join run by signed file with a one-time secret, an expiry and a safety code (MUS 7.3, `invite.ts`, `safetyCode.ts`) | A seat is a string on a person. There is no position that outlives its holder, no start date, no history and no rotation. The invitee can simply not answer, which amounts to declining |
| Roster writers | Only the devices of the staff lead and the deputy lead (`LEAD_ROLES`; MUS 7.1, owner decision 5). The roster is linear through `rosterPrev`, and a split is resolved by `roster.choose` | The authority to post cannot be delegated |
| Membership machine | invited, then join-requested, then active or refused (MUS 15.1) | "Refused" and "expired" are the only outcomes besides active. There is no "unable to report" path and no handover |
| Doctrine profiles | `doctrine.ts`: three staff profiles (`us-joint`, `us-army`, `nato-ca`), levels, processes, step names, annex letters, all as one pure data table | It covers planning vocabulary only. Joining and organization words are not in it |
| Capital pack | Neutral slots filled by a private profile, with a display rule of `label` or `name` (CAP 2.1). It has a portfolio office template (CAP 5.5) and a Portfolio Room that reads one organization's ledgers on one machine (CAP 8) | The pack is designed but not built. It has no cross-unit roll-up, no labels on roll-up items, and no aggregation |
| Guided setup | Q1 asks the role (software, staff, analysis, capital projects, writing). The bundle has an optional `onboarding` key (GUIDE 4.2, 9.3) | It asks the role but suggests no mode |
| Labels | Phase 70 scales and levels (`scale/level`), label cells (MUS 8), the write-up-never-down rule, and lowering only by a person | Joining labels across projects is not defined |
| Aggregation | Designed for the data platform: rules in the signed bundle ("N distinct people or M items in a compartment raise one level"), default thresholds (DP owner decision 13), and strict indistinguishability by default (DP decision 7) | Nothing is built yet. The rules are designed for indexes and exports, not for cross-unit views |
| Hub scale | About 10 projects, 150 persons and 400 devices per hub; "beyond that, a hub per site and L5 federation" (MUS 10.9) | A full defence portfolio needs several hubs |

The lesson is that the roster already holds the hard parts: linear authority, signed facts, safety codes, cells, grants and rekeys. Positions and postings are new roster kinds on that machinery, not a second membership system.

---

## 3. Part A: assigned positions

### 3.1 Positions are separate from people

A position is a roster object with:
- a random id;
- a title, for example "J2 Chief";
- a section, for example `j2`;
- an optional shift or variant, for example "night";
- the **decision roles** it carries, for example `decision_for: commander` or "approves intelligence estimates";
- the **clearance it requires**;
- the **cells it grants**;
- whether it may be held **acting** or **dual-hatted**;
- an optional **establishment reference**, the line in a manning document (later, 3.11).

Roles, decision authority and cell grants attach to the position, not to the person. A person gets them while they hold the position and loses them when relieved, unless another posting of theirs carries the same thing.

Positions persist. "Who held J2 Chief at 14:00 on 3 December?" has one answer from the fold. Every decision records both the person and the position they decided as, so an approval stays attributable after the holder rotates out.

### 3.2 The authority to post

| Item | Rule |
|---|---|
| Who holds it | The staff lead, from genesis. In Military and Public service mode the lead is itself a position, filled by posting |
| Delegation | `authority.delegate` names a member, the scope (a list of positions, a section, or all), the posting kinds allowed (substantive, acting, temporary), an expiry, and whether they may sub-delegate (default no). Delegation only narrows: a delegate passes on at most what they hold, which is Phase 71's rule applied early |
| Typical delegates | J1 or personnel staff for all positions, J3 for the watch roster, or whoever sets up teams. The policy default is "lead plus delegates" |
| Revoking | `authority.revoke` by the lead or the delegator. Postings already ordered stand. Pending ones show "ordered under an authority that has since ended" to the lead, who confirms or cancels them |
| Record | Every posting carries `orderedBy` (member and device), `authority` (the delegation chain up to the lead), the signed time, and an optional order reference (free text, for example a posting message number) |

Delegates become roster writers, but only for posting and position kinds within their scope. The roster fold checks the scope at the cited roster head, exactly as it checks the lead's devices today. More roster writers mean more chances of an offline split. Online, the hub accepts only entries that cite the current head, so delegates are serialized. Offline, section 3.7 keeps splits rare.

### 3.3 Kinds of posting

| Kind | Meaning | Rule |
|---|---|---|
| Substantive | The person holds the position | At most one substantive holder at a time |
| Acting | The person holds the position's authority while it is vacant or the substantive holder is away | While an acting posting is in effect, the substantive holder is **away**: they keep membership and history, but the position's roles and decision authority go to the acting holder. It ends on its end date, when the substantive holder returns (`posting.return`), or by the tasker |
| Temporary | A posting with a required end date, for example a two-week augmentee | It ends by itself on the end date, and the person is relieved unless another posting covers them |
| Dual-hatted | One person holds two positions, each through its own posting | Allowed only where both positions allow it. Separation-of-duty rules apply: the same person may not both own and approve one product. The fold checks this per decision and refuses with "You hold both positions; this decision needs someone else" |

The invariant is that at any roster position, each position has at most one person exercising its authority: the substantive holder, or the acting holder while one is in effect.

### 3.4 The person cannot decline

Assignment mode has no Decline button and no expiry that silently cancels a posting. The person sees:

> You have been posted to **J2 Chief** from 1 December, ordered by the J1 under the staff lead's authority.
> [Prove this computer] [Report unable]

From the start date they also see **[Report for duty]**.

**Report unable** asks for a reason, chosen from:
- medical;
- compassionate;
- conflicting tasking;
- not qualified;
- not cleared;
- other (free text, 500 characters).

The reason is sealed to the tasker and their authority chain only (3.7), never to other members. The tasker then decides:

| Tasker decision | Effect |
|---|---|
| Confirm | The posting stands as ordered. The person is told "Your posting stands. Report for duty from 1 December." |
| Defer | A new start date. The posting goes back to ordered |
| Reassign | The posting is cancelled with the reason recorded, and usually a new posting for someone else follows |

There is no outright refusal. If nobody reports by the start date plus the overdue setting (default 2 days), the posting shows **overdue** to the tasker with **Remind**, **Defer** and **Reassign**. Nothing waits forever, and the tasker always has a next action.

Agents never post, never report, and never decide on a report-unable. These are signed person acts that no agent tool can reach, as for staff decisions today.

### 3.5 Proving the computer is key delivery, not consent

The posting file (or hub delivery) works like today's invitation. It carries the genesis hash, the posting id, the hub address and pin, a one-time secret and the tasker's signature.

1. The posted person's extension makes a device request: their Ed25519 and X25519 keys, with a MAC under the secret.
2. Both sides show the six-word safety code. Any tasker for that position, or the lead, compares it by voice or in person and confirms. The roster then records `posting.enrol`, binding the device to the person and the posting.

Every screen says what this step is for: "This makes sure the keys go to your own computer. It does not ask whether you accept the posting." A secret that has expired only stops device enrolment. The tasker issues a new posting file, and the posting itself stays in force.

### 3.6 Handover: never empty, never two

In military and public service work, a person replacing another in one position is a **handover** (handover and takeover). **Relief in place** is the doctrinal term for replacing all or part of a force with an incoming unit, so it is used when a whole team or watch rotates. **Transfer of authority** is used when command authority passes. In Canadian land operations doctrine, relief in place is defined as the replacement of all or part of a force in a sector by an incoming unit. The vocabulary table (section 5) shows these words. The mechanics are the same for all of them.

**Authority switches at one roster entry.**
1. The tasker posts the incoming person to a position that is held.
2. The posting enters **handover pending**: the outgoing holder keeps full authority.
3. When the incoming person reports for duty, the fold applies `posting.report`. At that same roster position, the outgoing holder is **relieved**, and the position's roles and decisions pass to the incoming.
4. Any entry the outgoing holder signs after that position, under the position's roles, is refused as unauthorized, with "Relieved from J2 Chief at 09:12; this was signed after."

**Keys switch at the same entry, prepared in advance.** A cryptographic key cannot wait for a date, so the tasker's machine prepares the next epoch for each cell the outgoing holder loses at the time of the order:
- `cell.rekey.staged` holds wraps for every remaining member plus the incoming device, and none for the outgoing.
- It is marked "activates at the report of posting P".
- Writers switch to the staged epoch the moment their fold applies the report.

If membership changes between the order and the report, the staging goes stale. The fold refuses a stale staging, and the tasker's or lead's machine stages again automatically. The roster flags a stale staging: "The key change for this handover must be prepared again", with one action.

**Reading in before reporting.** The incoming device receives the history wraps when it is enrolled, so it can read the position's past work during the handover. This is normal practice for reading in, and the posting card says so. It cannot write or decide until it reports. An organization that wants no early reading sets `postings.enrolAtReport: true`. The device is then proven at the moment of reporting, which needs a live safety code with a tasker.

**The outgoing holder keeps what they already received.** This is the existing removal sentence (MUS 8.3): "They keep what they already received. They will not receive anything new."

**A position becomes vacant only by a signed act.** Either the tasker relieves the holder with no replacement (`posting.end`, reason required), or a temporary posting ends with nobody else posted. Vacancy then shows as a gap ("J2 Chief: vacant since 3 December"), and the position's decision roles fall back to the lead with a warning on the decision queue.

### 3.7 Entries and where they live

| Entry (roster stream unless stated) | Writer | Content |
|---|---|---|
| `position.create`, `position.update`, `position.disestablish` | Lead or a delegate with that scope | The fields of 3.1 |
| `authority.delegate`, `authority.revoke` | Lead or a delegator | Section 3.2 |
| `posting.order` | Tasker | Posting id, position, person (existing member, or a new person with a proposed name), kind, start, end, `orderedBy`, `authority`, staged rekey reference |
| `posting.enrol` | Tasker or lead | Device descriptor bound to the person and posting, after the safety code |
| `posting.report` | **The posted person's enrolled device** (see below) | Posting id |
| `posting.decide` | Tasker | confirm, defer (new start) or reassign, after a report-unable |
| `posting.return`, `posting.end`, `posting.cancel` | Tasker, or the fold for end dates | Return from away, relief without replacement, cancellation |
| `posting.unable` (**personnel cell**, not the roster) | The posted person's device | Posting id and reason, sealed to the personnel cell |
| `cell.rekey.staged` | Tasker or lead | Section 3.6 |
| `roster.require` | Lead | Features the project needs (3.9) |

**Self-report is a narrow roster write.** The posted person is not a roster writer. Making the tasker countersign every report would leave a handover stuck whenever the tasker is offline. Instead, the enrolled device of the person named in a posting may append exactly one kind, `posting.report`, for that posting only, on or after its start date (signed time, with the existing 10-minute future hold).
- **Online:** the hub accepts it only if it cites the head, so reports serialize with everything else.
- **Offline:** a report and another roster entry concurrent on one head **commute**. The fold applies the other entry first and the report after it, in a fixed order, when they touch different positions and postings. Only a conflict on the same posting or position is a real split for `roster.choose`. Example: the tasker cancelled the posting while the person reported.

**The personnel cell.** A label cell created with the first delegation, held by the lead, the deputy and taskers. It keeps report-unable reasons and order references away from the base cell, which every member reads. By-name personnel detail stays in this cell, in line with note 07's two-zone J1 design.

### 3.8 State machines

Every transition below gets a test.

**Position**

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | vacant | `position.create` | Lead or delegate |
| vacant | held | `posting.report` of a substantive or acting posting | Posted person's device |
| held | handover pending | `posting.order` for a held position | Tasker |
| handover pending | held (new holder) | `posting.report` of the incoming; the outgoing is relieved at the same roster position | Incoming's device |
| handover pending | held (same holder) | Incoming posting cancelled or reassigned | Tasker |
| held | held with acting | Acting posting reported while the substantive holder is away | Acting person's device |
| held with acting | held | `posting.return`, or the acting end date | Tasker or fold |
| held | vacant | `posting.end` without a replacement, or a temporary posting ends | Tasker or fold |
| vacant or held | disestablished | `position.disestablish`; refused while a posting is pending | Lead or delegate |

**Posting**

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | ordered | `posting.order` | Tasker |
| ordered | ordered, device proven | `posting.enrol` after the safety code | Tasker or lead |
| ordered | unable reported | `posting.unable` | Posted person |
| unable reported | ordered | `posting.decide confirm`, or `defer` with a new start | Tasker |
| unable reported | cancelled | `posting.decide reassign` | Tasker |
| ordered, device proven | in effect | `posting.report` on or after the start | Posted person |
| ordered | overdue | Start plus the overdue setting passes without a report (display state, from signed time and the local clock) | Fold |
| overdue | ordered, in effect or cancelled | Defer, report, or reassign | Tasker or person |
| ordered | cancelled | `posting.cancel` | Tasker |
| in effect | away | Acting posting to the same position reported | Fold |
| away | in effect | `posting.return` | Tasker |
| in effect | relieved | Incoming report, `posting.end`, or the end date | Fold or tasker |

There is no transition from ordered to declined. An ordered posting whose authority was revoked shows **authority ended** to the lead (confirm or cancel) and stays ordered until they act.

**Staged rekey**

| From | To | Trigger |
|---|---|---|
| (none) | staged | `cell.rekey.staged` with the order |
| staged | active | The matching `posting.report` is folded |
| staged | stale | A roster change after staging alters who should hold the cell |
| stale | staged | Restaged automatically by the tasker's or lead's machine |
| staged | withdrawn | The posting is cancelled |

### 3.9 Older clients fail safe

MUS 4.3 says unknown kinds are kept and relayed but never change state on an older client. For postings that rule is unsafe: an older client would ignore a relief and keep accepting the outgoing holder's writes. The project therefore writes `roster.require { features: ["positions"] }` before its first position entry. A client that does not know a required feature refuses to fold the project and shows "This project needs a newer version of the extension. Update to keep working on it."

The check itself is small and generic, so it should ship in Phase 33, with drop A. That way every multi-user client in the field already obeys it when positions arrive.

### 3.10 Migration from seats

Turning on positions for an existing multi-user project:
- creates one position per distinct seat;
- writes one substantive posting per member with a seat, already in effect, ordered by the lead "at migration";
- moves the seat's roles to the position.

The fold gives the same decisions and grants before and after, which is a parity test. Projects in invitation mode keep `member.invite` and are untouched.

### 3.11 Later: manning documents and directory groups

- **From a manning document.** A joint manning document (note 07) or an establishment table, imported as a signed file, creates positions and proposes postings. A tasker still signs each posting, because an import never posts anyone by itself.
- **From your organization's directory groups.** With Phase 71 identities and the directory snapshot the data platform keeps (DP 4, the Microsoft 365 connector in Phase 89), a posting can name a verified person. A group change proposes a posting or a relief for a tasker to confirm.
- **Clearances.** These become credentials checked against the position's required clearance. Before Phase 71, clearances stay declared, and every screen says so (MUS 7.2).

### 3.12 Plain-words copy

- **Tasker:** "Post a person to J2 Chief. Start date: 1 December. Kind: substantive. You are posting under the staff lead's authority (delegated to you on 18 November, all J2 positions)."
- **Person:** "You have been posted. You cannot decline a posting here; if you cannot take it up, report that you are unable and say why. Your tasker decides."
- **Handover:** "Handover: Maj Example will take over J2 Chief when they report for duty. Until then, you hold it."
- **Relieved:** "You were relieved from J2 Chief at 09:12 on 3 December. You keep what you already received. Your decisions as J2 Chief before 09:12 still stand."
- **Tasker after a report-unable:** "Capt Example reported unable to take up Watch Officer, night: conflicting tasking. Confirm, Defer or Reassign."

---

## 4. Why not keep invitations and add a "mandatory" flag

| Option | For | Against |
|---|---|---|
| (a) Invitation with a "cannot decline" flag | Small change | The position still dies with the person. There is no delegated authority, no handover, and no single-holder rule. The words stay wrong |
| (b) Positions and postings as roster kinds (chosen) | Positions persist. Authority is explicit and delegable. Handover is atomic in the fold. Keys follow at the same entry | More roster kinds. A narrow self-report write, and staged rekeys |
| (c) A separate personnel system outside the roster | Matches how organizations hold HR records | Two sources of truth for who may act. The roster would trail the HR system, which is exactly the "two records disagree" state to avoid |

(b) keeps one source of truth for who may act, and it is the one the fold already enforces. The organization's own HR system stays the system of record for people. As note 07 says, the J1 coordinates and the services account, so later it only proposes postings (3.11).

---

## 5. Part B: organization modes

### 5.1 One table, two jobs

A mode bundles two things that must not drift apart:
- the **words** on every screen;
- the **joining model and default behaviour** behind them.

A screen that says "posted" while the code allows declining would be a lie, so both come from one row. The table is pure data, like `doctrine.ts`, in a new `src/domain/org/modes.ts`. The staff doctrine profiles stay as they are and become what a Military-mode project selects for planning words. Mode and profile are separate axes: a Public service project can still use the NATO/Canadian planning profile.

**Concept keys.** Code never spells a mode word. It asks for a concept, for example `term('position', mode)` or `term('report', mode)`, much as the capital pack's display rule renders a slot's `name` or `label` (CAP 2.1). The portfolio also rolls up by concept key, which is what lets units of different modes add up (section 6).

### 5.2 Vocabulary

| Concept key | Military | Public service | Corporate and software | Capital projects |
|---|---|---|---|---|
| `position` | Billet (position) | Position | Seat on the team | Role |
| `group` | Section, staff, unit | Directorate, branch, unit | Team | Project office |
| `join` | Posting | Assignment | Invitation | Appointment |
| `joined` | Posted | Assigned | Invited | Appointed |
| `report` | Report for duty | Report to the position | Accept | Take up the appointment |
| `unable` | Report unable | Report unable | Decline | Report unable |
| `tasker` | Tasking authority | Delegated manager | Team admin | Appointing authority |
| `delegate` | Delegate tasking authority | Delegate authority | Make admin | Delegation of authority |
| `acting` | Acting (while so employed) | Acting appointment | (not offered) | Acting |
| `temporary` | Temporary duty or attached posting | Temporary assignment | Guest | Temporary appointment |
| `dual` | Dual-hatted | Concurrent responsibilities | Member of two teams | Dual role |
| `handover` | Handover; relief in place (a whole team or watch); transfer of authority (command) | Handover | Hand over ownership | Handover of the appointment |
| `relieved` | Relieved | Assignment ended | Removed | Appointment ended |
| `lead` | Staff lead (commander's representative) | Responsible manager | Team lead | Project leader |
| `member` | Staff officer | Employee | Member | Project team member |

Each military and public service term in the shipped table is checked against a doctrine or policy source in a terms note and the staff terms register before the phase ships (research flag in 10.2). The owner's reference copies are used to check words, never quoted. Capital-mode words are the pack's neutral labels. Your organization's private capital profile can rename them, as it renames every capital slot (CAP 2.1).

### 5.3 Behaviour

| Setting | Military | Public service | Corporate and software | Capital projects |
|---|---|---|---|---|
| Joining model | Assignment | Assignment | Invitation | Appointment |
| `mayDecline` | No (report unable) | No (report unable) | Yes | No (report unable) |
| Invitation expiry cancels the join | No (only the device secret expires) | No | Yes (7 days) | No |
| Who may post or appoint | Lead plus delegates | Lead plus delegates | Lead and deputy (today) | Appointing authority plus delegates; the appointment cites an instrument (for example an appointment letter slot) |
| Acting, temporary, dual-hatted | All three | All three | Temporary as guest only | All three |
| Handover required to replace a holder | Yes (atomic) | Yes | No (remove, then invite) | Yes |
| Positions persist across rotations | Yes | Yes | Optional | Yes |
| Guests by invitation (liaison, adviser, observer) | Allowed if the policy allows | Allowed | Always | Allowed |
| Default planning profile | `nato-ca` or the policy's choice | None (plain steps) | None | Capital pack |
| Decision wording | Commander's decision | Approved by the delegated authority | Approved | Endorse or approve by the profile's body |

**Appointment** is assignment plus an instrument. The appointing authority's order cites a document, for example the capital pack's appointment-letter slot, and the appointee's report acknowledges that instrument. Behind it is the same posting machine (3.8) with different words and one extra required field.

### 5.4 Where the mode is stored

> **Coherence review (2026-11-20):** the `organization` key becomes `people.organization` in policy bundle v2, named in `requires`. The mode table (`src/domain/org/modes.ts`) and `term()` are built in Phase 41 (the organization policy foundation) rather than Phase 32.1, because Phase 33.1 needs them and `mayDecline` is a security rule. See `.planning/research/coherence/REVIEW.md`.

| Layer | What | Rule |
|---|---|---|
| Signed policy bundle | `organization: { mode, allowedModes, projectMayChoose, settings }` | It is the default for everything under the policy, parsed with strict key checks like the `onboarding` key (GUIDE 9.3). `settings` may tighten behaviour (for example `enrolAtReport`, the overdue days, dual-hatting off) but never loosen what a mode forbids. Declining can never be enabled in an assignment mode |
| Project | `project.genesis.mode` | It must be in `allowedModes`. A change is a roster entry, `project.mode`, by the lead, within what the policy allows, and is refused while postings are pending |
| Unit in a portfolio | The unit's own policy | Each unit keeps its mode. The portfolio stores the unit's mode only to render its terms in a crosswalk (6.5) |

A project without a mode, which is every project today, behaves as Corporate and software for joining. Staff profiles are unchanged, so nothing changes for existing users.

### 5.5 How it is applied

- **Words:** `term()` everywhere, with a lint test that fails when a joining or organization word is spelled in a webview or host string outside the table, like the doctrine rule that "code in profiles.ts never spells a doctrine term of its own".
- **Behaviour:** the roster host picks the flow from `joiningModel`: `member.invite` for invitation, `posting.order` for assignment and appointment. The fold enforces `mayDecline`. A decline entry in an assignment-mode project is refused, not just hidden.
- **Templates:** team templates and the Staff Room read `term()`. Capital pack screens keep their profile names.

### 5.6 Suggested by guided setup

The guide's Q1 role suggests a mode when the policy lets the project choose:

| Q1 answer | Suggested mode |
|---|---|
| Staff work in a headquarters section | Military |
| Plan or manage capital projects | Capital projects |
| Write or review software | Corporate and software |
| Anything else | The policy's default mode |

The suggestion is shown on the check-answers page ("People join this project by posting, as in a military staff. Change"), never applied silently. When the policy fixes the mode, the row shows "Set by your organization" and cannot be changed. This adds one row to GUIDE 8.3 and one optional field to the setup record.

### 5.7 Mode change

| From | To | Trigger | Rule |
|---|---|---|---|
| (none) | mode M | Genesis, with M in `allowedModes` | The guide suggests M |
| M | M' | `project.mode` by the lead | M' must be in `allowedModes`, with no pending posting or invitation. From invitation to assignment, active members become substantive holders of positions made from their seats (3.10). From assignment to invitation, positions stay as seats and the history is kept |
| any | refused | The policy removes M from `allowedModes` | The project stays readable. New joins are refused with "Your organization no longer allows this way of joining; ask the lead to change the project's mode" |

---

## 6. Part C: mixed organizations and the portfolio view

### 6.1 Research summary

Sources are listed in section 11. "[S]" marks facts seen only in search summaries, and "[F]" marks pages that were read. Treasury Board policy pages refused automated reading, so their clause-level detail is marked unconfirmed and must be checked by a person before a phase cites it.

**Standards and practice.**
- **PMI, Standard for Portfolio Management (4th ed.) [S].** Portfolio components are programmes, projects and other work. They compete for limited resources and are identified, categorized, evaluated and prioritized. It has performance domains for strategic management, governance, capacity and capability management (supply and demand against resource capacity), stakeholder engagement, value and risk.
- **PMI, Standard for Program Management (4th ed.) [S].** Five domains: strategy alignment, benefits management, stakeholder engagement, governance and life cycle. The 5th edition (2024) added collaboration.
- **Axelos MoP [S].** A definition cycle (understand, categorize, prioritize, balance, plan) and a delivery cycle (management control, benefits, finance, risk, resource, stakeholder engagement). It describes portfolio management as continuous and iterative: "continued prioritization, strategic alignment and balance".
- **Axelos MSP 5th ed. [S/F].** Tranches deliver capability in timeboxed steps with their benefits. The blueprint is now called the target operating model.
- **Axelos P3O [F].** A permanent portfolio office plus temporary programme and project offices, and a centre of excellence for standards and assurance. Its **hub-and-spoke** model has a central P3O and departmental P3Os, each with its own programme and project offices. The functions are "scrutiny and challenge" and transparency through "relevant, accurate and timely data from a single source". This is the closest match to a defence portfolio of mixed units.
- **Gartner-style strategic portfolio management (public abstracts) [S].** It links strategy and outcomes to capabilities, investments and programmes. Its capabilities include element-neutral portfolio creation, dynamic funding and investment modelling, demand management, adaptive programme management and portfolio-level resource planning. The EPMO trend is away from execution tracking and toward value realization.

**Government of Canada.**
- **Investment and project rules (Treasury Board) [S, clauses unconfirmed].** The Policy on the Planning and Management of Investments and the Directive on the Management of Projects and Programmes (in force 2019, with 2025 editions catalogued) cover:
  - a departmental investment plan;
  - a gating plan set no later than business case approval;
  - Treasury Board approval when a project's assessed complexity and risk exceeds the department's approved project management capacity class.
- **Project Complexity and Risk Assessment (PCRA) [F].** 64 questions in 7 categories, giving four levels: 1 Sustaining, 2 Tactical, 3 Evolutionary, 4 Transformational. It is done before funds are spent and updated as the project matures.
- **Organizational Project Management Capacity Assessment (OPMCA) [F].** 92 questions in 13 knowledge areas, giving capacity classes 0 to 4, confirmed every three years. A project above the department's class needs Treasury Board approval.
- **Policy on Results [S].** A Departmental Results Framework of core responsibilities, departmental results and indicators. A Departmental Plan in spring and a Departmental Results Report in fall.

**DND/CAF (public pages).**
- **Defence investment planning.** The public Defence Investment Plan says planning decisions follow the forces' capability requirements, and projects enter the plan when fully assessed and funded [S].
- **Project phases.** A public audit describes five project phases: identification, options analysis, definition, implementation and close-out. It names a capabilities board that approves early documents and a programme management board that advises on the investment plan [F].
- **Independent review.** The Independent Review Panel for Defence Acquisition advises the Minister on large projects [S].
- **What the portfolio needs.** Capability links, stage gates, a complexity and risk rating per project, a capacity class per unit, and results-framework links. Your organization's own approval directive is mirrored only through the capital pack's private profile (CAP 2.1), and none of its text enters the repository.

**Open-source portfolio tools.** These were read for design only, as untrusted pages. No code was run or copied, and the extension is MIT-licensed, so GPL and AGPL code could not be copied in anyway.

| Tool | Licence | Portfolio model | Maturity | Security note | What we take |
|---|---|---|---|---|---|
| OpenProject 17 | GPL-3.0; portfolios are an Enterprise add-on | Portfolio, programme and project workspaces; status and count roll-up; project attributes; formula scores still in development (public-sector PM2 hackathon work) | High: about 17.6k stars, active, public-sector users | Role permissions per workspace; several 2026 cross-project authorization CVEs (CVE-2026-52779, CVE-2026-22605, CVE-2026-27733, CVE-2026-44735) | Three-level hierarchy, attributes as the roll-up schema, risk matrix. The CVEs show why we never give a portfolio a "see across projects" permission and use publications instead |
| Leantime | AGPL-3.0; programme and strategy are paid plugins | Goals and canvases in core; a programme plugin groups projects | Medium to high: about 12.1k stars | Plugins may carry other licences | Goals linked to work, as a light benefits link |
| Odoo Community | LGPL-3.0 (Enterprise proprietary) | No native portfolio; tags and analytic accounts | Very high | Large ERP attack surface | Nothing for portfolio |
| Taiga | MPL-2.0 | None | Medium, slowing | Per-project roles | Nothing |
| Redmine with plugins | GPL-2.0 core; plugins vary | Subproject tree; dashboard plugins (Redmine Pulse), many stale | Core mature, plugins uneven | Plugins run with full privileges | Subproject tree only |
| Tuleap | GPL-2.0 or later; programme management possibly Enterprise | SAFe programme and team projects, synchronized programme increments | Mature, compliance-focused | Fine-grained tracker permissions | Planning held at programme level and synchronized down, as a model for downward publications |
| ProjectLibre | CPAL | Desktop single project; portfolio only in the paid cloud edition | Medium | Not applicable | Nothing |

None of them labels roll-up items, handles aggregation, or keeps each unit's data in its own keyed compartment. All of them share data across projects by permission inside one database. That is the property a defence portfolio cannot accept, and the main reason to build this rather than integrate one. A later connector may still import from or export to OpenProject's API through the data platform's catalogue (Phase 100), at the label of what is exchanged.

**Prioritization methods.**
- **Weighted scoring.** Criteria should be mutually exclusive and collectively exhaustive, because overlapping criteria double-count. Each criterion needs clear anchors per score. People should score independently and then reconcile, and the model should be calibrated against decision-makers' own rankings. Risk subtracts rather than adds. Scores bunched in the top half show that the model does not separate projects [F, practitioner sources].
- **Efficient frontier.** A true frontier comes from repeated constrained optimization at varying budgets. A benefit-to-cost ranking matches it only without dependencies or time-phased funds. With discrete projects the frontier is a set of points [F].
- **AHP pairwise weights.** These suffer rank reversal when an option is added or removed [S].
- **WSJF.** Cost of delay divided by job size. It suits flow-based software units [F].
- **MoSCoW.** Musts should be at most about 60 percent of effort. It is a release tool, not a portfolio tool [S].
- **Gaming and false precision.** These are widely discussed, but no authoritative source was found to cite. The design guards against them anyway (6.6).

**Aggregation and compilation.**
- **NATO.** AC/35-D/2002 REV4 says a document is classified at least as high as its highest component, and collated information "may warrant a higher classification than its component parts" [F].
- **United States.** E.O. 13526 section 1.7(e) allows classifying compilations of individually unclassified items that reveal an association [F]. Critics note that compilation is subjective and open to over-classification [F].
- **Canada.** Treasury Board's security categorization standard has the category of a repository reflect aggregation [S]. DND's own guidance gives the example of one address at Protected A and 10,000 addresses at least Protected B [F]. A 2023 Treasury Board notice deliberately caps personal information in the aggregate at Protected B, with extra safeguards instead of a higher level [F].
- **Academic work.** The multilevel database literature (Denning et al. 1987, Lunt 1989) treats aggregation as constraints on views [S].
- **Conclusion.** Aggregation rules must be **policy data set per scale by your organization**, never hard-coded. Some scales raise the level and some (Canadian personal information) only add safeguards. A person must be able to see why a view got its label.

### 6.2 What we take and what we do not

| Take | From | Where |
|---|---|---|
| A permanent portfolio office, temporary programme and project offices, hub and spoke | P3O | 6.3, roles in 6.9 |
| Categorize, prioritize, balance, plan, and repeat | MoP, PMI | 6.6 |
| Benefits with indicator, baseline, target, owner and date | MSP, PMI, CAP 7.1 | Publication schema, 6.4 |
| Capacity and capability, demand against supply | PMI, SPM | 6.7 |
| Gates per project with complexity and risk rating, a capacity class per unit | Treasury Board rules, PCRA and OPMCA, the capital pack | 6.8 |
| Results-framework links (core responsibility, result, indicator) and plan and results reports | Policy on Results | 6.4, products in 6.9 |
| Three-level hierarchy and attributes as schema | OpenProject | 6.3, 6.4 |
| Aggregation as signed constraints on views | Multilevel security literature, NATO, Canadian guidance | 6.10 |
| Not taken: cross-project read permissions inside one store | Every tool reviewed | Publications instead (6.4) |
| Not taken: one score that ranks everything without constraints | Faux frontier critique | Constrained frontier (6.6) |

### 6.3 The organization tree

```
Portfolio            (a portfolio project: its own genesis, roster, cells, mode)
 +- Unit             (a command, a branch, a project office, a software cell; each with its own mode and policy)
     +- Programme    (optional; a programme office, a team of teams, CAP 5.4)
         +- Project or staff team   (a replica project: staff project, capital project office, or a plain project)
```

- **Each node that does work is its own replica project.** It has its own roster, cells and mode. A unit node is a small project of its own (the unit's office), so the unit can review its children's publications before they go up.
- **The tree itself is a signed structure in the portfolio project.** It is made of `portfolio.unit.add`, `portfolio.programme.add`, `portfolio.project.link` and `portfolio.node.retire` entries, written by the portfolio lead. A link is only active when the child side has signed the matching **publication agreement** (6.4). The portfolio cannot claim a unit that has not agreed to report.
- **Mixed modes.** Each node records its mode, so the portfolio can show "Posted: 41 of 44 billets" for a command and "Assigned: 18 of 20 positions" for a branch. They still roll up under one concept key (`position`, filled against established).
- **Node ids are opaque.** A node's name and mode are visible only at the node's own label. A classified unit can sit in the tree without lower-cleared viewers learning that it exists (6.10).

### 6.4 Publications: what each level sends upward

**Publication agreement.** A signed pair:
- the portfolio's offer names the intake cells and their labels, the item types wanted, the cadence (for example status monthly, risks on change), and the route (direct, or through the unit's office);
- the node's acceptance names the **publishers**: the positions allowed to release publications, for example the unit PMO reporting officer.

Either side may end the agreement. Ending it stops new publications, and the portfolio keeps what it received, marked "no longer reporting since ...".

**Intake keys (write-only).** For each intake cell and epoch, the portfolio creates an X25519 intake key pair:
- the private half is wrapped only to the portfolio's members on that cell, like any epoch key (MUS 8.2);
- the public half goes to the node in the agreement;
- a publisher seals a publication to the intake public key with the same ephemeral X25519, HKDF and AES-256-GCM wrap the roster uses.

So a unit can publish into the portfolio's Protected B intake without holding any key that reads it, and without seeing what other units sent. The hub holds ciphertext and an opaque cell id, as it does for every ungranted cell.

**Publisher proof.** The portfolio cannot read the node's roster, so each publication carries a **roster attestation**: a statement signed by a roster writer of the node that device D holds a publisher position at roster head H. The portfolio's fold checks the attestation against the node lead keys pinned in the agreement. With Phase 71 it becomes a verifiable credential. Each publisher's publications carry a sequence number, so a gap shows as "missing 2 publications from the logistics command since 3 December", which is MUS 4.5's withholding rule.

**Release by a person.** A publication is a product in the node's cell at its label. Agents draft it from the node's own products, registers and ledgers. A publisher person releases it through the release guard. The guard holds:
- personal data and markings;
- a label below the join of what the publication cites;
- compilation within the node's own publications (6.10).

Lowering a publication below its sources is the existing downgrade act, a person with a sanitization note (MUS 8.1 rule 5).

**What each level publishes.**

| Item type | Fields (concept keys) | Typical label | Published by |
|---|---|---|---|
| `status` | Overall, schedule, cost, scope and benefits ratings (green, amber, red) each with a one-line reason; as-of date; trend | Same as the project | Project, programme |
| `milestone` | Id, title, original baseline, current baseline, forecast, actual, gate link | Project's | Project |
| `risk` | Id, title, cause, effect, probability, impact, rating, owner position, response, escalation state, age | Often higher than status | Project, programme, unit |
| `issue` | Id, title, impact, owner position, needed by, decision needed from | Project's | Project, unit |
| `demand` | Role or skill, required clearance, period, quantity in person-months, firm or tentative, linked work | Project's; raises when it reveals operations | Project, programme |
| `supply` | Positions by concept, skill, clearance and period: established, filled, vacant, away, from Part A's fold; **counts only, no names** | Unit's | Unit |
| `spend` | Fiscal year, fund or vote, planned, committed, actual, forecast, estimate class; each figure citing a calculator record (CAP 7.3) | Often Protected B or supplier-confidential | Project, programme |
| `benefit` | Indicator, baseline, target, actual, owner position, date, the results-framework link | Project's | Programme, project |
| `capability` | Capability ids from the portfolio's capability catalogue, with contribution (delivers, enables, depends) | Can be high: links reveal gaps | Project, programme |
| `gate` | Gate slot, state, decision date, deciding body slot, the path from the capital path calculator, complexity and risk level (PCRA-style slot) | Project's | Project |
| `dependency` | From, to (node ids, possibly in other units), type, needed by, state | The join of both ends' labels, published by the "from" side | Project |
| `capacity-class` | The unit's assessed project management capacity class and its date (OPMCA-style slot) | Unit's | Unit |

**Downward publications** use the same machinery in reverse. The portfolio releases **priorities**, **allocations** (6.7), **guidance** and **gate calendar** items to the intake keys of its nodes. The portfolio never posts a person in another unit. An allocation is a tasking to the unit, which the unit's own tasker turns into postings (Part A). That keeps each unit's authority, as the J1 coordination rule does.

### 6.5 The portfolio view (Portfolio Room)

> **Coherence review (2026-11-20):** this is the one Portfolio Room. The capital projects design's Portfolio Room and Project Room (capital 8) become its capital tab, built in Phase 43. See `.planning/research/coherence/REVIEW.md`, conflict K26.

The Portfolio Room is a webview built from Staff Room components, extending CAP 8 from one organization's ledgers to publications from many units. It draws only from the portfolio's folded publications at the viewer's cells, never from units' own streams.

| View | Content | Answers |
|---|---|---|
| Tree and heat map | The organization tree with each node's latest status, as-of age, mode and terms crosswalk (hover: "Billet (Military) = Position (Public service)") | Where is everything, and how fresh is it |
| Pipeline and gates | Gate state per project on its path; gate calendar of each deciding body with packages due; complexity and risk level against the unit's capacity class (flagging projects that need a higher approval) | What is coming to which board, and what needs higher approval |
| Strategic alignment | Projects against capabilities and results-framework outcomes; outcomes with no project and projects with no outcome | Are we funding the strategy |
| Prioritization | Ranked list under the active criteria set, score spread per item, sensitivity band, efficient frontier chart, mandatory items marked | What should go first, and how sure are we |
| Scenarios | Side by side: funded set, total spend by year and fund, capacity gaps by skill, benefits by outcome, risk exposure, dependencies broken | What do we gain and lose with each option |
| Capacity and demand | Demand against supply by skill, clearance and period, across units; gaps and surpluses; proposed reallocations | Where people are short, and where they could come from |
| Dependencies | Cross-unit graph; late upstream items in red with the downstream items they put at risk | What will slip because of something elsewhere |
| Risk and issues | Aggregated heat map; risks waiting past escalation age; issues waiting on the portfolio | What needs the portfolio's attention now |
| Spend and benefits | Planned, committed, actual and forecast by fiscal year and fund; benefits realized against target | Is the money buying what was promised |
| Decision queue | Every prioritization, allocation, gate and escalation decision waiting on a person, with options, risk and dissent | Where the portfolio board's time goes |

Every view shows its label at the top, a **"Why this label"** link (6.10), and the fixed sentence "Built from the publications available to you." The sentence is the same for every viewer, so it reveals nothing.

The knowledge base layer of the data platform (Phase 97, "every number computed under the viewer's clearance") later becomes the rendering and ad-hoc analysis layer for these same views. The publication fold stays the source, and Phase 97 reads it as one more governed source.

### 6.6 Prioritization

**Criteria set.** A signed, versioned product of the portfolio office, released by a person. It contains:
- criteria, each with a definition, anchored score levels (for example 0, 1, 3, 5 with a sentence each), a direction (benefit, or risk which subtracts) and a weight;
- weights that sum to 100;
- optional constraints: mandatory items (legal, safety, committed contracts), budget per fiscal year and fund, capacity per skill and period, and dependency rules (if B then A).

A lint holds a criteria set when:
- weights do not sum to 100;
- a criterion has no anchors;
- two criteria have overlapping definitions (flagged for a person, since overlap double-counts);
- risk is weighted as a benefit.

The criteria set has its own label. Strategic weights can be sensitive.

**Scoring.**
1. For each item and criterion, an agent drafts a proposed score with cited evidence from the item's publications (`pub:<id>` citations, like `calc:<id>`). An agent score without evidence is refused.
2. Named scorers score independently (default two per criterion), each signed.
3. The view shows the spread. Where scorers differ by more than one anchor level, a reconciliation note by a person is required.
4. The unit's own scores (self-assessed) are shown beside the portfolio's, never merged silently.

**Analysis (pure functions, deterministic, tested).**
- **Weighted score** per item and **rank**.
- **Sensitivity.** Each weight is varied by plus and minus 10 points (renormalized). Items whose rank moves across the funding line are marked "rank depends on weights".
- **Efficient frontier.** Exact 0/1 selection under budget-per-year, capacity-per-skill, mandatory and dependency constraints, by branch and bound, maximizing total weighted value at each budget level in steps. Portfolios of a few hundred items are within reach. A time limit returns the best set found, marked "best found, not proven optimal". This is never presented as a ranking alone, because of the faux-frontier critique.
- **Optional methods.** AHP pairwise weights, with a warning that adding or removing an item can reorder others. WSJF for units in software mode, shown in their own lane, not mixed into portfolio scores.

**Scenarios.** A scenario is a signed snapshot of everything it was computed from:
- the publication heads;
- the criteria set version;
- the constraints and overrides, for example "force-include project X";
- the result.

Comparing scenarios shows the differences. A scenario never changes when new publications arrive. It shows "N newer publications since this scenario" and offers **Recompute as a new scenario**.

**Decision.** The portfolio board decides on a scenario version through the replica version and decision algebra (MUS 6): approve, reject, or approve with changes. Changes create a new version that must be approved. Concurrent conflicting decisions are **contested** and need a fresh decision. The approved scenario then produces the downward `priorities` and `allocations` publications, released by a person.

### 6.7 Resource allocation, capacity and demand

- **Supply** comes from Part A. Each unit's fold knows established, filled, vacant and away positions by concept, skill and clearance, and the unit publishes these as **counts**. Names never leave the unit. This follows note 07 (J1 works on aggregate reports) and data platform decision 31 (no per-person productivity scoring).
- **Demand** comes from projects' `demand` publications.
- **The capacity view** matches demand and supply by skill, clearance and period across units, and shows gaps and surpluses.
- **Proposed reallocations** are drafted by an agent: move a skill from unit X's surplus to unit Y's gap. Each needs a person's decision in the portfolio and then a tasking to each unit. Unit X's tasker posts the people under the unit's own mode. A military unit posts, a branch assigns, and a project office appoints. The portfolio sees the result as changed supply counts in the next publication.
- **Clearance-aware matching.** A demand that requires Secret can only be met by supply at Secret. Supply above the viewer's clearance is not shown (6.10).

### 6.8 Dependencies and stage gates

- **Dependencies** cross units. A dependency is published by the "from" side and labelled the join of both ends. If the viewer cannot see one end, they cannot see the edge.
- **Lateness propagates downstream.** When an upstream milestone forecast moves past the downstream "needed by", the downstream item is marked "at risk from a dependency". A viewer who cannot see the upstream item sees only their own item's published forecast, never the reason.
- **Stage gates** come from the capital pack's gate slots and path calculator (CAP 2.4, 4.3), so a project's gate state in the portfolio is the one its own office recorded. The portfolio flags gate packages due before each body's meeting and projects whose complexity and risk level exceeds the unit's capacity class (the Treasury Board rule pattern, with thresholds from the profile, never from code).

### 6.9 People decide, agents draft

The portfolio office template is CAP 5.5's ten members, extended:
- `capacity-analyst`, for demand and supply matching and reallocation drafts;
- `scenario-modeller`, for frontiers and scenario comparisons;
- `results-reporter`, for drafts of the Departmental Plan and Departmental Results Report sections from benefit and results links.

Agents draft scores with evidence, scenarios, briefs, gate calendars and reports. They never approve a criteria set, a score reconciliation, a scenario, a priority or an allocation. These are person decisions through signed commands that no agent tool can reach, as everywhere else.

Agents run inside the portfolio cell whose label covers their inputs. The gate routes them by that label, raised by aggregation (6.10). A portfolio view labelled Secret by aggregation can only be drafted by models the policy allows for Secret, which usually means local models on an accredited machine. Model passports and use tiers (Phase 74.1) and Cohere vault ceilings (Phases 36 and 37) apply unchanged, at the view's label rather than the items' labels.

### 6.10 Labels and aggregation (central)

**Rule 1: every published item carries a label.** A publication's label is at least the join of the labels of everything it cites. The node's release guard enforces this, and only a person lowers it, with a sanitization note. The label travels inside the sealed body and in the intake cell choice: a publication labelled Protected B goes to the Protected B intake cell.

**Rule 2: a view is labelled as a whole.** For each render, export or snapshot, the view's label is:
- the **join** (highest on each scale, union of compartments) of the labels of the items in it;
- raised by any **aggregation rule** the set of items in it triggers.

Aggregation rules are signed policy data (the bundle's `aggregation` key, shared with the data platform's rules from DP 6.2 and decision 13). One evaluator serves both. Each rule names:
- a scope (a scale and level, or compartments);
- a trigger: a count (N items, N distinct units, N distinct capabilities) or a combination (item types present together, for example `capability` with `risk` and `supply`);
- an effect: raise to level L, add a compartment, add a handling flag, or (for scales whose policy says so, like Canadian personal information in the aggregate) **add safeguards only**;
- a remedy order (Rule 4).

**"Why this label"** lists the highest inputs and every rule that fired, with the rule's text. A person can always see why a view is labelled as it is.

**Rule 3: the viewer sees only what they may, and learns nothing about the rest.** A viewer's machine holds only the intake cells their clearance dominates (MUS 8.1 sender filtering), so items above them never arrive. By default, following the data platform's owner decision 7(a):
- there are no counts, placeholders or "some items hidden" notes;
- every view carries the same fixed sentence ("Built from the publications available to you");
- totals over what they hold are labelled as such.

An organization may opt in per scale to **existence only**, following decision 7(b). Even then, counts reach lower viewers only as a **sanitized publication** made by a person at the lower label, for example: "One further programme at a higher label: demand 12 person-months in the next two quarters, no names, no capability links." The view never computes such a count automatically.

**Rule 4: when the aggregate exceeds the viewer, degrade, never leak.** A viewer may be cleared for every item in a view but not for the aggregate, for example a Protected B viewer looking at 600 Protected B capacity items that a rule raises to Secret together. The Room does not build the aggregate for them. It offers the scoped views that stay within their clearance, in the rule's remedy order:
1. **Narrow** the scope (one unit, one programme).
2. **Suppress** the fields that trigger the rule (for example locations or capability links).
3. **Coarsen** (quarters instead of months, ranges instead of figures).

Each option is labelled, and the Room says "This combined view needs a higher clearance than yours. These views stay within it." The viewer could still compile the items themselves. Compilation rules classify the product, not the reading of the items, so the tool only refuses to make the compilation product for them, and its exports carry the compiled label.

**Rule 5: no lower view is ever derived from higher items.** Lower-labelled views are computed only from lower-labelled items, the write-down rule. Subtracting two views at different labels therefore reveals nothing, and the only way information moves down is a person's sanitized publication. This closes the classic difference attack, where totals at two clearances are compared.

**Rule 6: cross-organization sharing is by publication, never by cells.** The portfolio office gets intake keys, not units' cells. A unit's own cells, products, registers and observations never leave it except as publications its people release. Revoking an agreement or a publisher position rekeys the intake cell for new epochs (MUS 8.3).

**Rule 7: labels are not accreditation, and networks stay separate.** Labels decide where items go inside one system. A portfolio that mixes Secret and unclassified units runs on a network and hub accredited for the highest label it holds. Moving a sanitized publication from a classified network to an unclassified one is a cross-domain transfer through your organization's approved process. It is outside this product, as MUS 2 states. The extension can export a sealed publication bundle for that process and can import one, but it never bridges networks itself.

**Aggregated view label: state machine.**

| From | To | Trigger |
|---|---|---|
| (computing) | labelled L | Join of items plus rules evaluated, L within the viewer's clearance |
| (computing) | above viewer | L exceeds the viewer's clearance: Rule 4 options shown, nothing rendered |
| labelled L | labelled L' (L' at least L) | New publications or a new rule raise it, and the view re-renders with the new label |
| labelled L | labelled lower | Only when the items that raised it are withdrawn or a rule is removed by a signed policy change; never by a viewer |
| any | export | The export product carries L and goes through the portfolio's release guard |

**Publication: state machine** (on the node side, then the portfolio side).

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | draft | Agent or person drafts in the node's cell | Agent or person |
| draft | guarded | Release guard CLEARED (or HOLD, back to draft) | Guard |
| guarded | released | Publisher person releases; sealed to the intake key | Publisher |
| released | received | Portfolio fold verifies signature, attestation, sequence and label | Portfolio fold |
| received | refused | Bad attestation, label below what the agreement's cell requires, or sequence replay | Portfolio fold |
| received | superseded | A newer publication of the same item id | Node |
| received | withdrawn | Node publishes a withdrawal (kept in history, shown as withdrawn) | Publisher |
| received | stale | Cadence passes with no newer publication (display state) | Portfolio fold |

**Publication agreement.** offered, then active once both sides have signed, then ended by either side. Staged intake rekey on ended.

**Scenario.** draft, then computed, then proposed (a version), then decided (approved, rejected or contested). Approved, then superseded by a later approved scenario.

### 6.11 Federation: one hub first

| Capability | One hub (Phases 32 to 35, then 38 to 40) | Needs L5 federation and Phase 71 |
|---|---|---|
| Units, programmes and projects in one portfolio | Yes, within one hub's capacity (about 10 projects, 150 people) and one organization's policy | Many hubs and sites; hundreds of projects |
| Live publications | Yes: intake streams on the hub, ciphertext only | Hub-to-hub relay of sealed envelopes, with checkpoints naming their signer (MUS 4.6) |
| Publications across an air gap | Yes from Phase 34: sealed bundle files carry publications, which are self-contained | Automatic when links return |
| Publisher identity | Roster attestations by the node's lead, declared clearances, and the self-declared sentences on every screen | Verifiable credentials for positions and clearances, revocation through status lists, maximum offline age per level |
| Cross-organization portfolios (for example a defence portfolio with a partner department) | Only by file exchange of sealed publications, with keys pinned manually in the agreement | Organization DIDs anchored (L4), issuer delegation for a second site (L5) |
| Real data | No: fictional data until verified identities and an accredited host (CAP owner decision 2) | Yes, after Phase 71, the Stage 1 gate and accreditation |

Because publications are self-contained (signed, sealed, labelled, sequenced), federation only changes the transport and trust anchors, never the format. The L5 outline gets a line for this.

---

## 7. How it fits existing phases

| Phase or design | Relation |
|---|---|
| 30 replica core | Reused unchanged: entries, fold, digest, decisions, contested state |
| 31 roster | Positions, postings, delegations and staged rekeys are new roster kinds on `ROSTER_KIND_OWNER`. Self-report is a narrow writer rule. The personnel cell is an ordinary cell |
| 32 hub | Append checks extended to delegate scope and self-report. Intake streams for publications. No new service |
| 32.1 guided setup | Mode table, `organization` policy key, `term()`, and the mode suggestion (ORG-01 to ORG-04) |
| 33 live staff | Adds the generic `roster.require` feature check (POST-01), so older clients fail safe before positions ship |
| 33.1 (new) | Assigned positions and handover |
| 34 offline | Bundle files carry publications between hubs before L5 |
| 35 watches | A hub watch may draft a stale-publication reminder. Never a release |
| Capital pack (not yet on the roadmap) | Supplies gates, the path calculator, calculator records and the portfolio office template. The portfolio works without it (staff and plain projects publish status, risks, demand), and it adds gate and spend detail |
| 70 gate | Labels, joins and routing reused. Aggregation raises the route label |
| 71 identities | Verified publishers, positions and clearances. Delegation that only narrows becomes credentials |
| 74.1, 36, 37 | Model passports and vault ceilings apply at the view's label |
| 93 classification | Shares the aggregation rule evaluator built in Phase 38. Phase 93 extends it to indexes, exports and datasets |
| 97 analytics and views | Becomes the rendering and ad-hoc analysis layer over the publication fold |
| 100 easy sources | Financial, procurement and schedule feeds into project publications (CAP 9). Optional OpenProject exchange |
| L2 Team Mode | Corporate-mode invitation stays the Team Mode flow |
| L5 federation | Cross-hub publication relay and checkpoints |

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A handover leaves two people with authority, or none | High | Authority switches at one roster entry in the fold. Property tests over random orders and offline splits. A position is vacant only by a signed act |
| Keys lag the authority switch | High | Staged rekey activates at the report. Stale staging is refused and restaged. Writers hold writes to an affected cell until the staged epoch is folded |
| Older clients ignore a relief | High | `roster.require` in Phase 33, failing closed |
| More roster writers mean more splits | Medium | Hub serialization online. Self-report commutes offline. Delegates are scoped |
| Report-unable reasons leak | Medium | Personnel cell only. Never shown to other members or the portfolio |
| Mode words diverge from behaviour | Medium | One table. Lint for spelled words. The fold enforces `mayDecline` |
| Aggregation rules over- or under-classify | High | Rules are policy data a security officer sets. "Why this label" on every view. Defaults ship conservative and are adjustable with simulation (DP decision 13). Some scales add safeguards rather than raise |
| Difference attacks across clearances | High | Lower views only from lower items (Rule 5). No automatic counts. Two-compartment indistinguishability test on every view |
| Portfolio office becomes a super-reader | High | Intake keys only. No unit cells. The portfolio project's own roster and clearances decide who in the office reads which intake cell |
| Score gaming and false precision | Medium | Evidence required. Independent scorers and spread. Sensitivity bands. Self-assessed and portfolio-assessed scores kept apart. Frontier rather than rank alone |
| Stale publications drive decisions | Medium | As-of age on every view. Stale state. Scenarios pinned to publication heads |
| Hub capacity limits a real portfolio | Medium | Pilot on one hub. Bundles between hubs from Phase 34. L5 for scale |
| Cross-network pressure ("just show the Secret projects on the unclassified screen") | High | Rule 7: out of scope. Sanitized publications through your organization's cross-domain process only |
| By-name personnel data reaching the portfolio | High | Supply is counts only. The guard holds personal data in publications |

---

## 9. Decisions, with defaults

**Decided (owner, 2026-11-20):** all twelve, as recommended (the bold default in each row).

| # | Decision | Options | Default (recommended) |
|---|---|---|---|
| D1 | Where assignment lands | (a) fold into Phase 33; (b) inserted Phase 33.1 right after; (c) later | **(b)**, with the `roster.require` check in Phase 33. Drop A is already large, and the check is the only piece that must be in the field first |
| D2 | Who may post by default | (a) lead only; (b) lead plus delegates; (c) any roster writer | **(b)**, as the owner proposed |
| D3 | Reading in before reporting | (a) allowed from enrolment; (b) enrol at report | **(a)**, with `enrolAtReport` as a policy setting |
| D4 | Overdue report reminder | Days after start | **2 days** |
| D5 | Default scorers per criterion | 1, 2 or 3 | **2**, with a reconciliation note when they differ by more than one anchor level |
| D6 | Publication route default | (a) direct from projects; (b) through the unit's office | **(b)**, which matches reporting lines. Direct is a per-agreement option |
| D7 | Existence-only counts for lower viewers | (a) never; (b) opt-in per scale, as person-made sanitized publications | **(b) off by default**, the data platform's decision 7 |
| D8 | Aggregation defaults for the portfolio | Thresholds | Ship the data platform's (100 distinct people, 500 items in one compartment raise one level), plus one portfolio rule: `capability` links with `supply` and `risk` across 3 or more units raise one level. All adjustable, all shown |
| D9 | Placement of the portfolio layer | (a) 0.4.x Phases 38 to 40 after drop B, fictional data; (b) its own milestone after v0.6.0; (c) wait for L5 | **(a)**. Reasoning in 10.1 |
| D10 | Frontier solver | (a) exact branch and bound with a time limit; (b) greedy benefit-to-cost; (c) an external solver | **(a)**, pure TypeScript, no dependency. (b) only as a labelled fallback |
| D11 | Military handover words | "Handover" for one position, "relief in place" for a team or watch, "transfer of authority" for command | **As listed**, checked against doctrine before shipping |
| D12 | Mode for projects without one | Corporate and software (today's behaviour) | **Keep**, so nothing changes for existing users |

---

## 10. Phase proposal

### 10.1 Placement and reasoning

- **Modes go in Phase 32.1** (ORG-01 to ORG-04). The guide already asks the role and reads the bundle. The mode table is pure data plus a policy key, so it adds little to 32.1 and gives Phase 33.1 its words.
- **Assigned positions get an inserted Phase 33.1**, after drop A (Phase 33) and before drop B (Phase 34) (POST-01 to POST-08). It needs the live roster host flows and the hub's append checks from 31 to 33, and changes only roster kinds, the hub's append checks and the Staff Room. POST-01 (the feature check) is planned into Phase 33 so it ships with drop A.
- **The portfolio layer goes in Phases 38 to 40 in the 0.4.x line, after drop B**, on fictional data and one hub (PORT-01 to PORT-12).
  - It needs only the replica layer, the hub, positions (for supply), modes and the Phase 70 gate, all of which exist by then.
  - Waiting for v0.6.0 would delay the demo audience's first look by a whole milestone, when nothing in it reads real data.
  - Building the aggregation evaluator here first gives Phase 93 a tested module rather than a second one.
  - The capital pack is not required, which keeps the portfolio from waiting on an unscheduled pack. When the pack lands, its gate and spend publications plug in.
- **Later stages are lines in existing milestones, not new phases:**
  - v0.6.0 Phase 97 (views over the publication fold);
  - Phase 100 (financial, procurement and schedule feeds into publications);
  - Phase 71 (verified publishers and positions);
  - L5 (cross-hub relay).
  Real data waits for Phase 71, the Stage 1 gate and an accredited host.

Order and parallel work:
- ORG work in 32.1 runs beside 32.1's other work after its contract.
- 33.1 follows 33.
- Phase 38 needs 33.1's supply fold only for its `supply` item, so its other packages can start in parallel with 34 and 35 in their own worktrees. Its integration waits for drop B because the hub intake streams sit beside drop B's hub changes.
- Phases 39 and 40 depend on 38's publication contract and can then run in parallel with each other.

The sequential links are the publication contract (38) and the roster feature check (33).

### 10.2 Phase 33.1: Assigned positions and handover (INSERTED)

**Goal:** In military, public service and capital projects work, people are posted to positions that outlive them by someone with the authority to do so. They cannot decline, only report for duty or report unable, and a handover passes a position's authority and keys from one holder to the next at a single point, never leaving it empty or held by two.

**Depends on:** Phase 33 (live roster, hub append checks, POST-01). Phase 32.1 (mode table and `term()`).

| Id | Requirement |
|---|---|
| POST-01 | `roster.require` feature check: a client that lacks a required feature refuses to fold the project with the update sentence (lands in Phase 33) |
| POST-02 | Positions as roster objects with title, section, shift, decision roles, required clearance, cells, acting and dual-hat flags; history answers who held what when |
| POST-03 | Signed authority to post: held by the lead, delegated with scope, kinds and expiry, only narrowing; every posting records who ordered it, under whose authority, and when |
| POST-04 | Posting machine (3.8): ordered, device proven, unable reported, decided (confirm, defer, reassign), in effect, overdue, away, relieved, cancelled; no decline path in assignment modes, enforced by the fold |
| POST-05 | Device proof by safety code as key delivery, with the "not consent" sentence; expired secrets never cancel a posting |
| POST-06 | Atomic handover: authority switches at the incoming's report entry; staged rekey activates at the same point; stale staging refused and restaged; writes held until the staged epoch is folded |
| POST-07 | Acting, temporary and dual-hatted postings with the single-authority invariant and separation-of-duty checks |
| POST-08 | Personnel cell for report-unable reasons and order references; migration from seats with parity; Staff Room screens in the mode's words |

**Success criteria:**
1. A J1 delegate posts a person to "Watch Officer, night" from 1 December. The person proves their computer by safety code, sees no Decline, and reports for duty on 1 December. The roster shows the posting with the J1 as orderer and the lead's delegation as authority. (POST-02, POST-03, POST-04, POST-05)
2. A person reports unable with "conflicting tasking". Only the tasker sees the reason. Confirm, Defer and Reassign each lead to their state, and an unanswered posting becomes overdue after 2 days with the tasker's actions. (POST-04, POST-08)
3. In a handover, the outgoing holder's decision signed one entry after the incoming's report is refused. The incoming can read new entries in the position's cells and the outgoing cannot. A membership change between order and report forces a restage. All of this holds in random fold orders and in an offline split resolved by `roster.choose`. (POST-06)
4. An acting posting moves decision roles to the acting holder and back on return. A dual-hatted person cannot approve a product they own. A client without the positions feature refuses the project with the update sentence. (POST-01, POST-07)
5. An existing multi-user project switched to Military mode gives the same decisions and grants before and after migration, and an invitation-mode project is unchanged. (POST-08)

### 10.3 Modes in Phase 32.1 (added requirements)

| Id | Requirement |
|---|---|
| ORG-01 | One pure mode table (`src/domain/org/modes.ts`): four modes, concept-key vocabulary and behaviour settings (5.2, 5.3), with sources per military and public service term |
| ORG-02 | The `organization` policy key (mode, allowed modes, project may choose, tightening-only settings) parsed with strict key checks; genesis mode; `project.mode` change rules (5.7) |
| ORG-03 | `term()` used by every joining and organization string, with a lint test that fails on spelled words |
| ORG-04 | The guide suggests a mode from Q1 on the check-answers page, shows "Set by your organization" when fixed, and records the choice |

**Added success criterion for 32.1:** A staff officer's setup suggests Military mode and the Staff Room then says "Post a person"; a policy fixing Public service shows the mode as set by your organization; a software project keeps "Invite", unchanged. (ORG-01 to ORG-04)

### 10.4 Phases 38 to 40: the portfolio view (one hub, fictional data)

**Phase 38: Organization tree, publications and label-safe roll-up.**
Goal: units of different modes agree to report to a portfolio and release signed, labelled publications into write-only intake cells. The portfolio folds them into views whose label covers the whole, under signed aggregation rules.
Depends on: drop B (Phases 34 and 35, for hub intake streams beside its hub changes and bundle transport), Phase 33.1 (supply), Phase 32.1 (modes).

| Id | Requirement |
|---|---|
| PORT-01 | Portfolio project and signed organization tree (portfolio, unit, programme, project) with opaque node ids and each node's mode |
| PORT-02 | Publication agreements (offer and acceptance, publishers, cadence, route, item types, intake cells) and their state machine |
| PORT-03 | Write-only intake keys per cell and epoch; publications sealed to them; roster attestations; per-publisher sequence and withholding detection |
| PORT-04 | Publication item schemas (6.4) by concept key, released by a person through the release guard with label and compilation checks; downward publications |
| PORT-05 | One aggregation rule evaluator shared with the data platform: join plus signed rules (raise, compartment, handling, safeguards-only), "Why this label", remedy order |
| PORT-06 | Reader-relative views: only held cells, the fixed sentence, Rule 4 degradation, Rule 5 (no lower view from higher items), opt-in sanitized count publications; two-compartment indistinguishability test on every view |

Success criteria:
1. A Military-mode unit and a Public service unit each publish status, risks and supply counts. Neither can read the other's publications or the portfolio's, as proven by byte capture on the hub. (PORT-01 to PORT-03)
2. 600 Protected B supply and capability items across three units raise the combined view to the next level under the default rule. A Protected B viewer is offered only narrowed, suppressed or coarsened views, each labelled, and "Why this label" names the rule. (PORT-05, PORT-06)
3. A viewer below a unit's label sees identical screens whether or not that unit exists. A missing publication shows as withheld to cleared viewers only. (PORT-03, PORT-06)
4. Publications move between two hubs by sealed bundle file and fold to the same digest. (PORT-03)

**Phase 39: Portfolio Room, prioritization and scenarios.**
Goal: the portfolio office sets weighted criteria, people score with agent-drafted evidence, and scenarios with the efficient frontier are compared and decided by named people.
Depends on: Phase 38.

| Id | Requirement |
|---|---|
| PORT-07 | Portfolio Room views (6.5) built from Staff Room components, each labelled, with as-of age and the terms crosswalk |
| PORT-08 | Criteria sets with anchors, weights and lint; agent-drafted scores with evidence citations; independent signed scorers and reconciliation |
| PORT-09 | Pure scoring, sensitivity and constrained frontier (branch and bound with a time limit); scenarios pinned to publication heads; decisions through the version and decision algebra, including contested |

Success criteria:
1. A criteria set whose weights sum to 90, or that has a criterion without anchors, is held. An agent score without a `pub:` citation is refused. Two scorers differing by two anchor levels require a reconciliation note. (PORT-08)
2. The frontier for a fictional 120-project portfolio under per-year budget, per-skill capacity, mandatory and dependency constraints matches a brute-force reference on small cases. On the full set it either completes or says "best found, not proven optimal". (PORT-09)
3. Two board members deciding one scenario version differently at the same time make it contested. The approved scenario produces downward priority publications released by a person. Agents can reach none of these acts. (PORT-07, PORT-09)

**Phase 40: Capacity, allocation, dependencies and gates.**
Goal: demand and supply across units are matched by skill, clearance and period; reallocations become taskings that each unit fills in its own mode; cross-unit dependencies and gate calendars show what will slip.
Depends on: Phase 38 (and 39 for decisions).

| Id | Requirement |
|---|---|
| PORT-10 | Capacity view and clearance-aware matching; agent-drafted reallocations decided by a person and sent as allocation publications; units fill them through postings |
| PORT-11 | Cross-unit dependency graph labelled at the join of both ends, with lateness propagation that never reveals a hidden upstream item |
| PORT-12 | Gate calendar and the complexity-against-capacity-class flag from profile slots (capital pack when present, a neutral default otherwise); a results-framework link and report drafts |

Success criteria:
1. A Secret demand is never matched by Protected B supply. An approved reallocation reaches unit X as a tasking, X's tasker posts two people, and the next supply publication shows the change. (PORT-10)
2. A viewer who cannot see an upstream milestone sees their own item at risk only through its own published forecast, with no hint of the edge. (PORT-11)
3. A fictional project rated above its unit's capacity class is flagged for higher approval from profile thresholds, with no threshold in code. (PORT-12)

**Later (lines added to existing entries):**
- Phase 97: views over the publication fold.
- Phase 100: feeds into publications.
- Phase 71: verified publishers and positions.
- L5: hub-to-hub publication relay and cross-organization portfolios.

---

## 11. Sources

Standards and practice:
- PMI, The Standard for Portfolio Management, 4th ed.: https://www.pmi.org/standards/for-portfolio-management ; chapter 5 summary https://www.oreilly.com/library/view/the-standard-for/9781628253962/chapter05.xhtml
- PMI, The Standard for Program Management, 4th ed. and 5th ed.: https://oreilly.com/library/view/the-standard-for/9781628253931 ; https://oreilly.com/library/view/the-standard-for/9781628258158
- Axelos MoP: https://axelos.com/best-practice-solutions/mop ; https://www.axelos.com/resource-hub/blog/change-portfolio-management-with-mop
- Axelos MSP 5th ed.: https://axelos.com/resource-hub/blog/msp-5th-edition-what-has-changed ; https://goodelearning.com/msp-5th-edition-whats-changed-about-managing-successful-programmes/
- P3O hub and spoke: https://www.finance-ni.gov.uk/articles/role-portfolio-programme-and-project-office-p3o ; https://www.knowledgetrain.co.uk/project-management/pmo/p3o
- Gartner SPM (public abstracts): https://www.gartner.com/en/documents/5468395 ; https://www.gartner.com/en/documents/4990831

Government of Canada and DND/CAF:
- Directive on the Management of Projects and Programmes: https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32594
- Policy on the Planning and Management of Investments: https://tbs-sct.gc.ca/pol/doc-eng.aspx?id=32593
- PCRA guide: https://www.canada.ca/en/treasury-board-secretariat/services/information-technology-project-management/project-management/guide-using-project-complexity-risk-assessment-tool.html
- OPMCA guide: https://www.canada.ca/en/treasury-board-secretariat/services/information-technology-project-management/project-management/guide-using-organizational-project-management-capacity-assessment-tool.html
- Policy on Results: https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=31300 ; Departmental Plans: https://www.canada.ca/en/treasury-board-secretariat/services/planned-government-spending/reports-plans-priorities.html
- Defence Investment Plan 2018: https://www.canada.ca/en/department-national-defence/corporate/reports-publications/defence-investment-plan-2018.html
- Audit of Defence Project Management (2022): https://www.canada.ca/en/department-national-defence/corporate/reports-publications/audit-evaluation/audit-defence-project-management.html
- Independent Review Panel for Defence Acquisition: https://www.canada.ca/en/independent-review-panel-defence-acquisition/corporate/mandate/terms-reference.html

Open-source tools (read only):
- OpenProject: https://github.com/opf/openproject ; https://www.openproject.org/docs/user-guide/portfolios/ ; https://www.openproject.org/blog/pm2-hackathon ; https://osv.dev/vulnerability/CVE-2026-52779
- Leantime: https://github.com/Leantime/leantime
- Odoo licences: https://www.odoo.com/documentation/master/legal/licenses.html
- Taiga: https://github.com/taigaio/taiga-back
- Redmine plugins: https://www.redmine.org/plugins/redmine_pulse
- Tuleap programme management: https://docs.tuleap.org/user-guide/program-management.html

Prioritization:
- Efficient frontier: https://www.pmi.org/learning/library/improving-project-success-efficient-frontier-technique-7576 ; https://blog.planview.com/se/efficient-frontiers-and-productivity-rankings-in-project-prioritization/
- AHP and rank reversal: https://www.pmi.org/learning/library/analytic-hierarchy-process-prioritize-projects-6608 ; https://eprints.whiterose.ac.uk/167778/3/ishizaka_4_revSS.pdf
- WSJF: https://framework.scaledagile.com/wsjf
- Scoring practice: https://www.smartsheet.com/content/project-scoring

Aggregation and compilation:
- Treasury Board, Directive on Security Management (security categorization appendix): https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32614
- Treasury Board, personal information in the aggregate (2023): https://www.canada.ca/en/government/system/digital-government/policies-standards/spin/security-policy-implementation-notice-direction-security-categorization-personal-information-aggregate.html
- DND, working with sensitive information (2020): https://www.canada.ca/en/department-national-defence/maple-leaf/defence/2020/12/working-with-sensitive-information.html
- E.O. 13526, section 1.7(e): https://www.archives.gov/isoo/policy-documents/cnsi-eo.html ; critique https://fas.org/publication/compilation/
- Denning et al., Views for Multilevel Database Security (1987): https://faculty.nps.edu/dedennin/publications/ViewsMultilevelDatabaseSecurity.pdf
