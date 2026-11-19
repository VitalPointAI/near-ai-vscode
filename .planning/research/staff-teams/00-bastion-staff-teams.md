# Bastion staff teams: what exists, and what the extension can reuse

Research note for shipping military staff team templates in the NEAR AI VS Code extension. Priority order from the owner: J2, then J5, J3 and J4, because these teams carry the product demos.

Source: the private repository VitalPointAI/Bastion (default branch `master`, last push 2026-04-13), read through the GitHub API only. Nothing was cloned or run. Bastion file paths are quoted as they appear in that repository. Where something is no longer on `master`, the commit it was read from is given.

## Key points first

1. **Bastion has one complete, doctrinal staff agent library, but it was deleted.** Phase 16 produced 107 single-purpose agents across all 31 staff positions (`backend/src/exercise/agent-library.ts`). Phase 51 removed it (commit `70c0c9d0`, "remove staff officer agents"), replaced the idea of named staff officers with one Ironclaw "chief of staff" agent, and dropped the tables (`backend/src/db/migrations/037-remove-staff-officers.sql`). The library is still readable at the parent commit `1e054404`. It is the best raw material for our templates.
2. **The library was never proven in execution.** Each agent's `tools` list was a set of labels that the runner never bound to callable tools: each agent ran as one LLM call with its prompt hint and focus line (`backend/src/exercise/ai-role-graph.ts`). Since Phase 51 the runner loads an empty team (`const agentTeam: StaffAgentDef[] = [];`), so the AI-assigned staff workspace now runs with no agents. Treat the library as a design, not as tested behaviour.
3. **The role and product model is alive and reusable:** 31 positions, presets, a product registry with structured fields per product (`backend/src/exercise/types.ts`), the 7-step JPP with primary and supporting roles per step (`backend/src/jpp/types.ts`), and per-role validation fixtures with authority-boundary tests (`backend/src/validation/fixtures/*.json`).
4. **There is no "agent to agent exchange" for partner MCP tooling in Bastion.** No A2A code, design or plan exists. The nearest pieces are: an internal AI-to-AI coordination log (Phase 16, never wired to a callable tool), a DID-authorised MCP server (Phase 52 and 60), classification-gated cross-workspace subscriptions (Phase 20), and two deferred ideas ("MCP server federation across multiple BASTION deployments", "skill marketplace") in Phase 52. Coalition federation (Phase 12) is unplanned. If the owner remembers such a design, it lives somewhere other than this repository.
5. **Doctrine is inconsistent across Bastion's layers** (three naming schemes for the same sections, J5 and J35 swapped between the role model and the JPP model, Army tactical terms in joint products). The templates should fix these rather than copy them. Details in section 6.

## 1. How Bastion models sections, roles, workspaces, products and planning steps

### Staff sections and roles (Phase 15)

Source: `.planning/phases/15-jpp-staff-organization-workspaces/15-CONTEXT.md`, `backend/src/exercise/types.ts` (`STAFF_ROLE_CONFIG`, `STAFF_PRESET_TEMPLATES`, `PRODUCT_TYPE_REGISTRY`).

- **Roles are data, not code.** `STAFF_ROLE_CONFIG` holds 31 entries, each with `key`, `label`, `category`, `doctrinalFocus`, `defaultProducts` and an optional `agentTeamId`. Adding a role is a configuration change.
- **Six categories:** Command (commander, dcom), J-Staff (cos, j1, j2, j3, j35, j4, j5, j6, j7, j8, j9), Special Staff (sja, polad, pao, surgeon), Supporting Elements (cyber, space, transcom, socom, io, fires, ew), Component Commands (jfacc, jflcc, jfmcc, jfsocc), Additional Elements (engineer, cbrn, knowledge_mgmt).
- **Presets:** `full_joint_staff` (31), `core_staff` (commander, cos, j1, j2, j3, j35, j4, j5, j6), `intel_focus` (commander, j2, j35, j3, jfacc, fires), plus custom selection. An exercise shows only the roles it enables.
- **Assignment per role (Phase 16):** each position is Human, AI or Disabled (`role_assignments` on the scenario). An AI role shows an agent roster card with a Begin button, then a product panel and a structured activity channel.

### Workspaces (Phases 15, 20, 23)

