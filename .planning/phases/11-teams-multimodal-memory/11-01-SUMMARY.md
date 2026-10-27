# Phase 11 summary: teams, multimodal, generation, and memory on the runner

**Completed:** 2026-10-26

## What was built

- **Teams** (`src/agent/teams.ts`, `src/services/workspaceCommands.ts`). A team is a Markdown file: frontmatter `name`/`description`, one `## member` section per member with optional `role:`, `model:`, `tools:`. `TeamLibrary` stores reusable teams in extension storage (create, duplicate, archive, restore, import, delete, 20 versions kept, a version recorded on every save) and reads the project team at `.planning/.near-ai/team.md`. `/team:<slug> <task>` runs a lead agent that has the members as Agent sub-agents; each member is limited to its `tools:` list. Commands: Manage Agent Teams, Set Up Project Team, Manage Project Memory.
- **ONB-04.** Set Up Project Team asks goal, risk, and work-shape questions, renders `recommendAgentTeam` as a team file, and opens it for the user to review and edit before it is used. Review roles get read-only tools.
- **Attachments** (`src/agent/attachments.ts`). Images up to 10 MB, audio up to 25 MB, text up to 1 MB. Images are read by the chosen model if it reads images, otherwise by `nearAi.agent.visionModel`; audio is transcribed by `nearAi.agent.transcriptionModel` (Whisper). The chat states which model handled each file. TEE-only mode blocks the turn when that model is not TEE-attested. PDFs, Office files, and video are refused with a message.
- **Image generation** (`imageTool`). Offered only when the provider lists an image-output model. Capability `mediaGeneration`, so it asks under the action policy with the price; the PNG is saved through checkpoints, so Revert removes it.
- **Memory** (`memoryTools`, `memoryPreamble`). Remember and Recall over `ContextGraphMemory`, with project scope plus a private scope per sub-agent role. Each run starts with up to 10 facts that match words in the request. Secret-looking content is refused by the memory service.
- **Reputation.** Each sub-agent's outcome is recorded as reliability evidence for its role in `.planning/.near-ai/reputation.json`.

## Bugs found while testing

- The agent could not write memory at all: `ContextGraphMemory` rejects agent provenance from actors not registered by the host, and the chat created it without registering one. The chat now registers `AGENT_MEMORY_ACTOR`. A test also checks that an unregistered actor is still rejected.
- `ContextGraphMemory.search` gives non-matching nodes a baseline score and sorts by ID, so it returns every fact. Recall, the run preamble, and the memory command would have sent the whole memory to the model on every run. `matchingFacts` now keeps only facts that contain a query word, best matches first.
- Reputation writes were fire-and-forget and could be lost when the turn ended; they are now awaited.
- The chat and the memory command each derived the project scope; both now use `projectMemoryScope`.

## Not done (recorded in SECURITY.md known limitations)

- Video attachments and generation; PDF and Office attachments (MULTI-01, GEN-01 partial).
- A graph view of memory (MEM-05); there is a searchable list with correct, retract, export, and reset.
- Shared team memory (part of MEM-01); members get project memory and their own private memory.
- Reputation is recorded but does not change routing yet (ROUTE-02 partial). Routing comes from team `model:` lines and the deep/standard/fast settings (ROUTE-01).
- Team members have role, model, tools, and instructions; budget and approval follow the project's action policy rather than per-member settings (TEAM-02 partial).
- The old TeamStudio, MultimodalOrchestrator, and GenerationService backends are superseded by the above and stay hidden in the Tools panel.

## Verification

- `src/test/phase11.test.ts`: 7 behaviour tests covering team parsing, the library lifecycle, the questionnaire, a team run with a scripted model (member tools and reputation), attachments, GenerateImage with revert, and Remember/Recall/preamble.
- `npm run check`: passes; 263 tests, 262 passing, 1 opt-in skipped.
