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
    ], [(0, 1, True, True), (2, 3, True), (6, 7, True), (7, 8, True)]),
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

# Status applies to the named tile. For mixed tiles, show the maturity of the
# implemented foundation and state its remaining work in the caption or overview.
status_styles = {
    "A": (GREEN, "Available"),
    "I": ("#9fc7ff", "Implemented"),
    "V": (GOLD, "Verified offline"),
    "P": (VIOLET, "Planned"),
}
group_status = {
    "release": "AAAAAAVP",
    "workbench": "AAAIIIIIII",
    "trust": "IIIIIIIIII",
    "hosted": "VVPPVVPVPP",
    "mission": "IIPPPIPPPP",
    "inference": "AAAAAPII",
    "assurance": "AIIAIAIA",
    "data": "PPPVPPPPVP",
    "factory": "PPPPPPVPPP",
}


def status_badge(x, y, code):
    color, _ = status_styles[code]
    draw.rounded_rectangle((x, y, x + 25, y + 24), 6, fill=color)
    text(x + 7, y + 2, code, 16, BACKGROUND, True)


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
    for index, ((name, description), status) in enumerate(zip(tiles, group_status[key], strict=True)):
        a, b, c, d = tile_box(x, y, index)
        draw.rounded_rectangle((a, b, c, d), 8, fill=INSET, outline="#31516a")
        title_room = TILE_WIDTH - 56
        size = 23 if draw.textlength(name, font=font(23, True)) <= title_room else 21
        text(a + 13, b + 4, name, size, heavy=True, width=title_room)
        status_badge(c - 36, b + 6, status)
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
text(2068, 153, "COMPONENT STATUS", 20, MUTED, True)
for index, (code, (_, name)) in enumerate(status_styles.items()):
    x = 2280 + 290 * index
    status_badge(x, 153, code)
    text(x + 36, 149, name, 25, WHITE, width=236)

for key, parameters in groups.items():
    group(key, *parameters)

