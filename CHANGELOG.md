# Changelog

## Unreleased

- **Your team does the specialist work in every run, not only the first.** A team was used only for
  the `/team:<name>` message that started it. A later message in the same conversation, or an
  Open-GSD workflow, could not see the team's members, so work such as images went to a general
  agent instead of the team's designer. Now a conversation keeps the team it was started with, and
  without one the project's own team is used, after you agree to it once for that project (and again
  if its team file changes). Open-GSD keeps the project on track (planning,
  checking, verification) and hands the specialist work to the member whose role covers it, using a
  general agent only when no member fits. The chat says which team it is working with.

## 0.4.20

This release is about your project staying the same wherever you open it. The same project in
code-server, desktop VS Code and on another computer now shows the same chats, runs, comparisons and
model choices, and a project can be kept in step between computers with a recovery code.

- **One project state, in the project.** Chats, runs, checkpoints, comparisons, model choices and
  spend history live in a single folder inside the project, `.near-ai/state/`, which the extension keeps
  out of git. Every editor that opens the folder on this computer shows the same thing. Your earlier
  chats, runs, comparisons and spend are merged in the first time an editor opens the project, and
  nothing is overwritten or deleted. Opening a folder you never used NEAR AI in still writes nothing.
- **Full history in every interface.** Each conversation, including `@near` chats from VS Code's Chat
  view, opens with every message, reply and tool step, and tool steps open to their output. The 5 most
  recently used conversations stay open and the older ones are archived inside the project, never
  deleted, and still listed in **NEAR AI: Show Chat History**; opening one makes it live again
  (`nearAi.history.liveConversations`).
- **Model choices follow the project.** Compare Models results and the choices you apply with **Use
  as...** are saved with the project, so every editor shows them without running the comparison again.
  A setting in your workspace still wins, then the project's choice, then your user setting. Choices
  you applied earlier in one editor's user settings are offered for import once, never copied without a
  click. Compare Models lists what the project has chosen, and you can clear the choices there or with
  **NEAR AI: Clear This Project's Model Choices**. Putting a model into one role changes only that role.
- **Pick up where you left off.** Opening a project in another editor or on another computer shows a
  card in the empty chat with the last chat, how its run ended and the current Open-GSD phase with its
  next step. **Open chat** reopens that chat and starts nothing, so it spends nothing.
- **The NEAR AI key works in a second editor with no set-up.** On the same computer, a second editor
  uses the project's NEAR AI key because an encrypted copy of it lives in the state folder. With
  `nearAi.sync.keepKeyInProject` off, that copy cannot be opened without the recovery code or that
  device's own secret storage.
- **A sync control in the chat panel.** From the moment the panel opens, a control next to the profile
  shows **Sync off**, **Synced**, **Syncing...**, **Needs attention** or **No online home**, writes the
  reason in plain words when something needs you, and starts the right step with one click. It works
  from the keyboard and in light, dark and high-contrast themes.
- **Sync between computers with a recovery code.** **NEAR AI: Turn On Project Sync** shows what your git
  host can and cannot see, then makes a recovery code and shows it once. Sync is turned on in each
  editor you use; a second editor on the same computer needs one click and shows no new code. Enter
  the code on another computer with **NEAR AI: Enter Recovery Code** and your chats, runs,
  comparisons, model choices and NEAR AI key are there. **NEAR AI: Sync Project Now** syncs at once,
  **NEAR AI: Show a New Recovery Code** makes a new code (it does not lock out the old one, see the
  known limits), and **NEAR AI: Turn Off Project Sync** stops syncing. Everything is encrypted on
  your computer before it leaves, and your git host sees only that sync is used, roughly how much is
  stored and when you save. Sync runs after a run or reply ends, a minute after you leave the window,
  and every 10 minutes while idle (`nearAi.sync.intervalMinutes`, 0 turns it off). It pulls when the
  project opens and when you come back after 5 minutes away. Nothing is ever pushed to `main`.
- **Give a project an online home.** With no git repository or remote, one click starts git, signs in
  to GitHub through VS Code, asks every time whether the repository is public or private, creates it and
  pushes the encrypted sync branch. Pushing your own code is a separate step that lists the files and
  blocks likely secrets, including ones left in earlier commits. Without GitHub sign-in it offers the
  `gh` tool or the address of an empty repository you paste in, and it never asks for a token.
  **NEAR AI: Put This Project's Code Online** pushes your own code later, with the same checks.
- **Sync no longer trusts files in the project folder.** Files that arrive with a cloned repository no
  longer decide what sync runs, whether it is on, or which key it uses. Sync's private mirror and
  hooks live in the editor's own storage, the agent asks before it writes under `.near-ai/` or reads
  the state folder, entering a recovery code on a computer with chats keeps whatever it could not
  carry, and a deleted or rewound sync branch is rebuilt without loss.
- **The chat task list checks off finished tasks.** A finished run no longer leaves its list at 0/N.
  When a run ends with unfinished items, the agent is asked once to update the list, and anything still
  unfinished shows as "not confirmed done" instead of looking finished. Sub-agent tasks are matched to
  the list more reliably: a sub-agent's task is matched by its text first, and only when the match is
  unique.
- **Every research team now has a plagiarism checker.** It sits between the writer and the red
  team, compares the draft with every source fetched in the run and searches the web for
  distinctive sentences, checks every note against its source, and ends
  `.planning/research/INTEGRITY-CHECK.md` with CLEAN or NOT CLEAN. It never edits the report;
  problems go back to the writer. The editor cannot sign off while the check says NOT CLEAN, is
  missing, or checked an older draft. **NEAR AI: Update Team…** adds it to existing research teams
  without asking and says whether the team was missing it or it had been removed; your own edits to
  it are kept like any member's. Team Studio's AI builder adds it to any team it drafts that does
  research.
- **Research reports are cited in Chicago style.** Writers now use the Chicago Manual of Style,
  18th edition, notes and bibliography: a full note the first time a source is cited, shortened
  notes after, and a bibliography, as footnotes or endnotes to suit the report. Source grades move
  from the notes to the audit annex. A project can still choose another style in
  `.planning/STYLE.md`.
- **New tool: CheckOriginality.** It finds runs of eight or more words copied from a fetched page
  without quotation marks (and says whether a note is attached), quotations that differ from the
  page their note cites, quotations with no note, and sentences too close to a source's wording.
  It only sees pages fetched in the same run, and says so.
- **Role tests for the plagiarism checker.** Team Studio offers a Plagiarism checker role with its
  own graded task, and a member whose name has a task of its own (such as the research team's
  editor or writer) is now tested on that task rather than on its general role's.

Known limits in this release:

- The daily spend limit still counts the spend of the editor it runs in, not the project's total
  across editors.
- History shows the lead agent's steps and each sub-agent's report. Sub-agent steps become linked
  threads in a later release.
- A single tool output over 2 MiB is stored shortened, with a visible "output shortened" marker.
- A new recovery code does not lock out the old one. Anyone with your old code and read access to the
  repository can still open everything synced, including what is synced from now on, because your
  chats keep the same key. A way to change that key is planned. Treat a leaked code as a leak of
  everything synced.
- A conversation written in one editor at the very instant another editor joins the project can be
  undone by that join. Conversation writes do not yet take a lock.
- Error text from a failed reply in VS Code's Chat view stays in VS Code's own chat history.

## 0.4.19

