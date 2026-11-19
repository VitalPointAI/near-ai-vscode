# Research note 01: the Agent Exchange from ai-workbench, mapped onto the extension

Date: 2026-11-18. Scope: how agent teams, including the new military staff teams (J2, J5, J3, J4), could get partner MCP tools and other agents' skills through the "agent to agent exchange" described in the private repository VitalPointAI/ai-workbench, and what that means for this extension today.

Method: ai-workbench was read only through the GitHub API (`gh api .../contents/<path>` and the recursive tree). Nothing was cloned or run. Extension facts come from this repository at release 0.4.33 (Phase 70 merged through PR #95).

## Summary

- **ai-workbench is a specification, not code.** The repository holds a 1,270-line spec, a 20-phase roadmap for its first milestone (no phase started), research, reviews, source documents and 31 HTML mockups. There is no Exchange code, no A2A code and no payment code. The Exchange is planned for that project's Phase 1 (v0.2, February to June 2027) and Phase 2 (v0.3, to March 2028).
- **What the Exchange is:** a governed catalogue of approved partner services (agents, MCP tools and connectors). A cell's agent can find a service, check its signed identity card, agree a price inside a mandate a person signed, call it through the gateway with only the data the task needs, check the result, and have the call metered, recorded and billed. Whatever is bought becomes an asset of the organization and is reused before anything is bought again. Separately, sites share skills, team templates and connectors only as signed, scrubbed packages.
- **Protocols:** MCP for tools, A2A v1.0 for agent-to-agent tasks, mandates modelled on AP2, signed agent cards verified before every call, listing levels (Listed, Assessed, Accredited) tied to data labels, and three settlement lanes (consolidated invoice, committed budget, direct settlement with stablecoins only after legal review). NEAR Intents is named only as one candidate rail for direct settlement, with open questions.
- **The extension already has most of the local half:** an MCP client, capability manifests per MCP server with a restrictive default, per-member scoping (`mcp:<server>`), a signed local policy, labels with routing tiers, an outbound fingerprint check, results fenced as untrusted, and a recorded decision for every call. It has none of the market half: no catalogue, no partner identity beyond TLS, no signed cards, no mandates or spend caps per server, no destination label ceiling, no A2A, no settlement.
- **Where it should land:** identity, credentials and spend caps come from v0.7.0 Stage 1 (Phases 71, 73, 74 and 79). Skill and team sharing belongs in L3 (routines and signed packages), which already reserves a marketplace `listing` field. The catalogue, partner cards, mandates and A2A should be their own later milestone after L3 and alongside L4, not squeezed into v0.7.0.
- **Minimum for staff teams to use partner MCP tools safely now:** remote servers only, each with a person-written manifest that declares every tool, scoped to named members, never unattended, asking every call for anything that sends data, and a policy whose routing keeps any labelled level local-only so labelled chats cannot reach a partner at all. One small new control is worth adding before real use: a label ceiling per MCP server in the signed policy bundle.

## 1. What the exchange is

### Purpose

The ai-workbench spec (`SPEC.md`, opening summary and "Purpose and scope") describes the Workbench as the software layer of a sovereign AI offering for defence clients: build agentic staff cells, govern every agent under standing orders, route every request through a sovereign gateway, "and trade work agent to agent through the Agent Exchange." The source proposal (`docs/sources/text/Sterling_Sovereign_AI_Proposal_v0.9.txt`, section 12.5 "Sovereign Exchange") states the purpose: "A cell is limited to the skills and tools it is given." The Exchange widens that with a self-serve catalogue of approved partner AI services that people can select and agents can discover and call on their own, "including services that call each other", within limits the client set, "without a new procurement for each tool."

The proposal frames it as an intents model: the agent states the outcome it needs and its limits, and approved partners compete to fulfil it.

### Actors

From `SPEC.md` ("Users and roles", "Three kinds of agent", "Core entities") and the proposal:

| Actor | Role in the Exchange |
| --- | --- |
| Exchange partner (approved company) | Lists services, publishes signed agent cards, receives and fulfils tasks. Has no authority inside the client; its agents act only under a client mandate. Uses the Partner Portal, a separate web app. |
| Consumer agents | Cell leads and specialists (for example J2-AI, J4-AI), personal assistants, platform advisors. They search, check, agree and call within their grant and mandate. |
| Client administrator | Enables Exchange services for users and cells. |
| Branch head (or other signer) | Signs the mandate: purpose, approved sellers, markings, spend caps per task, per day and in total. |
| Risk owner | Raises a listing's level; delists (in an emergency the platform administrator may delist, recorded). |
| Capability Advisor (platform advisor) | Runs a buy-or-build analysis before new kinds of purchase, above a set value, or after a set number of repeat purchases (BB-01). |
| The platform operator | Certifies partner interfaces, runs the listing service, meters, invoices (never holds client funds). |

### Flows

**Publish.** Partners build an agent interface (an MCP server or an A2A agent), often with the platform's forward-deployed engineers, test it against a conformance suite in a sandbox tenant and certify it (EX-07, P2). The Partner Portal mockup (`mockups/screens/PartnerPortal.html`) shows a listing with an agent card (`lexica-translate v2.3`, "A2A v1.0 · MCP tool translate.passages", "hybrid quantum-safe seal", where it runs, what it handles), a conformance suite with checks for card signature, mandate and price limits, no-retention data handling, and prompt-injection probes ("1 of 30 failed · fix before v2.4"), usage and invoices. Listing levels gate where a service appears:

| Level | Where it can run | Requirements (proposed) |
| --- | --- | --- |
| Listed | Unclassified and Protected A; commercial clients | Partner agreement with flow-down terms; certified interface; declared data handling; security review |
| Assessed | Protected B | Plus residency and admin access in Canada, privacy and IT security assessment, CPCSC Level 1 where required |
| Accredited | Classified and disconnected | Deployed inside the client enclave with no outbound calls; SA&A; cleared staff; supply-chain review |

**Discover.** The catalogue is filtered by the environment's listing level and the data labels (EX-01). The Exchange mockup (`mockups/screens/Exchange.html`) shows "You can use services cleared to Listed and Assessed", cards with level, price, data terms ("keeps nothing · never trains on your data", "Canadian residency and admin · Protected B") and an "Enable for J4-AI" action.

**Invoke.** The seven-step flow (EX-03; proposal section 12.5), each step with a guard rail:

1. Need: the agent acts only for the purpose its mandate names.
2. Discover: listing levels and approved sellers only.
3. Check: read the signed agent card (identity, price, data handling, level); the gateway refuses unknown or unlisted services.
4. Agree: accept the listed price within the mandate's caps; over-cap or unusual requests go to a person.
5. Call: send only the passages the task needs, through the gateway; label checked, personal information redacted, residency enforced.
6. Deliver and verify: the result is checked against the request; low-confidence results go to a person.
7. Settle and record: metered, logged in Canada, billed under the client's settlement lane; any authority can be revoked at once.

Before step 2, EX-12 adds "buy once, use everywhere": the platform checks the knowledge base and an acquired-assets register for an equivalent result, licence or subscription the organization already holds, and reuses it if the terms and the requester's clearance allow. The Exchange mockup shows "Already held: 14 translations in the knowledge base" and "This month: 9 purchases avoided by reuse".

**Pay.** Mandates follow AP2 (the Agent Payments Protocol, an A2A extension). Settlement lanes (EX-05):

| Lane | How it settles | Status in the plan |
| --- | --- | --- |
| A. Consolidated invoice | Metered purchases roll up to one monthly invoice | Default from catalogue launch, all clients including defence |
| B. Committed budget | Client commits a budget; agents draw it down within mandates; invoiced in arrears, no prepayment held | With lane A (spec puts it in Phase 2) |
| C. Direct settlement | Client pays partner directly on a rail they agree, including stablecoins; the Exchange still enforces mandates and meters; the platform invoices the partner a disclosed fee | Fiat from launch; digital asset rails only after legal review |

The proposal lists NEAR Intents (with Confidential Intents), x402 and the Machine Payments Protocol as candidate rails for lane C, none selected, each to pass an independent security audit, the sovereignty standard, auditable confidentiality and stablecoins-only. Only settlement values and hashes may reach any external ledger (EX-06); what was bought, by which agent, under which mandate and label stays in the audit record in Canada.

**Rate.** There is no star rating or review flow. Quality is handled by: the conformance suite and listing levels (publish side), result verification and escalation of low-confidence results (step 6), the Capability Advisor's use history and the "honest ROI" rule (`docs/reviews/sawyer-ironclaw-review.md`, CAP-11), instant delisting with in-flight calls stopped (EX-08), and expiring sovereignty attestations that make a listing unreachable when they lapse (SOV-06, ACC-08).

### Skills and other agents' work

The Exchange covers buying services. Sharing skills between agents is a separate rule: EX-09 (P2) says that across tenants or sites, agents share only "deliberately published, signed, scrubbed packages (skills, cell templates, connectors, outcomes) with provenance and labels; no agent queries another tenant's knowledge base; a consultation is one scoped A2A request and one derived answer, recorded on both sides and routed to a person by default." EX-10 adds content hashing of every installed package, a recorded install trail so a malicious package can be revoked everywhere in one operation, and quarantine under the tightest lease until one clean run. Learned skills inside a site come from Skill Scout and Model Studio, not from the Exchange.

## 2. Protocol and technical design

All of this is design in `SPEC.md`, `.planning/REQUIREMENTS.md` and `.planning/research/FEATURES.md` of ai-workbench.

**Protocols.** "A2A v1.0 for agents, MCP for tools; AP2-style mandates for purchases" (`SPEC.md`, "Decisions at a glance"). EX-02: "Connect by MCP (tools) and A2A v1.0 (agents); every listing has a signed agent card verified before each call." The research file notes A2A v1.0 cards are JWS (RFC 7515) with JCS canonicalization, which conflicts with the spec's hybrid post-quantum signatures (ML-DSA-65 plus Ed25519), so interoperating with outside A2A agents needs a classical JWS beside the hybrid one (`.planning/research/FEATURES.md`, compatibility note for EX-02).

**How partner MCP servers are listed and reached.** An `exchange` service (TypeScript) holds the catalogue, an A2A broker, agent-card verification, mandates, metering, settlement adapters and the Partner Portal API (`SPEC.md`, "Packages"). Every call to a partner leaves through the gateway, which is the only egress beyond the site boundary and the only holder of outside credentials (GW-01; `AGENTS.md`: "the gateway is the only egress beyond the site boundary; the tool host is the only MCP host"). Inside the cell runtime, a ToolAdapter wraps each MCP server or connector "with the action class of each operation" (`SPEC.md`, "Extension points"). The Gateway mockup (`mockups/screens/Gateway.html`) shows partners as their own routing destination ("Exchange partners 2%", "14 refused: label or sovereignty rule") and a marking table: Unclassified and Protected A may go to partners; Protected B and above may not.

The inbound direction is separate: INT-02 is a governed MCP server through which approved outside agents use platform capabilities, with tools filtered by the caller's grant. The Integrations mockup (`mockups/screens/Integrations.html`) shows a translation partner registered as a system with an owner, ceiling ("Unclassified"), agreement and expiry, a six-step registration ("Purpose and owner; Data flows and labels; Sovereignty and export posture; Interconnection agreement; Risk owner approves; Credentials issued: its own identity, mutual TLS, sender-bound tokens") and a per-caller tool list ("translate.passages: read · Unclassified · 400 calls/day"; "knowledge.search: not in its grant").

**Identity and auth.** Every agent, including partner agents, is a governed entity acting under a grant a named person issued, narrowed at each hop, checked by a policy decision point it cannot reach. Identity is DIDs (`did:key`, `did:web`) and verifiable credentials; authority tokens are Biscuit caveats in a hybrid-signed envelope; policy is Cedar. The research flags an unresolved gap: outside MCP servers expect OAuth 2.1 tokens with RFC 8707 audience binding, while the platform's authority is Biscuit and DIDs, so a token exchange at the gateway or tool host "is not in SPEC.md, raise with owner" (`.planning/research/FEATURES.md`).

**Billing.** Metering per call, agent, cell, tier and client, including cancelled calls, reconciled against provider cost (GW-08, GW-16); mandates with caps; lanes A to C as above; the platform never holds or moves funds.

**Trust, attestation and sandboxing.** Signed agent cards verified before each call; listing levels; sovereignty attestations with evidence and expiry on every provider, model and listing, and anything without a matching attestation is unreachable (SOV-06); export-control posture per partner, so sending controlled data to a foreign-operated service is treated as an export and denied (XC-03); results marked untrusted and taint propagated (SO-10, SO-16); every action records its cause, including "an Exchange partner" (SO-18); Accredited partners run inside the enclave with no outbound calls; consumed packages run in quarantine (EX-10); the cell runtime runs in an OpenShell sandbox (`docs/architecture/nvidia-openshell.md`).

## 3. Built versus designed

| Item | State in ai-workbench |
| --- | --- |
| Exchange requirements (EX-01 to EX-12), flows 3 and 8, roles, approval matrix rows | Written (`SPEC.md`, `.planning/REQUIREMENTS.md`) |
| Exchange screen, Partner Portal, Integrations, Gateway, Buy-or-build | Static HTML mockups with sample data; "Partners are illustrative; none signed yet" |
| Exchange service, A2A broker, card verification, mandates, metering, settlement | Not built. Roadmap: EX-01 to 05, 08, 11, 12 in v0.2 (CANSEC demo, flow 3); EX-06, 07, 09, 10 in v0.3 |
| Any code at all | None. `.planning/STATE.md`: milestone v0.1, Phase 1 of 20 "Ready to plan", 0% |
| Settlement rails | Candidates only, none selected; legal review required for lane C |
| Proposal's own estimate | "Agent Exchange catalogue: Build; integrate partner rails, v1 Dec 2027" (`docs/sources/text/Agentic_Staff_Cells_GDG_Brief_v0.7.txt`) |

One review in ai-workbench also notes that a "Sovereign Exchange" claimed in an earlier project (Bastion) was "Not present in the repository" (`docs/reviews/bastion-trust-layer-review.md`). So no working exchange exists anywhere in these sources.

The ai-workbench spec planned to reuse this extension's MCP client, tool adapter and registry (`docs/reviews/near-ai-vscode-0.4.4-audit.md`, rows P1 to P3) and saw the extension's future as a thin client plus "Exchange partner tooling (sign agent cards, run the EX-07 suite against a test tenant)". Since then the direction reversed: the extension is the product, so the spec's design is a source of requirements, not a parallel build.

## 4. How it maps onto the extension today

Note on numbering: the brief mentions "v0.5.0 identities, credential broker and run contracts". In this repository v0.5.0 (knowledge base) is paused; identities, the credential broker and run contracts are Phases 71, 73 and 74 in **v0.7.0 Stage 1** (`.planning/ROADMAP.md`). The mapping below uses those numbers.

### What exists

| Exchange need | Extension today | Where |
| --- | --- | --- |
| Connect to partner tools by MCP | MCP client over stdio and Streamable HTTP with SSE fallback; up to 200 tools per server; client declares no capabilities, so no sampling or elicitation | `src/mcp/client.ts` |
| Per-tool action class | Capability manifest v1 per MCP server (`runsOn`, `hosts`, `credentials`, `contexts`, exact tool table, `toolDefaults`). New servers start `restrictive`: an undeclared tool is treated as shell anywhere, network anywhere, write and delete anything, interactive only. Words on the MCP page say the manifest is a claim the extension cannot check | `src/domain/gate/manifest.ts`, `src/domain/gate/words.ts`, `src/mcp/tools.ts` |
| Who may use a service | Per-project enablement; team members scoped with `mcp:<server>` in the team file | `src/services/mcpRegistry.ts`, `src/agent/teams.ts` |
| No unattended partner calls | Policy ceiling `unattendedMcp` is empty by default, so MCP tools are denied in runs nobody watches unless named | `src/domain/gate/bundle.ts`, `src/domain/gate/decide.ts` |
| Mandate signed by a person | A signed local policy bundle (device key), with a floor nothing overrides; but no purpose, seller list or spend caps per server | Phase 70 |
| Label checks before a call | Chat mark raised by what agents read; at a `local-only` or `deny` tier any call that may send off the machine is refused (`label.network-at-mark`); at `attested-cloud` a call is refused if its payload carries fingerprints of labelled text (`label.outbound-match`) | `src/agent/gateAdapter.ts`, `src/agent/outboundCheck.ts`, `src/domain/gate/routing.ts` |
| Results treated as untrusted | MCP results fenced (`fenceUntrusted`); manifests mark MCP tools `untrusted: true` | `src/mcp/tools.ts`, `src/agent/untrusted.ts` |
| Record every call | Every gate decision recorded with actor, capability, outcome and rule | `src/domain/gate/record.ts` |
| Secrets | URL, header and environment values in VS Code SecretStorage | `src/services/mcpRegistry.ts` |
| Trust badge on the provider | NEAR AI Cloud attestation and trust badge, for model answers only | `src/domain/gate/trustBadge.ts` (0.4.33) |
| Sharing skills and teams | `<team>.near-team.json` share file with an integrity digest (not a signature), imported teams treated as untrusted and confirmed before first run, a reserved `listing: null` field for a later marketplace | `src/agent/teamPackage.ts` |

### What is missing

1. **Destination ceilings.** Routing tiers judge where a *model* request may go. A partner MCP server is not a model tier, so at `attested-cloud` a paraphrase or summary of labelled content can reach any remote MCP server; only verbatim text is caught. There is no "this server may receive up to Unclassified" setting, which is exactly what listing levels and the Integrations "Ceiling" column provide in ai-workbench.
2. **Partner identity.** Only TLS and a host name. No signed card, no DID for the partner, no check that the manifest came from anyone but the person who typed it.
3. **Sovereignty and terms.** No residency, operator, export-control posture, retention or training terms per server, and no expiry that makes a server unreachable when an attestation lapses.
4. **Spend.** No per-server or per-task spend cap and no metering of partner charges (PKG-03 in L3 plans per-server spend limits).
5. **Credential handling.** Tokens sit in the extension and are sent as headers; no audience binding beyond the configured URL. Phase 73 fixes this.
6. **Tool description poisoning.** Tool descriptions from the server go into the model's tool list as given (prefixed `[MCP: name]`, capped at 1,024 characters), not fenced. A partner can change them at any time.
7. **Catalogue, A2A, mandates, settlement, delisting of in-flight calls, conformance suite.** None exist.
8. **Signed skill packages.** The team share file is integrity-checked but unsigned; skills are not packaged separately.

### Where the exchange should land in the roadmap

| Exchange piece | Natural home | Why |
| --- | --- | --- |
| Destination label ceiling per MCP server, in the signed bundle | A small follow-up to Phase 70 (or Phase 29's window), before staff teams use partner tools with labelled work | Uses only the existing gate, mark and bundle; closes the largest gap for labelled data |
| Partner identity as a DID, verified per call; status-list revocation | Phase 71 | Same DID and credential machinery (`did:webvh` for an organization fits a partner) |
| Partner tokens as audience-bound handles, signed invocations, receipts | Phase 73 | Already names MCP headers and the MCP authorization audience binding |
| Mandate caps (cost, calls, time) on runs that use partners | Phase 74, then Phase 79 budgets | A mandate is a run contract plus a seller list and purpose |
| Per-server spend limits, MCP sampling off, signed packages for skills, teams and connectors, the `listing` field | L3 (routines and signed packages: PKG-01 to PKG-03) | Matches EX-09 and EX-10: signed, scanned, pinned, consent on widening, quarantine first |
| Catalogue, signed partner cards, listing levels, A2A tasks, metering of partner charges, invoicing lane A | A new milestone after L3, alongside L4 | Needs identities, broker, contracts and packages first; it is a product of its own |
| Settlement on rails (lane C, NEAR Intents or others), anchoring settlement hashes | After that milestone and L4, and only after the legal and audit criteria in the proposal | The proposal itself makes digital asset rails conditional; L4 anchors only roots |
| HQ-hosted catalogue for edge sites, offline listing cache | L5 (federation) | Edge sites need a cached, signed catalogue and status lists |

### Minimum for staff teams to use partner MCP tools safely now

With what ships in 0.4.33, a staff team (for example J2 using a translation or imagery partner) can use partner tools if the person setting it up does all of the following:

1. **Remote servers only.** Add partner tools as HTTP servers. Do not run partner code as a local stdio server, which runs with the person's own permissions.
2. **Declare every tool.** Keep `toolDefaults: restrictive` and declare each partner tool exactly in the server's manifest, with `runsOn: remote` and the partner's host in `hosts`. A tool the partner adds later stays restrictive and interactive only.
3. **Scope to members.** Give `mcp:<server>` only to the members that need it (for example the J2 collection member), not to the lead or every member.
4. **Never unattended.** Leave the server off the policy's `unattendedMcp` list.
5. **Ask before sending.** Set the server's approval to ask every call (or at least ask for changes) so a person sees the arguments before they leave.
6. **Keep labelled chats away from partners.** In the signed policy, route every level above the default label to `local-only`. Then any chat that has read labelled content refuses every call that may send off the machine, partner tools included. Use partner tools only in chats that hold unlabelled, releasable content.
7. **Least-scope tokens.** Give each partner its own token with the narrowest scope and shortest life the partner offers; never reuse a token across partners or put one in a team file.
8. **Treat results as untrusted.** They are fenced already; a person reviews anything a partner returns before it goes into a product.

The one new control worth building before real use with labelled work is a **label ceiling per MCP server, held in the signed policy bundle** (not in the manifest, which is the person's or server's claim): a call is refused when the chat's mark is above the server's ceiling, whatever the routing tier. It reuses `markVerdictFor` in `src/agent/gateAdapter.ts` and the bundle parser, and it is the extension's version of listing levels. A second small item is to fence or length-limit MCP tool descriptions as untrusted text, and to show the person when a server's tool list or descriptions change.

## 5. Security concerns, given labelled data and clearances

Partner tools are external network endpoints run by another organization. The main concerns:

1. **Exfiltration by paraphrase.** The outbound check catches verbatim text only (it says so in `OUTBOUND_LIMITS_TEXT`). At `attested-cloud` a summary of labelled content can go to any remote server. Until a destination ceiling exists, labelled levels must be `local-only` for partner use.
2. **Clearance is self-declared.** Until Phase 71, a clearance comes from the person's own policy file (`CLEARANCE_SELF_ASSERTED_TEXT`), so it is not an enforced boundary, and labels "do not make this device accredited for classified information" (`LABELS_NOT_ACCREDITATION_TEXT`). No partner use for Protected B or classified work on this basis.
3. **Aggregation.** Many small, individually releasable calls to one partner can reveal a picture that is itself sensitive (for example J2 collection interests or J3 timings). Nothing tracks what one partner has received over time.
4. **Prompt injection and tool poisoning.** Results are fenced, but tool descriptions are not, and both can carry instructions. A partner can change its tool list or descriptions after approval ("rug pull").
5. **Partner identity and terms.** TLS proves the host, not the organization, its residency, its operators' nationalities, its retention or its training use. Sending controlled data to a foreign-operated service can be an export (ai-workbench XC-03). This needs attestations with expiry, which do not exist yet.
6. **Credentials.** Partner tokens sit in SecretStorage and travel as headers; an agent that can read the environment or a misconfigured server could misuse them. Token passthrough and confused-deputy risks remain until Phase 73's audience-bound handles and signed invocations.
7. **Chained services.** The ai-workbench design lets partner services call each other; each hop is another party that sees the data. Any future A2A support must refuse onward calls the mandate does not name.
8. **Spend.** Paid partner tools have no cap in the extension; a loop could run up charges outside the extension's ledger.
9. **Metadata.** Arguments, timing and call counts reveal what a staff branch is working on, even when content is unlabelled. Settlement records (if ever on a public ledger) must carry only values and hashes, as ai-workbench EX-06 requires.
10. **Revocation.** There is no instant delisting that stops in-flight calls across all members and teams (ai-workbench EX-08). Today the person must disable the server per project.
11. **Signature format.** A2A v1.0 cards use classical JWS; ai-workbench wants hybrid post-quantum signatures. This extension signs with Ed25519 today. Pick the card format when the catalogue milestone starts, not before.
12. **Skills from others.** A shared team or skill can change what agents do. Today's share file is integrity-checked but unsigned and asks before first run; a malicious package is not traceable or revocable across sites until L3's signed packages (and the EX-10 install trail) exist.

## Sources

ai-workbench (read through the GitHub API): `SPEC.md` (sections "Decisions at a glance", "Users and roles", "Domain model", "Extension points", "Foundations", EX, SOV, INT, XC, key flows 3 and 8); `.planning/PROJECT.md`; `.planning/ROADMAP.md`; `.planning/REQUIREMENTS.md`; `.planning/STATE.md`; `.planning/research/FEATURES.md`; `.planning/research/ARCHITECTURE.md`; `.planning/research/SUMMARY.md`; `AGENTS.md`; `mockups/README.md`; `mockups/screens/Exchange.html` and `mockups/source/Exchange.dc.html` (same content, editable original); `mockups/screens/PartnerPortal.html`; `mockups/screens/Integrations.html`; `mockups/screens/Gateway.html`; `docs/sources/text/Sterling_Sovereign_AI_Proposal_v0.9.txt` (sections 12.2 and 12.5); `docs/sources/text/Agentic_Staff_Cells_GDG_Brief_v0.7.txt`; `docs/reviews/near-ai-vscode-0.4.4-audit.md`; `docs/reviews/sawyer-ironclaw-review.md`; `docs/reviews/bastion-trust-layer-review.md`; `docs/research/bastion-whitepaper-extract.md`. `design/` holds only icons (`design/icons/ic-exchange.svg` among them), no design text.

This repository: `.planning/ROADMAP.md` (Phases 70 to 74, 79, later milestones L1 to L6), `.planning/REQUIREMENTS.md` (PKG-01 to PKG-03, ANCH, SKIL), `CHANGELOG.md` (0.4.31 to 0.4.33), `src/mcp/`, `src/services/mcpRegistry.ts`, `src/domain/gate/`, `src/agent/gateAdapter.ts`, `src/agent/outboundCheck.ts`, `src/agent/teamPackage.ts`.