# Route cross-boundary connections in the gutters. The payload and any reverse
# path are labeled separately where their direction or authority differs.
connections = [
    ([(1030, 456), (1270, 456)], (1150, 390), ["Approved", "image digest"], GOLD, False, False),
    ([(2230, 410), (2470, 410)], (2350, 347), ["Task + scoped", "context"], AQUA, False, False),
    ([(2470, 543), (2230, 543)], (2350, 479), ["Decision, result", "and provenance"], AQUA, False, False),
    ([(366, 709), (366, 849)], (366, 750), ["Signed offline bundle", "via import host"], GOLD, False, False),
    ([(1668, 709), (1668, 849)], (1668, 748), ["Planned editor pairing", "Signed sealed replicas"], VIOLET, True, True),
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
    status_badge(x, 2114, "P")
    text(x + 38, 2110, name, 28, heavy=True, width=600)
    text(x, 2154, description, 23, MUTED, width=638)

destination = Path(__file__).resolve().parents[1] / "static/img/sovai-data-flows.webp"
image.save(destination, "WEBP", quality=94, method=6)
print(destination)


def hardware_icon(kind, x, y, color):
    """Draw a hardware symbol in a 64-pixel square."""
    def line(points):
        draw.line([(x + a, y + b) for a, b in points], fill=color, width=3, joint="curve")

    def box(a, b, c, d, radius=5):
        draw.rounded_rectangle((x + a, y + b, x + c, y + d), radius, outline=color, width=3)

    def dot(a, b):
        draw.ellipse((x + a - 2, y + b - 2, x + a + 2, y + b + 2), fill=color)

    if kind == "workstation":
        box(4, 5, 59, 43)
        line([(8, 36), (55, 36)])
        line([(31, 44), (31, 55), (19, 55), (44, 55)])
    elif kind == "server":
        for top in (8, 25, 42):
            box(5, top, 59, top + 13, 3)
            dot(49, top + 6)
            line([(13, top + 6), (23, top + 6)])
    elif kind == "storage":
        for top in (7, 20, 33):
            draw.arc((x + 9, y + top, x + 55, y + top + 20), 0, 180, fill=color, width=3)
        draw.ellipse((x + 9, y + 7, x + 55, y + 27), outline=color, width=3)
        line([(9, 17), (9, 43)])
        line([(55, 17), (55, 43)])
    elif kind == "accelerator":
        box(10, 10, 54, 54)
        box(20, 20, 44, 44, 2)
        for pin in (19, 27, 36, 44):
            line([(pin, 5), (pin, 10)])
            line([(pin, 54), (pin, 59)])
            line([(5, pin), (10, pin)])
            line([(54, pin), (59, pin)])
    elif kind == "custody":
        box(9, 27, 55, 55)
        draw.arc((x + 19, y + 5, x + 45, y + 41), 180, 360, fill=color, width=3)
        line([(19, 23), (19, 27)])
        line([(45, 23), (45, 27)])
        dot(32, 39)
        line([(32, 39), (32, 47)])
    elif kind == "media":
        box(18, 18, 49, 57)
        box(23, 5, 44, 18, 1)
        dot(31, 41)
        line([(31, 44), (31, 51)])
    else:
        for a, b in ((14, 35), (31, 13), (50, 35), (32, 53)):
            box(a - 5, b - 5, a + 5, b + 5, 1)
        line([(17, 31), (27, 18)])
        line([(35, 18), (46, 31)])
        line([(45, 39), (36, 49)])
        line([(27, 49), (18, 39)])


def hardware_card(x, y, width, height, kind, title, lines, color=AQUA):
    draw.rounded_rectangle((x, y, x + width, y + height), 17, fill=INSET, outline="#3a5772", width=2)
    draw.rounded_rectangle((x + 16, y + 17, x + 93, y + 94), 13, fill=BACKGROUND)
    hardware_icon(kind, x + 23, y + 23, color)
    text(x + 111, y + 19, title, 30, heavy=True, width=width - 130)
    for row, line in enumerate(lines):
        text(x + 111, y + 62 + row * 31, line, 23, MUTED, width=width - 130)


def hardware_zone(box, title, detail, color):
    x, y, right, bottom = box
    draw.rounded_rectangle(box, 24, fill=PANEL, outline=color, width=2)
    text(x + 24, y + 17, title, 37, heavy=True, width=right - x - 48)
    text(x + 26, y + 62, detail, 18, color, True, width=right - x - 50)
    draw.line((x + 25, y + 91, right - 25, y + 91), fill="#31516a")


PHYSICAL_HEIGHT = 2090
image = Image.new("RGB", (WIDTH, PHYSICAL_HEIGHT), BACKGROUND)
draw = ImageDraw.Draw(image)
for x in range(20, WIDTH, 29):
    for y in range(20, PHYSICAL_HEIGHT, 29):
        draw.point((x, y), fill="#294259")

text(70, 32, "STERLING SOVEREIGN AI", 24, AQUA, True)
text(68, 59, "Physical deployment blueprint", 69, heavy=True)
text(73, 146, "Hardware placement, network boundaries and software on each host", 31, MUTED)
arrow([(2440, 84), (2540, 84)], AQUA, two_way=True)
text(2556, 66, "Network exchange / both directions", 27, MUTED)
arrow([(2440, 128), (2540, 128)], VIOLET, True)
text(2556, 110, "Planned deployment or integration", 27, MUTED)
arrow([(3050, 128), (3150, 128)], GOLD)
text(3166, 110, "Signed artifact transfer", 27, MUTED)

hardware_zone((70, 225, 833, 1470), "Staff and edge devices",
              "ORGANIZATION MANAGED / BROWSER-BASED ACCESS", AQUA)
hardware_card(94, 345, 715, 196, "workstation", "Staff workstation A", [
    "Linux Intel / AMD PC and local SSD",
    "Browser, Docker, launcher and Theia container",
    "Local project, policy gate and optional inference",
])
hardware_card(94, 565, 715, 193, "workstation", "Staff workstation B", [
    "Separate computer with its own project replica",
    "Optional hub connection; standalone still works",
    "Managed endpoint collector is planned",
])
hardware_card(94, 782, 715, 192, "workstation", "Same-machine development", [
    "One PC can host Workbench and an optional hub",
    "Separate containers and persistent volumes",
    "Local inference can share the PC if it fits",
])
hardware_card(94, 998, 715, 187, "network", "Edge or remote site", [
    "Authorized workstations and optional separate hub",
    "Local replicas and later approved exchange",
    "Wider disconnected federation is planned",
], VIOLET)
hardware_card(94, 1208, 715, 188, "custody", "Hosted browser and sign-in", [
    "Staff may use a browser-only client at a site",
    "Passkey or approved hardware key if required",
    "Hosted workspace runs inside the site cluster",
], VIOLET)

hardware_zone((1105, 225, 2460, 990), "Organization service hosts",
              "SEPARATE HOST ROLES / CO-LOCATE WHERE CAPACITY AND POLICY PERMIT", AQUA)
hardware_card(1129, 345, 640, 183, "server", "Mission hub VM or server", [
    "Hub service, roster and sealed sync",
    "Encrypted persistent state",
    "Per-mission membership and trust",
])
hardware_card(1796, 345, 640, 183, "accelerator", "Approved inference host", [
    "Model runtime and approved weights",
    "CPU, GPU or other supported hardware",
    "Can run locally or on a separate host",
])
hardware_card(1129, 553, 640, 184, "server", "Data Platform host", [
    "Connectors, extraction and query service",
    "Governed PostgreSQL catalogue and search",
    "Authorized datasets and derived artifacts",
], VIOLET)
hardware_card(1796, 553, 640, 184, "accelerator", "Approved training host", [
    "Model Factory chooses eligible hardware",
    "Isolated trainer and accelerator resources",
    "No off-host trainer calls; activation separate",
], VIOLET)
hardware_card(1129, 761, 640, 184, "server", "Optional relay VM", [
    "Private queue and authorized integration",
    "Independent of the mission hub",
    "Wider messaging integrations planned",
])
hardware_card(1796, 761, 640, 184, "storage", "Approved source systems", [
    "File share, organization NAS or database",
    "Other approved connected source services",
    "Source permissions remain authoritative",
], VIOLET)

hardware_zone((1105, 1101, 2460, 1862), "On-premises hosted site pilot",
              "PLANNED / CONNECTED OR AIR-GAPPED / OFFLINE CONFIGURATION VERIFIED IN PART", VIOLET)
for index in range(3):
    x = 1133 + 436 * index
    draw.rounded_rectangle((x, 1215, x + 406, 1327), 13, fill=INSET, outline="#3a5772", width=2)
    hardware_icon("server", x + 20, 1238, VIOLET)
    text(x + 100, 1236, f"Cluster node {index + 1}", 27, heavy=True)
    text(x + 100, 1273, "Linux server or VM", 23, MUTED)
text(1135, 1352, "Shared service pool across the cluster", 29, heavy=True)
site_software = [
    ("RKE2 / etcd and admission", "Kyverno, HAProxy, cluster DNS and policies"),
    ("Identity and hosted sessions", "Keycloak, PostgreSQL, oauth2-proxy, Theia Cloud"),
    ("Site trust and image supply", "OpenBao, cert-manager and Harbor or Zot"),
    ("Operations and service workloads", "Hubs, Fluent Bit, OpenSearch, Prometheus, alerts"),
    ("Encrypted persistent volumes", "Longhorn or approved storage for PVs and workspaces"),
    ("Pilot failure domains", "Place VMs on separate hosts for host-failure tests"),
]
for index, (title, line) in enumerate(site_software):
    x = 1130 + (index % 2) * 666
    y = 1410 + (index // 2) * 119
    draw.rounded_rectangle((x, y, x + 637, y + 101), 13, fill=INSET, outline="#31516a", width=2)
    text(x + 18, y + 12, title, 27, heavy=True, width=600)
    text(x + 18, y + 55, line, 22, MUTED, width=600)
text(1134, 1790, "Services can move between nodes. Each tile above is a host, not a dedicated appliance per service.",
     25, MUTED, width=1294)

hardware_zone((2660, 225, 3430, 988), "Connected external services",
              "OUTSIDE THE ORGANIZATION'S HOSTED SITE", GOLD)
hardware_card(2684, 345, 722, 170, "network", "GitHub CI and registry", [
    "Build, independent review and owner release",
    "Published digest or signed site bundle",
], GOLD)
hardware_card(2684, 539, 722, 170, "network", "Approved external inference", [
    "NEAR AI private / forwarded and vault routes",
    "Only when destination and network are approved",
], GOLD)
hardware_card(2684, 733, 722, 197, "media", "Approved offline transfer media", [
    "Carries the exact signed software bundle",
    "Verification roots use separately trusted media",
    "No direct Internet connection to an isolated site",
], GOLD)

hardware_zone((2660, 1035, 3430, 1862), "Site support hardware",
              "CUSTODY, STORAGE AND RECOVERY / AS APPROVED", GREEN)
hardware_card(2684, 1143, 722, 118, "workstation", "Site-side import host", [
    "Verifies bundle, then loads the site registry",
], GOLD)
hardware_card(2684, 1273, 722, 135, "custody", "Optional hardware security module", [
    "Site key custody for OpenBao where selected",
    "Offline root, escrow and approved ceremony",
], GREEN)
hardware_card(2684, 1418, 722, 135, "storage", "Optional encrypted NAS / storage", [
    "Datasets or backups; live volumes if validated",
    "Network storage is optional for live volumes",
], GREEN)
hardware_card(2684, 1563, 722, 135, "server", "Site time, network and DNS", [
    "Authoritative site time and DNS services",
    "Switching and routing stay in site control",
], GREEN)

hardware_card(2684, 1708, 722, 135, "storage", "Independent backup destination", [
    "Recovery copy in a separate failure domain",
    "Dedicated backup storage or separate-site copy",
], GREEN)

hardware_zone((70, 1550, 833, 1862), "Single-machine site lab",
              "ALTERNATIVE TO PILOT FOR OFFLINE REHEARSAL", VIOLET)
hardware_card(94, 1660, 715, 173, "server", "Physical KVM host → one guest", [
    "Linux PC hosts one RHEL-compatible lab VM",
    "Zot, encrypted volumes, hub and test session",
    "Live signed installation remains to be verified",
], VIOLET)

physical_links = [
    ([(809, 410), (1129, 410)], (969, 347), ["Planned Workbench", "hub pairing"], VIOLET, True, True),
    ([(809, 605), (1129, 605)], (969, 542), ["Approved lookup", "and result"], VIOLET, True, True),
    ([(809, 495), (1007, 495), (1007, 325), (2070, 325), (2070, 345)],
     (1495, 317), ["Approved model request and result"], AQUA, False, True),
    ([(809, 373), (870, 373), (870, 203), (2607, 203), (2607, 617), (2684, 617)],
     (1690, 194), ["Connected users only: approved inference"], AQUA, False, True),
    ([(3406, 438), (3418, 438), (3418, 830), (3406, 830)],
     (3147, 706), ["Signed site bundle"], GOLD, False, False),
    ([(833, 1284), (1105, 1284)], (969, 1218), ["Browser HTTPS", "to site ingress"], VIOLET, True, True),
    ([(3300, 930), (3300, 1035), (3420, 1035), (3420, 1201), (3406, 1201)],
     (3180, 992), ["Air-gap crossing by media"], GOLD, False, False),
    ([(2684, 1195), (2460, 1195)], (2565, 1133), ["Verified load", "to site registry"], GOLD, False, False),
    ([(2070, 553), (2070, 528)], (2225, 536), ["Approved model only"], VIOLET, True, False),
    ([(1769, 695), (1782, 695), (1782, 835), (1796, 835)],
     (1520, 739), ["Scoped source reads"], VIOLET, True, True),
    ([(2460, 1345), (2660, 1345)], (2560, 1292), ["Key custody"], GREEN, True, True),
    ([(2460, 1485), (2660, 1485)], (2560, 1421), ["Volumes /", "backups"], GREEN, True, True),
    ([(2460, 1758), (2660, 1758)], (2560, 1695), ["Recovery", "copy"], GREEN, True, False),
    ([(2660, 1625), (2460, 1625)], (2560, 1563), ["Site DNS", "and time"], GREEN, True, False),
]
for points, position, lines, color, planned, two_way in physical_links:
    arrow(points, color, planned, two_way)
    label(*position, lines, color)

draw.rounded_rectangle((70, 1915, 3430, 2037), 17, fill=PANEL, outline="#31516a", width=2)
text(96, 1932, "Placement options", 26, AQUA, True)
text(96, 1972, "Separate drawings denote host roles or trust boundaries. Your organization can co-locate eligible roles or isolate them on different hardware.",
     27, MUTED, width=3290)
destination = destination.with_name("sovai-physical-layout.webp")
image.save(destination, "WEBP", quality=94, method=6)
print(destination)