This release is about runs that finish, and reports worth reading. Long research runs no longer
sit for hours on approvals nobody is there to give, a reload no longer ends a run, and a stalled
model reply fails over to a backup. Research teams now deliver finished reports as PDF or Word
files, teams keep and grow their own knowledge graph, and each role can run on the model that
tested best for it.

- **Sub-agents no longer stall on approvals nobody is there to give.** Measured on two research
  projects, sub-agents waited 15 minutes at a time on cards for their own checks (106 and 135 such
  waits), and two long runs died after about three hours of them. In Auto and Edits auto, a sub-agent
  now runs commands the safety rules call safe (reads, read-only git, tests, lint, type checks, builds,
  and writes inside its own folder or worktree) and verification scripts inside the project that no
  agent of the run wrote or changed, without a card (`nearAi.agent.unattendedAutoApprove`). Pushes, deletes outside the project,
  publishing, network commands and credential paths still ask, and Ask before edits is unchanged. A
  sub-agent's card now waits 20 seconds (`nearAi.agent.subagentApprovalWaitSeconds`); then the
  sub-agent is told it is awaiting approval and carries on, and the card stays queued. Allowing it
  later allows that command for the rest of the run and tells the lead. Three unanswered approvals in a
  row pause the run with a message (`nearAi.agent.approvalTimeoutsBeforePause`).
- **Smaller, cacheable context.** A conversation is summarized at 70,000 tokens whatever the model's
  window (`nearAi.agent.compactAtTokens`); the median request in the measured runs carried about
  190,000. Reading a large file without a range returns its first 400 lines and an outline, a
  sub-agent's report to its lead is capped at 12,000 characters, and every request now repeats the
  previous one byte for byte before adding to it, so NEAR's prompt cache can serve the shared part.
  Cached tokens are recorded in the activity history.
- **Stalled replies fail over.** A model reply that sends nothing for 120 seconds, before its first
  token or between chunks, is retried once on a backup model (`nearAi.agent.modelStallSeconds`,
  `nearAi.agent.backupModel`; the standard tier by default, and only a model at least as private as
  the chat's). A reply that keeps streaming is never cut, however long it runs; one reply still has a
  30-minute ceiling. Planner, plan-checker, verifier, analyst, editor and red-team roles now default to
  the deep tier, and fetch and extract roles to the fast tier (`nearAi.agent.roleModels`); a team
  member's own model line still wins.
- **More runs at once.** Read-only shell commands (`git status`, `git diff`, `ls`, `grep`, `cat` …) now
  run side by side with other lookups instead of queuing; anything that changes something still runs
  alone and in order. Sub-agents in their own git worktree are capped by
  `nearAi.agent.maxParallelWorktrees` (4), and leads are told to give parallel writers a worktree.
- **A reload no longer ends a run.** A run cut off by a reload in the last 12 hours carries on by
  itself with a notice (`nearAi.agent.autoResumeAfterReload`). Its state is now saved after every
  finished tool call, so it keeps every finished step's result and does not run it again.
- **A research profile for Open-GSD.** Research and writing projects plan coarser phases, use quick
  mode for content edits, and skip the plan-checker only for plans that change nothing but
  document, data and image files (`nearAi.gsd.researchProfile`), judged from the plan and from the actual changes. A skipped check
  replies with Open-GSD's pass marker so the run does not stop to ask, and says on the next line that the
  checker was not run. They also get three verifier scripts in `scripts/verify/`: citation
  resolution, figure recompute, and an internal-path leak check, which agents run without asking.
  **NEAR AI: Set Up Research Verifiers** adds them to an existing project. An edited verifier asks before
  it runs until **NEAR AI: Trust Research Verifiers** records the new version, after you confirm.
- **See where a run's time went.** **NEAR AI: Show Run Performance Report** (and
  `npm run report:runs`) prints each run's wall time split into model wait, tools, approval wait and
  idle, with input, cached and output tokens, model latency and unanswered approvals. The activity
  history now keeps up to 256 KiB of events per run instead of only its last 100.
- **Agents are only told to hand work to sub-agents when they can.** A plain chat, or a sub-agent whose
  tool list does not include Agent, was still told to "fan out with the Agent tool", so it tried a tool it
  did not have and wasted a turn. The advice now appears only when the Agent tool is there.
- **A sub-agent that starts its own sub-agent no longer hangs.** With the parallel-agent limit at 1 (or
  every slot taken by agents waiting on their own helpers), the helper waited for ever for a slot its
  parent held. An agent now gives its slot back while it waits for a helper it started.
- **Isolated sub-agents start in your workspace folder.** In a repository opened at a subfolder (say
  `packages/app`), an agent run with `isolation: "worktree"` started at the repository's top instead of
  that folder in its worktree.
- **The emergency stop reaches every open window.** Pressing it in one window stopped only that window's
  runs; others kept running and showed no stop. Other windows now stop within a few seconds and show the
  status-bar item, and resuming works the same way. This covers the windows on one machine; a window
  connected to a remote machine or a container keeps its own stop.
- **Smaller fixes:** when the context is nearly full and summarizing cannot free space (the recent
  messages hold most of it), the chat now says so once instead of carrying on silently; when the shell
  ends while a process it started still holds the output open, the Bash result says later output was not
  captured; and leftover temporary undo files from a save cut off by a crash are cleaned up.
- **Update Team.** Teams made from a built-in project type can now pick up improved roles. **NEAR AI:
  Update Team…**, or **Update team…** on a team's card in Team Studio, previews the change member by
  member and asks before writing: members you never changed are replaced with the current definition;
  for a member you changed you see the differences and choose to take the new one, keep yours, or keep
  yours and add only what is new (a privacy line, new tools, and the new Output and Done-when
  sections); members you added are left alone, members no longer built in are kept and flagged, and new
  built-in members are offered. A project's `AGENTS.md` guidance is updated the same way when the
  extension wrote it. The team is backed up to its version history first, and **Undo** puts it back.
  New teams record their template in their frontmatter; teams made earlier are recognised by their
  member names. When a team is out of date you are told once per version, with **Review**, **Later**,
  and **Don't ask for this team** (turn the notice off with `nearAi.teams.updateNotifications`), and
  nothing is updated while a run is in progress.
- **Research teams that ship professional, fully sourced reports.** Each role in a new research team now
  has one input, one job, one output file, and a definition of done, and they run in order:
  investigator, source-verifier, analyst, writer, red team, editor. Every role reads the project's
  `.planning/STYLE.md` (written at the plan stage; the team asks who the reader is rather than guessing)
  and treats your recorded decisions as binding. The investigator keeps an open-questions list, marks each
  finding new, confirming, or contradicting, checks analogous cases, and gives a blocking finding its way
  forward (requirement, earliest date, action). The source-verifier writes `SOURCE-CHECK.md`, confirms
  key quotes by an independent method, labels client and vendor statements as such, and records page and
  access dates. The analyst recomputes every derived figure and ranking from its inputs. The writer cites
  with real notes and keeps internal file paths and working codes out of the reader's text. The red team
  attacks the finished document as well as the findings, and tests the project's checks with deliberate
  breakages. The **editor is the release gate**: it checks the report against its audience, for
  coherence and comprehension (a reader must be able to follow it without the authors' context, and a
  failure here alone blocks release), for professional quality, and that every note's verified source
  really says what the sentence claims; it fixes wording itself, sends factual problems back, and ends
  `.planning/EDITORIAL-REVIEW.md` with SIGN-OFF or NOT READY. Nothing is released without SIGN-OFF.
  The presales reviewer and the writing editor work the same way. The source-verifier, analyst, red
  team, and editor use the deep tier, and every research member (and the presales reviewer) has
  `privacy: private`; change a member's line to `privacy: any` to relax it.
  **Existing projects keep the team they have** until you choose to update it: run **NEAR AI: Update
  Team…** (below) to pick up the new roles.
