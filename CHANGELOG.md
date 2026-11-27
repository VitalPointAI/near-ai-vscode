# Changelog

## Unreleased

- In About SovAI, Enter closes the dialog when its Close button has keyboard focus.
- Workbench Documentation opens published guides and section links locally, shows both architecture blueprints at full size, and opens the gap register in Compliance.

## 0.4.41

This maintenance release makes the Linux Workbench easier to start and improves reliability in Team Studio and Compare Models.

- The Linux launcher checks prerequisites, reports CPU, memory and Docker storage, and starts the approved image in your local browser. The setup guides cover first launch, shutdown and running a Workbench and sync hub on the same development machine.
- A sidebar shortcut that cannot open its page gives you feedback and a retry. Team Studio keeps replacement state with the project being saved when you switch projects.
- Compare Models starts one comparison at a time. Repeated clicks during setup no longer trigger extra comparisons or cost prompts.
- The offline on-premises lab configuration preview and the recorded capability checks provide evidence for later evaluation on your own infrastructure. Operational checks remain open.
- The release build now prepares the pinned hub runtime so its collaboration tests run with the same prerequisites as normal CI.

## 0.4.40

This update makes the Linux Workbench easier to start and improves reliability in Team Studio and Compare Models. It also adds deployment guidance and evidence for teams evaluating Sterling Sovereign AI on their own infrastructure.

### Workbench setup

- The Linux launcher checks prerequisites and starts the Workbench image identified by the approved digest, with a local browser address and an owned workspace.
- The setup check reports CPU, memory and available space on the filesystem it can inspect at Docker's configured data directory.
- The documentation covers first launch, shutdown, and running Workbench and the sync hub on one development machine.
- Workbench offers retry feedback when a sidebar shortcut cannot open its page.

### Working with teams and models

- Team Studio keeps saved replacement state with the project being saved even if the selected project changes.
- Compare Models starts one comparison at a time. Repeated clicks while it prepares a run no longer create extra starts or cost prompts.

### Deployment and assurance

- The offline on-premises lab has a verified configuration preview. This provides configuration evidence for a future site trial.
- The repository records capability gate verification and its remaining operational checks, along with updates to the staff collaboration and site control evidence.

## 0.4.39

Sterling Sovereign AI (SovAI) is now the product's name everywhere, and the Sterling workbench
image becomes the native Defence workbench the owner reviewed: a right-hand rail, Get Started
with the four Defence work areas, the Portfolio Room, the Resource Inventory, and documentation
whose figures render. NEAR AI stays only as a model provider.

### One name: Sterling Sovereign AI

- **Commands are listed under SovAI.** Every command in the Command Palette now shows under
  **SovAI** (for example **SovAI: Open Chat**), and messages that name a command use the same
  words. Before, they said NEAR AI, which is only one of the providers you can choose.
- **Chat and setup no longer assume one provider.** The empty chat says **Connect AI to start**
  and offers local models and NEAR AI Cloud alike, and the chat input says **Ask a question**.
- **The SA&A package names the system Sterling Sovereign AI.** The OSCAL documents, the readable
  package and the sponsor report use the product name; their technical ids are unchanged, so
  earlier packages still line up.
- **Staff Room is the one name.** The Planning page's button reads **Open Staff Room**, the same
  name the rest of the product uses.

### The Sterling workbench

- **A right-hand rail.** Ten shortcuts sit on the right edge: Get Started, Portfolio, Chat, Team
  Studio, Agent Activity, Governance, Compliance and Documentation open their page; Data
  Management and Model Factory are shown as planned. The rail stays even when the chat is
  unavailable.
- **Get Started for the Canadian Defence Edition.** Set up Sterling, Open Chat and Explore a
  sample agent team, then four Defence work areas: Capability Development, Exercises & Training,
  Planning and Resource Management. Each card opens that work area's own page, Planning with
  its artwork, and each page's **Create** button makes a new work area in a new folder without
  overwriting anything.
- **Portfolio Room and Resource Inventory.** The Portfolio Room previews your DND and CAF
  portfolio, and the Resource Inventory lists resources by source and links them to work areas.
- **The chat drawer slides in and out.** The rail's Chat shortcut opens and closes the drawer,
  and closing the last conversation hides the drawer and keeps the conversation, instead of
  discarding it.
- **Download the SA&A ZIP from the workbench.** After **SovAI: Generate SA&A Package…** saves
  the package, a **Download ZIP** button sends it to your browser. Before, the file stayed on
  the workbench server with no way to get it.
- **Documentation with its figures.** Guides are rendered when the image is built, with their
  screenshots and diagrams bundled, so the Documentation view shows pictures instead of source
  and fetches nothing from outside.
- **Contributing and Environment packs are back in Documentation.** The two guides the docs
  site publishes had dropped out of the workbench's Documentation view; Environment packs is
  listed under Reference and Contributing under Developing again.
- **Wide diagrams are no longer cut off.** A diagram wider than the page now shrinks to fit or
  scrolls inside its own frame, instead of losing its right-hand side.
- **A hardened image.** The workbench runs on Red Hat UBI 9 with Node 26 as a non-root user,
  listens on `127.0.0.1` by default, keeps telemetry off, and contacts no outside server unless
  you configure one. Each release checks this before publishing.

### Fixes

- **A missing saved key asks you to reconnect.** A NEAR AI Cloud or hybrid profile whose saved
  key is gone shows "Your saved profile needs its connection checked again" instead of a ready
  chat whose first message fails. A local profile with no key stays ready.
- **Project Setup follows the project you chose.** If you switch projects while Project Setup is
  open, it says so and runs nothing, instead of running a step in the project you left.
- **Proxy advice fits the workbench.** The browser and remote proxy advice talks about the
  workbench instead of VS Code.
- **A high-severity advisory in a workbench dependency is fixed** (GHSA-mrhx-c7xc-m3w5, in zod),
  and the workbench's dependency audit blocks on high findings again.

### For your organization's own sites

- **The on-premise site stack is in the repository.** Air-gapped installation, site
  certificates, passwordless sign-in, signed offline bundles, federation between a headquarters
  and its edge sites, time sources, key escrow, recovery and maintenance checks, with operator
  runbooks. These are previews for your organization's deployment team; Sterling Sovereign AI
  itself still runs on `127.0.0.1` only.
- **Verified credentials, the engine.** The groundwork for people's identities and verified
  credentials (who holds which role and clearance) is in place and tested. Nothing in the product
  uses it yet, so clearances still show as declared, not verified.
- **Compliance documentation grows.** The documentation lists every component with why the
  architecture needs it and its exact version, the SA&A export includes the component inventory,
  and a new page, Road to production and higher classification, lists every open condition by
  classification level.

## 0.4.38

This is the first complete container release. 0.4.37's image reached the registry, but its last
publication check failed, so it has no GitHub release and no assessor package. 0.4.38 carries
the same product with that fixed.

### Released as a container image

- **Each release now finishes with its GitHub release and assessor package.** Before, the step
  that confirms the pushed image is the tested one compared the wrong digest on newer Docker
  versions and stopped the release after the image was already published. It now accepts the
  registry copy only when it is exactly the tested image, under either way Docker reports an
  image's identity.
- **The OSCAL import check runs again.** The check that imports the assessor package into
  Compliance Trestle unpacked it inside Trestle's own workspace, which Trestle refuses. It now
  unpacks beside it, so the import and validation results appear in each release run.

### Compliance and documentation

- **The hosted compliance views show their first evidence.** For the planned on-premise
  deployment, three statements now rest on a checked test of the site stack: it renders no k3s
  and no ingress-nginx, and no certificate issuer uses a public ACME service. Everything else
  in those views still shows No statement yet or a dated gap, never Met without evidence.
- **The documentation matches how Sterling ships.** Getting started covers both the extension
  and the workbench image, and the architecture, release and security pages describe the
  approved container publication and the planned hosting for your organization's own sites.

## 0.4.37

This is the first release shipped as a Sterling container image instead of a Marketplace
extension. It also adds an editable Security Assessment and Authorization (SA&A) package and
makes the compliance dashboard stricter about what it shows as met.

### Released as a container image

- **One versioned image per release.** Each release publishes the Sterling workbench image to
  the GitHub Container Registry after the owner's approval. The GitHub release records the
  exact image digest beside the extension package, its checksum and the assessor package. The
  extension is no longer published to the Visual Studio Marketplace.
- **The Sterling workbench in your browser.** The image opens the Sterling Get Started page,
  with the Canadian Defence Edition, read-only Team Studio samples, the bundled documentation,
  and a Compliance view that shows control states only from an evidence bundle whose hashes
  were checked for the same release.
- **Local preview only, for now.** The image has no sign-in of its own. It refuses to start
  until you confirm you publish it on `127.0.0.1` only. Sign-in for many people at your own
  sites comes in later releases.

### SA&A package on demand

- **Generate an SA&A package.** Choose a published release in **NEAR AI: Generate SA&A
  Package…**. The ZIP includes an editable sponsor Word draft, a control and evidence workbook,
  verified release records, and administrative forms.
- **Follow the evidence for each finding.** OSCAL keeps partially met controls open and links
  each finding to its evidence in the bundle.
- **See who approved the release.** The export includes a checksummed receipt of the
  publication approval when GitHub confirms it for the selected release, for container
  releases and for earlier Marketplace releases.

### Compliance and security

- **No control shows as met while part of the system says nothing about it.** A control is
  now Partly met until every component in scope has a statement or a reviewed exclusion.
- **Release integrity evidence works again.** The release check follows each release tag to
  its commit and checks the published checksum against GitHub's recorded asset digests.
- **Nothing new is used without a compliance check.** Every dependency, base image, workflow
  action and bundled library now needs a reviewed entry before it can be used.
- **Two pages or replies can no longer freeze the editor.** The reader for fetched web pages
  and the usage line under chat replies now take linear time on any input.

## 0.4.36

Your organization can now distribute signed rules and see where each answer ran. This release
also adds an operator-ready sync hub, tighter routing and privacy controls, and accreditation
evidence for assessors. Shared staff projects remain a preview. Live editing through the hub and
the guided Get Started workflows will ship in later feature releases.

### Your organization's rules

Your organization can now hand every computer its rules as one signed file, and every feature
reads them the same way. Your own settings on this computer can only make them stricter.

- **Add your organization's rules.** **NEAR AI: Add Your Organization's Rules** opens the file
  your organization's security contact sends and shows twelve words to compare with the twelve
  words they read to you. Only **The twelve words match** takes the rules; anything else changes
  nothing. Later versions of the rules are taken only when the same key signed them and they are
  newer.
- **One policy page.** **NEAR AI: Policy** opens "Your organization's rules" (or "Your rules"),
  read only, with who set them. A change is shown there first, one plain sentence per setting:
  apply it to your own rules, or save it as a file for your organization. **Edit my rules**,
  **Apply my draft**, **Show as stored** and **Reset my rules** are on the page, and the old
  Show, Edit, Apply and Reset commands left the Command Palette.
- **Reset touches your own rules only.** Under your organization's rules, Reset signs fresh
  starting rules for your own settings and leaves your organization's rules as they are.
- **Wider personal settings are ignored and listed.** A setting of yours that is wider than your
  organization allows has no effect, and one notice lists it; a change that would make a setting
  wider is refused, naming it.
- **One list of where AI may run.** Your policy's local servers are now listed with every other
  place AI may run, with the same effect as before, and a notice says so once. Protected B sent
  to a server your policy names as local now needs a TLS pin and a Protected B authorization
  naming that server.
- **Private means checked.** `nearAi.privacyMode`, private agent teams and private members all
  ask the same check, and its choice now reads "Only verified private hardware or this computer".
- **A trust line under each answer.** Beside the badge, one line says where the answer ran, what
  was checked and what allowed it.