- Phase 15 workspaces were per-role views inside an exercise: a task-centred dashboard (outstanding actions, product status, activity). The commander's workspace doubles as the combined staff view.
- Phase 20 made the workspace (later renamed "problem set" in Phase 23) the top-level unit, with an Organization, Unit and Team hierarchy, a tab bar, role-gated tabs, downward data inheritance, and **classification-gated subscriptions** for sharing sideways between workspaces. A commander can delegate subscription approval to an AI agent that checks classification and national caveats and escalates when unsure. Escalated decisions become DAO proposals in the parent with autocratic (urgent) or democratic (standard) voting, and come back down as directives. Source: `.planning/phases/20-workspace-operational-panels-cross-workspace-intelligence-sharing/20-CONTEXT.md`.

### Products (Phase 15)

- **Hybrid template:** structured fields on top (they feed other products), free narrative below.
- **Lifecycle:** draft (private) then explicit publish. Only published versions are tracked. Publishing notifies every enabled role and highlights the most relevant ones. Linked products get a "source changed" badge; the owner reviews a diff and integrates or rejects.
- **AI review lifecycle (Phase 16):** run states `queued, running, paused, awaiting_review, complete, failed`. A reviewer has five actions: approve, edit then approve, request revision, edit then request revision, reject. Feedback is free text plus an annotated copy. Every draft version is kept. The graph caps revisions at 3 iterations.

The product registry entries for the four priority sections (`PRODUCT_TYPE_REGISTRY` in `backend/src/exercise/types.ts`):

| Section | Product key | Label | Structured fields |
|---|---|---|---|
| J2 | `ipb_assessment` | IPB Assessment | threatLevel (low, moderate, high, severe), areaOfOperations, namedAreasOfInterest |
| J2 | `threat_assessment` | Threat Assessment | threatActor, capabilitySummary, mostLikelyCOA, mostDangerousCOA |
| J2 | `oob` | Order of Battle | forceComposition (unit table), keyCapabilities, equipmentSummary |
| J2 | `intel_summary` | Intelligence Summary (INTSUM) | reportingPeriod, significantActivity, assessments |
| J2 | `pir` | Priority Intelligence Requirements | requirements, collectionPlan |
| J5 | `strategic_estimate` | Strategic Estimate (also polad) | situation, missionAnalysis, courses |
| J5 | `strategic_direction` | Strategic Direction (also commander) | nationalObjectives, militaryObjectives, constraints, restraints |
| J5 | `campaign_objectives` | Campaign Objectives | primaryObjective, secondaryObjectives, conditions |
| J5 | `strategic_guidance` | Strategic Guidance (also commander, dcom) | objectiveCount, objectives, priority |
| J3 | `sync_matrix` | Synchronization Matrix (also fires) | phases, tasks, resources |
| J3 | `coa_sketch` | COA Sketch | conceptOfOperation, mainEffort, supportingEfforts |
| J3 | `task_org` | Task Organization (also components, socom) | commandElement, attachments, detachments |
| J3 | `roe` | Rules of Engagement (also sja) | authorizedActions, restrictedActions, legalReview |
| J3 | `execute_order` | Execute Order (EXORD) | effectiveDateTime, tasks, coordinatingInstructions |
| J35 | `coa_development` | COA Development | coaNumber, coaName, conceptOfOperation, schemeOfManeuver |
| J35 | `coa_analysis` | COA Analysis (Wargame) | methodology, advantages, disadvantages, recommendation |
| J35 | `campaign_plan` | Campaign Plan | campaignObjective, phases, endState |
| J4 | `logistics_estimate` | Logistics Estimate (also transcom) | supplyStatus, sustainmentConcept, criticalShortfalls |
| J4 | `css_annex` | CSS Annex | cssOrganization, supplyClasses, maintenancePlan |
| J4 | `supply_plan` | Supply Plan | supplyClasses, distributionPlan, prepositioningRequirements |
| Many | `staff_estimate` | Staff Estimate | missionImpact, currentStatus, considerations, recommendation |

### Planning steps: JPP, MDMP, no OPP

