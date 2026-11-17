# 70-17a: PR #70 review carry-overs, fixed on the PR 3 branch

Branch `feat/gate-floor`, on top of plan 17 (`96cb9b3`). One commit per item. Each fix replaces a heuristic with an invariant and a test that would
catch the next case of the same class. Every new test was seen failing first (the implementation set aside with a tagged stash, then applied back by SHA).

## Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (once, at the end, under the memory cap): 3289 tests, 3280 passed, 0 failed, 9 skipped (the skips are existing ones; none is new).
- `package.json` and `package-lock.json`: unchanged. No new packages.

## Per item

### 1. Policy event ids were not on any known list

- Commit `78b2d9e`.
- `POLICY_EVENT_IDS` (`policy.created`, `policy.renewed`, `policy.reset`, `policy.load`) is a named list in `src/domain/gate/bundle.ts`, kept apart
  from `GATE_RULE_IDS` (events, not rules). `BundleEvent` is derived from it. `RECORD_RULE_IDS` in `decide.ts` joins both.
- Invariant: `validateDecisionRecord` refuses a record whose rule (`authorizations[].policy.name`) is not in `RECORD_RULE_IDS`, or whose
  `api.operation` is neither a capability verb nor a policy event. The decision log runs that check before every write, so a writer that invents an id is
  caught at its first record (reported once through `onProblem`, never failing a decision).
- Tests (`src/test/gateRecordIds.test.ts`): every known id validates and an invented one is refused and not written; the host's real created, load and
  reset events land on disk with known ids; a scan of all of `src` finds every rule-shaped string literal and fails on one that is neither a known id nor
  named, with its reason, as something else (a Team Mode event, a file name, a field path).

### 2. SECURITY.md overclaimed what is removed from decision records

- Commit `e3cabf1`.
- `redactCredentialArguments` in `src/domain/redaction.ts` removes credentials by where they sit: the user part of a URL; the value of `-u`, `--user`,
  `--proxy-user`, `-U` when it holds a colon; the value of an option named for a password, passphrase, token, secret, API key or credential (not the
  `-file`/`-stdin`/`-path` forms); credential headers (`Authorization` of any scheme, `Proxy-Authorization`, `Cookie`, `Private-Token`,
  `X-...-Token`/`-Key`/`-Auth`/`-Secret`); an environment assignment or URL query parameter named for one (a `$VAR` reference is kept). It is idempotent.
- Invariant: `redactRecord` runs it over every string of a record before the token shapes, and `validateDecisionRecord` refuses a record in which any
  string still carries a credential argument, so no writer can skip it.
- SECURITY.md now lists exactly what is removed and what is not (a plain positional password such as `sshpass -p`, `mysql -p...`, `htpasswd -b`; one a
  script reads; one built by command substitution; names not listed).
- Tests (`src/test/gateRecordRedaction.test.ts`): one per class with near misses that must survive, the documented gaps asserted as gaps, a record built
  end to end, a refused unredacted record, and a Bash call through `gateToolCall`. `gateDocs.test.ts` checks the new wording and runs each documented
  example against the code; its older phrase check (`secrets are removed`, the overclaim itself) now checks the new sentence.
- Not changed: `redactSecrets` (the activity feed and other surfaces) does not use the new classes; only decision records do. Widening the shared
  function is a separate change with its own surfaces to check.

### 3. The host kept a decision log per project root forever