- **Export-controlled content stays here by default.** Content marked Controlled goods (Canada),
  ITAR or US export-controlled (EAR) stays on this computer under the starting rules. A fresh
  install, and the renewal of starting rules nobody edited, get these entries: an upgraded install
  whose starting rules nobody edited gets them when its policy is next renewed, in the last 30 days
  before it ends, and an edited policy gets them through a change on the policy page. Your
  organization's rules can carry export-control decisions; they are used to allow access in a
  later release.

### Fixes

- **Daily accreditation evidence keeps CI test results.** When a daily bundle uses test results
  from the same commit, the dashboard links to the original CI run and shows when the tests ran.
- **Content that must stay local no longer reaches a host by a broad pattern or plain http.** A
  host your organization names as local now serves Protected B, org Restricted and NATO Restricted
  content only when the policy names that exact host (not a `*.` pattern) and the runtime uses
  https. Protected C, Canadian classified levels and NATO Confidential and above never leave this
  computer, even for a named host or a policy that routes them to a cloud. A request this refuses says why and how to fix the policy, and a
  policy with a `*.` entry is told so when the window starts.
- **Classified work on an unaccredited computer is said out loud.** When a chat's classified or
  Protected C content goes to a model, the chat says once that this computer is not recorded as
  accredited, and the decision log records it. Nothing is refused for it yet.
- **"Private" now means checked, every time.** A private team or member, Team Studio's private
  calls and TEE-only mode no longer trust the model list's word: each request goes only to a model
  on this computer or on a host your organization names exactly over https, or to NEAR AI Cloud
  over a connection proven to end inside its private hardware, and is refused before anything is
  sent otherwise. The model picker now reads "Private ·
  NEAR AI private hardware, checked each time it is used".
- **Staff teams say where their private models come from.** Setting up or running a military staff
  team now says that the private models NEAR AI offers today come from developers in the People's
  Republic of China, so the team is for fictional or exercise material only until your organization
  approves a model for operational work. Nothing changes about where the work goes.
- **A newer policy asks you to update, never to reset.** A policy that needs a feature or setting
  this version does not know still runs reading and planning only, and now says to update the
  extension instead of offering to reset the policy to its defaults, which would have discarded its
  rules. For your own policy with a setting this version does not know, the policy page still offers
  Reset my rules, saying what it discards.
- **Labels read by name.** Labels now show the scale's name with the level ("Organization:
  Internal", "Canada, Classified: Confidential"), and the organization's Confidential level reads
  "Sensitive" so it is never mistaken for the classified one. Stored labels are unchanged, and the
  staff checks and a chat's label now rank levels by your policy's own scales.
- **Agents that start together in their own git worktrees no longer fail at random.** When a team
  started several members with worktree isolation in one repository, git could refuse one of the
  worktrees ("failed to read .../commondir") because they were created at the same moment. They
  are now created, and removed, one at a time per repository.
- **Team Live and the agents strip.** The run picker in Team Live now offers finished runs too, so
  the last finished run stays reachable while another team run is live. An agent stopped while it
  waited for a free slot no longer shows a task travelling to it. A project agent that shares its
  name with a team member is drawn as a helper, not as that member. Team Live's clock stops when
  there is nothing to show, and a closed panel is sent nothing more.
- **Watch the team only where there is a team.** The chat's team dots and Watch the team show only
  for a run that leads or works with a team, and agents waiting for a slot are listed there with a
  queued dot. Agent Activity offers Watch the team for a team run from its start, even while the
  lead works alone. Team Studio's Watch it live link on the Team shape tab now appears and goes as
  a run of the open team starts and ends.
- **No secrets in the activity history.** The description an agent gives when it starts another
  agent, and the role it names, are redacted before they are saved to the project's activity
  history, as the live view already showed them.
- **More git commands count as reaching the network.** After an agent reads a credential file, `git
  remote update`, `git remote show` and `prune`, `git send-pack`, `git fetch-pack`, git lfs fetch,
  pull, push and clone, and `git submodule update` now ask in every mode, like `git fetch` and
  `git push` already did.
- **git's stored logins stay private.** `git credential fill` and git's credential helpers run by
  hand (`git credential-store get` and the like) are refused in every mode, like `gh auth token`;
  `git credential approve`, `reject` and `erase` ask first. A command spelled with `$'…'` quoting
  is now read as the shell reads it, so it cannot hide one of these.
- **A repointed MCP server is approved again.** Editing an MCP server to a new address, transport
  or program holds all its tools until you approve them on the MCP page; renaming it keeps the
  approval.
- **The project's key folder is safer from searches.** A search or copy that runs through
  `.near-ai` or its state folder (`grep -r`, `rg`, `find`, `tar`, `cp -r` and the like) is
  refused, as reading the key folder directly already was.
- **The War room opens closer.** The COP map's first view now fits the exercise itself, its
  units, control measures and named places, with a margin, instead of all the land in the
  exercise frame.
- **A staff lead is offered only the staff tools it can use.** Reading the wargame record is now
  its own tool, so a staff run's lead can read it without being offered recording and deriving,
  which only the team's members can do. Run **NEAR AI: Update Team…** on a J5 or J3 team to give its
  wargame members the new read tool.
- **The J3 event log announces every escalation.** An entry already in the log whose status turns
  to escalated is now announced to a screen reader, once, like a new escalated entry.
- **guard-scan notices a coordinate pair on a line of its own.** With an exercise box set, a line
  holding only two decimal numbers such as "45.42, 75.69" outside the box now goes to the release
  guard to check, as a pair after a word like "position" already did.
- **Merging a COP proposal handles stray copies more carefully.** When 50 aside copies are already
  there, the merge stops with a plain message instead of a file system error; a result that reused
  an older aside copy now says so; and a stray copy changed during a refused merge is no longer
  put back under the kept name, where it would block the next merge.
- **The chat's Staff teams card ignores a malformed team list.** A section's matching library
  teams are shown only when they are real team names, so a damaged record never shows an empty
  "Found" line.