- **JPP (Phase 33):** seven JP 5-0 steps in `backend/src/jpp/types.ts` (`JPP_STEPS`, `JPPStepConfig`): planning initiation, mission analysis, COA development, COA analysis (wargaming), COA comparison, COA approval, plan/order development. Plan approval is treated as a governance gate, not a step. Navigation is free; only formal product approval is gated. Each step has primary and supporting roles:

  | Step | Primary roles | Supporting roles | Step agent (Phase 33) |
  |---|---|---|---|
  | Planning initiation | chief_of_staff, j5_plans | j3_operations | Commander's staff officer |
  | Mission analysis | j2_intelligence, j5_plans | j3_operations, j4_logistics, j6_comms | Mission analysis officer (IPB plus tasks) |
  | COA development | j5_plans, j3_operations | j2_intelligence, j4_logistics, fires_coordinator | Plans officer |
  | COA analysis | j5_plans, red_team | j2_intelligence, j3_operations | Red team analyst |
  | COA comparison | j5_plans | chief_of_staff, j3_operations | Decision support analyst |
  | COA approval | commander | chief_of_staff, j5_plans | Briefing officer |
  | Plan/order development | j5_plans, j3_operations | j4_logistics, j6_comms, j1_personnel | Plans development officer |

  The step agents live in `backend/src/graph/agents/jpp-*-agent.ts`, with tools such as `get_jpp_instance`, `save_step_product`, `get_step_products`, `get_parent_jpp_products`, `query_objectives`, `search_entities`, `fetch_osint_feeds`, `get_loes_from_design`, `create_ewm_linkage`, `get_ewm_linkages`, `find_ewm_gaps` (`backend/src/graph/tools/jpp-tools.ts`). Inputs come from operational design (lines of effort, Phase 25); outputs are COAs and an annex-based OPLAN with ends, ways and means linkage. Parent problem set products flow into a child's step 1 as higher headquarters guidance.
- **MDMP (Phases 5.1, 34):** used for tactical echelons; the Plan tab picks JPP or MDMP by echelon.
- **OPP:** not present. The Canadian Operational Planning Process is not mentioned anywhere. `PROJECT.md` lists NATO COPD and coalition planning processes as future extensions only.

## 2. Roles and agents by section

Source of agent rows: `backend/src/exercise/agent-library.ts` at commit `1e054404` (deleted on `master`). Each agent had `name`, `rank`, `branch`, `specialty`, a one-sentence `focus`, `tools`, `personality` tokens and a `systemPromptHint` that states what it produces and what it does not produce ("Your output is X, not Y"). Design rules from `16-CONTEXT.md`: single responsibility, deterministic scope, no overlap within a team, a clear escalation path, and a persona consistent with function and rank. Persona names are fictional and are left out here; templates should not reuse them (section 6).

Tool labels used: `read_scenario_documents`, `read_shared_context`, `read_product_drafts`, `write_product_draft`, `write_shared_context`, `send_ai_to_ai_request`, `escalate_to_human`. Every agent has `write_product_draft`; the lead of each section also has `write_shared_context`.

### J2 Intelligence (4 agents; products: IPB assessment, threat assessment, OOB, INTSUM, PIR)

| Id | Rank | Specialty | Produces | Explicitly not | Extra tools |
|---|---|---|---|---|---|
| j2-001 (lead) | LTC | All-source analysis | IPB assessment: terrain, threat disposition, OAKOC conclusions across the area of operations | Collection tasking, targeting | write_shared_context |
| j2-002 | MAJ | Threat analysis | Threat assessment: most likely and most dangerous enemy COAs, with capability and intent analysis | Targeting recommendations | |
| j2-003 | CW3 | Order of battle | Enemy OOB: unit identifications, equipment, strength, disposition | COA or intent analysis | |
| j2-004 | CPT | Collection management | PIR list and collection plan: what is needed, from which sources, by when | Analysis of collected information | send_ai_to_ai_request |

Personalities: analytical, systematic, evidence-based, precise; objective, critical-thinking; meticulous, source-conscious; forward-looking, gap-focused.

