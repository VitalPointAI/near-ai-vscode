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