- **Team Studio: a project team that was written but not fully recorded says so.** When the project's
  team file was written and a later step failed (keeping it in History, noting where its members
  came from, or writing the project type's guidance to AGENTS.md), Team Studio used to say the team
  was not used. It now says the team was written and which step did not happen, and shows the new
  team.
- **Team Studio: Use as is and Clone and modify no longer get each other's answers.** A late answer
  to a Clone you had left behind could turn the buttons back on while Use as is was still being
  answered. Use as is is also announced only once Team Studio has answered.
- **Team Studio: very large pictures are refused before they are opened.** An uploaded or generated
  picture is checked for its size in pixels first (at most 16 megapixels, 8192 pixels a side), so a
  small file that describes a huge picture cannot stall the editor.
- **Team Studio: icon fixes.** A failed icon change no longer leaves a copy of the icon that is still
  in use in History; Duplicate makes the copy even when its icon cannot be copied, and says it has
  the default icon; earlier icons load when you open the History tab instead of with every team.
- **Team Studio dashboard fixes.** Setting up the same project team again keeps your rating and its
  role-test health, and replacing it with another team says in the question that they are cleared.
  A team archived before the dashboard arrived gets its role-test health back. A team whose local
  check has not run shows "not known" instead of "needs fixing", and a file problem that names a
  one-part path such as `/home` no longer shows that path.
- **Team Live: the project team's run from history.** A run of the project team saved in the history
  is shown with the project team, not with a team in My teams that happens to be called "team".
- **Team Studio: clones stay clones.** A cloned team is still checked for a name of its own after you
  reword every member, and a team made after Use as is is no longer taken for a clone.
- **Parallel-work suggestions fire when they should.** The suggestions to give each member its own
  area and to say who brings the parts together now look for those things being said, rather than
  any use of words like "own" or "merge". The research team's investigators that run at the same
  time each write their own findings file, which the lead combines, instead of writing parts of one
  shared file. Update Team offers the new research team wording.

### Military staff teams

- **Labelled products in shared staff projects.** A shared staff project now keeps each product
  in a part of its own for its label, and gives that part only to the computers of people whose
  declared clearance covers the label. The part every member holds carries only the list of
  people, so it never holds product text. Products made without a label are `org/Internal`.
- **Make This Staff Project Multi-User converts labelled projects.** Projects with products above
  `org/Public` are no longer refused. You are asked to declare your own clearance first, and the
  conversion is refused only for labels your declared clearance does not cover, naming the
  products that carry them. The old product ledger and decision log are kept whole in a part only
  you, and a deputy cleared for every label in them, can open.
- **Projects made multi-user with 0.4.35 keep working.** Their products stay where they are. To
  give those products parts of their own, make a single-machine copy and make that copy
  multi-user again.
- **The single-machine copy says what it left out.** A copy made on a computer that is not cleared
  for every part of the project says "Parts of this project you are not cleared for were not
  copied."
- **Your organization can run a sync hub for multi-user staff projects.** The hub is a small
  service in `hub/` that runs beside the relay, as its own service under the Compose profile
  `hub`. It checks every change against the project's member list, sends changes and who is
  active to members at once, and signs checkpoints. It holds no model credential, opens no
  outbound connection and is never in the VSIX.
- **The hub reads only the member list and the parts it is granted.** Everything else it stores
  and passes on stays sealed. The staff lead grants it a part only after confirming that the hub,
  and anyone who takes over its server, will be able to read that part.
- **Members' computers notice a hub that misbehaves.** A hub that withholds changes, delays
  them, rolls back to an older history or shows different people different histories is named on
  the computers that see it, and a restore from an old backup is refilled by those computers.
- **An operator guide for the hub.** `relay/README.md` covers certificates and pins, the secret
  files, running it with Compose, hub files, backups, the restore drill and upgrades.
- **Not usable from the editor yet.** This release ships the hub for operators only. Connecting a
  staff project to it from the editor comes in a later release.


## 0.4.35

The COP map now looks like the ground: photo-like imagery with 3D terrain by default, a
topographic map one choice away, a globe on NASA Blue Marble imagery that you can spin, and a
military map margin, with the layers in a drawer so the map gets the room. A staff project now
knows its staff teams, so the chat offers to task them, and a staff run carries on when a NEAR AI
model is overloaded. Staff projects that several people work on from their own computers are here
as a preview behind a setting, off by default. Version 0.4.34 was never published to the
Marketplace, so this release also brings everything in its notes below: the military staff teams.

### Staff collaboration (preview)

- **Multi-user staff projects, behind a setting.** Turn on `nearAi.staff.multiUserPreview` (off by
  default) to try staff projects that several people work on from their own computers. While it
  is off nothing changes: the commands below are hidden and do nothing.
- **Make This Staff Project Multi-User.** **NEAR AI: Staff: Make This Staff Project Multi-User**
  checks the four staff ledgers first, says what will happen, and then moves the project's history
  into a signed shared record. You become its staff lead. The original files are kept in
  `.planning/staff/legacy/` and never deleted. For now it converts only projects whose products
  are all labelled `org/Public`: everyone admitted receives a converted product, so a project with
  a higher label is refused before anything is written, naming those products. A product file
  edited while a conversion is half done is never written over: the conversion stops, names the
  file and says how to finish.
- **Invite, join and admit by file and six words.** **Staff: Invite to Staff Project** saves an
  invitation file to send any way you like. The person opens it with **Staff: Join Staff
  Project**, sends back a join request and reads you six words. **Staff: Admit to Staff Project**
  shows the same six words and admits them only when you confirm the words match. They open the
  welcome file you send back with **Staff: Join Staff Project**.
- **Manage who is in the project.** **Staff: Remove from Staff Project** removes a person, one of
  their devices or an open invitation. **Staff: Change a Staff Project Member** changes a name,
  seat, roles, declared clearance or agent seats. **Staff: Add My Other Machine**, **Staff: Name
  Deputy Lead**, **Staff: Hand Over Staff Lead** and **Staff: Choose Roster Branch** cover a
  second computer, the deputy, the handover and a roster changed in two places at once. Removing
  someone or lowering their clearance tells you plainly: "They keep what they already received.
  They will not receive anything new."
- **Start This Computer's Shared History Again.** When the shared history on this computer is
  refused because it is older than what this device has seen, damaged, or its signed record does
  not verify, **Staff: Start This Computer's Shared History Again** asks first, then moves the
  folder aside without deleting it, keeps your own changes, and says how to get the rest back: a
  new welcome file from your staff lead. A damaged line is now reported as damage, not as an
  older copy.
- **Invitations from more computers, and a join that recovers.** The lead's other computers, the
  deputy and a new lead after a handover can now invite people and add computers, not only the
  computer that created the project. The six words now also cover the inviting computer and a
  random value from the joining computer, so someone who controls the files both ways cannot make
  the words match. Opening an invitation no longer ties a computer to the project until the
  welcome file is opened, so a fake invitation cannot block the real one. A lost welcome file is
  made again with **Staff: Admit to Staff Project** and the same join request. An interrupted
  removal or clearance change is finished by the next removal, change or admission, and **Staff:
  Remove from Staff Project** offers to finish it. Expired invitations are listed so you can cancel
  them, and **Staff: Choose Roster Branch** describes each change. Join requests made by an earlier
  preview build are refused: ask the person to make a new one.
- **Make a Single-Machine Copy.** **Staff: Make a Single-Machine Copy** writes a copy you can work
  in alone into an empty folder, and says what it does not copy.
- **Declared, not verified.** Every multi-user screen says that people and clearances are declared
  by the staff lead, not verified, and that labels are not accreditation.
- In a shared project, Set Aside the Product Ledger, the product decisions and Decide a PIR now say
  at once that the step is not available there, instead of after their dialogs.
- **An invitation that could not be saved can be saved again.** If saving an invitation file fails,
  **Staff: Remove from Staff Project** on the computer that made it offers to save that invitation
  again; nothing in the project changes. A project folder whose shared-project file cannot be read
  now says which error stopped the step, instead of calling the project shared.

### Military staff teams

- **The COP map looks like the ground.** The map now opens on photo-like aerial imagery of the
  exercise area with 3D terrain, and the globe on NASA Blue Marble imagery (credit: NASA Earth
  Observatory). **Topographic** (colour relief, land cover, hillshade, contours every 20 m with
  labelled index contours every 100 m, roads and the KQ grid; Natural Earth on the globe) is one
  choice away in the layer drawer's **Base map**, and **Plain** keeps the flat map. The drawer also
  has **3D terrain** with a height slider (1 to 3 times, 1.5 to start) and **Grid**. Everything is
  bundled with the extension and drawn offline; the exercise imagery and terrain are synthetic and
  not a real place.
- **Military map margin.** Scale bars in kilometres and nautical miles, the datum, the grid, the
  contour interval and a declination diagram. IRON LANTERN's magnetic declination, 17 degrees
  east, is fictional and says so.
- **3D starts off where it would be slow.** On a computer that draws the map without a graphics
  card, 3D terrain starts off and the drawer says why; you can still turn it on.
- **Spin the globe.** On the globe, **Spin** turns it slowly until you touch the map; dragging
  spins it with momentum. Spin never runs under Calm or reduced motion, and stops when the room is
  hidden.
- **The 2D map is topographic.** Where WebGL is not available, the 2D map keeps the drawer and
  shows the Topographic base, and says why Imagery and 3D are not there.

- **The project knows its staff teams.** Set Up a Staff Team now records each section's team in
  the project's staff settings, so after setting up a J2 the chat no longer says "This project has
  no team yet". A staff project shows a **Staff teams** card instead: each section with its team's
  name and a **Task** button that puts `/team:<name> ` in the message box without sending it, and
  **Set up** for the sections not set up yet.
- **The Staff teams card appears right after setup.** With the chat already open (as in a browser
  editor such as code-server), setting up a staff team now replaces "This project has no team yet"
  with the **Staff teams** card at once. If the staff settings cannot be read, the card says why
  and the reason is written to the **NEAR AI** output, instead of the "no team yet" card showing
  with nothing said.
- **Set up a staff team from the chat.** The "This project has no team yet" card now offers **Set
  up a staff team** beside **Set up your project team**, so a staff project can start there.
- **Task a staff team from anywhere.** The message when setup finishes names the team and offers
  **Task it now** and **Open the Staff Room**. The `/team` menu lists the project's staff teams
  first, labelled by section, and each section card in the Staff Room shows its team with **Task
  in chat** (or **Set up** for a section without one).
- **Missing and older teams.** A team file that was deleted or renamed in your teams shows as
  missing with **Set up again**, never as a command that would fail. A project set up before this
  release is offered the matching teams already in your teams to **Link**, only after you confirm.
- **The Staff Room's map has the room.** Once a scenario is loaded the map is the main panel and
  fills the panel's height without scrolling; the process rail and the section cards fold into
  one line that opens them again, and that line's **Staff teams** opens the cards at the first
  section's **Task in chat** or **Set up**. **Full map** puts the map over the whole Staff Room,
  and Escape brings the room back. The J2 and J3 workspaces' map fills its view the same way.
- **A layer drawer instead of a block of checkboxes.** **Layers** over the map shows how many
  layers are on and slides in a drawer from the map's edge, with the layers grouped as Picture,
  Environment and Reference, each with its count and a SIM badge for simulated data. Escape or a
  click outside closes it, and focus stays inside while it is open. The classification line,
  the track count, the time slider and the data's attribution now float over the map.
- **A closer first view.** The map opens on the land, the named places and the units with a
  margin, so the peninsula fills most of the map; the exercise frame's dashed line is still drawn
  round it. The hillshade and contours read in every theme, and units that would cover each other
  are drawn as one stacked symbol with a count until you zoom in (a click on the stack lists what
  is in it). Symbols are smaller at the wide view.
- **Globe that shows the globe.** **Globe** flies out until the curve of the earth is plain, with
  a graticule and the exercise frame ringed in gold, and **Map** flies back to the first view.
  Units stay hidden at the globe's zoom. Under reduced motion or Calm the view jumps instead.
- **The 2D map draws the ground.** Where WebGL is not available, the room's 2D map draws the
  terrain pack's land, hillshade and contours under the units, and uses the same layer drawer.
- **One machine for now.** Staff projects work on one machine: several people and machines on one
  staff project are not supported yet, because the signed ledgers trust only this computer's key.
  Multi-user staff workspaces are planned.
- Fixed: symbols could go missing after zooming in on the COP map, leaving only their names.
- Fixed: a staff team's run could sit on "working" without tasking anyone, after an error card
  such as "COP layers failed. Not allowed". The run's lead was offered the members' tools (the COP
  map, the feeds, the workbenches), tried one and was refused. Each agent is now offered only the
  tools it may use: the lead coordinates, marks the step and starts the members at once, and each
  member gets what its tools line grants.
- **A member carries on when NEAR AI is overloaded.** In a J2 staff run, five of twelve members
  failed: the ones on GLM 5.3 got "service overloaded" for four minutes, and the ones on Kimi K3
  sent nothing for 90 seconds again and again. A member whose model is overloaded for about a
  minute, or sends nothing twice, now moves to the next model and continues the same task, for
  example "threat-analyst switched from Kimi K3 to Qwen 3.6: Kimi K3 is overloaded at NEAR AI".
  Team Live, the Staff Room activity and the chat show the switch, and spend and the activity
  record name the model that did the work. The next model is the backup model, then the standard,
  deep and fast tiers, then the chat's model, skipping one that is busy; it is always at least as
  private (TEE stays TEE, a private member stays private, TEE-only mode holds). A member whose
  team file names its model moves too, with the notice.
- **Members no longer crowd one busy model.** While NEAR AI refuses a model, the extension sends
  it at most two requests at a time and waits longer each time it refuses again, instead of every
  member trying at once.
- **A member that fails says why.** Its activity, the Staff Room and the lead's report now say
  "overloaded at NEAR AI", "no answer for 90 s" or "refused by policy" instead of only
  "AgentRunError".
- Fixed: a `privacy: private` member whose reply stalled could be retried on the chat's own model
  even when that model is forwarded. The retry now uses only a model at least as private.

## 0.4.34

This release adds military staff teams. Set up a J2 intelligence, J5 plans, J3 operations or J4
logistics staff team for your project in your doctrine profile's own terms (US Joint, US Army or
NATO/Canadian), load a fictional exercise scenario, and let the members draft in parallel while
every product passes the team's gates and a named person makes every decision, signed with this
device's key. The new Staff Room shows the staff at work around one COP map, and Exercise IRON
LANTERN can be replayed as live simulated feeds on this machine. Staff teams are private,
unclassified and for exercise and fictional data only; labels are not accreditation, and no member
has a persona name or a rank. Your policy can also now set a label ceiling for each add-on MCP
server, and a server that changes its tools after you approved them waits for you to approve the
changes.

- **Set Up a Staff Team.** **NEAR AI: Set Up a Staff Team**, also a button in Team Studio, asks
  for the section (J2, J5, J3 or J4), the doctrine profile, the level, the nation (NATO/Canadian),
  the planning type and the section's own options, then shows the roster: the person who decides,
  and each member with its role and who it reports to. It saves the private team to your teams,
  writes PROFILE.md and the section's skills under `.planning/staff/`, the staff settings in the
  project's settings and the section's guidance in `AGENTS.md` between markers of its own, then
  offers to load the starter scenario. An existing team file is archived after you confirm, never
  deleted. **Update Team** brings a staff team up to date for the project's current staff settings
  and keeps the members you changed. Staff team cards show a violet badge for the section's agent
  work and a gold badge naming the person who decides.
- **J2 intelligence team.** 9 members at strategic level, 12 at operational level, 7 for a brigade
  and 5 for a battalion, each with its doctrinal job, the products it owns with their required
  headings, a "your output is X, not Y" boundary, what it hands back and to whom, and what it never
  decides: PIRs, collection allocation and every release stay with people. Two skills come with
  it: ICD 203 analytic standards, and source grading with reliability and credibility graded
  separately.
- **J5 plans team.** A lead planner who runs the planning steps and the wargame, design before the
  steps, two COA cells given distinct themes and run at the same time, the lead planner alone
  applying the profile's COA tests, a red cell seat, an independent red team that reports to the
  human chief of staff, future operations, sustainment, legal support, a plans writer and a release
  guard. Strategic, operational and tactical variants, a multidomain convergence planner under US
  Army, and the J3 director as planning lead in crisis planning. Four skills: planning templates,
  wargame ledger, centre of gravity analysis and assessment framework.
- **J3 operations team.** 12 members at strategic and operational level and 10 at tactical level:
  an integrator who keeps the running estimate (headed by the seven joint functions, or Command,
  Sense, Act, Shield and Sustain under NATO/Canadian with Canada) and proposes the CCIRs, current
  operations with the COP and the event log, a watch officer, future operations with branches,
  fragmentary order drafts and the decision support template and matrix in execution, fires and
  effects, targeting, information, cyber and space (JP 3-14 (2023) mission areas only), airspace
  and maritime liaison, assessment, liaison and a release guard. The three planning horizons come
  from your staff settings. A plan moves into execution only when a person approves the transition
  brief; from then on the J3 writes the decision support matrix and the synchronization matrix the
  J5 made, in place, and the J5 proposes changes instead (a version still open under the J5 is
  withdrawn first). Every fragmentary order is a product a person releases, and every fires package
  and targeting row carries both the commander-or-delegate and the legal review marks. Two skills:
  running estimate and execution loop.