- **A team member can be kept on private models.** A `privacy: private` line in a team file keeps that
  member on a model that runs in a NEAR TEE or on your machine: the most capable private model for its
  tier, and if none is available the member does not run and the lead is told why, rather than its
  work going to a forwarded model. `privacy: any`, or no line, keeps today's behaviour. The Team
  Studio keeps the line when you edit and save a team, and always writes it after `tools:`, so the
  file stays safe if an older version of the extension opens it.
- **Reports as PDF and Word files.** Two new tools, CreatePdf and CreateDocument, turn Markdown (inline,
  or a `.md` file in the workspace) into a `.pdf` or a `.docx`: headings, lists, tables, quotes, code,
  links, and workspace images (PNG, JPEG, or SVG). The PDF has bookmarks from the headings and
  numbered pages; the Word file uses Word's Heading 1-4 styles, so its Navigation pane works. Both are
  made on your machine with no extra software, the same input gives the same file, and they follow the
  same rules as every other write: inside the workspace only, asking first where a write is protected,
  and undone by **Revert**. The PDF uses the standard PDF fonts, which cover Western European text;
  other characters are replaced with `?` and listed, and CreateDocument keeps every character.
  Both take footnotes (`[^id]` in the text, `[^id]: source` once): as real Word endnotes or footnotes,
  or in the PDF as linked superscript numbers with a Notes section at the end or notes at the foot of
  each page. A citation without a source, a source nothing cites, or a source defined twice stops the
  tool with the note's name rather than dropping it. Word files you attach now include their
  footnotes and endnotes in the text the agent reads.
  Research, presales, writing, and software teams get both tools, and so does any existing team
  member whose `tools:` line lists CreatePresentation: the tools are added when the team is loaded,
  and your team files are not changed.
- **Long runs from a single request are summarized when the context fills up.** Before, only history
  before your last message could be summarized, so one long request kept growing until it hit the
  model's limit, while the chat still said "The conversation was summarized" and rewrote
  `.planning/HANDOFF.json` on every turn. That notice and the handoff now appear only when a summary
  really happened.
- **A command that ends the shell no longer hangs the agent.** `exit`, or a failing command after
  `set -e`, used to leave the Bash tool waiting until its timeout (up to 10 minutes). It now finishes
  at once, says the shell ended, and the next command starts in a fresh shell. `set -e` also no longer
  carries over from one command to the next.
- **Edits work in files with Windows line endings.** Changing several lines at once in a CRLF file
  failed with "old_string was not found"; it now matches and keeps the file's line endings.
- **File search no longer wanders into `node_modules` and `.git` by accident.** A pattern such as
  `**/routes/**`, `.github/...` or `**/distance*` searched every skipped folder because it happened to
  contain "out", ".git" or "dist". Only a skipped folder the pattern names in full (`node_modules`, say) is searched now, and only folders of that name.
