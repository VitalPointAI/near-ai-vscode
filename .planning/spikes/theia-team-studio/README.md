# Sterling in Eclipse Theia

The Docker workbench opens to Sterling Get Started. Set up Sterling or open Chat from the welcome page. The native Team Studio sample uses the extension's existing team parser and four packaged sample projects.

## Run locally

From the root of this checkout, build and start the local development build with Docker.

```sh
docker build -f .planning/spikes/theia-team-studio/Dockerfile -t near-ai-theia-preview:local .
docker run --detach --name near-ai-theia-team-preview \
  --publish 127.0.0.1:18771:3000 near-ai-theia-preview:local
```

Open [Get Started](http://127.0.0.1:18771/). The home icon at the top of the right rail reopens the landing page. **SovAI: Open Team Studio Preview** in the command palette opens a read-only sample. Its project picker includes two valid teams, a folder without a team, and a folder with an invalid team. Select a member to see their role, reporting line, and instructions.

Use `docker stop near-ai-theia-team-preview` and `docker start near-ai-theia-team-preview` to stop and restart the same container.

The container runs as the unprivileged Node user and binds to localhost on the host. The examples are synthetic. This sample container has no host workspace mounts, provider credentials, or agent run controls.

## Run the existing extension in Theia

Build the same image as above. Unpack a trusted release VSIX into the ignored local plugin directory, then start a separate container with that directory mounted read-only. The VSIX runs with a new container-side workspace and no host home or provider credentials. This sample session disables automatic GSD installation. If Theia asks whether you trust the sample workspace, choose Restricted Mode to explore without trusting it.

```sh
mkdir -p .planning/spikes/theia-team-studio/local-plugins
unzip -q /path/to/near-ai-vscode-0.4.36.vsix 'extension/*' \
  -d .planning/spikes/theia-team-studio/local-plugins

docker run --detach --name near-ai-theia-vsix \
  --publish 127.0.0.1:18874:3000 \
  --mount "type=bind,source=$PWD/.planning/spikes/theia-team-studio/local-plugins,target=/plugins,readonly" \
  --env THEIA_DEFAULT_PLUGINS=local-dir:///plugins \
  near-ai-theia-preview:local \
  node_modules/.bin/theia start /home/node/workspace --hostname 0.0.0.0 --port 3000 \
  --session-preference nearAi.autoInstallGsd=false
```

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. Get Started opens Sterling setup, Chat, and the four Defence work-area landing pages. The right rail opens Get Started, Portfolio, Chat, Team Studio, Agent Activity, Governance, Compliance, and Documentation. Data Management and Model Factory are marked as planned. Chat slides from the right rail and respects reduced-motion preferences. Click its rail icon again or close its last conversation tab to dismiss the drawer. Reopening it shows the same conversation. The compatibility container is for synthetic projects and has an in-memory credential store.

## Defence work areas and Portfolio

Use the four cards in Get Started to open their landing pages. Browse existing work areas in an open folder, or choose Create to name a new work area. Sterling creates it in the current folder or asks which folder to use. Capability Development also lets you name the programs, major and minor capital projects, initiatives, and products that form the capability. Sterling opens the new folder and shows its name on Get Started. Its title and capability components are kept in Git-ignored local metadata.

Portfolio can display an approved non-sensitive export from an explicitly selected, trusted folder. Store it at `.planning/.near-ai/portfolio.snapshot.json` in that folder, then open **Portfolio** and choose **Load snapshot**. While visible, the view checks for file changes every five seconds and displays the reported source and generation time. The signed DND/CAF publication feed requires separate deployment and access.

A synthetic example has this shape:

```json
{
  "schemaVersion": 1,
  "source": "Synthetic portfolio example",
  "generatedAt": "2026-11-23T15:00:00Z",
  "nodes": [
    { "id": "example", "level": "L0", "name": "Example portfolio" },
    {
      "id": "sample-unit",
      "parentId": "example",
      "level": "L1",
      "name": "Example unit",
      "status": "green",
      "asOf": "2026-11-23T14:30:00Z"
    }
  ]
}
```

Use levels L0 through L5, with each child linked to a parent at the preceding level. Status values are `green`, `amber`, and `red`. Omit status when the source has no report.

## Resource Inventory

Place an approved non-sensitive export at `.planning/.near-ai/resource-inventory.snapshot.json` in the trusted folder that contains the work areas. Open **Resource Management** and choose **Open resource inventory**. The inventory appears automatically in a trusted workspace and refreshes while visible. Search by resource ID or name, and filter by category and reported status.

Use **Link a resource** on an existing work area to open the inventory scoped to that folder. Pick an item and choose **Link resource**. The work area stores the source ID and resource ID in its local metadata while the inventory retains the source record. Allocation belongs to the signed approval workflow in Phase 40. The local build reads an optional reported `assetDid`, `usagePolicyRef`, `stockNumber`, `description`, and `imageRef` from the inventory source. Durable identity issuance and usage policy checks belong in the governed host.

A synthetic inventory export has this shape:

```json
{
  "schemaVersion": 1,
  "sourceId": "example-inventory",
  "source": "Synthetic resource example",
  "generatedAt": "2026-11-23T15:00:00Z",
  "resources": [
    {
      "id": "training-kit",
      "name": "Example training kit",
      "category": "Training equipment",
      "quantity": 3,
      "unit": "kits",
      "status": "available",
      "asOf": "2026-11-23T14:30:00Z"
    }
  ]
}
```

### Public CAF starter catalogue

Copy [caf-public-catalogue.snapshot.json](extension/fixtures/caf-public-catalogue.snapshot.json) into a trusted folder at `.planning/.near-ai/resource-inventory.snapshot.json` when starting from an empty workspace. Keep any existing inventory snapshot in place. Resource Inventory opens the catalogue automatically. Choose a folder only when the workspace has several roots. The public catalogue shows evidence and a lifecycle label per record and leaves asset linking for authorized inventory sources.

The seed combines the CAF equipment export, current service catalogues, results reports, procurement notices and supplier acceptance evidence where official service listings lag. Public listings, documented deliveries, contracted services, acquisitions and retirement evidence receive separate labels. Catalogue entries include source links and official image references where matched. Stock numbers are populated only for the exact item named in the source, such as a logistics spare in a DND request for information. The public catalogue carries no unit availability, serial data or asset DIDs. The local development build keeps copied reference images in the persistent workspace volume under `.planning/.near-ai/resource-inventory-media/`. A record’s `imageDigest` names the local bytes by SHA-256, and `imageRef` records their source. The view displays the stored copy and keeps working without a connection to the source. Approved exports can supply the same photo files beside their snapshot. [CAF equipment export](https://open.canada.ca/data/en/dataset/18beb583-8dbe-434e-ba49-970658fcd6ef?wbdisable=true) · [RCAF aircraft](https://www.canada.ca/en/air-force/services/aircraft.html) · [RCN fleet](https://www.canada.ca/en/navy/corporate/fleet-units.html) · [Army vehicles](https://www.canada.ca/en/army/services/equipment/vehicles.html) · [DND 2025–26 results](https://www.canada.ca/en/department-national-defence/corporate/reports-publications/departmental-results-report/drr-2025-26.html)

Cross-checks changed several public labels. Departmental results establish that the Kingfisher entered operational service and that ACSV deliveries continued. The Juno supplier documented formal RCAF acceptance, while the Siskin II supplier reported Canadian arrival ahead of acceptance. The Navy's Kingston class listing remains useful for identification during its announced divestment. [DND results](https://www.canada.ca/en/department-national-defence/corporate/reports-publications/departmental-results-report/drr-2025-26.html) · [Juno acceptance](https://skyalyne.ca/latest-updates/skyalyne-celebrates-delivery-of-first-ct-153-juno-helicopter-for-fact-program/) · [Siskin II arrival](https://skyalyne.ca/latest-updates/in-photos-welcome-to-canada-rcaf-ct-157-siskin-ii/) · [Kingston divestment](https://www.canada.ca/en/department-national-defence/news/2025/07/royal-canadian-navy-to-pay-off-kingston-class-vessels.html)

Use **Add catalogue entry** or **Edit entry** to curate a candidate in the trusted local snapshot. **Archive entry** removes it from the default view. Enable **Show archived entries** to review or restore it. These actions are available in the provisional catalogue. Approved asset snapshots retain their read-only import workflow.

The [historical vehicle model index](extension/fixtures/caf-vehicle-historical-model-index.csv) consolidates published make and model aliases across construction years. It excludes rows with unnamed equipment families and omits the historical counts from the starter catalogue. Use it to propose matches when current departmental records arrive. [CAF vehicle equipment export](https://open.canada.ca/data/en/dataset/1270405b-fa35-49a5-800e-a8ddac54a086)

### Equipment catalogues and asset identity

The public CAF equipment CSV inspected on 2026-11-23 has 57 rows and three columns for equipment type, name, and description. The CAF service pages publish selected equipment images. These are model-level references. [CAF Open Government dataset](https://open.canada.ca/data/en/dataset/18beb583-8dbe-434e-ba49-970658fcd6ef) · [CAF equipment pages](https://www.canada.ca/en/services/defence/caf/equipment.html)

The NATO Master Catalogue of References for Logistics is the stock catalogue, available through NSPA. Use an authorized, licensed organisation export matched against the department's approved materiel records. DND records master data in DRMIS where security requirements permit and maintains photographs and supporting technical records under its Materiel Identification directive. [NSPA catalogue](https://eportal.nspa.nato.int/ac135/nmcrl) · [DND Materiel Identification directive](https://www.canada.ca/en/department-national-defence/corporate/policies-standards/defence-administrative-orders-directives/3000-series/3038/3038-0-materiel-identification.html)

Use the NATO stock number for the catalogue item where assigned. Identify each individual asset with an opaque DID issued by its authorized controller. Multiple individual assets can refer to the same catalogue item. Store approved images and their provenance in governed data management. Apply signed usage policy to the individual asset; keep custody, location, serial and other restricted data in permissioned records. [W3C DID Core](https://www.w3.org/TR/did/)

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.

## Hero artwork

The built-in ImageGen tool generated [the Sterling hero](extension/assets/sterling-hero.webp). The app animates the image and a light sweep in CSS and honors reduced-motion preferences.

> Editorial 3D hero image for the Sterling sovereign AI desktop workbench. A polished, monumental brushed-silver torus assembled from precisely machined interlocking arc segments floats above a dark graphite circular platform. A fine translucent icy-blue light traces one arc and echoes in thin concentric rings on the floor. Futuristic, architectural, restrained and tactile, with a soft cobalt atmospheric horizon, deep ink shadows, realistic metal reflections and a little film grain. Wide landscape composition, sculpture centred around 56% width, usable empty dark navy first quarter on the left for HTML text, generous framing. Clean high-end industrial photography, no text, no logos, no interface, no watermark.

### Canadian Edition

The Canadian Edition uses [the maple leaf hero](extension/assets/sterling-hero-ca.webp). The welcome page’s edition artwork, label, and shell accent class are paired in [the welcome module](extension/src/browser/sterling-welcome-module.ts) for future Sterling territories. The original hero remains available as a shared asset.

ImageGen edit prompt:

> Edit the supplied Sterling Sovereign AI hero with one localized change. Add a single clearly recognizable Canadian red maple leaf, matching the iconic symmetrical 11-point silhouette on Canada's flag, suspended at the exact visual center of the open steel ring. Make it a crisp, premium red enamel emblem with subtle dimensionality and a faint cool rim reflection from the blue light, facing the camera. Give it breathing room around all points within the opening, about 55% of the opening's width. Preserve the ring, camera position, framing, platform, dark navy and cobalt lighting, and especially the dark negative space on the left for webpage typography. Keep the same wide landscape composition. No flag rectangle, no extra symbols, no lettering, no watermark.

### Canadian Defence Edition

Documentation and Compliance open as Theia tabs. The Docker build bundles the existing Markdown sources for Documentation. The Compliance tab shows the published public evidence and explains when it is unavailable. To supply the refreshed bundle at startup, add this option to the workbench’s `docker run` command before the image name:

```sh
--mount "type=bind,source=/absolute/path/to/docs-site/build/compliance,target=/repo/.planning/spikes/theia-team-studio/lib/frontend/compliance,readonly"
```

Use the `build/compliance` directory populated by the docs site’s existing refresh workflow. Private overlays stay with the docs service.


The [Defence Edition hero](extension/assets/sterling-hero-ca-defence.webp) adds motifs for cyber, space, land, sea, and air around the maple leaf. A pulse travels along the trails. The hero pause button and reduced-motion setting also stop the pulses.

> Localized image edit for the Sterling Sovereign AI Canadian Defence Edition Get Started hero. Preserve the existing 16:9 wide blue and brushed-metal design, strong red Canadian maple leaf exactly in the ring's opening, pedestal, camera framing and original dark clean left 40 percent for the website headline. Add five distinct, understated cyan-blue holographic symbols in the open dark space around the outside of the ring, linked by slender curved dotted orbital tracks. The five symbols represent cyber (small circuit network), space (recognizable satellite with solar panels), land (topographic ground contour or mountain ridge), sea (wave lines and a small ship silhouette), and air (simple aircraft silhouette). Keep the symbols readable but restrained and visually secondary to the ring and red maple leaf. Keep all five clear within the central-right composition with generous edge margins. No writing, labels, brand text, watermarks, weapons, combat, explosions, or targeting graphics.

### Defence work-area heroes

Sterling uses built-in ImageGen illustrations for the four landing pages. The equipment scenes used a common prompt that requested a wide 16:9 realistic editorial photograph shaped for dark left-side web copy, cool steel and navy lighting, and an unoccupied scene without people or uniforms.

- **Capability Development** shows a scale model of the Harry DeWolf-class ship in a naval design studio. [Asset](extension/assets/sterling-area-capability.webp) · [Royal Canadian Navy reference](https://www.canada.ca/en/navy/corporate/fleet-units/surface/harry-dewolf-class.html)
- **Exercises & Training** shows a Canadian Army mountain training group crossing a rocky ridge in the Canadian Rockies. The built-in ImageGen prompt placed four distant, backlit figures with backpacks to the right of the page copy and kept faces, uniform details, and insignia indistinguishable. [Asset](extension/assets/sterling-area-training.webp)
- **Planning** shows an empty Canadian government planning room at blue hour. The built-in ImageGen prompt requested abstract Canadian maps and planning sheets on a table, quiet space for the heading, and cool steel-blue light with a muted amber accent. [Asset](extension/assets/sterling-area-planning.webp)
- **Resource Management** shows the Canadian Army's Mack Defence MSVS Standard Military Pattern truck in an empty logistics depot. The edit used the official vehicle photo as a reference for the cab profile, four axles, flat deck, and stowed crane. [Asset](extension/assets/sterling-area-resources.webp) · [DND reference](https://www.canada.ca/en/department-national-defence/services/procurement/medium-support-vehicle-system-project.html)