- **J4 logistics team.** 12 members at strategic and operational level and 9 at tactical level: the
  section's integrator, a logistics plans officer, the logistics current-operations chief (always
  named in full, for example the JTF J4 JLOC), one planner for each core logistics function
  (supply, maintenance, deployment and distribution, engineering, operational contract support,
  health services, and logistic services with mortuary affairs), a LOGSTAT analyst with no file
  tools, so it can flag a report but never fix one, and the release guard. Support planning starts
  at step 1, alongside force planning. Every number in a J4 product cites the calculator record that
  produced it (`calc:<id>` on the same line, from factors a person entered), and the release guard
  holds a product with a number that has no record, or that cites a record the calculator did not
  write or that changed since. With the Canadian nation setting the team also writes the weekly
  logistics and ammunition reports for the CJOC J4 desk. One skill: LOGSTAT definitions. Health
  products carry SURGEON REVIEW REQUIRED, and mortuary affairs products hold no personal data.
- **Your profile's own doctrine terms.** Every team, product and screen uses the words of your
  profile: JIPOE, IPOE or IPB; J-2, J2, G2 or S-2; the annex letters of each profile (Annex D
  Logistics under US Joint, Annex F Sustainment under US Army, the NATO COPD letters such as Annex
  R Logistics, Annex SS2 Information Operations and Annex TT Public Affairs under NATO/Canadian);
  FRAGORD or Frag O; the concept of logistic support (COLS) under US Joint; and combat service
  support at Canadian tactical level. US Army teams follow the six-step intelligence process of
  ADP 2-0 (2026), NATO JIPOE has its three steps, the joint targeting cycle ends in combat
  assessment, and source grade 1 reads "Confirmed by other sources" (NATO) or "Confirmed" (US
  Army). Staff abbreviations such as COA, DSM and LOGSTAT stay in capitals on every screen.
- **Products with a person's decision.** Products live in `.planning/staff/products/<section>/` and
  move from draft through the gates to a person's decision, recorded in a signed, chained ledger in
  `.planning/staff/ledger/`. This computer keeps a signed record of the ledger's head outside the
  project, so a ledger cut short, deleted or replaced reads as tampered, and a ledger or register
  that cannot be read whole is reported as unreadable, never as empty. Members use the built-in
  `mcp:staff-products` tools by role (propose, status and list for owners; submit and withdraw for
  the section's lead; verdicts for the two gates), with the shared CCIR, RFI, assumptions, annex,
  synchronization, decision support and targeting registers, the wargame ledger and the step rail.
  Reading a register is a read-only tool, so it never asks for a write approval. Approving,
  rejecting and releasing are **NEAR AI: Staff:** commands a person runs, signed with this device's
  key; no agent tool can do them.
- **Staff: Use This Branch's Ledger.** After switching to a git branch with an older product ledger,
  the ledger reads as tampered, because this computer remembers a later head. This person-only
  command checks that the branch's ledger verifies on its own (every signature and the whole
  chain), shows what changes, records a signed entry with your name and role, and then remembers
  this ledger's head. A ledger that does not verify is refused; Set Aside stays the way out for
  that.
- **Two blocking gates.** The release guard runs `mcp:guard-scan` (classification and caveat
  markings, the exercise box, your real-entity list, publications with no public copy, decisions
  written as made, personal data, secrets, J4 numbers without a calculation, and coordinates) and
  records CLEARED or HOLD on the exact version. J2 products first need the tradecraft reviewer's
  SIGN-OFF, held to the ICD 203 tradecraft lint. An edit voids both verdicts. Coordinates with two
  decimals are checked against the exercise box when they are marked as a position (a hemisphere
  letter, a minus sign or a degree sign, as in "51.10 N, 11.10 E"), or, with an exercise box set,
  when two plain numbers are presented as a position outside it (after words such as lat, grid,
  position or at). Prices, scores and measures such as "12.50, 3.50" are left alone.
- **Intel workbench.** J2 members granted `mcp:intel-workbench` keep the source register, the PIR
  register and the collection plan in `.planning/staff/products/j2/`. Reliability (A to F) and
  credibility (1 to 6) are two fields, reports that share an origin never count as corroboration,
  every PIR names its decision point and latest time of value, and only a named person approves one,
  with **NEAR AI: Staff: Decide a PIR**, which signs the decision (a decision written into the
  register file alone never counts) and names the reason when the register cannot be read. The
  collection plan holds recommendations only. The workbench drafts INTSUM and INTREP skeletons and
  checks a product for compilation risk, which always ends with a question for a person. It reaches
  no network and takes exercise labels only.
- **Orders and battle rhythm.** Members granted `mcp:orders` (the J3 director and future operations
  planner, the J5 lead planner and plans writer, and the J4 director) get the annex list of your
  doctrine profile, a consistency check that names a wrong annex letter, a missing owner, an annex
  not yet released and an annex built on a source with a newer approved version, assembly of an
  OPORD, OPLAN, CONOPS or the profile's other orders from released products only, and fragmentary
  order drafts against a released order. The J3 current operations chief may draft an immediate
  fragmentary order with that one tool. Each result is a draft that goes through the release guard;
  only a person releases it. The current operations chief also keeps the battle rhythm (boards,
  bureaus, centres, cells, working groups, meetings and briefs, with times, owners, inputs and
  outputs) with `mcp:battle-rhythm`, exports it to an `.ics` file you can open in a calendar
  program and imports one you put in the project (size-capped, checked line by line and shown to
  the model as untrusted data). It also lists the suspenses of open RFIs and of decisions waiting
  on a person.
- **Logistics server.** The J4 team's `mcp:logistics` tools. The consumption calculator multiplies
  planning factors you enter in `.planning/.near-ai/staff-factors.json` by the force list and the
  days, gives days of supply from what is on hand, and shows the formula on every result; it ships
  no planning factor tables. LOGSTAT reports are entered as the units sent them, validated against
  six plausibility rules with each finding sent back to its unit, and consolidated only once they
  pass, with the colour bands you set and consumption against the forecast. Notional movement
  tables are checked for lift and arrival against the required delivery date, routes come from a
  road graph in your project with no network, and readiness comes from a CSV you import. Every
  calculation, movement check and readiness import is a record in a signed calculator ledger.
- **The Staff Room.** **NEAR AI: Open Staff Room**, also a button in Team Studio and on the message
  after staff setup, shows a staff run as a war room: the planning process across the top in your
  profile's own step names, the staff sections as squads with each agent's state in words and
  icons, the product ledger where every product opens its provenance (owner, version, gates on that
  version, who approved it, what it depends on, its history), and the gold human decisions panel.
  Its buttons run only the person-only staff commands, which ask who you are, confirm in a dialog
  and sign; the room shows a decision only once the signed ledger holds it. Night, day and high
  contrast themes follow VS Code; Calm and the system's reduced-motion setting stop all movement;
  the whole room works from the keyboard, with single-key shortcuts you can turn off; and Follow
  the action moves the view to where the work is.
- **A workspace for each section.** Every workspace shares the map, the ledger, the decisions and
  one clock, and shows the section's products with owner, version and release state, the decisions
  waiting for a named person in gold and the agents' work in violet. J2: the threat picture on the
  map (adversary units with their grades, the most likely and most dangerous courses of action as
  dashed red axes, NAIs and control measures), the source register, PIRs linked to the decision
  points they support, the collection plan, the standing watches and the live feed reports (newest
  first, only what your clearances cover, simulated ones marked SIM). J5: COA cells with their
  themes and validity tests, the comparison against the criteria and weights a person approved,
  the wargame ledger, the decision brief with dissent unedited, and the annex tracker. J3: the event
  log with escalations and CCIR matches on the map (a new escalation is announced even past the
  first page), the decision support and synchronization matrices with their owner, fragmentary
  order drafts, the battle rhythm and suspenses. J4: LOGSTAT by unit, calculator results with their
  formulas, movement, readiness, supportability per COA and the logistics annex. Long registers show
  a page at a time.
- **The COP map.** The Staff Room draws the COP in 2D or on the globe (MapLibre), offline over the
  scenario's synthetic geography with no map tiles fetched, with a time slider on the shared clock,
  "as happened" and "as known" replay, symbol cards in words and a budget of 2,000 tracks; without
  WebGL it falls back to the room's own 2D map and says why. Names never cover each other. Members
  granted `mcp:cop-map` read the layers and put military symbols (MIL-STD-2525D and APP-6(D), drawn
  by milsymbol), control measures, overlays per adversary course of action and decision points on
  the layer they write, in grid references on the scenario's grid. Each product layer has one
  writer; anyone else proposes and the writer merges, each change is a new version a person decides
  on, and a merge that cannot keep its copy is refused with the proposal left where it was. Feed
  layers are views nobody writes.
- **Terrain and weather on the map.** Hillshade, contours every 50 m with the coastline, and the
  weather (wind arrows, fog, rain and rough sea) for Exercise IRON LANTERN come from a bundled,
  synthetic environment pack, offline, as layers you turn on and off. The time slider picks the
  forecast for the time shown, with its model run and lead time, and shows no weather outside the
  forecast. A pack whose files do not match their recorded hashes, that strays outside the exercise
  frame, or that holds real data without its attribution and licences is refused, with the reason
  on the map. Developers with GDAL can build a pack from a real elevation model or forecast with
  `scripts/build-env-pack.mjs`; the format is in `docs/staff-env-packs.md`.