- **Search keeps credential files out on Windows and in surrounding lines.** Grep failed to recognise
  files like `.env` behind a `C:\` path, and showed the lines around a match in a credentials file.
  Both are hidden now unless you search that file by path.
- **Smaller fixes to runs:** a long run is no longer stopped as "stuck" after four replies hit the
  output limit at different times (only four in a row count); on Windows without Git Bash, the agent
  starts and only the Bash tool reports what to install, instead of the chat staying stuck as running;
  stopping a background command the agent started no longer asks for approval; and sub-agents changing
  files at the same time no longer risk a damaged undo record.

- **A run does not lose its place when nobody answers.** An approval that used to be declined after 15
  minutes, so the agent worked around a decision you never made and the work was redone, now parks the run
  on that step. Nothing runs, nothing is lost, the card keeps its buttons, and answering whenever you are
  back carries on from exactly there, up to a day: after that the action is declined and the run released, so an
  abandoned conversation cannot hold a run and its sub-agents open for ever. Measured on real runs, up to 752 minutes of a single run went into
  waits like this.
- **A team's own knowledge graph, and a network view of it.** Each team keeps what it learns: actors,
  what each does, and how they relate, with the signed strength of each relation and an Admiralty grade
  (source reliability A to F, information credibility 1 to 6) on the evidence. Two tools feed it, shared
  by every member and kept between runs. A new **Knowledge** tab draws it as an interactive network:
  select an actor and its relations are drawn on in sequence, strongest first, with a card showing what
  is known, where it came from, and how reliable that is.
- **A team is drawn, not just listed.** A **Team shape** tab shows the team as nested boxes, so the
  nesting is the hierarchy, and clicking a member opens its card: what it is for, what it can do from
  its tools, its model, who it reports to and who it leads, and what to expect from it. An optional
  `reports-to` line adds hierarchy to a team; existing team files need no change.
- **A team can be started from one description.** Say what the team should produce, and the AI drafts
  the team: a name, a mission, members with a name each and a role, a suggested model tier for each,
  what each one hands back, and the outputs you get with their formats. You see the proposal before
  anything is saved, and the Markdown editor is still there for anyone who wants the raw file.
- **Models are chosen from tests, per role.** Each role has its own graded task, and the last step of
  adding a team tests its roles and sets each member's model from the result, with the cost shown first
  and a skip. A role added later automatically gets the task for its kind of work, so no role is chosen
  by guesswork. **Optimise all teams** does the same for every team on demand.
- **Compare Models can now answer "which model for which role".** Run the comparison from a terminal
  with `npm run compare:models`, keep only what is stale or new with one click, and apply the setup the
  results point to in one action: deep is the most accurate, fast the quickest model still within half a
  point, standard the best value among those. For cyber work it advises a model chosen only from those that do not refuse
the work, once one has been tested: a scan picks its own model when it starts, so that row is advice rather than a setting
the button writes. A chart shows the score over time, by task type, so you can see whether it is improving.
- **Check now, when a run is waiting on CI or a review.** A running agent row has a **Check now** button
  beside Pause and Stop: it interrupts the wait and tells the agent to read the real state from GitHub
  again. Runs also wait without sleeping, so a verdict that lands early is picked up with no click.
- **A multi-part task is fanned out.** Agents are told to start one sub-agent per independent part in a
  single turn, and up to 8 sub-agents may run at once. Measured on real runs, 30 of 37 had only one
  request in flight, so four parts in parallel now finish in about the time of one.
- **The between-steps choice is a picker**, beside the approval picker and styled the same way: carry on
  by itself, or stop between steps in any of the asking modes.
- **"1 to fix" now says what needs fixing**, and takes you to the step that holds it.
- **A download runs without asking only in one exact shape.** `curl -sS [-w …] -o <path> <one https URL>` or
  `wget -q --max-redirect=0 -O <path> <one https URL>`: one public address, no redirect (wget follows redirects
  unless told not to, so its shape turns them off), every word literal, no other flag and no header of any kind.
  Anything else asks, including a bare `curl <url>`, a user agent, a
  `--resolve`, or an address on the local machine however it is written. Once a run has read outside content, even the exact shape asks.
- **Reading from GitHub no longer asks.** `gh pr view`, `gh pr list`, `gh pr checks` and the other read-only subcommands run, so a run can poll for a
  verdict; anything that writes to GitHub still asks.
- **A project's team keeps its own knowledge graph.** Every project's team, and a team of yours saved as
  `team.md`, used to read and feed one shared graph. A project team now has a graph of its own, kept apart
  from every other project, so it starts empty. The old shared graph is left where it was
  (`knowledge/team.json` in your teams folder) and is not merged in, because it may mix several projects.
- **Every team you made works from the message box again.** `/team:<name>` for a team created since 0.4.18
  was not offered by the composer and went to the model as plain text; the composer now lists the same
  teams a run uses. Testing a project team's roles in Team Studio no longer says the team "could not be
  found on disk".
- **Agent Activity adds up correctly.** A run's cost is the sum of its requests rather than the last one,
  each sub-agent is counted once (a finished one no longer shows as still running), a run whose attachments
  could not be read is marked failed instead of running until a reload, and the chat view's runs are no
  longer erased from the history when the sidebar chat records its own.
- **More secrets are masked in logs and activity.** Keys written as JSON (`"apiKey": "…"`), passwords,
  client secrets, and a bare `sk-…` key are now redacted, not only `api_key=…` forms.
- **Smaller fixes.** Model comparisons no longer count a test's own printed `ok` lines or skipped tests
  as passes, so a score cannot exceed 10, and a cost with some turns unbilled includes their estimates;
  `npm run compare:models` builds the extension first; saving a team file is versioned on Windows when
  the drive letter's case differs; and the approval timeout setting describes what it does now (the run
  pauses on that step, and the action is declined only after a further day).
- **More small fixes to teams and model comparisons.** A model comparison no longer lets a solution's own
  printed output turn a failed test into a pass: a test passes only when every report of it is a pass.
  On Windows, a project's team keeps one knowledge graph however the folder's drive letter or case is
  written. Testing a team's roles always sets the models in the team you acted on, even when your
  project team and one of your own teams share a name. And when a team's knowledge graph file cannot be
  opened (its permissions, or another program holding it), the agent is told it is left as it is and
  cannot be added to until it opens again, instead of being invited to start afresh. A fact can no longer
  be dated in the future, and a fact first recorded without a grade takes the first grade it is given (after
  that a grade only falls). An agent working in a subfolder of a repository (a monorepo package, or its own
  isolated copy of one) is told it is in a git repository, so it commits as asked.

- **A team's knowledge graph accumulates, and learns.** Nothing a team learned is silently dropped to enforce a size: the graph has no ceiling, because a
  ceiling that dropped the oldest entries made a team forget what it had learned. (The Learn tool still accepts at most 40 actors, 60 relations, and 12 facts per
  actor in one call; that bounds one call, not the graph.) What changes over time is what is currently *believed*: a fact that later evidence contradicts moves to
  a recorded history with why and when it stopped being believed, so a decision made on the old knowledge can still be revisited. Only a claim at least as
  strong as what stands can retire it. A refuted claim is not re-learned from an unsourced echo; a re-assertion that cites a source is believed again, dated
  from then.
- **An agent's word is worth C3 at most in the knowledge graph.** An agent that read a hostile page can be steered into writing any grade and any source,
  including one that does not look like a page, so everything in a team's graph is stored at C3 ("fairly reliable, possibly true") or below, whatever it
  cites. An agent can still grade lower (D5, F6), and a grade only ever falls as the graph is merged, so a later mention cannot raise one. Graphs written by
  0.4.18, where an agent could store A1, are read at C3, and saved at C3 the next time the team learns something. Nothing moves on disk: a team's graph stays
  in the file it was always in. Looking up an actor now also lists what the team no longer believes about it, and why.
- **A damaged knowledge file is kept, not overwritten.** When a team's graph cannot be parsed, the next addition copies it aside as
  `<team>.damaged-<time>-….json` before starting a new graph, and the agent is told, rather than the file being replaced in silence. A graph file that
  exists but cannot be opened at all (permissions, a lock) is never written over: the addition is refused and the file left as it is.

## 0.4.18

- **A workflow carries on by itself in Auto.** A research or software project used to stop at every
  boundary between analysing, planning and building, because the project's Open-GSD settings told it
  to. In Auto the workflow now starts the next step on its own, and a switch beside the approval
  picker lets you change that during a run.
- **Approval cards are clearer, and "always allow" really learns.** The card offers **Allow this
  time** and **Allow every time**; the second writes the rule and says whether it was saved, so the
  same command is not asked about again. What a card would save is shown, and a command that no rule
  can cover never offers it.
- **A temporary folder is accepted for helper work.** A command that works in `/tmp` (where
  Open-GSD's own steps put a helper script and run it) no longer asks. It stays safe: only a script
  this run wrote may run, a symlink out of `/tmp` is refused, and `rm`, the network, keys and any
  other folder still ask.
- **Scratch work stays inside the project.** Each project keeps its scratch files in
  `.near-ai/scratch/` and attached files in `.near-ai/attachments/`. Both are added to the
  project's `.gitignore` the first time a set-up project opens, so drafts and copied attachments are
  never committed, and the scratch folder is emptied after each run so the project does not grow.
- **Research accumulates instead of repeating.** The team writes its own findings files and reads
  what Open-GSD already researched before adding to it, so the same question is not researched twice.

- **Steer interrupts the agent now.** A message sent while the agent is working
  used to only queue for its next step. **Steer** (a button beside Send, or
  Ctrl+Enter) interrupts the reply in flight and becomes the agent's newest
  direction; Enter still queues, and the message says which it did.
- **Reading your own team never asks for approval.** Teams are NEAR AI's own
  files, so reading one no longer appears as "outside this project", while any
  other file outside still does.
- **An attached file is saved into the project.** A file you attach from
  anywhere on the machine is copied into `.near-ai/attachments/` in your
  project and the message names it, so the agent opens it with its own file
  tools instead of looking for it on disk.
- **Your agent teams survive an uninstall.** Teams made in Team Studio now live
  in `.near-ai-teams` in your home folder instead of inside the extension, so
  uninstalling the extension, reinstalling it, or installing it in another
  VS Code keeps them. Teams saved by an earlier version are copied across the
  first time this version starts, and the old copies stay where they were.

## 0.4.17

- **Auto approve stops asking about research work.** Web search and web fetch
  now run by themselves in Auto mode, so a research run is not a stream of
  questions. Shell commands that can reach the network still ask once the run
  has read a web page, because that page may have asked for them, but the web
  tools themselves do not ask again. A command that runs or reads outside this
  project is still held, and a safety model's approval can no longer wave it
  through.
- **An approval card says what the risk is, and shows the command.** The card
  names the kind of risk in one plain sentence, then the rule's reason, with
  **Show what will run** to expand the whole reason and the exact command or
  code.
- **Always allow now works.** It is offered for every command that a rule can
  cover, including the ones held for review, and it saves that exact command.
  Before, a command naming a web address offered a rule that could never match,
  which is why it seemed to do nothing.
- **A project can allow a whole kind of risk once.** **Auto allow outside the
  workspace** and **Auto allow installs** let a project stop asking about
  reading elsewhere and about installing. Destruction, publishing and reading
  keys still always ask.

## 0.4.16

- **A cybersecurity scan runs on an abliterated model.** A scan sends exploits,
  payloads and attack strings, which a safety-tuned model refuses or waters
  down, so **NEAR AI: Cybersecurity** now runs each scan on a model whose
  safety tuning was removed and shows that model in its Model list. With one
  such model offered it is chosen for you. If your organization offers several,
  the panel asks which one this scan runs on, once per engagement, and
  remembers your answer for it. If it offers none, the panel keeps your chat
  model and says a scan may be refused. A scan handed to the chat keeps the
  abliterated model, so its follow-up messages stay on it.
- **The Software development team has a DevOps member.** It sets up a
  protected way of working for the project: a CI workflow that runs the
  tests, a secret scan, and a dependency audit on every pull request,
  required checks and a review before anything reaches the default branch,
  and a release workflow whose publishing waits for your approval. It never
  asks for or stores a token, and for settings outside the repository
  (branch protection, environments, secrets) it writes the exact commands
  for you to approve and run. The team's guidance now tells every member to
  work through pull requests.

## 0.4.15

- **Use a profile from another project.** **NEAR AI: Use a Saved Profile**,
  and a new choice in **NEAR AI: Select Profile**, list the profiles you set
  up in your other projects. Pick one and this project uses it, without
  entering the key again; the key stays where it was saved and is never
  shown. Removing it from this project leaves the original alone, and if the
  original was removed, the project says so and asks you to set up a new
  profile or choose another.
- **A setup step that fails says so.** If **Review project team** or **More
  setup steps** in the ready message cannot open, you now see why instead of
  nothing happening.
- **The loop guard also ignores `cd -- <folder>`**, like `cd <folder>`.

## 0.4.14

NEAR AI can now test your own systems for security problems. A new
**NEAR AI: Cybersecurity** panel takes a target, records who authorized the
test, and runs a scan against it.

- **Pick what to test.** A web address, a folder in your project, a range of
  addresses, a running container, or a git folder. The panel shows exactly what
  it will touch — hosts, ports, folders and any exclusions — before anything is
  sent to a model.
- **Accept a disclaimer once per engagement.** Twelve regions, each with its own
  statement of the law that applies, detected from your locale and changeable.
  The record names who accepted it, on which machine, and which version of the
  text, so a later change asks you to accept again.
- **Defensive scans need no extra tools.** Nine built-in checks cover response
  headers, TLS certificates, DNS, open ports, robots.txt, committed secrets,
  infrastructure-as-code, dependency vulnerabilities and fingerprints. Ten
  optional tools (nmap, nuclei, trivy and others) add more for a scan run from
  the chat; the panel lists them with how strongly it recommends each one, what
  installing it changes on your machine, and a one-click install that asks
  first and reports whether it worked.
- **Offensive scans run in a sandbox.** A deep scan can attempt exploits, but
  only inside a container or a temporary folder, under a rate limit and a time
  budget, with a stop button that works within one step. Stopping keeps and
  records every finding the scan already reached. A sandboxed command may run
  for up to two minutes, so a slow exploit is not reported as failed, and Stop
  still interrupts it at once. Cleanup is verified both ways, and after a
  successful exploit only read-only commands may run.
- **Honest results.** Every attempt ends in one of four verdicts — not
  vulnerable, exploit failed, could not determine, or verified access — and a
  failure always says why. A check that could not run is always named, so a
  scan never reads as clean when it was merely incomplete.
- **Evidence you can check.** Each step is an entry in an append-only chain
  that proves the report was not edited afterwards, with the raw evidence stored
  beside it and an offline replay.
- **Reports you can hand over.** Markdown, JSON and SARIF exports, each carrying
  the authorization record.

Long scans can run in the panel or in the chat; a deep run keeps going if you
close the panel and can be steered by typing.

Other changes:

- **Panels now fit narrow widths.** The chat, Agent Activity, Compare Models,
  MCP connections, Team Studio, Tools and the welcome page wrap, stack or hide
  less important columns when you make them narrow, instead of scrolling
  sideways. A hidden column's values show in a short line under the row's
  name, and on a very narrow panel each table row becomes a small card. Code
  and diffs still scroll sideways inside their own box, so lines are never
  wrapped in a misleading way.
- **Shorter MCP approval choices.** The approval menu for a tool server now
  reads "Ask before changes", "Ask before every call" or "Trusted", with a
  one-line explanation of the chosen setting under it.
- **No more false "repeated the same action" stops for changing folder.** An
  agent that runs `cd <folder>` (or `pwd`) on its own between its real commands
  is no longer stopped for repeating itself. Changing folder does nothing new on
  its own, so the loop guard now ignores it and only counts commands that do
  work. A `cd` to a folder that does not exist still counts, so an agent
  stuck on it is caught.
- **Stuck agents repeating a failing shell command are now caught.** Shell
  errors carried a random temporary file name, so each repeat looked new and
  the loop guard never stepped in. That name is now ignored when results are
  compared.
- **The chat asks you to connect NEAR AI first.** Until the project has a
  working profile (a saved NEAR AI key or local runtime that was checked
  and works), the empty chat shows only **Connect NEAR AI to start** with a
  **Set up a new profile** button. If a saved profile needs its key checked
  again, or you have saved profiles but none is chosen for this project, it
  also offers **Choose a profile** and says why. With no folder open, it
  asks you to open one first. The suggestions to start a new project,
  onboard an existing one or show progress appear once you are connected,
  without reloading. The new command **NEAR AI: Set Up a New Profile**
  starts the same setup, and the chat's sign-in message now offers the same
  two buttons.
- **After you connect NEAR AI, the extension suggests what to do next in
  the chat.** The chat comes into view, and nothing opens over your work.
  If the project has no team yet, the chat starts with setting up your
  project team, and a short message says your next steps are in the chat.
  If the project already has a team, the message offers **Review project
  team** and **More setup steps**.
- **NEAR AI: Project Setup** lists every setup step: your project team, a
  spending limit, web search, or going straight to the chat. Steps you have
  done are marked done. It is also on the Tools tab, and the chat's card
  links to it.
- **The empty chat shows a small card while the project has no team**, with
  a button to set one up and an **All setup steps** link. **Not now** hides
  the card for this project only.
- **The NEAR AI welcome page has a new step, Choose your team**, right after
  connecting NEAR AI, with a button to set up your project team.

## 0.4.13

Replies in the chat are easier to read. Tables, quotes and crossed-out text
now show the way the model wrote them, and links in replies open the right
page.

- **Tables in replies now show as real tables** with headers and lined-up
  columns. Before, a table showed up as lines of text full of dividers and
  dashes. Wide tables scroll sideways inside the message, and keep their
  place while the reply is still arriving. To scroll one with the keyboard,
  press Tab until the table is selected, then use the arrow keys. Screen
  readers name each table by its column headings.
- **Quoted text stays together as one quote**, and crossed-out text shows
  crossed out. Before, each line of a longer quote showed as a separate
  quote, and crossed-out text showed with its marks around it.
- **Links in replies open the right page** even when the address has
  characters like underscores, tildes or asterisks in it. Before, some of
  these links went to a broken address.
- **Reporting a security problem is now private.** The security notes
  explain how to send a report that only the maintainers can see, from the
  Security tab of the project's GitHub page.

## 0.4.12

An agent doing useful work could be stopped as if it were stuck, and the chat
then blamed the turn limit. This release fixes the stuck-agent check and makes
every stop honest and easy to continue.

- **Productive runs are no longer stopped as loops.** The check compared shell
  commands by their first two words, so an agent that starts every command
  with `cd <folder> &&` looked like it was repeating one action: a run doing
  `cd <folder> && npm test`, `cd <folder> && git status`, and so on was
  stopped after 14 different commands. The check now compares the whole
  command (ignoring a leading `cd <folder> &&` and variable settings), and an
  action counts as repeated only when it also gave the same result as before.
  If the output changed, it is progress, not a loop.
- **A stuck agent gets a chance to recover.** An agent that really does repeat
  the same action with the same result is first nudged, then warned that its
  result has not changed and told to change approach (try a different
  command, read the error, or finish and report). It is stopped only if it
  still repeats after that.
- **An honest stop, with Continue.** A stopped run now says why: "Stopped: the
  agent kept repeating <action> with the same result.", or, when the turn
  limit was really reached, "Stopped after reaching the turn limit (<N>
  turns)." Both come with a **Continue** button that sends "Continue." for
  you, so you no longer have to type it. Nothing continues until you click.
  Agent Activity history shows such runs as "Stuck", and a sub-agent that is
  stopped tells the agent that started it that it did not finish.

## 0.4.11

Agent runs in code-server (VS Code in a browser) could stop or stall without
any sign in the chat. This release makes those interruptions visible and
recoverable.

- **A run cut off by code-server or a reload can be resumed.** When a
  code-server tab stays disconnected (Chrome pauses background tabs) while
  another code-server tab connects, code-server closes the window's extension
  host about 5 minutes later. Every run in that window died, and the window
  came back empty: one run had made 79 requests and never finished. A reload
  or a crash has the same effect. Runs now save their state after every step
  and record when they start and end, in the extension's own storage on this
  computer (IDs, times, and tool names only). When the chat opens again, the
  conversation is reopened and says "This run was cut off (the window or
  code-server closed it) at" the time, with **Resume** and **Dismiss**.
  Resume continues from the last saved step and tells the agent which steps
  had started but were never recorded, so it checks whether they already
  happened instead of doing them twice. Nothing resumes until you click.
- **Waiting approvals and questions are noticed in a background tab.** The
  "waiting for your approval" notice only appeared when the chat was hidden,
  and a background browser tab still counts as showing the chat, so nothing
  told you. The notice now also appears when the VS Code window (or its
  browser tab) is not focused, and when you come back to the window while a
  prompt is still waiting and was not announced yet. It never appears twice
  for the same prompt, and the waiting badge stays.
- **Advice for code-server and remote windows: proxy support.** VS Code's
  proxy support (`http.proxySupport`, on by default) asks the window which
  proxy to use for every new network connection. A browser tab that the
  browser has paused cannot answer, so every new connection waited: one run
  made no requests for 26 minutes and carried on the moment its tab was shown
  again. When VS Code runs in a browser or a remote window, proxy support is
  on, and no proxy is set (no `http.proxy` setting and no `HTTP_PROXY` or
  `HTTPS_PROXY` variable), the extension now explains this once and offers
  **Turn off proxy support**, which sets `http.proxySupport` to `"off"` in
  your user settings, and only when you click it. **Not now** asks again in
  two weeks; **Don't ask again** never asks.
- **Tip for code-server users:** if you don't use a proxy, set
  `"http.proxySupport": "off"` in your user settings. Keep the code-server tab
  open during long runs: code-server's 5-minute cap on a disconnected window
  can still stop runs, and Resume then picks them up.

## 0.4.10

- **Usage reporting no longer looks broken while NEAR AI Cloud is missing its
  usage summary.** NEAR AI Cloud documents the usage summary that a reporting
  token reads, but it currently answers HTTP 404 to it. The token test used to
  report that as a failure and offer **Fix token**, which could not help.
  Now the token is kept and its test says it is saved. The figures are this
  computer's own, and NEAR is asked again every hour, so NEAR's total appears
  on its own once NEAR turns the summary on.
- **The token's messages agree with each other.** The token link said "Using
  NEAR's total" whenever a token was stored, while the spend tooltip still
  said to set one. Both now follow the same state: using NEAR's total, waiting
  for NEAR's first answer, NEAR not offering its total yet, or NEAR's total
  failing. Without a token they say how to set one.

## 0.4.9

- **Signing in works from code-server on another computer.** When VS Code runs
  in the browser (code-server) and that browser is on a different computer, for
  example over Tailscale, NEAR AI Cloud sent the sign-in to a `localhost`
  address on the browser's computer, which doesn't load, and the setup waited
  until it timed out. VS Code now shows a box for the sign-in address as soon as
  the browser opens: copy the address of the page that won't load into it and
  the token is made. If the browser is on the same computer, the sign-in still
  finishes on its own and the box closes.

## 0.4.8

- **Set up usage reporting by signing in.** **Set Usage Reporting Token** (and
  every "set up usage reporting" link) now offers **Sign in with GitHub** or
  **Sign in with Google**. You sign in to NEAR AI Cloud in your browser once, and
  the extension creates a read-only usage token with no expiry. It tests the
  token and starts showing NEAR's own spend figures, with no console session
  token to find and no API call to make by hand. The sign-in is used once and
  then signed out; only the read-only token is kept, in VS Code's encrypted
  secret storage. Signing in again replaces the token and revokes the old one.
  Needs an owner or admin of the API key's organization. Pasting a token still
  works.
- **Fix token signs in again.** When NEAR rejects the token, **Fix token** in
  Agent Activity and in the test result goes straight to the sign-in instead
  of to Settings.

## 0.4.7

- **The guide covers 0.4.6's features.** The README, which is also the Marketplace page, now explains
  Compare Models, the approval card's "Always allow" button and what Auto
  approve clears on its own, and the Spend section in Agent Activity. The
  `nearAi.agent.allowCommands` row in the settings table describes how
  entries are matched. No change to how the extension works.

## 0.4.6

- **Auto approve asks far less.** The safety check's model often used up its
  answer length thinking and never gave a verdict, so the command asked you
  ("the safety model's answer could not be read"). It now answers directly,
  falls back to a second private model when the first is busy, and the card
  says exactly why a check failed. The rules also clear more everyday work on
  their own: deleting single files and build output (dist, node_modules, …),
  installs from the lockfile, git pull, fetch, switch, stash, merge, revert and
  cherry-pick, sed and awk that only print or substitute, wildcards that can
  only match inside the workspace, and the project's own node_modules tools.
- **Always allow from the approval card.** "Always allow "git push" in this
  workspace" adds the command to `nearAi.agent.allowCommands` and applies at
  once, including to each part of `cd app && git push`. Entries stay narrow:
  `npm run build` rather than all scripts, never `--force`, a typed URL, `rm`,
  `curl`, or an interpreter like `node` or `bash`.
- **After a web search or MCP result, the safety check still runs.** Unclear
  commands go to the private safety model, which is told the run read outside
  content and is stricter; commands that can reach the network still ask.
- **NEAR AI: Compare Models.** A leaderboard ranks every model you have tested
  (overall score out of 10, coding, research, planning and execution, pass
  rate, speed, cost, stalls, privacy, and the roles it holds). Below it, pick
  2–6 models, see a cost estimate before anything is spent, and either reuse
  saved results (so only a new model is run) or run everything again. Every
  comparison is saved. "Use as…" puts a model into the main, deep, standard or
  fast slot or an agent role in one click, with Undo. Also on the Tools page.
- **Agent Activity shows where costs come from.** A Spend section says whether
  figures are actual NEAR billing (your usage reporting token works), reconciled
  per request, or estimated from list prices, with **Test token now** and **Fix
  token**. It shows spend for today, this week, this month and this year, the
  7-day burn rate, and **Top up credits** (opens the NEAR AI Cloud console;
  NEAR has no payment link that works without signing in, and its API does not
  give the remaining balance to an API key or reporting token). A stored
  reporting token is now used from the start, not only after the first chat.

## 0.4.5

- **Team Studio.** **NEAR AI: Team Studio** shows your teams as cards (members,
  roles, models with TEE / Local / Forwarded badges) and walks you through
  building one: purpose and a starting point, members and roles, models, tools
  and what each will run or ask, then instructions with a live preview of the
  Markdown it saves. Existing teams open in tabs with version history, diffs
  and restore. The Markdown file stays the source of truth: anything you wrote
  by hand is kept, and edits made outside the studio are picked up. Leaving with
  unsaved changes asks first, and closing the panel keeps them as a draft.
- **A reply that stops is retried, then reported.** A model reply that NEAR cuts
  off, or that stops sending anything, used to end the run silently with no
  answer. It is now retried up to three times, and then the chat says which
  model stopped responding and that your work is kept. Agent Activity shows the
  run as failed instead of running. Stop now ends a reply immediately.
- **Set up exact spend tracking from Settings.** The NEAR AI settings, the chat's
  spend line, Spending Limits, Agent Activity and the Tools page link to **Set
  usage reporting token**, with how to create one. The token is kept in
  SecretStorage; one pasted into a setting by mistake is moved there.
- **Agent Activity keeps up.** Runs that finished quickly could be missing from
  History and the totals until something else changed. They now appear within
  about a second.
- Tool descriptions no longer stop short at "e.g.".

## 0.4.4

- **Several conversations at once.** Tabs above the chat let you start a new
  conversation while others keep running in the background. Each tab shows
  whether it is running, waiting for you, stopped or done, and a notice says
  when a background conversation needs you. Switching brings back its prompts,
  agents, tasks and draft. Stop stops only the conversation on screen; the
  emergency stop still stops everything. Open conversations come back after a
  reload, and a run cut off by the reload is marked stopped.
- **Redirect a running agent.** The message box stays open during a run, with
  separate Send and Stop buttons (Esc in an empty box also stops). A message
  sent mid-run reaches the agent after its current step and takes precedence
  over its plan. If the run ends first, it is sent as a new message.
- **Spend that matches NEAR AI Cloud.** Every billable call is recorded once,
  including sub-agents, Auto safety checks, summaries, attachments and images,
  and NEAR confirms each request's actual cost. The status line, Agent
  Activity, Spending Limits and reply footers all show the same figure:
  confirmed plus pending, or NEAR's own total when you set a usage reporting
  token (**NEAR AI: Set Usage Reporting Token**). "Today" is your local day
  (`nearAi.spend.dayBoundary`), and the daily limit uses the same figure. NEAR's
  spend-limit response is shown as "NEAR spend limit reached".
- **Agent Activity is an overview.** Running agents with their state (including
  "Rate limited · retry in 12s") and cost; totals for this conversation, today
  or the last 7 days, with the time split, tool calls, approvals and problems by
  model; and a history of past runs that opens each conversation. **Export
  details** still saves the raw record.
- **Export usage and activity.** **NEAR AI: Export Usage and Activity…** saves
  CSV or JSON by project and date range, with no prompt text.
- **The Tools page is a directory.** It lists the workflows, agents and teams,
  built-in tools (and whether each runs or asks under your approval mode), MCP
  servers and models the agents can use, with **Use in chat** buttons. The old
  second chat is gone. **Use in chat** keeps what you had typed.
- **Tasks keep up with sub-agents.** A listed task is marked done as soon as
  the agent working on it finishes, and each sub-agent's own steps show in its
  row ("1/2 steps").
- **Prompts stay in view until you answer.** Approvals, agent questions and
  Open-GSD choices are pinned above the message box instead of scrolling away.
  When several wait, you step through them ("1 of 3 waiting"), each saying
  which agent asks. The chat keeps a line where each was asked that records
  the outcome. The sidebar shows a badge while anything waits, and a reloaded
  chat shows the prompts again.
- **Open-GSD runs without constant prompts in Auto.** The Open-GSD runtime the
  extension installs is trusted, so its workflow tool calls run. They still
  ask when a copy of the tool inside the workspace would run instead, or when
  the command was edited or does something risky.
- **Clearer reasons.** When Auto asks because the safety check was skipped or
  NEAR was too busy to answer, the card says so.
- **The approval menu says what each mode allows.** Each mode shows a
  one-line summary, and the menu works from the keyboard.
- **The task list collapses** like the running-agents panel.

## 0.4.3

- **Approval mode in the chat bar.** A picker beside the model chooses how
  much the agent may do without asking: Ask before edits, Edits auto, Auto,
  or Full auto. Full auto asks you to confirm first and shows in the warning
  colour. The choice is saved to your user settings, or to the project's when
  the project already sets it, and the next run uses it. During an emergency
  stop the picker shows **Stopped**.
- **No more pricing requests NEAR doesn't support.** The model list stops
  asking NEAR AI Cloud for prices once it answers that the request is not
  implemented.

## 0.4.2

- **Auto approve.** A new `auto` value for `nearAi.actionPolicy` runs what
  passes a safety check and asks only about the rest, with the reason on the
  card. Ordinary build, test, lint, git and in-workspace file commands run.
  Deleting, pushing, publishing or deploying, piping a download into a shell,
  uploads, credential or knowledge-base paths, and writes outside the
  workspace ask. A command the rules can't place goes to a private (TEE or
  local) model, `nearAi.agent.safetyModel`; if it errors, times out, or no
  private model is available, the command asks.
- **Rate limits no longer turn into a storm.** A 429 from NEAR AI is no longer
  retried within a fraction of a second. The agent waits as long as NEAR asks
  (`Retry-After`), with some randomness, and agents using the same model share
  one pause, so only one request checks whether the model is back. After about
  four minutes of continuous rate limiting the run stops and keeps its work,
  instead of retrying forever.
- **NEAR's own error message.** Failed requests show what NEAR said and the
  request ID, and the new **NEAR AI** output channel logs status, model,
  request ID and rate-limit headers.
- **The model list survives a failed refresh.** If NEAR is busy when the list
  is refreshed, the last good list keeps working.
- **Easier-to-read chat.** Code is smaller than the chat text and tinted, so it
  stands apart, and `#` and `##` headings step up in size. The running-agents
  panel collapses to one line, and stays collapsed across reloads.