Other live J2 material:
- COP intelligence overlay agent (`cop_j2_intel` in `backend/src/cop/agents/agent-definitions.ts`): threat assessment, enemy positions and NAIs for the map layer, tools `read_orders`, `query_raft_graph`, `generate_layer_spec`, `validate_cco`, `assess_threats`.
- Ironclaw skill pack "Intelligence Analysis (S2)" (`backend/src/ironclaw/skill-packs.ts`): IPB, threat assessment, collection management, adversary COA, NAI management, OSINT fusion; triggers such as "IPB", "collection plan", "ACOA", "intelligence estimate".
- Intelligence MCP tools (`backend/src/ironclaw/tool-bridge.ts`): `bastion_intel_get_intelligence_gaps`, `bastion_intel_get_priority_intel_requirements`, `bastion_intel_create_pir_from_assumption`, `bastion_intel_answer_pir`, `bastion_intel_derive_pirs_from_design`, `bastion_intel_create_pir_alert`, `bastion_intel_web_search`, `bastion_intel_detect_conflicts`, `bastion_intel_draft_situation_assessment`, plus knowledge graph search.
- Validation fixture `backend/src/validation/fixtures/j2.json`: IPB (terrain, weather, maritime; must use "IPB", "battlespace", "avenues of approach"; cite JP 2-0), threat analysis, an intelligence estimate in doctrinal format, and authority tests: J2 must not issue collection orders, must not make operational decisions from intelligence, must not reveal classified sources.

### J5 Strategic Plans (4 agents; products: strategic estimate, strategic direction, campaign objectives)

| Id | Rank | Specialty | Produces | Explicitly not | Extra tools |
|---|---|---|---|---|---|
| j5-001 (lead) | LTC | Strategic planning | Strategic estimate: operational environment, strategic objectives, military options at theatre level | Operational planning | write_shared_context |
| j5-002 | MAJ | Policy integration | Strategic direction aligning military objectives with national policy, theatre campaign objectives and alliance commitments | The strategic estimate | |
| j5-003 | MAJ | Campaign objectives | Primary and secondary objectives with measurable conditions of success | The strategic estimate | read_product_drafts |
| j5-004 | CPT | Partner nation assessment | Allied contributions, gaps and interoperability constraints for coalition operations | Policy or campaign objectives | send_ai_to_ai_request |

Validation fixture `backend/src/validation/fixtures/j5.json`: a strategic estimate (centres of gravity, decisive points, operational environment; cite JP 5-0), three COAs, a planning timeline, and authority tests: J5 must not bypass commander approval or make execution decisions. There is no J5 or S5 Ironclaw skill pack.

### J3 Operations (5 agents; products: sync matrix, COA sketch, task organization, ROE, EXORD)

| Id | Rank | Specialty | Produces | Explicitly not | Extra tools |
|---|---|---|---|---|---|
| j3-001 (lead) | LTC | Current operations | Synchronization matrix of tasks, forces and effects across time and space | COA development | write_shared_context |
| j3-002 | MAJ | COA development | COA sketch and brief: scheme of manoeuvre, main and supporting efforts, concept of operations | The commander's decision brief | read_product_drafts |
| j3-003 | MAJ | Task organization | Command and support relationships, attachments, detachments | The concept of operations | |
| j3-004 | CPT | Rules of engagement | ROE matrix of authorized and restricted actions | Legal interpretation (belongs to SJA) | send_ai_to_ai_request |
| j3-005 | CPT | Execute orders | EXORD with tasks, timelines, coordinating instructions | The decision itself | read_product_drafts |

### J35 Future Plans (5 agents; products: COA development, COA analysis, staff estimate, campaign plan)

| Id | Specialty | Produces |
|---|---|---|
| j35-001 (lead) | Campaign planning | Campaign plan: phased objectives, sequencing, phase transition conditions |
| j35-002 | COA analysis and wargaming | Structured wargame comparison with recommendation |
| j35-003 | COA development | Full COA packages for wargaming |
| j35-004 | Staff estimates integration | Consolidated estimate from all sections (has send_ai_to_ai_request) |
| j35-005 | Assumptions and constraints | Facts, assumptions and freedoms of action matrix |

### J4 Logistics (4 agents; products: logistics estimate, CSS annex, supply plan)

| Id | Rank | Specialty | Produces | Explicitly not | Extra tools |
|---|---|---|---|---|---|
| j4-001 (lead) | LTC | Sustainment planning | Logistics estimate: supply status, sustainment concept, critical shortfalls | Class supply tables | write_shared_context |
| j4-002 | MAJ | CSS planning | CSS annex: organization, supply class priorities, distribution architecture | The logistics estimate | |
| j4-003 | MAJ | Transportation | Supply distribution plan: class priorities, routes, resupply timelines | CSS organization | send_ai_to_ai_request |
| j4-004 | CPT | Maintenance | Equipment readiness rates and forward maintenance plan | Supply or transport plans | |