- **Exercise scenarios.** **NEAR AI: Load Staff Exercise Scenario** loads Exercise IRON LANTERN, a
  fictional, unclassified starter (a peninsula, a coast and a strait, both orders of battle, a
  mission with the higher commander's intent, graded and ungraded reports), or a scenario file of
  your own, into `.planning/staff/scenario/` with J2 and J5 demo scripts. Files with classification
  markings, names on your real-entity list or stray coordinates are refused, and an earlier scenario
  is archived rather than deleted. The real-entity list is one list, in
  `.planning/.near-ai/staff-guard.json` and `.planning/staff/real-entities.txt`, used by both the
  scenario import and guard-scan. Scenario files can now use version 2, with an optional exercise
  frame that places a fictional grid over empty ocean, far from any land, so map and feed replays
  can use real position formats without naming a real place; version 1 files load as before.
- **IRON LANTERN as live feeds.** **NEAR AI: Staff: Start the Exercise Feed Simulation** replays the
  starter scenario as live streams on this machine only: friendly and enemy tracks as Cursor on
  Target, ships in and near the Varn Strait as AIS, fictional news outlets as RSS, and a mock
  partner server (MCP) standing in for partner-only HUMINT, SIGINT, MASINT and CI with fictional
  reports, each marked SIM and kept local-only. The timeline follows the J2 demo script beat by beat
  and holds when the mid-demo report lands, so you can run the change-propagation beat and then
  resume. **Staff: Simulation Controls** pauses, resumes, steps to the next reports and sets the
  speed (0.5x, 1x, 2x or 4x); the status bar shows the SIM badge, the speed and the scenario clock.
  At 1x the three days play in about a quarter of an hour. With a project folder open the reports go
  into the project's observation store and the staff event log, so the J2 workspace and the map
  show them live. The partner feed stays off until a person adds the mock partner server.
- **Import feed files.** **NEAR AI: Staff: Import Feed File...** takes a GeoJSON, KML, Cursor on
  Target, RSS, Atom or AIS (NMEA) file into the project's observation store. You pick the file and
  the label; the file is read in a separate process with its own memory, size (16 MB) and time (20
  seconds) limits; then you see how many reports would be imported, the format, the label, the time
  span, what is held back because it lies outside the exercise frame and what was skipped and why,
  and nothing is written until you choose Import. Files that declare a document type are refused
  outright, so XML entity attacks cannot start. Imported reports name the file and when they were
  imported, and importing the same file again adds nothing. Agents cannot run the import. Cursor on
  Target tracks show their military symbol, drawn as unknown unless they are own-force positions,
  because a feed's affiliation is a claim.
- **Observations kept by your clearances.** Feed reports are kept in your project under
  `.planning/staff/observations/` (not committed), one append-only file per feed, channel and hour.
  A report delivered twice is kept once, each report keeps the label its feed gave it, and one
  labelled lower than its channel or without the handling its feed requires is refused. Each report
  records when it was true, when you learned it, where and how accurately, who reported it and where
  the information first came from. Tracks go stale and then lost without a report ever being
  deleted. J2 members granted `mcp:observations` ask for slices by area, time, grade, discipline,
  unit and echelon, a track with its state, what is near a place, what changed since a time,
  corroboration by independent origin and each feed's state, as known at any past time if asked.
  Every answer shows only what your clearances cover, raises the chat's label to what it showed and
  says when a limit cut it. ACLED, social media and other sources whose terms restrict this use are
  off by default, are never used for training and stay off until your organization records a
  licence; partner intelligence enters a staff project only as a fictional simulation kept on this
  machine.
- **Standing watches.** A watch binds a PIR's indicator to an area, a time window and the weakest
  source grade it counts, until the PIR's latest time of value, and names the person it alerts.
  **NEAR AI: Staff: Create a Standing Watch** creates and arms one; the J2 watch officer, warning
  analyst and threat or IPB analyst can only propose one, which a person arms with **Staff: Arm a
  Standing Watch**. Arming and retiring are signed with your device key, so a watch armed in the
  file by hand runs nothing and shows as proposed. A watch looks at new observations only while a
  staff run or the Staff Room is open; what came in meanwhile is delivered as "missed while paused"
  when a person is back. Matches are de-duplicated per track for 30 minutes, and you get at most
  four alerts an hour, then a digest. On a match the watch officer drafts an INTREP, and the owner
  of the adversary courses of action a revision if the watch allows it, each a draft that goes
  through the gates to your decision; nothing is released by a watch. **Acknowledge** arms it again
  once you have seen the drafts. Only the watch grant (`mcp__observations__watch_*`) gives the
  watch tools.
- **Members held to their own files and tools.** The built-in staff servers are listed once on the
  Tools page and in the Team Studio tool picker, and a run gets each one only for the members whose
  tools line grants it; the run's lead can call none of them, and none can approve, reject or
  release anything. In a staff team the red team may write only its critique, the release guard
  only its gate reports, and the J3 watch officer nothing at all (it proposes event-log rows through
  the staff tools). Write and Edit refuse every other path, and these members get no shell,
  document, agent-starting or other MCP tool. Every answer a staff tool gives an agent reaches the
  model fenced as untrusted text with injection attempts flagged, so text a unit, a person or
  another member wrote cannot pass as instructions. A server write to a file a member can also
  write replaces only the bytes the server read, so a member's write in between stands and the
  server refuses instead.
- **A label ceiling per MCP server.** Your policy can set the highest label each add-on server may
  receive (`ceiling.mcpLabelCeilings`, through **NEAR AI: Edit Policy**). A call to that server
  from a chat whose label is above it is refused before anything is sent, at every routing tier,
  with a plain reason and a decision record (`label.mcp-ceiling`). Servers with no ceiling, and
  every server under the shipped policy, behave as before.
- **MCP tool descriptions treated as untrusted, and tool changes held.** A server's tool
  descriptions now reach the model fenced as untrusted text and cut to 1,024 characters, like its
  results, and a description that looks like an injection is flagged to you. When a server adds a
  tool or changes a tool's description, inputs or hints after you approved it, those tools are held
  until you choose **Approve tool changes** on the MCP page.

## 0.4.33

Every answer of the lead agent from a cloud model now shows a trust badge that says what the
checks proved about it: Verified private model; Model verified, connection not proven; or Not
verified. Click it for the reasons and the full attestation. Public chats now also use the proven
connection to NEAR AI Cloud when there is one, so their answers from a private model can show
Verified private model. A new or cloned team shows its default icon while you name it.

- **A trust badge on every cloud answer.** Each answer of the lead agent from a cloud model shows
  one of three states under it: **Verified private model** (its signature and NEAR AI Cloud's
  attestation checked out, and the connection was proven to end inside the private enclave),
  **Model verified, connection not proven**, or **Not verified**, each with its reasons. It is set
  only from checks that ran and never says more than they proved. It replaces the Verify signature
  row. An answer from a model on this computer has no badge, and a helper agent's answer has none.
- **Checked once, automatically.** Each cloud answer from a private model is checked once in the
  background: one signature request per answer, with an attestation report already verified for
  the same signing key reused for up to ten minutes. A check that has not finished after 20 seconds
  shows Not verified, so a badge never waits forever (for example offline), and the badge changes
  if the check finishes later. A model NEAR AI forwards to another provider is never checked, and
  its badge says where it goes.
- **Click the badge for the details.** It explains its state and what the editor does not check.
  Opening the details moves the focus into them. Escape anywhere in the chat, or a click outside,
  closes them and Escape puts the focus back on the badge; Escape still stops a run from an empty
  message box and still closes the command and step menus, without also closing the details.
  **Check again** checks afresh and, on an answer whose failed check stopped the levels that need an
  attested cloud, lifts that stop when the answer now checks out. **Show full attestation** opens
  the signed text, the signing address and which component holds the key, every check, the
  connection and the attestation report as read-only JSON in a preview tab named for the answer,
  such as "Attestation: answer at 14:32, glm-5.3". It is not a file: it cannot be edited, never
  asks to be saved, and nothing is written to your project or to a record. Answers older than the
  last 20 say the details are no longer kept. A reopened chat shows each answer's badge as it was
  when the answer arrived.
- **Public chats over the proven connection too.** When a fresh proof of NEAR AI Cloud's
  connection exists, requests from chats at levels that do not need an attested cloud (Public,
  for example) also go over the connection held to NEAR AI Cloud's attested key, so their answers
  from a private model can show Verified private model. If the server presents another key, for
  example behind a proxy that inspects encrypted traffic, such a request is sent without it instead
  of being refused, a second record in the decision log says so, and its badge shows Model verified,
  connection not proven. Levels that need an attested cloud still refuse on a mismatch.
- **Fixes to the checks after each answer.** An answer at a level that needs an attested cloud that
  cannot be checked at all is still recorded in the decision log, with the reason; Check again on a
  failed answer from long ago in the chat can still lift the stop (and says when only a new chat
  can); and Set Label no longer says the chat keeps its label when the new label is as high as the
  chat's.
- **A new team shows its icon while you name it.** The Purpose step of a new or cloned team now
  shows the team's default icon, its initials on a colour, and it changes as you type the name.
  A cloned team starts with this default icon, not the icon of the team you copied. Before, the
  step showed no icon at all. You can upload or generate an icon on the team's Purpose tab after
  you save it.

## 0.4.32

Content at Internal, Confidential and the other levels that need an attested cloud can again use a
private NEAR AI Cloud model, but only over a connection proven to end inside its private hardware,
and each such answer is checked afterwards. The chat's label beside the model is now a button that
lowers it. Teams now run their members side by side, each on its own area, and the lead merges
their work and sorts out conflicts. A cloned team gets a name and an icon of its own.

- **Private NEAR AI Cloud models over a proven connection.** NEAR AI Cloud's attestation names the
  key of the certificate its endpoint serves. NEAR AI checks that in the background, never while a
  request waits: a fresh attestation report, a genuine Intel quote, and the same key on this
  computer's own connection. Every request at these levels is then sent over a connection that
  refuses any other key, before a byte is written. When the check has not passed, the content stays
  on this computer, and with no model on this computer the request is refused with a sentence that
  says why and to try again in a moment. Before, content at these levels always stayed on this
  computer.
- **Every such answer is checked afterwards.** The answer's signature and NEAR AI Cloud's
  attestation are checked in the background after each answer at these levels, tool-call turns and
  helper agents included, and the result shows under the answer. A report already verified for the
  same signing key is reused for up to ten minutes. A check that cannot be made, for example
  offline, changes nothing.
- **A failed check stops that level for the chat.** Nothing more at these levels goes to NEAR AI
  Cloud from that chat until **Check again** under the answer passes, which checks it again with a
  fresh report; a new chat or a window reload also starts without the stop. The failure stays in
  the decision log, and the refusal names Check again, a local model and **NEAR AI: Lower This
  Chat's Label**.
- **Behind a proxy that inspects encrypted traffic** the connection cannot be proven, so content at
  these levels stays on this computer. SECURITY.md and **NEAR AI: Show Policy** say what these checks
  prove and what they rely on.
- **Lower This Chat's Label where you look for it.** Click the chat's label beside the model (or
  press Enter or Space on it) to lower it. Every refusal that names **NEAR AI: Lower This Chat's
  Label** now has a button that runs it. Lowering a file's label with **NEAR AI: Set Label** while a
  chat that read the file is open says that the chat keeps its label, since a chat's label only rises
  on its own, and offers the same button.
- **Fixes to chat labels and the outbound check.** A lowering of a chat's label made while a sync
  raised it on another copy keeps the higher label and says so; a lowering is never applied below
  the project's label or compared by time as text; the outbound check also catches labelled text
  split across two arguments; refusal records name the tool, never the command, and say which
  check refused; and the label events of a lowering name the strictest label of the new label.
- **Teams work side by side, then bring their work together.** A team's lead now gives each member
  its own area (files, modules, or sections of the deliverable) and says what it must leave alone,
  starts the members that do not need each other at the same time, and gives each member that
  changes files its own git worktree. When they finish, the lead merges their branches one at a time,
  sorts out any conflict itself or hands it to the member who owns that area with both sides, and
  runs the project's checks once after all the merges. A member whose part fails does not hold up
  the others, and the lead's summary says which branches merged and which conflicts came up. Runs
  that work with a team, Open-GSD workflows included, are told the same. The AI team builder now
  designs teams this way, with a clear step where someone merges the parts and checks the whole,
  and puts members one after another only where one part needs another's output. The built-in
  teams and the recommended project team say what each member owns, and **Update Team** offers the
  new wording. While you edit a team, Team Studio adds a suggestion when no member owns an area of
  its own or no one brings the parts together; it is advice only, so your existing teams still
  save and still show Ready.
- **A cloned team gets a name and an icon of its own.** **Clone and modify** in Team Studio now
  starts the copy's name as "<team name> copy" (with a number added if that is taken). If you type
  a name that one of your teams, a built-in team or this project's team already has, ignoring
  capitals, spaces and punctuation, the studio says so under the name field and **Save** stays off
  until you change it; the extension checks the name again when it saves. **Duplicate** follows the
  same naming rule. A clone never takes the icon of the team it came from: it shows the default
  icon until you upload or generate one on its Purpose tab. **Generate with AI…** now asks for a
  colour scheme and drawing style picked at random each time, and if the picture is exactly the
  same as another team's icon, it makes one more; if that matches too, it leaves the icon as it was
  and says so.

## 0.4.31

You can now label files, folders and the project, so that agents cannot read what your clearance
does not cover, and add a clearance you hold through a signed, recorded policy draft. Each chat
now has a label of its own, raised by what its agents read, and that label decides where the
chat's requests may go: for now, content at a level that not every model may see stays on this
computer. Team Studio also opens on a dashboard of your teams, with each team's status,
models, stats, health and your own rating.

- **Show Policy says what is in use.** **NEAR AI: Show Policy** now says that your clearances are
  checked when an agent reads a labelled file, that each chat's label decides where its content is
  sent by the routing tiers, and that content with no label takes the default label.
- **Label files, folders and the project.** **NEAR AI: Set Label**, from the Explorer's right-click
  menu or the Command Palette, labels a file, a folder or the whole project on one of the scales
  your policy holds. Labels are kept in `.planning/.near-ai/labels.json`, signed with this
  computer's key, and travel with the project, so anyone who can read the project can read them.
  Before you pick, it says that labels are an organizational control, not an accreditation. You
  can only set a label your own clearance covers, and lowering one asks you why.
- **Agents cannot read files above your clearance.** A file tool, a search or a shell command that
  names a file whose label your clearances do not cover is refused, with a sentence that says
  which label and why. Searches leave such files out and say how many they hid. A label file
  changed by hand or signed on another computer only ever makes a label stricter, and NEAR AI
  signs it again only after you confirm. If the label file cannot be read or was deleted, or a
  branch switch puts back an older one, agents stop reading the project until you put it back or
  choose **Use this branch's labels**.
- **Edit your own policy.** **NEAR AI: Edit Policy** opens a draft of your policy, kept in this
  extension's storage and never in your project, and **NEAR AI: Apply Policy Draft** checks it,
  signs it with this computer's key and records the change. That is how you add a clearance you
  hold. A clearance comes from your own policy, so it is self-declared until verified credentials
  arrive. A draft that is not valid, or that was made before the policy changed, changes nothing.
- **A local runtime counts as local only on this computer.** For content that must stay on this
  computer, only a runtime on this computer (`localhost`, `127.0.0.1` or `[::1]`) counts as local,
  unless your organization names its host in the policy. The local runtime setup prompt says so.
- **Each chat has a label.** Reading a labelled file raises the chat's label to that file's
  label, and helper agents share it: what one of them reads raises the label of the whole chat. The
  chat shows its label next to the model, and the status bar shows the label of the chat in view,
  whenever it is above your policy's default label. A chat starts at its project's label (your
  policy's default label when the project has none), so in an unlabelled project a chat that read
  nothing labelled works as before.
- **The chat's label decides where its requests go.** Content at Restricted, Protected B and the
  other levels that must stay on this computer goes only to a model on this computer, and in this
  version so does content at the levels that need a private cloud model over a proven connection
  (Internal, Confidential, Protected A and NATO Unclassified by default). With no local model the
  request is not sent, and you are told why and how to get out of it.
- **Calls that could send data off this computer are held at those labels.** While a chat's label
  must stay on this computer, a web fetch, a web search, an add-on server call or a command that
  could send data off this computer is refused, in every mode. At Internal and Confidential they
  still run, but a call whose address, query or body carries text the chat read from a labelled
  file is refused. This catches copied or quoted text, not a paraphrase or an encoding.
- **What a labelled chat writes takes its label.** A file a labelled chat writes is labelled at the
  chat's label in the project's label file, never lower, so a later chat that reads it is labelled
  too. A file holds one label: a file already labelled only on a scale the chat's label does not
  hold is left as it is, and keeps a label that may let it go to a private cloud model once those
  are allowed.
- **Only you can lower a chat's label.** **NEAR AI: Lower This Chat's Label** lowers the label of
  the chat in view, never below the project's label, and asks for a reason, which is recorded. The
  label is kept with the chat and synced with it, and a sync never lowers it. A lowering is signed
  with this computer's key, but your other computers cannot check that key yet, so the copies of
  the chat there keep the higher label until you lower it there too.
- **Team Studio opens on a dashboard of your teams.** The main page now shows a summary row (how
  many teams you have, how many are running now, team runs and spend this week, and how many need
  attention), then one card for each of your saved teams and this project's team. Built-in teams
  are not on it; they stay in **New team**.
- **Each card says how the team is doing.** A card shows the team's icon, name and kind (the
  project team, one of your teams, or imported), whether it is private, and its status: **Running
  now** with **Watch it live**, **Ready**, **Needs attention** with the reason (an imported team
  not approved yet, problems the local check found, a member model your key does not offer, or a
  team file that needs fixing), or **Never run**. It lists each member's model or tier and whether
  it is private or cloud, and flags a model that is not in the model directory.
- **Stats come from what was recorded, nothing else.** Each card shows the team's runs, its last
  run, how many succeeded, the average time and the spend (in total and per run), from this
  project's run history. Spend is each run's own figure from the spend ledger. Where nothing was
  recorded the card says "none yet" or "not recorded", and with no project folder open it says
  that runs are kept per project.
- **A health score and your own rating.** Each card shows a health score made from the free local
  check and the last role test that **Optimise all teams** ran, with the score of each part. You
  can give a team 1 to 5 stars on its card, with the keyboard or the mouse. Your rating is kept on
  this computer only, never in the team file, so a project team's rating never goes into the
  project or a code push. Teams are kept by a stable name (a project's team by its folder, even
  when opened through a link), so ratings and role tests stay with the team. Archiving a team keeps
  them for **Restore**, and a new team with the same name starts without them. A member counts as
  passing its role test only with full marks.
- **Sort, filter, and live updates.** Sort the cards by **Most used**, **Recently run**,
  **Rating** or **Name**, or show only the teams that need attention; Team Studio remembers your
  choice. Running now and the stats change as soon as a team run starts or ends.
- **The AI box moved into New team.** "What should this team be able to produce?" is now under
  **New team**, **Create a new team**, **Describe it, and AI drafts it**. A drafted team waits on
  the main page and the **New team** screens until you use it or discard it, even if you were busy
  with something else when it arrived or closed Team Studio. If you have unsaved changes when you
  review it, you are asked about them first, and keeping them keeps the drafted team too. A star
  you choose just before you close Team Studio is still saved. The toolbar is **New team**,
  **Optimise all teams**, **Import…** and **Refresh**. A project with no team gets a card that says
  so, with **Set up**, and an empty library shows **New team** and **Set up a team for this
  project**.
- **Optimise all teams ends cleanly.** With no team open it no longer ends with a file error, and
  with a team open it no longer sends that team to the page a second time; the dashboard shows
  each team's new role test as soon as it is done.

## 0.4.30

Every request to a model is now checked before it is sent and leaves a short record of its own;
on a fresh install nothing changes where your requests go. Routing by label, where a chat that has
read labelled files may only use the models its label allows, comes in a later release. Team
Studio also gets a simpler start, same-size team cards and team icons.

- **Every model request is checked before it is sent.** Whatever sends it (the chat, a helper
  agent, reading an attached file, the NEAR AI chat in VS Code's own chat view, Team Studio, a
  cybersecurity scan or a model comparison), the request is checked against the routing in your
  policy, using only what is on this computer. Nothing can be labelled yet, so every request is
  at your policy's default label, which may go to any model. A request the routing does not allow
  is not sent, and you are told why in plain words.
- **Each model request leaves a record in a log of its own.** Next to the records of what the agent
  was allowed or refused, a separate log in this extension's storage keeps one record per model
  request: when, who asked, which model and provider, the rule that allowed it and a fingerprint of
  your policy. A routine request leaves a short record, about 1 KB. Records never hold what was
  sent, the address of the model server or a file path. The log rolls over at about 5 MB and keeps
  the last four older files, like the decision log, and it is never synced or put in your project.
- **Show Policy says the routing is in use.** **NEAR AI: Show Policy** now says that every model
  request is checked against the routing it lists; the scales and clearances it lists are still
  kept for later.
- **Recommend a team for me is on the first screen.** Building a team now offers three ways to
  start: **Use an existing team**, **Create a new team** and **Recommend a team for me**. The
  recommendation asks the kind of work, its risk, where models may run and, if you like, what the
  team is for, then shows the team it suggests before anything is saved, with **Use as is** and
  **Clone and modify** as for any team you pick. Changing an answer clears the team shown until
  you ask again. It is no longer listed among the existing teams, so it is offered once.
- **Every team card is the same size.** In the team list and when you pick a team, each card
  shows the team's icon, name, where it came from, its member count and the first three lines of
  its description, with the first four members and a count of the rest. **Show more** opens that
  card only, listing every member, and **Show less** closes it again.
- **Teams have icons.** On a saved team's Purpose tab, **Upload icon…** takes a PNG, JPEG or WebP
  picture of up to 2 MB, crops it to a square and keeps it as a small 128 x 128 PNG beside the team
  file. SVG pictures are refused, because they can carry scripts. **Generate with AI…** asks an
  image model for one, after showing the model and what it costs; it sends only the team's name
  and what it is for. A private team, a team whose members are all private, or any team in a
  project with a knowledge base can only use a private image model, and the button says why when
  there is none. **Remove icon** goes back to the default, and History keeps earlier icons to
  restore. A team without an icon, built-in teams included, shows its initials on a colour that
  comes from its name.
- **Shared teams keep their icon.** **Share…** includes the team's icon, and **Import…** checks
  it like any icon: one that is not a valid icon is left out, with the reason, and the team is
  still added. A team without an icon is shared in the same format as before, so earlier versions
  still import it; one with an icon needs this version or later.

## 0.4.29

Full auto still runs your work without asking, but it now stops for the few things that are hard
to undo, holds anything that could send your secrets away once it has read one, and no mode lets an
agent near the places where your keys and passwords are kept. Building a team also gets simpler:
using a team you already have no longer asks you to name it.

- **Full auto asks before what is hard to undo.** In every approval mode, Full auto included, the
  agent asks before it writes into git's own folder (`.git/`) or NEAR AI's own folders
  (`.planning/.near-ai/`, other than the team file, and `.near-ai/`, other than its scratch and
  attachments folders), before it publishes (git push, package and extension publishing, releases,
  container images, deploys, sending email) and before it destroys work (recursive deletes outside
  scratch and build folders, `git reset --hard`, `git clean`, discarding changes, rewriting history,
  deleting branches and tags). These cards have no **Always allow** and approving one allows only
  that call. In a run with nobody to answer, such as a model comparison or a benchmark, they are
  refused. Everything else still runs without asking.
- **Key and credential stores are off limits in every mode.** The NEAR key folder in your home
  folder, SSH keys, cloud and registry credential files, keychain commands that print a secret, VS
  Code's own secrets database and this extension's identity and policy files are refused with no
  card, whether the agent uses a file tool or a shell command. A file in your project that only has
  the same name as VS Code's secrets database is yours to use. The check reads the command's text,
  so a command that only mentions one of these places, such as a commit message naming `~/.ssh`, is
  refused too: rephrase it, or do that step yourself.
- **A command the checks cannot read whole asks.** A shell command nested more than four levels
  deep, too long to check, or started by a program the checks do not know with a command such as
  git push after it, asks first in Full auto too, and is refused when nobody is there to answer,
  instead of running unread. So does one the checks cannot parse, such as a line with a quote left
  open. Commands run through stdbuf, flock or watch are read like any other.
  The scripts that `npm run` and the like start are read from the package.json of the folder the
  command runs in, so `cd sub && npm run sync` is read as sub's script; when that folder cannot be
  told, the command asks too.
- **Approving a helper's card late runs that call once.** When you approve a helper agent's card
  after the helper has moved on, that exact call may run once; the next one like it asks again.
- **Web search with no search provider set up no longer asks first.** Such a call only says that
  web search is not set up, so it runs like reading and planning.
- **Decision records leave out passwords and tokens by kind.** The command kept in a decision
  record has them removed wherever they sit: in a web address, after options such as `--user`,
  `--password` or `--token`, in headers such as `Authorization` and `Cookie`, and in a variable or
  query parameter named for one. SECURITY.md lists what is removed and what is not.
- **Team Studio follows the folder you have open.** Open another folder while Team Studio is open
  and it lists, tests and saves that folder's team.
- **After reading a credential file, sending asks.** Full auto still reads your project's `.env`
  and key files without asking. Once a run has read one, anything that could send data off your
  computer asks first in every mode: a command the checks know reaches the network (such as curl
  sending data, ssh, git fetch or push, gh, or a cloud tool), publishing, a web fetch or search,
  and a call to an add-on server with a web address. Builds, tests and your own scripts still run.
  These cards have no **Always allow**, and with nobody to answer they are refused.
- **Merging a pull request and writing through the GitHub API ask in every mode.** `gh pr merge`
  and a `gh api` call that writes (a writing method, a field or a body) count as publishing.
  Opening a pull request and commenting follow your settings, as before.
- **Signing in and out asks in every mode.** Logging in or out of a package registry, a container
  registry, GitHub, Google Cloud, Azure or AWS, and revoking a stored token, ask first, because they
  change the logins kept on your computer. Commands that print a stored token are refused (below).
- **More credential stores and token commands are off limits.** The GitHub CLI's folder (which
  holds its login), cargo's, terraform's and RubyGems' credentials, your desktop keyring and your
  home `.yarnrc.yml` join the stores agents may not touch, and so do commands that print a stored
  token when they run, such as `gh auth token`, `gcloud auth print-access-token`, `aws sts
  get-session-token` and `npm token list` (a message or search that only mentions one is fine). A
  project's own `.npmrc` or `.yarnrc.yml` is still yours to use.
