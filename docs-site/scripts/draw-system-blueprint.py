"""Render the architecture overview image with Pillow and the Lato type family."""

from math import atan2, cos, sin
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 3500, 2280
BACKGROUND = "#081423"
PANEL = "#102339"
INSET = "#142b43"
WHITE = "#edf8ff"
MUTED = "#b6cde0"
AQUA = "#79e2f2"
GOLD = "#ffd489"
VIOLET = "#c3afff"
GREEN = "#a7ebc5"
FONT_DIR = Path("/usr/share/fonts/truetype/lato")

image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
draw = ImageDraw.Draw(image)


def font(size, heavy=False):
    return ImageFont.truetype(str(FONT_DIR / ("Lato-Bold.ttf" if heavy else "Lato-Regular.ttf")), size)


def text(x, y, value, size, fill=WHITE, heavy=False, width=None):
    face = font(size, heavy)
    if width is not None:
        assert draw.textlength(value, font=face) <= width, value
    draw.text((x, y), value, font=face, fill=fill)


def arrow(points, color=AQUA, planned=False, two_way=False, weight=4):
    for start, end in zip(points, points[1:]):
        if planned:
            x, y = start
            dx, dy = end[0] - x, end[1] - y
            length = (dx * dx + dy * dy) ** 0.5
            if not length:
                continue
            for n in range(0, int(length), 19):
                segment = [(x + dx * i / length, y + dy * i / length)
                           for i in (n, min(n + 11, length))]
                draw.line(segment, fill=color, width=weight)
        else:
            draw.line((start, end), fill=color, width=weight)
    tips = [(points[-2], points[-1])]
    if two_way:
        tips.append((points[1], points[0]))
    for start, tip in tips:
        angle = atan2(tip[1] - start[1], tip[0] - start[0])
        head = [tip] + [(tip[0] - 14 * cos(angle + side * .52),
                         tip[1] - 14 * sin(angle + side * .52))
                        for side in (-1, 1)]
        draw.polygon(head, fill=color)


def label(x, y, lines, color=AQUA):
    face = font(22, True)
    half = max(draw.textlength(line, font=face) for line in lines) / 2 + 13
    height = len(lines) * 26
    draw.rounded_rectangle((x - half, y - 4, x + half, y + height + 4), 8,
                           fill=BACKGROUND)
    for index, line in enumerate(lines):
        draw.text((x, y + index * 26), line, font=face, fill=color, anchor="mt")