Live J4 material: the COP logistics overlay agent (`cop_j4_logistics`) and the "Logistics Support (S4)" skill pack (LOGSTAT, classes of supply, maintenance, shortfalls).

### The rest of the staff (summary)

Every other position has 3 to 4 agents built the same way: a lieutenant-colonel lead who writes the section's staff estimate and the shared context, plus specialists. Commander (intent; COA decision brief; WARNORD and OPORD approval or return), DCOM (guidance memos; battle rhythm; interagency liaison), CoS (staff estimate; coordination checklist; integrated timeline; COP summary), J1 (personnel estimate; casualty tracking; manning status), J6 (C2 architecture; communications plan; network topology), J7 (training estimate; exercise coordination; lessons learned), J8 (resource estimate; budget analysis; cost per COA), J9 (civil considerations; interagency plan; host nation support), SJA (LOAC legal review; ROE legal sufficiency; SOFA analysis), POLAD (political-military assessment; strategic estimate input; alliance cohesion), PAO (communication strategy; media operations; public affairs estimate), Surgeon (medical readiness; CASEVAC; preventive medicine), Cyber (estimate; defensive plan; offensive options; threat actors), Space (estimate; space support plan; counter-space threats), TRANSCOM (lift estimate; airlift; sealift), SOCOM (SOF estimate; task organization; unconventional warfare; special reconnaissance), IO (estimate; MILDEC concept; PSYOP assessment), Fires (estimate; joint target list; fire support sync matrix; air defence), EW (estimate; electronic attack; electronic protection), JFACC, JFLCC, JFMCC, JFSOCC (estimate, scheme or ATO structure, task organization, one specialist each), Engineer (estimate; obstacle plan; infrastructure), CBRN (estimate; contamination control; hazard prediction), Knowledge management (KM plan; COP management; information management). There are validation fixtures for every one of these roles, plus four non-staff agents (deception planner, de-escalation manager, exploitation analyst, and others).

Separate agent sets still on `master`: the seven JPP step agents (above), the COP layer team (a coordinator plus six layer sub-agents led by warfighting function: J3 force disposition, J35 objectives, J3 control measures, J2 intelligence, J4 logistics, C2), and analytical agents such as adversary modeler, escalation modeler, deception detector (seeded inactive in `backend/src/agents/langgraph/agent-seeder.ts`).

## 3. Skills, tools and MCP servers

- **Bastion MCP server** (Phase 52, extended in Phase 60): `backend/src/mcp/mcp-server.ts`, `mcp-router.ts`, `index.ts`. Its own container (`bastion-mcp`), built on `@modelcontextprotocol/sdk` with the low-level Server API, SSE transport (`GET /mcp/sse`, `POST /mcp/messages`, `GET /mcp/health`), moved to port 4000 to match the blueprint convention `http://bastion:4000/mcp` (`.planning/STATE.md`). It exposes one consolidated tool, `bastion`, with `category.action` routing across design, intel, graph, brain, ops, admin and staff (`backend/src/mcp/consolidated-tools.ts`), because 80+ separate tools overwhelmed a small model's tool selection. Underneath are tool groups for knowledge, operations, calendar, resources, personnel and intelligence (`backend/src/mcp/tools/*.ts`).
- **Authorization:** callers identify with an agent DID, and per-tool checks against verifiable-credential claims (clearance level, staff section) were planned but not finished. Security details of that private codebase are deliberately left out of this note.
- **Skills registry** (Phase 52-02): `skills` and `agent_skill_assignments` tables (`backend/src/db/migrations/038-skills.sql`), `backend/src/agents/skill-store.ts`, `skill-registry.ts`, admin UI. A skill composes tools, prompts and validation, with Zod input and output schemas (`backend/src/agents/standard-agent.ts`).
- **Ironclaw skill packs** (Phase 60): seven role packs rendered as SKILL.md with frontmatter (`name`, `skill_id`, `staff_sections`, `triggers`, `required_tools`, `trust`): S2 intelligence, S3 operations planning, S4 logistics, S1 personnel, S6 communications and cyber, S9 civil affairs, commander and XO. No S5 or J5 pack.
- **Markdown skills** for design, navigation, symbology and tactical robot tasks (`backend/src/skills/**/*.md`): not staff skills.
- **Ironclaw builder actions** (Phase 52-03): approved action cards can create, update and delete agents, tools, teams and skills, each with a risk level (`backend/src/ironclaw/builder-handlers.ts`, `ironclaw-types.ts`). Sensitive field writes (mission statement, ROE) are high risk and need explicit approval.
- **Orchestration loop** (Phase 52-05): an 11-state task machine (`backend/src/ironclaw/task-types.ts`, `task-orchestrator.ts`) with role-based field permissions (`ROLE_FIELD_PERMISSIONS`), suggestions presented as "apply to field" cards, refine loops, and stale-task recovery on start.