- **Routine git upkeep no longer asks in Full auto.** `git gc` and `git prune` that keep git's
  grace period, and continuing, skipping or leaving a rebase already under way, run like other
  work. Pruning at once, starting a rebase and expiring the reflog still ask.
- **A file outside your project is refused at once.** When an agent names a file outside the
  project and every folder it may use, it is told so straight away instead of you seeing a card
  the tool would refuse anyway.
- **Local add-on servers can say what they do.** For a server that runs on your computer, the new
  `nearAi.mcp.localServerEffects` setting declares once what its tools may do: read, write named
  project paths, reach named hosts. A declaration is your statement that you trust what that
  server's tools do: NEAR AI does not check each call against it, so a declared tool runs without
  asking in Full auto. Only declare servers you trust like your own code. Until you declare it, its
  tools that change data keep asking, and a tool that says it may delete or reach the open world,
  or does not say, keeps asking after it too.
- **Every refused call is on the record.** A call whose arguments could not be read is now
  recorded too, naming the tool and never its arguments. Decision records also keep a number given
  to a token limit, such as `--max-tokens 4096`, while still removing tokens themselves.
- **Using a team you already have no longer asks you to name it.** Building a team used to open
  on its name, what it is for and where to save it, even when you only wanted a team you already
  had. It now asks how you want to start. **Use an existing team** lists your saved teams and the
  built-in ones; pick one, then **Use as is** or **Clone and modify**. Use as is makes it this
  project's team, asking first if the project already has one (the old one stays in its history),
  or, with no folder open, puts it in the chat; a built-in team is saved to My teams under its own
  name first. A built-in team that is made from your answers asks only those, next to the buttons.
  **Create a new team** starts from scratch, from a clone of an existing team, or from a description
  the AI drafts a team from. Only a new team or a clone asks for a name, what it is for and where to
  save it; a clone of one of your teams starts as "Copy of" that team, and a clone of a built-in team
  starts under the built-in's name. Back returns to the screen before at every step,
  and a draft you saved earlier opens on the step you left it. A team drafted by AI from the builder
  for this project is saved as this project's team unless you choose otherwise.