# Each group is an execution, administration or custody boundary. Each row is a
# pair of tiles; only declared links are drawn between tiles.
groups = {
    "release": ("Software supply and release", "BUILD SERVICE  /  SIGNED DISTRIBUTION", GOLD, [
        ("Source and GitHub CI", "Tests, CodeQL and integrity checks"),
        ("Independent review", "Merge eligibility and protected gates"),
        ("Release build", "Exact VSIX → Theia container"),
        ("Owner release approval", "Authorizes the publication"),
        ("GitHub Container Registry", "Pinned image digest and provenance"),
        ("SBOM and release assets", "Checksums, manifests and evidence"),
        ("Signed offline site bundle", "Charts, images and trusted pins"),
        ("Import host", "Verifies signature and exact bytes"),
    ], [(0, 1), (1, 3), (2, 3), (3, 4), (2, 5), (6, 7)]),
    "workbench": ("Staff workstation", "LOCAL  /  HOSTED SESSIONS USE THE SAME APP", AQUA, [
        ("Staff and local browser", "Loopback session or approved site URL"),
        ("Docker launcher", "Verifies exact image; keeps workspace"),
        ("Eclipse Theia Workbench", "Browser shell, setup and local views"),
        ("Extension host + native backend", "Profiles, attachments, identity and egress"),
        ("Chat, Team Studio, Agent Activity", "Tasks, team design and run/spend records"),
        ("Team Live and Staff Room", "Permissioned collaboration and products"),
        ("Defence Edition work areas", "Portfolio, resources, training and planning"),
        ("Agent runtime and Open-GSD", "Role tasks, bounded runs and worktrees"),
        ("Local project state + Git", "Transcripts, attachments and checkpoints"),
        ("Tools and execution backends", "Files, commands, search, web and MCP"),
    ], [(0, 2), (1, 3), (2, 3), (2, 4), (4, 7), (6, 8), (7, 9)]),
    "trust": ("Identity and trust controls", "POLICY APPLIES AT EVERY PROTECTED BOUNDARY", AQUA, [
        ("Person, agent and device", "DID/VC, issuer trust, expiry and status"),
        ("Organization policy", "Clearance, labels, privacy and handling"),
        ("Capability manifests", "Declare effects, scope and endpoints"),
        ("Policy gate", "Checks identity, labels and allowed effects"),
        ("Run contracts and delegation", "Purpose, recipient, time and spend"),
        ("Human approvals and stop", "Exact authorization, budgets and cancel"),
        ("Credential broker and vaults", "Narrow short-lived grants after allow"),
        ("Project and data protection", "Signed records and sealed content"),
        ("Export and allied exchange", "Eligibility, marking and TDF/ZTDF"),
        ("Trust and activity records", "Auditable decisions and outcomes"),
    ], [(0, 3), (1, 3), (2, 3), (4, 3), (5, 3), (3, 6), (7, 9)]),
    "hosted": ("Organization-hosted site", "PLANNED HOSTED SERVICE  /  VERIFIED OFFLINE IN PART", VIOLET, [
        ("HAProxy, DNS and network policy", "HTTPS ingress and webview routes"),
        ("Keycloak and PostgreSQL", "Hosted sign-in and realm state"),
        ("oauth2-proxy and Theia Cloud", "Starts isolated browser sessions"),
        ("RKE2 / etcd / admission", "Kubernetes state, Kyverno, signed images"),
        ("OpenBao, HSM and site PKI", "KV, transit, certificates and custody"),
        ("Harbor or Zot", "Local registry for verified imports"),
        ("Encrypted storage / NAS", "Workspace and service volumes, backups"),
        ("cert-manager and site time", "Certificate renewal and trusted time"),
        ("Prometheus and Alertmanager", "Platform health, exporters and alerts"),
        ("Backup, recovery and lab VM", "Restore exercise, escrow and offline lab"),
    ], [(0, 1), (1, 2), (5, 3), (4, 7), (2, 4)]),
    "mission": ("Mission sync and exchange", "OPTIONAL HUB  /  SEPARATE TRUST PER MISSION", AQUA, [
        ("Authorized workspace A", "Local history and scoped membership"),
        ("Mission Hub A and peer replicas", "Signed sealed events, blobs and presence"),
        ("Workspace B / Hub B", "Separate membership, keys and storage"),
        ("Offline or edge exchange", "Reconnect or import authorized records"),
        ("Scoped mission discovery", "Visibility-filtered catalogue notices"),
        ("Optional messaging relay", "Queue, dedupe; channel links planned"),
        ("Cross-domain originator", "Human approves exact release package"),
        ("Approved transfer / guard", "Checks markings and enforceable route"),
        ("Destination verification", "Quarantine, review and acceptance receipt"),
        ("Managed workstation setup", "Inventory, prerequisites and hub enrollment"),
    ], [(0, 1, False, True), (2, 3, True), (6, 7, True), (7, 8, True)]),
    "inference": ("Approved inference endpoints", "EACH DESTINATION HAS SEPARATE POLICY ELIGIBILITY", AQUA, [
        ("Model and tool routing", "Policy and endpoint eligibility"),
        ("Local runtime", "Same-computer-only when required"),
        ("Organization inference server", "Approved OpenAI-compatible endpoint"),
        ("NEAR AI Cloud private", "Fresh attested connection"),
        ("Forwarded model route", "Only eligible labels may use it"),
        ("Organization-attested / Cohere", "Separate confidential or vault routes"),
        ("Compare Models", "Tasks, graders and role-level ratings"),
        ("Approved model registry", "Passport, exact version and approval"),
    ], [(0, 1), (0, 2), (7, 6)]),
    "assurance": ("Compliance and operations", "CONTROL EVIDENCE  /  HUMAN AUTHORIZATION", GREEN, [
        ("Resource fit and component catalogue", "Pins, licence, control fit and inventory"),
        ("Fluent Bit and OpenSearch", "Redacted site logs, retention and archive"),
        ("Test, build and site evidence", "Scoped facts tied to release or site"),
        ("Compliance engine / OSCAL", "Applicability and fresh control evidence"),
        ("Workbench Compliance view", "Status, gaps and remediation"),
        ("Assessor package", "Verifiable system and assessment records"),
        ("Operations and authorization", "Organization and authorizing official"),
        ("Road to production", "Acceptance conditions and dependencies"),
    ], [(0, 2), (1, 3), (2, 3), (3, 5), (5, 4), (4, 6), (6, 7)]),
    "data": ("Governed data platform", "PLANNED LIVE PATH  /  ISOLATED SYNTHETIC TRIAL", VIOLET, [
        ("Approved sources and collectors", "M365, Google, shares and local folders"),
        ("Connector runtime and inventory", "Metadata first, scoped content and cursors"),
        ("Extraction and derived artifacts", "Isolated parse, OCR and transcription"),
        ("Ingest ledger and catalogue", "PostgreSQL, provenance, RLS and outbox"),
        ("Stewardship and lifecycle", "Labels, privacy, consent, hold and erasure"),
        ("Governed search and query", "Access before BM25, vectors or retrieval"),
        ("Context graph and cited answers", "Authorized entities, links and citations"),
        ("Analytics, reports and replay", "Parquet, DuckDB and DuckLake"),
        ("Workbench Data Management", "Health, inventory and authorized discovery"),
        ("Defence Digital Twin", "Potential governed asset projections"),
    ], [(0, 1, True), (1, 3, True), (2, 3, True), (4, 5, True), (5, 3, True),
        (5, 7, True), (7, 8, True), (7, 6, True), (8, 9, True)]),
    "factory": ("Model Factory", "PLANNED LIFECYCLE  /  FICTIONAL ADVISER FIXTURE VERIFIED", VIOLET, [
        ("Eligible activity and evaluation", "Consented signals and use rights"),
        ("Opportunity Agent", "Finds repeated tasks and proposes work"),
        ("Workload and corpus approval", "Exact purpose, sealed data and target scope"),
        ("Dataset builder", "Lineage, scrub, dedupe and splits"),
        ("Isolated training worker", "Approved network hardware; no off-host I/O"),
        ("Held-out evaluation", "Baseline, score, provenance and fit"),
        ("Classification and protection adviser", "Proposes marking, protections and review"),
        ("Registrar and signed passport", "Version, licence, evaluation and digest"),
        ("Activation and monitoring", "Shadow, approval, rollout and rollback"),
        ("Erasure or loss of consent", "Invalidate affected data, fallback or retrain"),
    ], [(0, 1, True), (1, 2, True), (2, 3, True), (3, 4, True), (4, 5, True),
        (5, 7, True), (7, 8, True), (7, 6, True), (9, 8, True)]),
}