- Commit `ca803b6`.
- `GateHost.retainProjectLogs(openRoots)` lets go of every project log whose folder is not open (never the install log or the open project's). Activation
  calls it on each `onDidChangeWorkspaceFolders`. Independently of folder events, the host holds at most `MAX_PROJECT_LOGS` (8) project logs and lets go
  of the least recently used one.
- A runtime now looks its log up at each record instead of holding it, so a run still going in a closed folder reopens the log and `flush()` always
  waits for it; a log let go with records queued is still awaited by `flush()`. No record is lost.
- Tests (`src/test/gateHostLogs.test.ts`): the cap and LRU order with every record on disk, retention with a running run, the open project kept, and
  activation through the stubbed editor (the shared vscode stub now fires `onDidChangeWorkspaceFolders` from `setWorkspaceFolders`).
- Known cost: a log reopened after being let go reports a persistent write failure again (once per reopen, not once per session).

### 4. A placeholder web search provider reached the catalog's manifests

- Commit `659343e`.
- `builtInTools()` has no stand-in provider: absent or `null` means none is set up, and WebSearch is built with no provider, so its manifest declares no
  host. `webSearchTool(undefined)` now has the shorthand `plan`, as its manifest already said: the Pitfall 10 agreement test had passed only because of
  the stand-in, and in a real install with no search set up the shorthand and manifest disagreed.
- Behaviour change to note: with no search provider, a WebSearch call (which only returns "web search is not set up") no longer asks in approve-risky.
- Tests (`src/test/gateManifests.test.ts`): no default-built tool names an RFC 2606 or RFC 6761 placeholder host; the catalog and Tools page sources
  name none; the page with search off or with no host lists none; a no-provider call is recorded as a plan naming no host. The page comparisons build the
  catalog with the same configured provider as the page.

### 5. Team Studio captured its folder when the panel opened

- Commit `23c0ed5`.
- `TeamStudioDeps.root` is a function asked at each use (listing, `hasProject`, display paths, project save and its project type, role tests, share
  default). `onDidChangeFolder` refreshes the page. The panel's project team watcher moves to the new folder's team file and the old watcher is disposed.
  A project save reads the folder once, so the team file and the project type land in the same folder. A role test run keeps the folder it started in.
- Tests (`src/test/teamStudioPage.test.ts`): a folder change with and without notifying the studio (listing, no-folder error, save goes to the folder
  open now, old folder untouched); the real panel with a stubbed editor follows a folder change and moves its watcher.

### 6. Calls rejected before the gate wrote no record

- Commit `62c70ea`.
- `PRE_GATE_RULES` (`call.unknown-tool`, `call.check-failed`) are part of `GATE_RULE_IDS`. `recordRefusedBeforeGate` in `gateAdapter.ts` writes a
  `denied` record naming the tool (never its arguments), with the tool's own shorthand when it exists and fixed words, never the error text.
- The loop records an unknown tool name, and a `forbidden`, `sensitive`, `risky` or `preview` hook that throws. The preview runs after the gate asked, so
  its record closes that ask.
- Tests (`src/test/gateEnumeration.test.ts`): both cases through a scripted run, each hook, nothing ran, no argument or error text recorded.
- Deferred: a call whose arguments do not parse still writes no record. An existing plan 13 test states that on purpose ("reaches no decision and no
  execution ... writes no tool decision record"), so changing it needs an owner decision. If wanted, it is one more `recordRefusedBeforeGate` call with a
  third rule id.

### 7. The tool-run scan missed reflection

- Commit `2846b89`.
- The type-checked scan (`src/test/helpers/toolRunScan.ts`) has two new kinds, both failing the production check: `reflect` (a `Reflect.*` call given a
  tool, a table of tools or an untyped value; `Object.values`, `entries`, `getOwnPropertyDescriptor(s)`, `assign`, `fromEntries` given a tool or a table
  of tools) and `cast` (a tool or a tool table cast to a type that holds no tool: the other way the type, and so the scan, is lost).
- Planted sources prove each is found (`Reflect.get`, `Reflect.apply`, Reflect over a table and over `unknown`, `Object.values`/`entries` over a tool and a
  table, a computed key on a table, dropping casts), and that harmless reflection is not.
- The one production site it found: `extractFinding` in `src/services/cyberRun.ts` cast a tool to a narrower type to read `findingFrom`; it now widens the
  tool's type instead, with the same behaviour.
- Still not seen (stated in the scan's header): a value built from strings at run time, or a structural type with no `run` reached without a cast or an
  `any`. Neither can be written without one of the reported kinds.

## Review round 1 (PR #74)

Four commits on `feat/gate-floor`, one per finding (findings 1 and 2 share one, as both change `floorFactsFor`). Every new test was seen failing against
the unchanged source first (the tests compiled and ran before the implementation existed). Each fix closes the class the review named, not the instance.

### Results

- Lint (`tsc --noEmit`): clean.
- Full `npm test` (once, at the end, 6G cap): 3330 tests, 3321 passed, 0 failed, 0 cancelled, 9 skipped (the same 9 as before).
- `node scripts/secret-scan.mjs --range origin/main..HEAD`: clean.
- `package.json` and `package-lock.json`: unchanged by this round. No activation or webview code changed, so the e2e suite was not run.

### 1. [BLOCKER] The classifier's recursion had no bound on some paths, and its stack overflow failed open

- Commit `1b2f27b`.
- Reproduced first: `if ` x5000 + `git push`, and the same with `sudo`, `exec`, `{`, `then`, threw `RangeError` in the classifier; `floorFactsFor`
  returned `{ effects: [] }`, so the push ran unasked in fully-autonomous.
- One bound, `MAX_NESTING` (4), checked first by `tooDeep()` in both entry points every recursive path goes through, `classifyText` and
  `classifyWords`. Every recursion site was found: `RUNS_WHAT_FOLLOWS` words, `noteRunsAs` (sudo, doas, pkexec, su -c), `noteInlineScript` (eval,
  `sh -c` and the other shells), `checkScript` (npm scripts), `classifyNpx`, `xargs` (piped and plain), `find -exec`, `$(...)`, `NAME=$(...)` and the
  Open-GSD preamble remainder. `classifyNpx` passed the same depth (now `depth + 1`), and `checkScript` had its own silent `depth >= 3` skip that read a
  deeper script as having no effects (removed: the one bound applies).
- Past the bound the classifier calls `beyondReach()`, which marks the whole call's effect frame: `CommandClassification.effectsUnknown` carries the
  reason, and a command not read whole is never `safe` (the verdict becomes `unknown`).
- Non-recursive blowups: `MAX_COMMAND_LENGTH` (100,000 characters, checked before anything is read) and `MAX_COMMAND_WORDS` (10,000 lexed words, per
  line read) give the same unknown effects. Measured before: a 1 MB command took about 5 s to classify, and the cost is per word (about 33 µs for a
  path-like word), so the word cap bounds a call at about a third of a second. A 1,500-line here-document (about 6,000 words, since the lexer reads its
  text as words) is still read.
- The gate: `gateToolCall` gives a call whose command has unknown effects an empty effect list, so `decide()` asks with a person there and refuses with
  nobody (`manifest.effects-unknown`), in every mode; a credential store the command names is still refused first.
- Tests (`src/test/commandBounds.test.ts`): 24 wrapper kinds, each read once (the push is seen), then nested past the bound and thousands deep (no throw,
  effects unknown, never safe); npm script chains and a self-running script; the loop-read wrappers (time, nohup, nice, command, env, timeout, subshell
  parentheses) read whole through thousands; both caps and a megabyte; a source scan that every recursive call goes one level deeper and both entry
  points check the bound first; the gate in fully-autonomous with a person and with nobody.
- Docs: `FLOOR_EFFECTS_CANNOT_SEE_TEXT` and SECURITY.md no longer list "commands nested more than four levels deep" as something that runs unread; they
  say such a command, or one too long to read, asks and is refused with nobody. `gateDocs` now checks five levels and a too-long command have unknown
  effects (it asserted they had no tag) and still checks four levels are read.
- Deliberate test change: `commandSafety.test.ts` asserted a self-referencing script (`test: npm test`) is `safe`, which was the fail-open result. It now
  asserts `unknown` with unknown effects; its intent (no endless loop) is kept.
- Known UX cost: a deny-listed command that is also too deep or too long now asks instead of being refused by the deny list (the unknown-effects step comes
  before the settings layer). Nothing runs without a person.

### 2. [MAJOR] `floorFactsFor` failed open on any reader failure

- Commit `1b2f27b`.
- `floorFactsFor` now returns `effectsUnknown` when the classifier throws, when it stops reading (finding 1), and when the credential-store resolver
  throws (it used to `.catch(() => ({}))`, i.e. "reaches nothing"). The readers are injectable (`FloorReaders`, passed by tests through
  `GateCallOptions.floorReaders`); nothing in production passes them.
- Tests: a throwing classifier and a throwing resolver, each through `floorFactsFor` and through `gateToolCall` in fully-autonomous: asks with a person,
  refused with nobody; the same command with working readers is allowed, as before.
- Audit of the other catches in `gateAdapter.ts` and `decide.ts`: `decide.ts` has none. In `gateAdapter.ts`, `bundleHashOf`, `keep` and
  `recordRefusedBeforeGate` only affect records; `decideOrRefuse` keeps the caller's refusal; `recordApprovalReply` denies on a throw; `realFolder` falls
  back to the path as written. `readCallPaths` treats a throwing `resolveInWorkspace` as "not resolved": its credential checks still run on the path as
  written, and the tool itself resolves through the same function and refuses the call, so nothing runs on a path the gate could not read. No other catch
  yields empty effects or facts.

### 3. [MINOR] No changelog entry

- Commit `f022f72`.
- `## Unreleased` at the top of CHANGELOG.md, with a summary line and bold-led bullets: Full auto asks before writes into git's and NEAR AI's own
  folders, publishing and destruction (no Always allow, refused with nobody there; everything else still runs); key and credential stores and the
  extension's identity and policy files are refused in every mode (a project file named like VS Code's secrets database is not); a command too deep or
  too long to check asks; a late approval of a helper's card runs that call once; web search with no provider no longer asks; decision records leave
  out passwords and tokens by kind; Team Studio follows the open folder. No em-dash, no internal names.
- `gateDocs`: a new test pins this entry by its own words wherever it sits (Unreleased now, its version after the release), checks each bullet leads
  with a bold sentence, and checks for no em-dash, no "NEAR organization" and no internal names. The 0.4.28 policy entry test took whatever
  `## Unreleased` held to be the policy entry, so any later Unreleased entry broke it; it now finds that entry by its words ("Reset Policy to
  Defaults"), with every phrase check unchanged and the "Unreleased is first, a release follows" check kept. `changelogSections` passes.
- `node scripts/prepare-release.mjs check` on `feat/gate-floor` exits 1 with "run this on a release/x.y.z or hotfix/x.y.z branch", as designed.

### 4. [MINOR] VS Code's secrets database was refused by file name anywhere

- Commit `b701585`.
- `namesCredentialStore` matches `state.vscdb` and `state.vscdb.backup` only after a `globalStorage/` or `workspaceStorage/<id>/` folder (any VS Code's
  layout: Linux, macOS, Windows, remote), or anywhere under this VS Code's own storage folders, which `vscodeStorageRoots()` finds from the extension's
  global storage (the global storage folder, and in the standard layout the user-data folder above it). `shellReachesCredentialStore` uses the same check
  for each resolved word, with the global storage as written and as it resolves.
- Tests: the real locations by text and from the shell's folder are refused; `sqlite3 state.vscdb`, `fixtures/state.vscdb`, a project-root path and a
  temporary-folder path are not. Two old "anywhere" hits in `gateFloor.test.ts` (`sqlite3 /x/state.vscdb .dump`, `cp state.vscdb.backup /x`) move to
  the misses, which is the change the review asked for.
- Not changed: the auto mode's settings layer still calls such a file sensitive (it asks before reading it outside fully-autonomous); only the floor's
  refusal moved.

### 5. [MINOR] Scratch deletes were known only under `/tmp`

- Commit `7dbf485`.
- `CommandContext.temporaryRoots`: the caller hands the classifier the resolved temporary folders, so it reads no environment for them; with none given
  it keeps its old fallback (`/tmp`, `/var/tmp`, TMPDIR), which the auto mode's path still uses. `systemTemporaryRoots()` in the gate adapter gives
  os.tmpdir(), TMPDIR, `/tmp` and `/var/tmp`, each as written and as it resolves (`/private/var/folders/...`); `floorFactsFor` passes it.
- A delete is scratch only strictly inside such a folder, and never of a folder that holds the project or the home folder. That also closes the old
  rule's gap where `rm -rf /tmp/<project>` (a project kept in `/tmp`) was not destruction.
- Tests (`src/test/commandTemporary.test.ts`): a stand-in macOS folder as written and as it resolves; the folder itself, outside it and a project inside
  it; the context, not the environment, decides; `systemTemporaryRoots` with a linked stand-in tmpdir and TMPDIR; the floor with a stand-in and with
  the system's own folder.

### 6. [MINOR] `git gc`, `git prune`, `git rebase --continue` tagged destruction

- Not changed, as instructed: it is the owner question already in the PR body.