## 0.4.1

- **Security fixes in the build tooling.** The packaging tool's dependencies
  `undici` (TLS certificate check bypass, cross-origin cache disclosure, and
  denial-of-service advisories) and `@azure/msal-node` (authorization code flow
  disclosure) are updated to fixed versions (7.30.1 and 7.1.2). Neither is part
  of the installed extension; they ran only when the extension was built.
- **Eval output stays out of the package.** Live model-eval results are no
  longer picked up when the extension is packaged.
- **Tests stay honest.** When an agent edits a test that existed before the
  task and it ends up with fewer tests or assertions, or more skipped cases,
  the agent is told at once and reminded before it may finish. It restores
  the test and fixes the code, or says why the change was asked for. In the
  model eval, a cheaper model had "passed" a task by deleting the failing
  assertion.

## 0.4.0

A native agent that runs on NEAR AI's private models, with no proprietary
runtime in between. It is built for more than coding: research, presales and
solution design, writing, and data analysis projects get their own teams and
workflows.

- **See progress as it happens.** Each running agent shows what it is doing,
  how long it has run, and its tool calls. Click one to open its activity. A
  progress line in the chat sums up long, quiet stretches.
- **Fewer, faster turns.** Web searches and page fetches an agent asks for
  together now run in parallel, like file reads, and agents are told to batch
  independent lookups. Agent Activity shows where each agent's time goes
  (waiting, generating, tools) and how much of its output is reasoning.

