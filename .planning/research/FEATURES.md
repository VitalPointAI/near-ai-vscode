# Feature Research — Messaging Relay for Agent Teams (Microsoft Teams + Signal)

**Domain:** Owner-hosted multi-tenant messaging relay (`relay/`) exposing existing agent teams from Microsoft Teams group chats and Signal groups, with no VS Code for the end user.
**Researched:** 2026-11-13
**Confidence:** HIGH for Teams platform facts (verified against Microsoft Learn, mostly pages dated 2026-07…2026-11); HIGH for signal-cli capabilities (verified against the project man page); MEDIUM for deployment/economics patterns that only community and moderation threads cover.

Scope fixed by prior decisions (not re-researched): relay as a new workspace at `relay/`, Node 26.13.1, tenant allowlist, external-user bot, "group chat sees only the finished result / working thread continues in the bot's 1:1 chat." This document designs *within* those decisions. Agent loop, approvals, spend, model client, GSD integration, chat UI are existing product and are treated as the run engine behind the relay.

---

## Platform Facts These Features Rest On (verified)

Short list of hard platform facts that determine what is even buildable. Every feature row below traces back to these.

| # | Fact | Source |
|---|------|--------|
| P1 | A bot/agent installed in a Teams group chat **receives messages only when @mentioned**, by default. Receiving *all* chat messages requires the `ChatMessage.Read.Chat` RSC permission ("read and receive all of this chat's messages") and installation. Teams also never delivers messages authored by other agents/bots. Replies are thread-scoped: send to the *conversation id + root message id* to stay in-thread. Mentions must be taken from `entities`, never parsed from message text, and stripped before the text is handed to the team. Mentions arrive even if the mention text was later edited. | [channel-and-group-conversations](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations), 2026-10-27 |
| P2 | Proactive 1:1 messaging requires the app **installed for that user in personal scope** (or in a team they belong to); otherwise sending by `aadObjectId` fails with **403 ForbiddenOperationException**. Prerequisite: capture `tenantId` + `aadObjectId` from conversation events, then create-once the 1:1 conversation via REST with those ids plus the `serviceUrl`. Addressing by email/UPN is not supported. Proactive installs via Graph work **only for apps published to the org catalog or Teams Store** — not sideloaded zips. Users can block the bot (403, subCode MessageWritesBlocked). Conversation references go stale; re-fetch on failure. Conversation create/send has its own throttle bucket; global cap ≈ 50 RPS per app per tenant. | [send-proactive-messages](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages), 2026-10-12; [graph-proactive-bots-and-messages](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/proactive-bots-and-messages/graph-proactive-bots-and-messages), 2026-07-06; [rate-limit](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit), 2026-07-27 |
| P3 | Teams send throttles: per-thread send-to-conversation ≈ 7 ops/s, 60 ops/30s, **1800 ops/3600s**; global ≈ **50 RPS** per app per tenant; 429 ⇒ exponential backoff with jitter (also retry 412/502/504). | [rate-limit](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit) |
| P4 | Incoming activity JWTs must be validated (signature, issuer/audience/expiry) against Bot Framework OpenID metadata; tenant validation is the relay's own allowlist job. | [incoming-request-authentication](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/incoming-request-authentication) |
| P5 | Agent **message streaming is an official Teams protocol**: an outbound *typing* activity opens the stream, then progressive `delta` message updates (SDK or raw REST). Recommended cadence ≈ **1 delta / 400 ms**. 1:1 chats are first-class for streaming; the docs are silent on group-chat support — assume 1:1-only, verify in phase. | [streaming-ux](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux), 2026-10-28 |
| P6 | Files: teams file flows live at [bots-filesv4](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) ("Teams stores these files in OneDrive or SharePoint and displays them as file cards"); the formal **file-consent-card upload flow is documented for the personal context** (bots-files v3 docs: "in the personal context"). Team-internal / free-scoped tenants often can't provision the OneDrive drive an app-only upload needs — so **link delivery is the reliable path in external group chats**; attachments/consent cards are a 1:1 enhancement, not a dependency. Storage service limits in fact override Teams: a real-world consent upload failed with * inscriptionLimitsExceeded / StorageService NotAvailable* on such a tenant ([MS Q&A thread](https://learn.microsoft.com/en-us/answers/questions/1181042/send-file-consent-card-to-proactive-1-1-chat-micro)). | [bots-filesv4](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4), 2026-11-04; [bots-files (v3)](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/bot-v3/bots-files) |
| P7 | Adaptive Cards + Universal Actions (`Action.Execute`) work in Teams with backward-compatible `Action.Submit`; refresh + user-specific views make stateful buttons possible, but **require an app-only RSC permission consented by an admin**, and all-group-chat members see the same card unless user-specific views are wired. In a *file-free* external group chat, plan around submit-style cards. | [universal-actions overview](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/overview), 2026-09-30 |
| P8 | **New multi-tenant Azure Bot registrations stopped July 31, 2025** (existing ones keep working). Moderator-stated supported cross-tenant path: single-tenant bot + publish to Teams Store/AppSource; customer admin consents. In-place multi→single conversion is not documented as supported. | [Azure Bot "supported app types"](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration?view=azure-bot-service-4.0&tabs=multitenant#supported-app-types); moderated answers in [Q&A: migrating multi-tenant bots](https://learn.microsoft.com/en-us/answers/questions/5492711/migrating-from-multi-tenant-to-single-tenant-azure) |
| P9 | Distribution to a customer org: "Publish to your organization… Requires your Teams admin's approval" (custom upload / org catalog) vs "Teams Store… Requires Microsoft approval." Sideloading needs the customer's app-setup policy to allow custom uploads; SSO is possible against single-tenant apps. This is the **per-tenant admin workflow the allowlist flow must serve**. | [deploy-and-publish overview](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/overview), 2026-07-22; [apps-upload](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload), 2026-11-03 |
| P10 | Identity in host-org chats: guests are **Entra B2B accounts in the host org**; external-access participants are federated. The bot sees `aadObjectId` + `tenantId` per member (tenantId = *customer's*, not ours); map identity by `aadObjectId` within the tenant. | [communicate-with-users-from-other-organizations](https://learn.microsoft.com/en-us/microsoftteams/communicate-with-users-from-other-organizations), 2026-07-10 |
| P11 | signal-cli (the only credible OSS base for a Signal bot; no official bot API exists) exposes JSON-RPC over **unix socket, TCP (default localhost:7583) or HTTP** (`/api/v1/rpc` + SSE `/api/v1/events`); groups are opaque base64 **group ids**; send supports `--attachment` (path or RFC-2397 data URI), `--mention` (`start:length:recipient`), quoted replies (`--quote` author+timestamp), `sendTyping`, `sendReaction`, `sendReceipt`; rate-limit errors surface as **exit code 5 + submitRateLimitChallenge CAPTCHA**; accounts are registered numbers or username-linked identities, and linked devices can be severed remotely by a user action (removeDevice ⇒ QR re-pairing). Group membership is a real protocol state: the bot must actually **join/own** the group. | [signal-cli man page](https://github.com/AsamK/signal-cli) (`man/signal-cli.1.adoc`, fetched 2026-11-13) |
| P12 | Signal usernames (shipped Feb 2024) let the bot be contacted and added to groups **without exposing the relay's phone number**; discovery-by-phone-number can be disabled. Accounts can exist *without* a phone number (username-linked), which changes safe provisioning. | [signal.org/blog/phone-number-privacy-usernames](https://signal.org/blog/phone-number-privacy-usernames/), 2024-02-20; [PNN support deeper-dive](https://support.signal.org/hc/en-us/articles/6829998083994) |
| P13 | signal-cli upstream churns constantly because it reimplements Signal's private protocol; pinning is mandatory and upgrades must be deliberate. Observed release cadence 2026: 0.13.15 → 0.13.19 → 0.13.20 within ~3 months ([releases](https://github.com/AsamK/signal-cli/releases)). Secondary evidence of operational pain: dispatch/locking issues [asamk/signal-cli#1611](https://github.com/AsamK/signal-cli/issues/1611), [dispatchSignal controller log stories](https://github.com/boxdot/gurk-rs/issues/236). |

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these and the group chat feels broken within the first five minutes of use.

| Feature | Why Expected | Complexity | Notes / Platform Shape |
|---------|--------------|------------|------------------------|
| **Channel adapters** (Teams + Signal) | The product *is* the two channels; a relay with one adapter is half a product. | High | Each adapter = a `ChannelBinding`: parses inbound → normalized `ChatCommand`/`ChatMessage`, renders outbound from run lifecycle. All 10 feature rows below are per-channel; every difference is flagged. |
| **Reply-in-thread correctness** (Teams) | The bot is invited to a threaded surface; an answer landing outside the thread looks like a bug on day one. | Medium | Follow-ups in-group must reuse thread id (conversation id + root message id; also passes "existing thread" context to proactive thread replies). P1. *Signal has no threads — mark channel-specific.* |
| **Person attribution** | "Several people talk to one team" is the core scenario: each request must bind to the asker. Complexity sits in the relay, not the channel. | High | Teams: map by `aadObjectId` in the customer tenant (guests are B2B accounts in the host org; external-access users are federated) → P10. Signal: sender uuid/username in the group event. Persist `channel_identity ↔ tenant ↔ requester` on first sight. |
| **Acknowledge → finish → deliver** | Agent runs take minutes–hours; chat users expect instant acknowledgment, a finished answer later, and no dropped results. | High | Inbound → run spawns → ack in-channel → private working thread → **pending delivery outlives the WebSocket** (persistent queue row). Deliver with a proper quote/reference back to the originating thread, including a graceful "run died, sorry" state instead of silence. Both channels. |
| **Live progress in the working thread** | Long silent waits feel frozen. The working thread is exactly where "mirror GSD status updates" belongs. | Medium | Teams 1:1: official streaming protocol (typing ⇒ delta updates at ~400 ms; throttle budget separate from sends) — P5. Signal: queued sent messages (`follow periodic`); status posted as plain messages. Group-chat streaming is unverified on Teams — post, don't stream, in-group. |
| **Pause control: `pause`/`resume`** | Users must be able to stop the clock/burn mid-run and step in. Modelled on ChatGPT's pause; cheap and sufficient. | Low | Both channels; parse prefix, same process. Depends on existing agent engine's pause capability. |
| **Command surface as text** (`help`, `status`, `cancel`, `cost`) | Signal has no buttons; even Teams users revert to typing. A consistent text command set is the least-common-denominator control plane. | Low | Parse prefixed commands (`/` or natural language like "cancel"); same semantics both channels. |
| **Cancellable runs (`cancel`)** | Urgent stop must work with **no button UI at all** (Signal) and survive the dispatcher being gone. | Medium | Queued dispatch keyed by run id; cancel persists, then ack or run executes it; the queued acknowledgment loop then drains with a proper cancel — e.g. SIGINT to a found pid and close. Post an honest cancel confirmation + partial artifacts in-group if anything completed. Teams adds richer surfaces: `Action.Submit` inline cancel cards in-group (back-compat mode; P7) and buttons in the 1:1 — both are enhancements over, not replacements for, text cancel. |
| **`status` visibility** ("what are you doing?") | Chat-native equivalents of "check on the agent": elapsed, step, spend-so-far. | Low | Same parser; reads run registry. Teams may render as a small card, Signal plain text with quoted reference to the original ask. |
| **Document / report delivery (links first)** | The extension already emits PDF/DOCX reports; every chat user expects to receive them. | Medium-High | **Teams:** direct file-consent upload is only documented for personal context, and app-only upload needs OneDrive/Graph provisioning inside the customer tenant — often unavailable for free/scoped orgs ⇒ **signed expiring HTTPS links posted as a card** in-group, real file attachment in the bot's 1:1 where consent cards work — P6. **Signal:** first-class `--attachment` (PDF/DOCX pass through fine) — P11. Link-only fallback documented if attachments bounce. |
| **Typed event mapping & idempotency** | Duplicate/edited events, retries, and interleaved membersAdded happen on both platforms; double-runs are user-visible corruption. | Medium | Dedup key = (channel, conversation, message id/timestamp, sender); Teams conversationUpdate handled idempotently (per-thread greeting split). Both channels. |
| **Allowlist gated at the boundary** | One unexpected tenant triggering paid model runs is the worst-case failure; customer messaging admins can add the app org-wide. | High | Verify inbound JWT (issuer/audience/expiry per P4), then check `tenantId`/group id against tenant registry **before** anything else. Both channels; **one allowlist, two shapes**: Teams = per-tenant Azure Bot registrations provisioned + custom-app zip (P8/P9); Signal = server-side group-id allowlist seeded at onboarding. Feature *above* individual rows. |
| **Spending state & transaction log** | Run lifecycle IS spend — whoever holds runtime state holds billing; doing it elsewhere re-creates allocation bugs. | Medium | Extend existing spend module into the relay's durable run registry (SQLite + one directory per tenant). Both channels. Foundation for budgets below. |
| **Per-tenant budget caps + spend visibility** (`cost`) | Relay is multi-tenant and owner-operated: budgets are the abuse *floor* even with platform rate limits. | High | Add budget checks in the shared internal API boundary; caps per tenant (and per group/conversation, see Abuse row) before each engine billing boundary; refuse-on-exceeded with a plain in-chat explanation. `cost` is the user-visible refund of that machinery. |
| **System-prompt'd identity per binding** (name/avatar/personality) | Chat renders channel identity, not markdown lists; users must see *who* they're talking to. | Medium | Teams: bot name/icon + optional per-message personality; Signal: `updateProfile` name/about/avatar per tenant-bound account. Existing personality model reused. |
| **Append-only activity log + admin tooling** (logs & replay a run; kill/retry switch; SQLite → Postgres migration is clean by design) | Operator necessity, both for debugging user reports and for GDPR-ish deletion. | Medium-High | Straightforward at relay/ layer with channel ids; needed the moment a second tenant exists. |

### Differentiators (Set a Good Relay Apart)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Streaming progress in-group, not just 1:1** (Teams) | Competing agent bots post a single lazy "thinking…" and go quiet; live deltas in-thread are visibly better. | Medium | Streams on Teams support typing ⇒ progressive deltas; throttle separately; fallback markdown edits at ~5 s cadence if streaming balks in-group (docs are silent there — P5). **Teams-only** (P11). |
| **Ephemeral status events** (`run started/spent/$`, typed models, fallback text rendering) | Raises perceived reliability of long runs; cheap on top of a normalized run registry. | Low | Rendered differently per channel: Teams = card insert or streamed edit; Signal = one compact text line. Depends on acknowledge+registry. |
| **Onboarding into tenant: admin-runbook package** (zip, verification steps, upgrade procedure) | Sideloading + admin-consent workflows are the real adoption bottleneck (P9); a crisp package makes a customer's admin successful in minutes. | Medium-High | Distinct per channel: Teams = prepared app package + admin-consent URL verification guide; Signal = phone-number-provisioning checklist (QR, registration lock, credentials custody), recovery-plan doc. Depends on tenant registry schema being right. |
| **Self-host playbook (reverse proxy, redirect URI validation, key provisioning guide)** | Owner-hosted but diverse customer orgs; self-host-with-my-domain is an FAQ tier. Comfort in the docs, cost mostly in writing. | Medium | Positioning doc first; in-code: config-driven base URLs. Not on the critical path — but visible to buyers. |
| **Proactive "run done" DM only on completed milestone**, tuned to each channel's ambient rules | Notification-fatigue guardrail that respects platform ambient-noise policy (copy for Teams: *avoid proactive 1:1 within hours that user works normally*). | Low | Implementation is a flag on pending delivery; both channels. Signal ambient rule is same intent. Depends on pending-delivery queue. |
| **`cost`/spend meter parity with the extension UI** | Trust feature unique to this product's cost-aware identity; the relay shows the same spend surfaces the IDE shows. | Low | Reuses existing spend; medium only because chat rendering differs. |
| **Direct-link file delivery both directions** (drag into chat ⇄ signed link out) | Working two-way docs loop — receive attachments from users too, not just send reports. | Medium | Signal trivial; Teams 1:1 = consent-card/easy receive; in-group download path throttled by chat-message RSC only if `ChatMessage.Read.Chat` consented. Depends on document delivery base row. |
| **Web search enabled for persona/Teams marketplaces**? **No** — knowledge-tool parity isn't in chat scope; explicit competitor anti-feature instead. | — | — | Listed here as a deliberate *non*-differentiator to prevent scope creep; see Anti-Features. |

### Anti-Features (Explicitly NOT Building)

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|--------------------|
| **Universal-Actions-only cards with admin-required app-only consent (P7) as the sole Teams UX** | Depends on tenant-admin RSC consent for basic flows; breaks on orgs that refuse consent; kills portability. | Ship text commands everywhere; cards/refresh-based controls are progressive enhancement after consent exists. |
| **Third-party Voice/video/screen-share or meeting-room invocation (meeting-tab complex handlers)** | Never promised; big surface; pulls relay into real-time media compliance. | Async chat surface only; meetings produce transcripts users can paste/link. |
| **Thread-splitting arbitrary "run rooms" (fabricated sub-conversations)** | Both platforms render threads differently; invented ones confuse users and break reply threading. | Use the channel's real threads (Teams) / sequential messages + quoted replies (Signal). |
| **Public-facing unauthenticated inbound** (e.g. "email your request", public link joins) | Expansion of attack surface beyond decided scope; per-tenant identity already solves join-control. | All inbound goes through the two adapters + tenant registry. |
| **Streaming the full agent transcript into the group chat** (verbal diarrhoea mode) | Ruins group-chat hygiene (the design keeps the group chat clean of internal narration); throttle budgets punish chattiness. | Working thread mirrors internals; group gets ack + finished answer only (as decided). |
| **Per-message ad-hoc attachment upload through owner's OneDrive as the default Teams document path** | Tenant OneDrive provisioning is outside our control (drives not provisioned ⇒ hard failures — real reported case, P6). | Signed expiring links in-group; consent-card file delivery as 1:1 enhancement where provisioning exists. |
| **Auto-upgrading signal-cli / floating dependency** | Upstream protocol churn breaks silently (release every few weeks; dispatch bugs reported 2025 — P13). | Pin exact version; upgrade behind a deliberate milestone with a regression checklist (group join, attachments, JSON-RPC events). |
| **Bots talking to each other in shared group chats** | Teams fundamentally never delivers other bots' messages into an agent (P1) — fighting it is wasted effort. | One team per group chat as the design contract; document it. |
| **Public "anonymous requester" mode (no identity attribution)** | Breaks attribution, budgets, audit trail; admin surfaces require accountability. | Every request binds to a requester identity; anonymous use is not offered. |

---

## Feature Dependencies

```
Channel adapters ─┬─> Reply-in-thread correctness ─┐
                  ├─> Person attribution ──────────┼─> Acknowledge → finish → deliver ─┬─> Live progress in 1:1
                  ├─> Typed event mapping ─────────┘                                   ├─> Cancel/status/pause/cost commands
                  └─> Allowlist gate ────────────────> Per-tenant budgets ─────────────┤
                                                       (budget floor)                  └─> Document delivery (links)
Allowlist gate ──> Tenant onboarding runbook ──> Graph proactive install eligibility
Acknowledge+registry ──> Streaming in-group ──> Ephemeral status events
Acknowledge ──> Pending delivery queue ──> Milestone-only DMs
Document delivery ──> Two-way attachments
Everything ──> Activity log & admin tooling
```

Reading the graph: **allowlist + event mapping + acknowledge-with-registry are the true roots** — nearly every user-visible feature sits on top of the durable run registry. Streaming-in-group (differentiator) is the only feature needing a fresh platform verification spike; everything else extends verified behaviors.

---

## MVP Recommendation

Prioritize (first phase only):

1. **Relay core**: durable run registry + typed event mapping + idempotency.
2. **One channel end-to-end first — Teams** (larger installed base, official streaming protocol, actionable docs): adapter + reply-in-thread + person attribution + acknowledge→deliver + text commands + allowlist.
3. **Signal adapter second**: same relay core, plainly second (user is already using Signal personally — realistic).

Defer, with reasons:

- **Streaming in-group / status cards**: genuinely differentiating, but every platform detail is secondary to correct reply threading first. Derive quickly once the registry exists.
- **Two-way attachments in-group**: consent-card/OneDrive flows carry per-tenant provisioning failure modes (P6) — ship link-delivery first, enhance later.
- **Universal-Actions rich cards**: admin-RSC dependency makes them unshippable on constrained tenants; text commands cover all control paths.

---

## Sources

Teams (all fetched 2026-11-13):

- Channel & group conversations / threads / mentions gating: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations> (2026-10-27)
- Proactive messaging + install prerequisites: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages> (2026-10-12)
- Rate limits: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit> (2026-07-27)
- Agent streaming protocol: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux> (2026-10-28)
- Universal Actions: <https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/overview> (2026-09-30)
- Files: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4> (2026-11-04) · v3 personal-context: <https://learn.microsoft.com/en-us/microsoftteams/platform/resources/bot-v3/bots-files> · OneDrive-provisioning failure report: <https://learn.microsoft.com/en-us/answers/questions/1181042/send-file-consent-card-to-proactive-1-1-chat-micro>
- Bot authentication: <https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/incoming-request-authentication>
- Graph proactive install: <https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/proactive-bots-and-messages/graph-proactive-bots-and-messages> (2026-07-06)
- RSC permission catalog: <https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent> (2026-11-02)
- Multi-tenant bot registration cutoff: <https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration?view=azure-bot-service-4.0&tabs=multitenant#supported-app-types> · moderated migration guidance: <https://learn.microsoft.com/en-us/answers/questions/5492711/migrating-from-multi-tenant-to-single-tenant-azure> (MEDIUM — community/moderated, not spec)
- Distribution overview: <https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/overview> (2026-07-22) · custom upload: <https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload> (2026-11-03)
- Guest vs external identity: <https://learn.microsoft.com/en-us/microsoftteams/communicate-with-users-from-other-organizations> (2026-07-10)

Signal:

- signal-cli (capabilities, JSON-RPC modes, groups, quotes/mentions/typing/reactions, CAPTCHA rate limits): <https://github.com/AsamK/signal-cli> (man page fetched 2026-11-13)
- Release churn evidence: <https://github.com/AsamK/signal-cli/releases>; operational pain: <https://github.com/AsamK/signal-cli/issues/1611>, <https://github.com/boxdot/gurk-rs/issues/236> (MEDIUM)
- Usernames / PNN: <https://signal.org/blog/phone-number-privacy-usernames/> (2024-02-20) · <https://support.signal.org/hc/en-us/articles/6829998083994> (HIGH for facts on the page)