- **A team is not saved when its origin cannot be checked.** If Team Studio cannot check whether a
  team's members came from an imported team you have not approved, it now says so and saves
  nothing, instead of saving the team without the question it asks before such a team first runs.
- **Replacing a project's team always keeps the old one.** When the old team and the new one were
  kept as versions within the same millisecond, the new version could overwrite the old one.

## 0.4.28

This release adds Team Live, a panel where you watch your team work: the lead hands out tasks,
members wake up and report back. It also gives NEAR AI a policy: one signed file that sets the most
the agent may do, a status bar item and commands to see and reset it, and a plain statement of what
every tool does. Your settings still decide what is allowed day to day, and they can only narrow
what the policy allows.

- **Team Live: watch your team work.** A new panel draws a team run as a tree, the lead at
  the top and each member under whoever it reports to. When the lead hands a member a task, a
  dot carrying the task travels down the line and the member's card wakes up; a working card
  breathes slowly and shows its tool, what it is doing, how long it has worked, its model and
  where the model runs. When it finishes, a dot travels back up with its report. Waiting for
  you turns a card amber with **Answer in chat**. Members not asked yet are dimmed, helpers
  that are not members appear under the agent that started them, and a member asked several
  times is one card with a count. Click a card for the member's card, this run's figures,
  Pause, Resume and Stop, and the end of its latest reply with secrets removed. Open it with
  **Watch the team** under the running agents in the chat, in Agent Activity, on Team Studio's
  Team shape tab, or with **NEAR AI: Watch the Team Live**. Nothing moves under reduced motion
  or with **Calm**; every state has an icon and words; the team works as a keyboard tree and a
  narrow panel shows it as a list. After a reload, the last run is drawn as it ended.
- **The chat's running agents show the team at a glance:** a row of dots, one per agent, whose
  shape and words say what each is doing.
- **An agent started by another sub-agent now reports to that sub-agent.** Before, its report
  went to the run's lead, which had not asked for it, and the sub-agent ended without it. The
  sub-agent now reads it before it finishes, and while it waits it gives its place back so the
  helper can run.
- **Agent Activity shows who started each agent,** what an agent waiting for you waits for (an
  approval, an answer or an image review), and agents waiting for a free slot. A question from
  an agent now counts as waiting for you, as an approval does.
- **Improve with AI in Team Studio** says the cost is unknown when NEAR gives no price for the
  model, rather than leaving it out, and a Cancel while it is choosing a model now always reads
  as cancelled. A suggestion to change who a member reports to that names nobody is now set
  aside with a reason instead of being read as "reports to nobody".
- **A member's `privacy:` line may carry a note** after the value (`privacy: private  # client
  data`); marking the team private no longer adds a second line under it.
- **A policy status bar item.** A **Policy** item in the status bar shows that your policy is
  signed and valid. It says when the policy is close to its end and being renewed, and turns to a
  warning, with one sentence naming the cause and the fix, when the policy cannot be trusted.
- **NEAR AI: Show Policy.** Opens your policy in plain words and as stored. The view is read only:
  looking at it, or editing the text, changes nothing.
- **NEAR AI: Reset Policy to Defaults.** Asks you to confirm, signs a fresh default policy with
  this computer's key, keeps your old policy file beside the new one, and records the reset. It is
  the only way back from a policy that failed.
- **A policy step in setup.** The setup view has a **Check your policy** step. It is done when your
  policy is valid, and shows the status bar's sentence when it is not.
- **Every tool says what it does.** Each tool now declares whether it reads, changes your files,
  runs commands, uses the network or starts other agents, among others, and the Tools page shows
  it in plain words. For an MCP server's tools you can say what each one does (only reads,
  changes data on the server, or not known) on the MCP Connections page.
- **New MCP servers start restrictive.** A server you add starts with every tool undeclared. An
  undeclared tool asks before it runs in every mode except `fully-autonomous`, and it runs only
  while you are there: a run with nobody watching does not call it. Servers you added before keep
  working as they did.
- **A broken or missing policy file falls back to reading and planning only.** If the policy file
  is missing, changed outside NEAR AI, signed by a key this computer does not know, or expired,
  only reading and planning run until you run **NEAR AI: Reset Policy to Defaults**. NEAR AI never
  signs a replacement by itself, except on a true first install.
- **Records of the policy.** What happens to your policy (created, renewed, reset, or failing to
  load) is recorded in this extension's storage, in a log for this computer, and in the open
  project's record when a folder is open. Nothing goes into your project.

## 0.4.27

This release adds Improve with AI and a free local check to Team Studio, lets you mark a whole team
private, and makes Team Studio's AI calls respect TEE-only mode and your daily spend limit.

- **Improve with AI in Team Studio.** A new **Improve with AI** button in the team editor (and on
  the last step of the builder) first runs a free check of the team, then, when you ask, has an
  AI review it. Each suggestion changes one thing for one member (its instructions, role, who it
  reports to, or its tools) or adds or removes a member, with the reason and the exact lines that
  change. Accept, reject or edit each one; **Accept all** takes only wording changes. Accepting
  changes the team in the editor, and **Save** writes it and keeps a version as before. A
  suggestion that gives a member another tool, or adds or removes a member, is marked and must be
  accepted on its own. A suggestion that no longer fits (you edited that part, or the file
  changed) shows as stale, and one that would break the team as invalid; neither changes
  anything. The review never changes a member's model or privacy, and leaves the plagiarism
  checker and Open-GSD members as they are. The panel names the model and the most the review
  can cost before you ask, and the model may give its own rating of the team, shown as its
  opinion, not a measurement.
- **A free check of every team while you edit it.** Team Studio now warns when a member's
  instructions ask for something its tools cannot do (search the web, run commands, change files,
  make slides or PDFs), when a member told not to edit files still has Write or Edit, when
  instructions do not say what the member hands back, when a role is vague, when two members do
  the same work, when a reports-to line names nobody or goes round in a circle, when instructions
  are very long, and when something looks like a key or password. These are warnings: they never
  stop a save.
- **Private teams.** Tick **Private team** in Team Studio, or ask for a private team when the AI
  drafts one, to keep every member on a private model (a NEAR TEE model or one on this computer).
  The team file gets `privacy: private` in its frontmatter and on every member, so an older
  version of the extension still keeps each member private; unticking it leaves the members'
  lines for you to remove one by one. A team whose members are all private counts as private too,
  and in a project with a knowledge base every team does, including one the AI drafts. A private
  team is only ever sent to a private model when Team Studio asks AI about it (a NEAR TEE model
  counts only when NEAR reports its attestation as supported or verified); a team with some
  private members leaves their text out when no private model is
  available, and says so.
- **Team Studio's AI calls now follow your limits.** Drafting a team with AI used to skip the
  checks chat makes: Emergency stop, your daily spend limit, TEE-only mode and the check for keys
  and personal data. It, and Improve with AI, now pass them, and nothing is sent when they say no.
- **Saving a team keeps a change to who a member reports to.** It was lost when it was the only
  change to that member.
- **Team Mode refuses a remote address with a token in it on git older than 2.31**, such as
  `https://host/team.git?access_token=...`, as it already did for one with a password.
- **Key history warnings reach the NEAR AI Team output from the moment Team Mode starts**, also
  for a key rotation or revocation before you enable Team Mode or open a team project.

## 0.4.26

This release shows your saved teams when you set up a new team, lets you share and import a team
as one file, and tightens how Team Mode handles git addresses and key history warnings.

- **Your saved teams appear when you set up a new team.** The starting points in Team Studio's
  builder, including **Set Up Project Team** in a new project, now list the teams you saved as
  your own (from any project) next to the ones the extension provides, with a filter for **All**,
  **My teams** and **Built-in**. Each shows its description, how many members it has and where it
  came from. Choosing one copies its members into the new team for you to review, and a project
  team made this way is still asked about before it first runs. With no saved teams, **My teams**
  says how to save one.
- **Share a team as one file.** **Share…** in Team Studio saves a team as a `.near-team.json` file
  you can send to someone. It carries the team and a checksum, never a path, setting, key or
  token from your computer; the team's knowledge graph is left out unless you choose to include
  it, and is cleaned first when you do. A team holding something that looks like a key is not
  shared, and one naming a folder on your computer asks first. **Import…** checks the file, shows
  what the team contains and adds it only when you agree; a damaged or edited file is refused with
  a plain message. An imported team is not trusted until you approve it the first time it would
  run.
  **Share…** replaces the **Export** button on team cards; **Open as Markdown** still opens the
  team file itself. Anything made from an imported team you have not approved (a copy, a team
  built from it, or a project team) is asked about before it first runs too.
- **Team Mode refuses a remote address with a password on git older than 2.31.** Such a git has to
  receive the address on its command line, where other users of the computer can read it, so
  Team Mode now stops and asks you to update git or move the credentials into a credential
  helper.
- **Team Mode warnings about your key history reach the NEAR AI Team output** once Team Mode is
  active in the window (after Enable or when a team session starts), not only from Enable.

## 0.4.25

This release adds Team Mode as a preview, so a person can set up a signed team record for a
project, and hardens how Team Mode talks to git. It also fixes a few edge cases in image review.

