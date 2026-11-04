import type { HostTool, ToolEcosystem } from './cyberTools';

// What a one-click install would actually do to the user's machine, and how much it is worth (D-12).
// The panel shows this before the button is pressed: a user deciding whether to install nuclei should
// see that it lands in their home directory, that it is a Go binary of a few dozen megabytes, and that
// it is worth more to an offensive scan than to a defensive one. Nothing here installs anything.

/** How strongly the harness recommends a tool, and why. */
export type Recommendation = 'recommended' | 'useful' | 'optional';

export interface InstallAdvice {
  tool: string;
  recommendation: Recommendation;
  /** One line the user reads first: what this tool is worth to a scan. */
  why: string;
  /** Where it lands, in plain words. */
  footprint: string;
  /** What changes on the machine, spelled out for a reader who wants no surprises. */
  effects: string[];
  /** Things that make this a bad idea on some machines. Empty when nothing applies. */
  cautions: string[];
  /** True when the install needs an administrator's password. */
  needsElevation: boolean;
  /** Rough download size, when it is large enough to matter. */
  sizeHint?: string;
  /** The exact command for this platform, or undefined when the platform has no path. */
  command?: string;
}

/** The package manager this machine has, and the one-line command it implies per tool. */
export type Platform = 'debian' | 'macos' | 'other';

export function detectPlatform(platform: NodeJS.Platform = process.platform): Platform {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'debian';
  return 'other';
}

interface PerTool {
  recommendation: Recommendation;
  why: string;
  footprint: string;
  effects: string[];
  cautions?: string[];
  sizeHint?: string;
  /** The command per platform; a missing entry means "not available this way". */
  commands: Partial<Record<Platform, { command: string; elevated: boolean }>>;
  /** Extra packages a command pulls in. */
  pullsIn?: string;
}

/**
 * Per-tool install reality. The commands are the exact strings a user would type, chosen for the
 * platform's own package manager; they are never assembled from a template, so what the panel shows
 * is what runs.
 */