- **Agent in the sidebar.** It reads, searches, edits and runs commands in your
  project, with approval cards that show diffs and commands, per-run grants,
  and one-click **Revert**.
- **Open-GSD workflows on NEAR AI.** `/gsd-…` commands run on the native runner
  with sub-agents (including background ones you can pause or stop), questions,
  and context management. Open-GSD is installed per user and checked against
  each new release. Parallel executors each work in their own git worktree on
  a `worktree-agent-…` branch (kept in the extension's storage, not your
  project), and GSD merges them back. Workflows that chain to the next command
  (`--auto`, `/gsd-next`) work too.
- **Agent teams.** Teams are Markdown files you edit, version, duplicate,
  archive and import. Run one with `/team:<name>`. **Set Up Project Team**
  drafts one from a few questions.
- **Attachments.** Images are read by a vision model and audio is transcribed
  with Whisper. PDFs, .docx, .pptx, and .xlsx are read on your machine and
  their text is included, as are text files.
- **Requires VS Code 1.101 or newer**, which runs extensions on Node 22 or
  later (Node 20 is end of life).
- **Image generation** with NEAR's image models, saved through checkpoints.
- **Project memory.** Remember and Recall, reviewed with **Manage Project
  Memory**.
- **Verify signature.** Checks NEAR's signature over the exact request and
  response, and that a genuine Intel TDX quote, fresh for this check, binds
  the signing key.