- **Team Mode is available as an early preview.** It is off unless you turn on the setting
  `nearAi.team.preview`. With it on, **NEAR AI: Enable Team Mode** creates a team for the open
  project: it makes a signing key for this computer and keeps it in the editor's secret storage,
  starts a signed team log on its own branch of the project's git remote, and commits a small
  `team.json` so every clone can find the team. Nothing else in your project is pushed unless you
  choose to share your branch. **NEAR AI: Verify Team Log** checks every entry in that log
  (signatures, order and permissions) and reports who is in the team and anything it refused. Team
  Mode never asks for or stores your email address. This computer remembers which team each project
  belongs to: if `team.json` later names a different team or owner key, Team Mode pauses until you
  choose **Trust this new team** and confirm. For now a team holds only its owner: inviting
  teammates arrives in a later release. See "Team Mode (preview)" in the README.
- **Team Mode ignores programs named in the project's git config.** A cloned project carries its
  own git settings, and some of them make git run a program or send extra data when it talks to the
  remote: an ssh command, a credential helper, a proxy, upload and receive programs, extra HTTP
  headers, and rules that rewrite the remote address into one of git's command helpers. Enable Team
  Mode and **Share with my team** now check the remote address as git resolves it (Team Mode
  contacts only ssh, git, https, http and file addresses or a local path), then reach the remote
  without the project's git settings, so none of those run. Your own global git settings, such as
  your credential helper and ssh command, still apply, and so does an ssh command set in your
  environment.
- **A replaced signing key is never made active again.** If a key change on this computer was
  recorded but its new key was lost (for example after a crash), the old key could quietly become
  the active key again. Team Mode now keeps the old key aside, archives the key history (it is never
  deleted) and starts a fresh key with its own history.
- **A key history problem is reported, not hidden.** When saving the key history fails and it
  cannot be put back as it was, Team Mode now says so in its output panel, in plain words and
  without any key material.
- **An empty image draft shows as gone.** When an image draft's file was still there but empty,
  the review card treated it as an image, and asking for changes tried to edit it. The card now
  says the draft is gone, and the agent is told to make the image again.

## 0.4.24

This release gives questions and image reviews a time limit that matches approvals, fixes edge
cases in image review, and corrects README and SECURITY.md where they described the agent's
permissions differently from how it behaves.

- **Questions and image reviews no longer wait forever.** A question from the agent, or an image
  waiting for your review, had no time limit, so in Full auto or with a helper agent working in the
  background a run could sit waiting for the rest of the day. They now follow
  `nearAi.agent.approvalTimeoutMinutes` (15 minutes by default; 0 waits indefinitely). In Full
  auto, and for a helper agent running in the background, the card then says it timed out and the
  run carries on: the agent is told the question got no answer, and an image's draft is kept in
  `.near-ai/drafts/images/` for you to look at later. In the other modes nothing is decided for
  you: as with an approval, the run is paused on the question or image, the card stays, and your
  answer carries the run on whenever you are back. Left a whole day, the run is released, as an
  approval is, and the agent is told nobody answered (an image's draft is kept), not that it timed
  out.
- **An accepted image is not lost to a second attempt.** When two attempts at the same image ran
  at once, the second could delete the image you had just accepted before it was saved, and the
  save failed. The accepted image is now kept until it is saved.
- **A failed image edit no longer pays for a different image.** When an edit of an image failed
  with a "not found" error, it was treated as "this model cannot edit images" and a new image was
  made from the prompt instead, which cost a second image. Now that happens only when the error
  says editing is not supported; any other failure is reported as it is.
- **A missing image draft says so.** A review card for a draft whose file had been removed said the
  image was too large to show. It now says the draft is gone and offers only Discard, and an agent
  asked to change a draft that is gone is told to make a new image rather than edit a missing file.
- **Files you attached stay attached.** A rare message from the editor could hide the chips of
  files you had attached while they were still going to be sent with your next message. Chips now
  go only when their files have gone with a message.
- **Your earlier answer about a project's team is kept.** In a workspace with several folders, an
  answer to "use this project's team?" saved before 0.4.22 was forgotten when another folder's team
  was asked about first, so you were asked again. It is now kept for the folder it belongs to.
- **Docs match what the extension does.** The README no longer says answers cannot be checked
  (**Verify signature** checks them), the README and SECURITY.md now agree that Full auto reads
  credential files and writes into `.git/` without asking, and SECURITY.md describes each team's
  shared knowledge graph.

## 0.4.23

This release lets you review every image an agent makes before it is saved, makes helper agents
run on the model the agent asked for, keeps agents out of the project's keys, and fixes three sync
issues.

- **A sub-agent runs on the model the agent asked for, or not at all.** When the agent started a
  helper agent with a model your key does not have, the helper quietly ran on the chat's model
  instead. A short name such as `gpt-6.1-sol` now finds the full model ID when only one model on
  your key has that name, and a name that matches no model (or several) stops that helper with a
  message listing the models your key has, so the agent can pick one. Tiers (deep, standard, fast)
  work as before.
- **The agent knows which model each helper agent used.** The helper's report, and the line that
  says a background helper started, now name the model it ran on, so the agent can tell you
  truthfully. When a configured role model is not on your key and the chat's model is used
  instead, the chat says so.
- **The agent can choose an image model.** GenerateImage can now use any image model on your key,
  not only the one in `nearAi.agent.imageModel`, which stays the default. The tool lists the image
  models with their prices, and the approval, the result and the spend record name the model that
  made the image. A model that is not an image model on your key is refused with the list.
- **You review each image before it is saved.** An agent could make the same image again and
  again, judging each one with its own scripts and saving every attempt into your project, while
  you could not see it. Now each image the agent makes shows in the chat first, with where it will
  be saved, the model, the attempt number and the prompt. **Accept** saves it where the agent
  wanted, **Request changes** sends your words back to the agent so it makes a new version
  (editing the image when the model can), **Discard** throws it away, and **Open full size** opens
  it in a tab. Images made by helper agents show in the same chat, with the helper's name. The
  agent waits for your answer in every approval mode, as it does for its questions, and is told
  not to judge or remake images on its own. Images waiting for you are kept in the project's
  `.near-ai/drafts/images/` folder, which is never committed. A draft is removed once the agent
  makes a new version of it, and ones left there are removed after 7 days. To save images straight
  away as before, set `nearAi.agent.imageReview` to `off`.
- **Agents can no longer read the project's keys.** In one run an agent wrote a small script that
  read the project's key file and used it to open the project's own encrypted chats. The project's
  key folder, `.near-ai/state/keys/`, is now off limits to agents in every approval mode: the file
  tools refuse it and never list or search it, and a command that names it is refused without
  asking. The shell check follows the folder the agent's shell is in, so moving into
  `.near-ai/state` first and then reading `keys/local.key` is refused too, and the shell cannot
  work inside the key folder at all. A command that runs a project file whose text names the
  folder always asks first, with no "always allow". The shell checks read the command and the script it runs, so a path put
  together in other ways can still get through; SECURITY.md lists what they cannot see.
- **A chat that ended without saying so no longer stops syncing.** If the end of a chat was
  missed, sync kept treating it as running for the rest of the session and never sent its saved
  state. A chat that has no running record behind it is now treated as ended after a short while.
- **A conversation from another computer keeps its title.** A conversation that was running on
  another computer was added here as "Conversation" until its details arrived, and in rare cases
  that name could replace the real title. The stand-in name now never replaces a real one and is
  never sent to other computers.
- **Turning sync off removes the saved items sync was holding.** What a sync kept back for a
  running chat (`sync/deferred.enc`) stayed on disk after sync was turned off. It is now removed,
  and turning sync on again fetches those items from your project's remote again. A sync that was
  already running when you turned sync off no longer puts the file back afterwards.

## 0.4.22

This release stops Auto asking about the agent's own helper scripts, makes the waiting badge match
the approvals you can see, and keeps project sync running during long chats.

- **Auto no longer asks before running the agent's own helper scripts.** The agent is told to keep
  helper scripts in the project's `.near-ai/scratch/` folder, but with Auto on, running one asked for
  approval every time, often every few seconds. A script the agent wrote there during the current
  run, with its Write or Edit tools or with a shell redirect, `cp`, `mv` or `tee`, now runs without
  asking, and so does one written by another agent of the same run. A script written another way
  (for example with `sed -i`), one the run did not write itself, one changed since, or one written
  after the agent read outside content such as a web page, still asks.
- **The badge on the NEAR AI tab counts only approvals you can see and answer.** A helper agent's
  approval that went unanswered disappeared from the chat while still counting on the badge. It now
  stays in the chat until you answer it, and allowing a command for the run also settles the other
  waiting approvals for that same command.
- **"Allow every time" works on a helper agent's waiting approval.** Choosing it on an approval the
  helper agent had already moved on from allowed the command for that run only, so it asked again in
  the next run. It is now saved to the workspace's allow list, as it is on any other approval.
- **Sync no longer waits for a long chat to end.** A chat that ran for hours, or waited hours for
  your answer, held project sync back the whole time. Sync now also runs when a chat pauses (it is
  waiting for you, or between steps) once the last sync is older than the sync interval. The chat
  that is running is not changed by it: what another computer saved for that chat is added when the
  chat ends.
- **Sync Project Now works during a chat.** It runs at once instead of waiting for the chat to end.
- **Turning sync on during a chat no longer shows "Needs attention".** The first sync only had to
  wait for the chat, so it is no longer reported as a problem, and it runs at the chat's next pause.
- **A message sent while the agent is working says when it was not sent.** With no project folder
  open, the message now says it was not sent instead of vanishing, and a message whose files were
  not sent no longer shows them as sent.
- **Attached files are not lost or paid for twice.** Files of a message that fails before the agent
  starts come back to the message box, and a message Stop handed back is sent again without reading
  its image or audio file a second time.
- **A project's team is only used in a trusted window.** If VS Code cannot say the window is trusted,
  the team that came with the repository is not used and you are not asked about it.
- **The question about a project's team shows its members plainly.** Names and roles from the team
  file are shown as plain text, shortened, and only the first few are listed, so a team file cannot
  make the question say something else. Each folder of a multi-root workspace is asked about its own
  team.
- **A conversation whose team is gone says so.** If the team a conversation started with was deleted
  or renamed and there is no project team to use, the chat now tells you the run continues without a
  team, instead of dropping it without a word.

## 0.4.21

This release makes what you send and the team you chose reach the agent: files go with the message
they were attached to, and your team's members do the specialist work in every run.

- **Files attached to a message go with that message.** A file attached to a message you sent while
  the agent was working was held back for your next message, so the agent read your words without
  the file and went looking for it. Now the file is read and goes to the running agent in the same
  message, with the same privacy checks as any attachment. A message that becomes the next turn
  keeps its files, and one that Stop hands back to the composer gets its files back too.
- **The chat says where an attached file was saved.** The copy the agent opens with its own file
  tools is made in `.near-ai/attachments/` once the message passes its privacy checks, and the chat
  now names where each file was saved, or says when one could not be saved. Before, it was saved
  silently, and a file sent while the agent was working was not saved at all. A file you remove
  before sending, or whose message is blocked, is never written into the project. A file sent while
  the agent was working is saved when you send the message, so if you then press Stop, the message
  and its file come back to the message box and the saved copy stays.
- **Your team does the specialist work in every run, not only the first.** A team was used only for
  the `/team:<name>` message that started it. A later message in the same conversation, or an
  Open-GSD workflow, could not see the team's members, so work such as images went to a general
  agent instead of the team's designer. Now a conversation keeps the team it was started with, and
  without one the project's own team is used, after you agree to it once for that project (and again
  if its team file changes). Open-GSD keeps the project on track (planning, checking, verification)
  and hands the specialist work to the member whose role covers it, using a
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