## 4. "Agent to agent exchange" for partner MCP tooling

Not found. What exists, and its status:

| Piece | Where | Protocol | Status |
|---|---|---|---|
| AI-to-AI coordination between staff roles in one exercise | `.planning/phases/16-ai-assigned-staff-workspaces/16-CONTEXT.md`; `backend/src/exercise/ai-coordination-store.ts`, `ai-context-store.ts` | Shared JSONB context per scenario and role with PostgreSQL `pg_notify('context:<scenario>')`; an audit table of who asked whom for what | Stores built. The `send_ai_to_ai_request` tool was a label only; no caller in the role graph; agents removed in Phase 51 |
| Agent messaging bus | `backend/src/agents/agent-messaging.ts`, `backend/src/messaging/*` | In-process message bus with ABAC classification filter; message types task, data request and response, coordination request and response, escalation | Internal only |
| Bastion MCP server for outside agents | `backend/src/mcp/*` | MCP over SSE, DID header, VC claim gating (stubbed) | Built; Ironclaw is the only real client |
| Cross-workspace sharing | Phase 20 | Subscriptions with approval, classification gates, cached copies with change notices | Partly built (several Phase 20 plans unchecked in the roadmap) |
| MCP federation between Bastion deployments; skill marketplace | `.planning/phases/52-agent-skills-mcp/52-CONTEXT.md`, "Deferred Ideas" | None | Deferred |
| Coalition identity federation, information sharing rules | `.planning/ROADMAP.md` Phase 12, `.planning/PROJECT.md` | None | Not planned (TBD) |
| A2A protocol | `.planning/phases/4.2-ai-agent-teams/4.2-RESEARCH.md` | Listed as an emerging Google and Microsoft protocol to consider; open question on classification downgrade during agent handoffs | Research mention only |

The 105 Markdown and text files under `docs/` mention agent-to-agent interaction only as a security and testing concern (`docs/whitepaper/05-discussion.md`).

So a partner tool exchange would be new work. Bastion contributes two useful ideas: identity by agent DID with per-tool claim checks, and a filter step before every cross-classification handoff.

## 5. What the extension can reuse

The extension builds a team as a Markdown file: frontmatter `name`, `description`, optional `privacy`; then one `## member` section each with optional `role`, `model` (a NEAR model id or deep, standard, fast), `tools`, `reports-to`, `privacy`, then instructions (`src/agent/teams.ts`). Limits: at most 12 members, member names are lowercase slugs of up to 40 characters, instructions over 1,200 words draw a warning, and every member should say what it hands back (`src/agent/teamCheck.ts`). Members may hold `mcp__server__tool` tools. Project types in `src/agent/projectTypes.ts` pair a team with AGENTS.md guidance (the research type is the closest model: one input, one job, one output file and a definition of done per role, a fixed workflow order, a blocking checker, a release gate). New types need an entry in `teamTemplateHistory.ts` so Update Team can track versions.

### Reusable as-is (content, after renaming)