PANEL_WIDTH, PANEL_HEIGHT = 960, 503
POSITIONS = {
    key: (70 + (index % 3) * 1200, 206 + (index // 3) * 643)
    for index, key in enumerate(groups)
}
TILE_WIDTH, TILE_HEIGHT, TILE_STEP = 439, 57, 76


def tile_box(x, y, index):
    x += 24 + (index % 2) * 473
    y += 100 + index // 2 * TILE_STEP
    return x, y, x + TILE_WIDTH, y + TILE_HEIGHT


def group(key, title, scope, color, tiles, links):
    x, y = POSITIONS[key]
    draw.rounded_rectangle((x, y, x + PANEL_WIDTH, y + PANEL_HEIGHT), 22,
                           fill=PANEL, outline=color, width=2)
    draw.line((x + 25, y + 84, x + PANEL_WIDTH - 25, y + 84), fill="#31516a")
    text(x + 24, y + 12, title, 37, heavy=True, width=910)
    text(x + 26, y + 60, scope, 17, color, True, width=906)
    for index, (name, description) in enumerate(tiles):
        a, b, c, d = tile_box(x, y, index)
        draw.rounded_rectangle((a, b, c, d), 8, fill=INSET, outline="#31516a")
        text(a + 13, b + 3, name, 23, heavy=True, width=TILE_WIDTH - 26)
        text(a + 13, b + 31, description, 19, MUTED, width=TILE_WIDTH - 26)
    for start, end, *flags in links:
        a, b, c, d = tile_box(x, y, start)
        e, f, g, h = tile_box(x, y, end)
        if b == f:
            points = [(c, (b + d) // 2), (e, (f + h) // 2)] if a < e else [
                (a, (b + d) // 2), (g, (f + h) // 2)]
        else:
            points = [((a + c) // 2, d), ((e + g) // 2, f)] if b < f else [
                ((a + c) // 2, b), ((e + g) // 2, h)]
        if abs(start // 2 - end // 2) > 1:
            assert a != e, (key, start, end)
            first = (a if a > e else c, (b + d) // 2)
            last = (g if a > e else e, (f + h) // 2)
            middle = (first[0] + last[0]) // 2
            points = [first, (middle, first[1]), (middle, last[1]), last]
        elif b != f and a != e:
            first, last = points
            crossing = (first[1] + last[1]) // 2
            points = [first, (first[0], crossing), (last[0], crossing), last]
        arrow(points, color, *flags, weight=2)


for x in range(20, WIDTH, 29):
    for y in range(20, HEIGHT, 29):
        draw.point((x, y), fill="#294259")

text(69, 31, "STERLING SOVEREIGN AI", 24, AQUA, True)
text(68, 57, "System architecture blueprint", 69, heavy=True)
text(73, 143, "Deployment boundaries, component responsibilities and directed exchanges", 31, MUTED)
arrow([(2420, 86), (2520, 86)])
text(2536, 68, "Current path or foundation", 27, MUTED)
arrow([(2420, 130), (2520, 130)], VIOLET, True)
text(2536, 112, "Planned path", 27, MUTED)
arrow([(3050, 86), (3145, 86)], AQUA, two_way=True)
text(3161, 68, "Two-way exchange", 27, MUTED)

for key, parameters in groups.items():
    group(key, *parameters)

# Route cross-boundary connections in the gutters. The payload and any reverse
# path are labeled separately where their direction or authority differs.
connections = [
    ([(1030, 456), (1270, 456)], (1150, 390), ["Approved", "image digest"], GOLD, False, False),
    ([(2230, 410), (2470, 410)], (2350, 347), ["Task + scoped", "context"], AQUA, False, False),
    ([(2470, 543), (2230, 543)], (2350, 479), ["Decision, result", "and provenance"], AQUA, False, False),
    ([(366, 709), (366, 849)], (366, 750), ["Signed offline bundle", "via import host"], GOLD, False, False),
    ([(1668, 709), (1668, 849)], (1668, 748), ["Signed sealed changes", "and eligible replicas"], AQUA, False, True),
    ([(2710, 709), (2710, 849)], (2710, 746), ["Authorized model input"], AQUA, False, False),
    ([(3150, 849), (3150, 709)], (3150, 780), ["Result + provenance"], AQUA, False, False),
    ([(360, 1352), (360, 1492)], (360, 1390), ["Redacted logs +", "site evidence"], GREEN, False, False),
    ([(1030, 1063), (1136, 1063), (1136, 783), (1340, 783), (1340, 709)],
     (1136, 920), ["Hosted browser", "session"], VIOLET, True, False),
    ([(1270, 1725), (1193, 1725), (1193, 690), (1270, 690)],
     (1193, 1510), ["Permitted", "references / data"], VIOLET, True, False),
    ([(1270, 653), (1059, 653), (1059, 1774), (1270, 1774)],
     (1059, 1380), ["Access request", "and scope"], VIOLET, True, False),
    ([(1820, 1352), (1820, 1492)], (1820, 1385), ["Governed inventory", "and source notices"], VIOLET, True, True),
    ([(2230, 1827), (2470, 1827)], (2350, 1765), ["Eligible corpus", "and lineage"], VIOLET, True, False),
    ([(2910, 1492), (2910, 1352)], (2910, 1400), ["Approved passport", "and model version"], VIOLET, True, False),
]
for points, position, lines, color, planned, two_way in connections:
    arrow(points, color, planned, two_way)
    label(*position, lines, color)

# Keep proposals visually distinct from the running system.
draw.rounded_rectangle((70, 2050, 3430, 2212), 20, fill=PANEL, outline=VIOLET, width=2)
text(93, 2066, "ROADMAP EXTENSIONS", 22, VIOLET, True)
future = [
    ("Local appliance and desktop", "Local execution, inference and optional relay"),
    ("Governed teams", "Reusable signed roles, skills and tools"),
    ("Proof and edge federation", "Optional NEAR proofs, offline edge compute"),
    ("Assessment workspace", "Governed findings and evidence"),
    ("Digital Twin presentation", "Federated projections and potential 3D/XR"),
]
for index, (name, description) in enumerate(future):
    x = 93 + index * 670
    text(x, 2110, name, 28, heavy=True, width=638)
    text(x, 2154, description, 23, MUTED, width=638)

destination = Path(__file__).resolve().parents[1] / "static/img/sovai-data-flows.webp"
image.save(destination, "WEBP", quality=94, method=6)
print(destination)