export const INSTALL_ADVICE: Record<string, PerTool> = {
  nmap: {
    recommendation: 'recommended',
    why: 'Finds open ports and service versions, which is what tells an offensive scan where to look first.',
    footprint: 'A system package under /usr (a few megabytes), plus a service-name database.',
    effects: [
      'Installs into /usr/bin and /usr/share, shared by every user on the machine.',
      'apt writes a log line to /var/log/apt/history.log.',
      'nmap is setuid-root on Debian, so any local user can run raw-socket scans.'
    ],
    cautions: [
      'Some hosting providers treat network scanning as abuse; check the target is yours.',
      'A full port sweep of a /24 takes minutes and is the loudest thing this harness does.'
    ],
    sizeHint: 'about 6 MB plus dependencies',
    commands: {
      debian: { command: 'sudo apt-get install -y nmap', elevated: true },
      macos: { command: 'brew install nmap', elevated: false }
    }
  },
  trivy: {
    recommendation: 'recommended',
    why: 'Scans container images and filesystems for vulnerable packages, which the built-in dependency probe cannot do for images.',
    footprint: 'A single Go binary in /usr/local/bin. It downloads its own vulnerability database on first use.',
    effects: [
      'Places one executable on PATH.',
      'Fetches a vulnerability database (tens of megabytes) into a cache directory on first run.',
      'Needs network access at run time, not just at install time.'
    ],
    cautions: ['The first run is slow and network-dependent; later runs use the cached database.'],
    sizeHint: 'about 60 MB binary',
    commands: {
      debian: { command: 'sudo apt-get install -y trivy', elevated: true },
      macos: { command: 'brew install trivy', elevated: false }
    }
  },
  nuclei: {
    recommendation: 'useful',
    why: 'Runs a large library of community CVE templates, so a scan finds known issues the built-in probes do not look for.',
    footprint: 'A single Go binary under ~/go/bin, plus a templates folder that updates itself.',
    effects: [
      'Installs under ~/go/bin, which must be on PATH to be found.',
      'Creates ~/nuclei-templates and updates it from the internet on first run.',
      'Its templates make real requests to the target: this is the loudest tool here.'
    ],
    cautions: [
      'Needs Go installed; the panel cannot install a Go toolchain for you.',
      'Only worth it for offensive scans against a host you own.'
    ],
    sizeHint: 'about 40 MB binary plus tens of MB of templates',
    commands: {
      debian: { command: 'go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest', elevated: false },
      macos: { command: 'brew install nuclei', elevated: false }
    }
  },
  httpx: {
    recommendation: 'useful',
    why: 'Probes many hosts quickly and returns their status, title, and technologies as JSON.',
    footprint: 'A single Go binary under ~/go/bin.',
    effects: ['Installs under ~/go/bin, which must be on PATH to be found.'],
    cautions: ['Needs Go installed.'],
    sizeHint: 'about 30 MB binary',
    commands: {
      debian: { command: 'go install github.com/projectdiscovery/httpx/cmd/httpx@latest', elevated: false },
      macos: { command: 'brew install httpx', elevated: false }
    }
  },
  gitleaks: {
    recommendation: 'useful',
    why: 'Scans a git history for secrets; the built-in secrets probe only reads the working tree.',
    footprint: 'A single Go binary in /usr/local/bin.',
    effects: ['Places one executable on PATH.'],
    commands: {
      debian: { command: 'sudo apt-get install -y gitleaks', elevated: true },
      macos: { command: 'brew install gitleaks', elevated: false }
    }
  },
  semgrep: {
    recommendation: 'useful',
    why: 'Static analysis over source code, which finds injection and crypto mistakes a probe cannot see.',
    footprint: 'A Python package in an isolated pipx environment under ~/.local.',
    effects: [
      'Installs pipx itself if missing, which means a Python package manager change.',
      'Downloads rule packs from the internet on first run.',
      'Creates ~/.local/pipx/venvs/semgrep and adds a launcher to ~/.local/bin.'
    ],
    cautions: ['Needs Python 3 and network access for its rule packs.'],
    sizeHint: 'about 100 MB with dependencies',
    commands: {
      debian: { command: 'pipx install semgrep', elevated: false },
      macos: { command: 'brew install semgrep', elevated: false }
    }
  },
  sqlmap: {
    recommendation: 'optional',
    why: 'Automates SQL injection against a specific endpoint. Powerful, and the most likely tool to break something.',
    footprint: 'A Python package in an isolated pipx environment under ~/.local.',
    effects: [
      'Creates ~/.local/pipx/venvs/sqlmap and a launcher in ~/.local/bin.',
      'Writes session files as it probes an endpoint.'
    ],
    cautions: [
      'Only run it inside the sandbox: its default payloads can corrupt a live database.',
      'Its JSON output flag is unverified by this harness (research assumption A2).'
    ],
    commands: {
      debian: { command: 'pipx install sqlmap', elevated: false },
      macos: { command: 'brew install sqlmap', elevated: false }
    }
  },
  nikto: {
    recommendation: 'optional',
    why: 'A classic web-server misconfiguration scanner; largely covered by the built-in header and path probes.',
    footprint: 'A Perl package with a database of signatures under /usr/share.',
    effects: ['Installs into system directories; pulls in a Perl runtime if missing.'],
    cautions: ['Its JSON output flag is unverified by this harness (research assumption A1).'],
    sizeHint: 'about 2 MB plus Perl',
    commands: {
      debian: { command: 'sudo apt-get install -y nikto', elevated: true },
      macos: { command: 'brew install nikto', elevated: false }
    }
  },
  whatweb: {
    recommendation: 'optional',
    why: 'Fingerprints web technologies; the built-in fingerprint probe covers the common cases offline.',
    footprint: 'A Ruby gem plus its dependencies under /usr.',
    effects: ['Installs into system directories; pulls in a Ruby runtime if missing.'],
    cautions: ['Its JSON output flag is unverified by this harness (research assumption A3).'],
    commands: {
      debian: { command: 'sudo apt-get install -y whatweb', elevated: true },
      macos: { command: 'brew install whatweb', elevated: false }
    }
  },
  'testssl.sh': {
    recommendation: 'optional',
    why: 'A thorough TLS configuration audit; the built-in TLS probe already checks protocol, cipher, and certificate dates.',
    footprint: 'A shell script with an OpenSSL binary, usually under /usr/local.',
    effects: ['Places a script and a bundled OpenSSL binary on PATH.'],
    commands: {
      debian: { command: 'sudo apt-get install -y testssl.sh', elevated: true },
      macos: { command: 'brew install testssl', elevated: false }
    }
  }
};