| Bastion asset | Use in the extension |
|---|---|
| Section rosters and each agent's focus and "output is X, not Y" boundary (deleted library, commit `1e054404`) | One member per agent. The boundary sentence goes straight into instructions. It matches the extension's "your area is ..." rule. |
| Section lead with `write_shared_context` | The member others `reports-to`; it merges the section's products and writes the section's staff estimate. |
| `PRODUCT_TYPE_REGISTRY` structured fields | The heading skeleton of each member's output file (for example `products/j2/threat-assessment.md` with Threat actor, Capability summary, Most likely COA, Most dangerous COA, then narrative). |
| Phase 15 draft and publish, Phase 16 five review actions | A status line per product (draft, published) and the reviewer's verdict mapped to the extension's existing SIGN-OFF or NOT READY lines. |
| Phase 16 "Waiting on [Role]: [what is needed]" and "continue on what does not depend on it" | Instruction text for every member, and the RFI pattern between teams. Fits the owner's parallel-by-default direction. |
| Phase 16 escalation path per agent | "Stop and report a decision for the commander" rule in each instruction. |
| `JPPStepConfig` primary and supporting roles | Project guidance: which section leads and which contributes at each JPP step, like `RESEARCH_WORKFLOW`. COA approval stays human. |
| Validation fixtures (`backend/src/validation/fixtures/j2.json`, `j5.json`, `j3.json`, `j4.json`) | Acceptance checks for each template: required sections, terms and doctrinal citations, and the authority-boundary tests as red-team prompts. |
| Ironclaw skill pack triggers | Keywords for the team recommender (`recommendAgentTeam`). |

### Tool mapping

| Bastion label | Extension tools |
|---|---|
| read_scenario_documents, read_product_drafts, read_shared_context | Read, Glob, Grep, Recall |
| write_product_draft | Write, Edit (own product file only) |
| write_shared_context | Write to a shared section file, plus Remember |
| send_ai_to_ai_request | No direct tool: a "Waiting on" line in the report that the lead routes; across teams an RFI file |
| escalate_to_human | Report a decision needed, never decide |
| OSINT, web search (J2, J5 partner assessment) | WebSearch, WebFetch, CheckCitations |
| Bastion MCP (`bastion` tool) | Optional `mcp__bastion__bastion` when a Bastion instance is connected; not in the default templates |

The research team's source grading (NATO Admiralty reliability A to F and credibility 1 to 6) is exactly the J2 convention and can be copied into the J2 analysts' instructions.

### Suggested template shapes (12-member limit)