- **Local and hybrid runtimes.** Ollama, LM Studio, vLLM, or any
  OpenAI-compatible server, alone or alongside NEAR AI Cloud.
- **Agent Activity.** A live page of every agent's prompts, replies,
  reasoning, and tool calls with per-agent tokens, cost, speed, and failures;
  pause, filter, search, and export. In memory only, time- and size-limited,
  and streamed only while visible.
- **MCP connections.** Add remote or local MCP servers (official SDK client),
  switch them on per project, scope them to team members with `mcp:<server>`,
  choose approval per server, switch tools off, and see status and usage on
  the MCP Connections page. Secrets stay in SecretStorage; tools that can
  change data ask in every mode by default; results are fenced as outside
  content.
- **Privacy hardening.** Saved conversations are encrypted at rest
  (AES-256-GCM, key in SecretStorage); environment variables that look like
  credentials are kept out of the agent's shell (`nearAi.agent.shellEnvAllow`
  to pass specific ones) and out of the Open-GSD installer; the search setup
  says that Brave and Tavily keys link queries to your account; SECURITY.md
  lists every connection the extension makes.
- **Prompt caching counted and kept effective.** NEAR caches prompt prefixes
  automatically; estimates and run budgets now price cached input at NEAR's
  cache-read rate (GLM 5.3: $0.45 instead of $1.80 per million), context
  trimming advances in steps so the cached prefix stays stable, and Agent
  Activity shows each agent's cache hit rate.