/**
 * The install advice for one tool on this platform. A tool with no command for the platform still
 * returns advice (so the panel can explain it) with `command: undefined`.
 */
export function installAdviceFor(tool: string, platform: Platform = detectPlatform(), toolEntry?: HostTool): InstallAdvice {
  const advice = INSTALL_ADVICE[tool];
  if (!advice) {
    // A catalogued tool with no advice row still gets an honest, minimal entry rather than nothing.
    return {
      tool,
      recommendation: 'optional',
      why: toolEntry?.purpose ?? 'A host tool the harness can use when present.',
      footprint: 'Unknown to this build; check the tool\'s own documentation.',
      effects: ['This harness has no recorded install advice for this tool.'],
      cautions: ['Install it yourself, then press Refresh.'],
      needsElevation: false,
      ...(toolEntry ? { command: undefined } : {}),
      ...(toolEntry?.installCommand ? { command: toolEntry.installCommand } : {})
    };
  }
  const chosen = advice.commands[platform];
  return {
    tool,
    recommendation: advice.recommendation,
    why: advice.why,
    footprint: advice.footprint,
    effects: advice.effects,
    cautions: advice.cautions ?? [],
    needsElevation: chosen?.elevated ?? false,
    ...(advice.sizeHint ? { sizeHint: advice.sizeHint } : {}),
    ...(chosen ? { command: chosen.command } : {})
  };
}

/** Advice for every tool, ordered by how strongly it is recommended, then by name. */
export function installAdvice(missing: string[], platform: Platform = detectPlatform(), catalogue: HostTool[] = []): InstallAdvice[] {
  const order: Record<Recommendation, number> = { recommended: 0, useful: 1, optional: 2 };
  return missing
    .map((tool) => installAdviceFor(tool, platform, catalogue.find((entry) => entry.name === tool)))
    .sort((a, b) => order[a.recommendation] - order[b.recommendation] || a.tool.localeCompare(b.tool));
}

/** The one-line summary the panel shows above the list. */
export function installSummary(advice: InstallAdvice[]): string {
  const count = (recommendation: Recommendation) => advice.filter((entry) => entry.recommendation === recommendation).length;
  const recommended = count('recommended');
  const parts = [
    `${advice.length} check${advice.length === 1 ? '' : 's'} could not run.`,
    recommended ? `${recommended} tool${recommended === 1 ? '' : 's'} would add the most.` : 'None of the missing tools is strongly recommended.',
    'The built-in probes work without any of them.'
  ];
  return parts.join(' ');
}

/** True when a tool's install command needs an administrator's password on this platform. */
export function needsElevation(advice: InstallAdvice): boolean {
  return advice.needsElevation;
}

/** The ecosystem label a reader understands, for the panel's row. */
export function ecosystemLabel(ecosystem: ToolEcosystem): string {
  return { apt: 'system package (apt)', brew: 'Homebrew', pip: 'Python (pipx)', npm: 'npm', binary: 'prebuilt binary' }[ecosystem];
}