- **J2 team (demo priority 1):** j2-lead (all-source, intelligence estimate and JIPOE synthesis, deep), jipoe-environment-analyst (operational environment and terrain, standard), threat-analyst (adversary capabilities, most likely and most dangerous COAs, deep), oob-analyst (standard), collection-manager (PIRs and collection plan, standard), intsum-writer (new: INTSUM has no agent in Bastion), plus the extension's source-verifier and red-team (adversary view). 8 members, `privacy: private` by default.
- **J5 team:** j5-lead (strategic estimate), policy-integration, campaign-objectives, partner-assessment, plus a JPP plans officer for COA development and plan development (Bastion gives these to J5 in JPP but to J35 in the role model), editor and red-team.
- **J3 team:** j3-lead (sync matrix), coa-developer, task-org officer, roe officer (with "legal review belongs to SJA"), orders writer (EXORD and OPORD), reviewer, red-team.
- **J4 team:** j4-lead (logistics estimate), css-planner, distribution planner, maintenance officer, plus a COA supportability analyst (new: J4's input to COA analysis), reviewer, red-team.
- A combined **planning cell** for demos (commander's guidance stays human): one or two members per section within the 12-member limit, following the JPP step table.

Member names should be role slugs, not persona names; the `role:` line carries the specialty.

## 6. Gaps and doctrinal issues

1. **Three naming schemes for the same sections.** The role model uses `j2`, `j5`; the JPP model uses `j2_intelligence`, `j5_plans`, `red_team`, `fires_coordinator`, `chief_of_staff`; the DID middleware and skill packs use battalion and brigade S-codes (`S2`, `S3`, `S4`, `XO`, `CSM`). J-codes are joint headquarters; S-codes are tactical. The templates should pick one scheme per echelon and say so.
2. **J5 and J35 swapped.** In the role model, COA development, COA analysis and the campaign plan belong to J35, and J5 does theatre strategy. In `JPPStepConfig`, J5 leads COA development, comparison and plan development, and J35 does not appear. In joint usage the J5 normally leads deliberate planning and the J35 handles future operations under the J3. The J5 fixture also tests COA development. Recommend: J5 owns JPP products, J35 is future operations (branches and sequels), J3 is current operations.
3. **Duplicate COA developers.** j3-002, j35-003 and the JPP plans officer all develop COAs; j35-002 and the JPP red team analyst both wargame. This breaks the library's own "no overlap" rule across sections.
4. **Products with no producer, producers with no product.** INTSUM is a J2 default product with no agent. The J2 fixture asks for an intelligence estimate, which is neither a product nor an agent. The J5 partner nation assessment and the J4 maintenance plan have agents but no product type. The J4 CSS annex and supply plan both contain a distribution plan.
5. **Army tactical terms in joint products.** The J2 lead's IPB uses OAKOC terrain analysis; at a joint headquarters the doctrinal frame is JIPOE (define the operational environment, describe its impact, evaluate the adversary, determine adversary COAs). Templates should use JIPOE for J2 at joint level and IPB with OAKOC only for tactical teams.
6. **Missing J2 functions:** indications and warning, a red cell that plays the adversary in wargaming, and intelligence support to targeting (targeting sits with Fires). Collection manager may "identify" and "request" but not task, which matches the fixture's authority test and should be kept.
7. **Missing J4 contribution to COA analysis** (logistics supportability of each COA) and to JRSOI (reception, staging, onward movement and integration).
8. **AI agents in command roles.** The library has commander agents that "select" a COA and approve orders. Bastion's own validation fixtures test that staff agents must not bypass commander approval. The extension should ship decision support only: the decision brief and the approval are human steps.
9. **US-only identity details.** US Army ranks and branch codes, and realistic names, in a joint and coalition product. For Canadian or NATO demos this reads wrong, and realistic persona names can be mistaken for real people. Use role slugs and drop ranks.
10. **No OPP or COPD.** If demos target Canadian or NATO audiences, the guidance needs an OPP mapping (from general knowledge of CFJP 5.0: initiation, orientation, COA development, plan development, plan review; verify against the publication before shipping) and a COPD mapping. Bastion lists COPD as future work only.
11. **Small defects to avoid copying:** the `core_staff` preset comment says 10 roles but lists 9; the J5 has no skill pack; Phase 16 rejected Ironclaw and later phases adopted it, so Bastion's planning documents disagree about the agent runtime.
12. **Classification.** Bastion's content is exercise and unclassified, but the domain invites sensitive material. Default every staff template to `privacy: private` (NEAR TEE or local model), as the research type does, and say in the guidance that classified material must not be loaded at all.

## Bastion files read

- `.planning/ROADMAP.md`, `.planning/PROJECT.md`, `.planning/STATE.md`
All CONTEXT, RESEARCH, PLAN and SUMMARY files of phases 15, 16, 20, 21 and 52 were downloaded. The CONTEXT and SUMMARY files were read in full; the RESEARCH and PLAN files were searched for roles, agents, tools, MCP, AI-to-AI and partner terms and read where they matched.

- `.planning/phases/15-jpp-staff-organization-workspaces/`
- `.planning/phases/16-ai-assigned-staff-workspaces/`
- `.planning/phases/20-workspace-operational-panels-cross-workspace-intelligence-sharing/`
- `.planning/phases/21-ai-cop-layer-agent-team/`
- `.planning/phases/52-agent-skills-mcp/`
- `.planning/phases/33-joint-planning-process-jpp-campaign-plan-framework-with-ends-ways-means-linkage/33-CONTEXT.md`, `.planning/phases/4.2-ai-agent-teams/4.2-RESEARCH.md`
- `backend/src/exercise/agent-library.ts` (at `1e054404`), `backend/src/exercise/types.ts`, `backend/src/exercise/ai-role-graph.ts`
- `backend/src/jpp/types.ts`, `backend/src/graph/agents/jpp-*-agent.ts`
- `backend/src/cop/agents/agent-definitions.ts`
- `backend/src/agents/*` (agent store, registry, messaging, standard agent, skill store and registry, seeder)
- `backend/src/mcp/*`, `backend/src/ironclaw/tool-bridge.ts`, `skill-packs.ts`, `builder-handlers.ts`, `task-*.ts`
- `backend/src/db/migrations/037-remove-staff-officers.sql`, `038-skills.sql`; `backend/database/016-staff-workspaces.sql`, `017-ai-staff-workspaces.sql`
- `backend/src/validation/fixtures/j2.json`, `j5.json`
- All Markdown and text under `docs/`, plus `.planning/ISSUES.md`, `.planning/codebase/INTEGRATIONS.md` and `CONCERNS.md` (searched for agent-to-agent, A2A, partner and federation)
- Not read in full: `backend/src/validation/fixtures/j3.json` and `j4.json` (they exist and follow the same format as J2 and J5)