- **Runaway protection.** A run and all its sub-agents stop cleanly, keeping
  their work, at a per-run cost cap (`nearAi.agent.maxRunCostUsd`, default $5),
  what is left of the daily spend limit, or a token cap, checked before every
  model turn; an agent repeating the same action is nudged and then stopped.
  Each reply is capped at `nearAi.agent.maxOutputTokens` (default 32,000,
  never above the model's limit); a reply cut off there is followed by a
  request to continue more concisely, and repeated cut-offs stop the agent.
  An approval nobody answers is declined after
  `nearAi.agent.approvalTimeoutMinutes` (default 15) so an unattended run
  carries on, and a notification appears when an agent is waiting while the
  chat is hidden. **NEAR AI: Spending Limits** shows today's spend and changes the daily,
  per-run cost, and per-run token limits for you or one workspace.
- **Project types.** Set Up Project Team now starts from a project type
  (software, research, presales, writing, data, general) with a tailored team
  and AGENTS.md guidance for each stage of the GSD cycle, including a red-team
  stage before verification whose unfixed findings are always reported.
- **Agents read AGENTS.md and CLAUDE.md** project instructions.
- **Web search and prompt-injection defenses.** WebSearch (SearXNG, Brave,
  or Tavily), WebFetch for pages and documents, and CheckCitations for every
  agent. Hidden content is removed, likely injections are flagged and shown in
  Agent Activity, outside content is fenced, and after reading it, network
  commands, data-carrying URLs, and research agents' writes outside
  `.planning/` always ask, even in fully-autonomous mode.
- **SBOM and vulnerability checks.** A CycloneDX SBOM per project from its
  lockfiles (npm, pnpm, yarn, Python, Go, Rust, PHP, Ruby, .NET, Java), checked
  on OSV.dev with runtimes on endoflife.date; Problems entries, a status-bar
  shield, checks on open and on lockfile changes, an agent `SecurityScan`
  tool, and a GitHub Actions workflow. Asks once per project before sending
  package names and versions. The extension ships its own SBOM.
- **Graphics and decks.** Agents can trace images into SVG, render SVG to
  PNG, and build PowerPoint decks with sharp SVG images, all on this machine.
- **Resumable chats.** Conversation history is kept on this machine.
- **Runs recover by themselves.** If NEAR AI stops sending mid-answer for two
  minutes, drops the connection, or is busy, that step is retried (quickly at
  first, then every minute) and the run carries on from where it was. An
  answer that is still arriving is never cut off. **Stop** ends it.
- **Security hardening.**
  - Commands run without approval only when written as plain words.
  - `.git/` and the extension's settings are protected from silent writes.
  - Credential files ask first, however their path is written.
  - Fetches are restricted to public https addresses.
  - Sub-agents never use a less private model than the one you picked.
  - Keys are bound to their endpoint.
- **Default model:** GLM 5.3, which runs in NEAR's TEE.
- **Models per agent role** (`nearAi.agent.roleModels`): GSD's research,
  synthesis, and mapping roles default to the fast tier (Qwen3.6-35B-A3B, also
  TEE-attested). In a live eval of 24 tasks per model it researched as well as
  GLM 5.3 at about a tenth of the cost and several times the speed of GLM 5.3
  Flash, but cut corners on tests when building code, so planners, executors,
  verifiers, and red teams keep GLM 5.3. A team member's own `model:` line wins.

## 0.3.1

- Marketplace listing rewritten.

## 0.3.0

- Native VS Code chat styling and an `@nearAi` chat participant.
- The extension leaves projects it didn't set up untouched.
