import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isNearAiProject } from '../gsd/runtime';
import type { SecurityAccess } from '../agent/securityTool';
import type { Severity } from '../security/osv';
import { CI_WORKFLOW, SBOM_FILE, scanProject, ScanReport, scanSummary, worstSeverity } from '../security/scan';

// Dependency and runtime vulnerability checks in VS Code: an SBOM (sbom.cdx.json) per project,
// findings in the Problems view and the status bar, a scan when a NEAR AI project opens and when
// its lockfiles change, and the agent's SecurityScan tool. Package names and versions go to
// OSV.dev and runtime versions to endoflife.date, only after the user agrees once per project.

export type ScanTrigger = 'command' | 'open' | 'lockfile' | 'agent';
const CONSENT_KEY = 'nearAi.security.consent';
const LOCKFILES = '**/{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,poetry.lock,uv.lock,pdm.lock,Pipfile.lock,requirements*.txt,go.mod,Cargo.lock,composer.lock,Gemfile.lock,packages.lock.json,gradle.lockfile,pom.xml,package.json,.nvmrc,.node-version,.python-version,pyproject.toml,.tool-versions}';
// Looked up when used, not at import, so this module loads where vscode is only partly available.
const diagnosticSeverity = (severity: Severity): vscode.DiagnosticSeverity => severity === 'critical' || severity === 'high' ? vscode.DiagnosticSeverity.Error : severity === 'low' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;

let scanner: SecurityScanner | undefined;

function scannerFor(context: vscode.ExtensionContext, root: string): SecurityScanner {
  if (!scanner) { scanner = new SecurityScanner(context, root); context.subscriptions.push(scanner); }
  return scanner;
}

/** Whether this project allowed dependency checks, without starting the scanner. */
export function securityConsented(context: Pick<vscode.ExtensionContext, 'workspaceState'>): boolean {
  if (vscode.workspace.getConfiguration('nearAi').get<string>('security.scanOnOpen', 'ask') === 'never') return false;
  return context.workspaceState.get<string>(CONSENT_KEY) === 'granted';
}

/** The agent's view of the project's scanner, for the SecurityScan tool. */
export function securityAccess(context: vscode.ExtensionContext, root: string): SecurityAccess {
  // Created on first use by the tool, not per message; if it can't be, the agent is told nothing was checked.
  return {
    consented: () => { try { return scannerFor(context, root).consented; } catch { return false; } },
    scan: async () => { try { return await scannerFor(context, root).scan('agent'); } catch { return undefined; } }
  };
}

export class SecurityScanner implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('nearAi.security');
  private readonly status = vscode.window.createStatusBarItem('nearAi.security', vscode.StatusBarAlignment.Right, 90);
  private readonly output = vscode.window.createOutputChannel('NEAR AI Security');
  private readonly disposables: vscode.Disposable[] = [];
  private running: Promise<ScanReport | undefined> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private known = new Set<string>();
  public last: ScanReport | undefined;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly root: string) {
    this.status.name = 'NEAR AI dependency security';
    this.status.command = 'nearAi.securityScan';
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, LOCKFILES));
    const changed = (uri: vscode.Uri) => { if (!/[\\/](node_modules|\.git|vendor|\.venv)[\\/]/.test(uri.fsPath) && this.consented) this.schedule(); };
    this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
  }

  public get consented(): boolean {
    return securityConsented(this.context);
  }

  /** Asks once per project before anything is sent; a modal for explicit requests, a notification otherwise. */
  public async requestConsent(modal: boolean): Promise<boolean> {
    if (this.consented) return true;
    const detail = `To check ${path.basename(this.root)} for known vulnerabilities, NEAR AI sends the names and versions of its dependencies to OSV.dev (Google's open vulnerability database) and its runtime versions to endoflife.date. No code or file contents are sent. Results and an SBOM (${SBOM_FILE}) stay in this project.`;
    const allow = 'Check now and when the project opens';
    const never = 'Never for this project';
    const answer = modal ? await vscode.window.showInformationMessage('Check dependencies for known vulnerabilities?', { modal: true, detail }, allow, never) : await vscode.window.showInformationMessage(`Check this project's dependencies for known vulnerabilities? ${detail}`, allow, 'Not now', never);
    if (answer === allow) { await this.context.workspaceState.update(CONSENT_KEY, 'granted'); return true; }
    if (answer === never) await this.context.workspaceState.update(CONSENT_KEY, 'declined');
    return false;
  }

  public async onOpen(): Promise<void> {
    const mode = vscode.workspace.getConfiguration('nearAi').get<string>('security.scanOnOpen', 'ask');
    if (mode === 'never' || this.context.workspaceState.get<string>(CONSENT_KEY) === 'declined') return;
    if (mode === 'always' && !this.consented) await this.context.workspaceState.update(CONSENT_KEY, 'granted');
    if (this.consented || await this.requestConsent(false)) await this.scan('open');
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { this.debounce = undefined; void this.scan('lockfile'); }, 10_000);
  }

  /** Runs one scan at a time; explicit scans always rewrite the SBOM, automatic ones only on change. */
  public async scan(trigger: ScanTrigger): Promise<ScanReport | undefined> {
    if (!this.consented) return undefined;
    if (this.running) return this.running;
    this.status.text = '$(sync~spin) Checking dependencies';
    this.status.show();
    this.running = (async () => {
      try {
        const report = await scanProject(this.root, { write: trigger === 'command' || trigger === 'agent' ? 'always' : 'if-changed', tool: { name: 'NEAR AI for VS Code', version: String(this.context.extension.packageJSON.version ?? '') } });
        this.show(report, trigger);
        return report;
      } catch (error) {
        this.status.text = '$(shield) Dependency check failed';
        this.status.tooltip = (error as Error).message;
        this.output.appendLine(`[${new Date().toISOString()}] Scan failed: ${(error as Error).message}`);
        return undefined;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private show(report: ScanReport, trigger: ScanTrigger): void {
    this.last = report;
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, line: number | undefined, diagnostic: vscode.Diagnostic) => {
      const range = new vscode.Range(Math.max(0, (line ?? 1) - 1), 0, Math.max(0, (line ?? 1) - 1), 1_000);
      diagnostic.range = range;
      diagnostic.source = 'NEAR AI security';
      byFile.set(file, [...(byFile.get(file) ?? []), diagnostic]);
    };
    for (const finding of report.packages) for (const vuln of finding.vulnerabilities) {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `${finding.component.name} ${finding.component.version}: ${vuln.summary} (${[vuln.id, ...vuln.aliases].join(', ')}; ${vuln.severity}${vuln.score !== undefined ? ` ${vuln.score}` : ''}).${vuln.fixed.length ? ` Fixed in ${vuln.fixed[0]}.` : ' No fixed version yet.'}`, diagnosticSeverity(vuln.severity));
      diagnostic.code = { value: vuln.id, target: vscode.Uri.parse(vuln.url) };
      add(finding.component.source, finding.component.line, diagnostic);
    }
    for (const finding of report.runtimeFindings) {
      const file = finding.runtime.source.split(' ')[0];
      if (finding.runtime.kind === 'declared' && existsSync(path.join(this.root, file))) {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), finding.summary, diagnosticSeverity(finding.severity));
        diagnostic.code = { value: 'end-of-life', target: vscode.Uri.parse(finding.url) };
        add(file, 1, diagnostic);
      }
    }
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(path.join(this.root, file)), list);
    const total = Object.values(report.counts).reduce((sum, count) => sum + count, 0);
    const worst = worstSeverity(report);
    this.status.text = total ? `$(warning) ${total} known ${total === 1 ? 'vulnerability' : 'vulnerabilities'}` : report.errors.length ? '$(shield) Dependency check incomplete' : '$(shield) No known vulnerabilities';
    this.status.tooltip = `${scanSummary(report, 8)}\n\nClick to check again.`;
    this.status.backgroundColor = worst === 'critical' || worst === 'high' ? new vscode.ThemeColor('statusBarItem.errorBackground') : worst === 'medium' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.output.appendLine(`[${report.scannedAt}] ${trigger} scan\n${scanSummary(report, 200)}\n`);
    // Tell the user about serious findings they have not seen yet in this session.
    const serious = report.packages.flatMap((finding) => finding.vulnerabilities.filter((vuln) => vuln.severity === 'critical' || vuln.severity === 'high').map((vuln) => `${vuln.id}:${finding.component.purl}`));
    const fresh = serious.filter((key) => !this.known.has(key));
    this.known = new Set(serious);
    if (fresh.length && trigger !== 'agent') {
      void vscode.window.showWarningMessage(`${fresh.length} ${fresh.length === 1 ? 'dependency has' : 'dependencies have'} a high or critical known vulnerability in ${path.basename(this.root)}.`, 'Show problems', 'Show report').then((choice) => {
        if (choice === 'Show problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
        if (choice === 'Show report') this.output.show();
      });
    }
    if (trigger === 'command') this.output.show(true);
  }

  public dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    for (const disposable of this.disposables) disposable.dispose();
    this.diagnostics.dispose();
    this.status.dispose();
    this.output.dispose();
  }
}

export async function addScanWorkflow(root: string): Promise<string | undefined> {
  const file = path.join(root, '.github', 'workflows', 'dependency-scan.yml');
  if (existsSync(file)) {
    const replace = await vscode.window.showWarningMessage(`${path.relative(root, file)} already exists.`, { modal: true }, 'Replace');
    if (replace !== 'Replace') return undefined;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, CI_WORKFLOW, 'utf8');
  return file;
}

export function registerSecurityScanning(context: vscode.ExtensionContext): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.securityScan', async () => {
      if (!root) { void vscode.window.showInformationMessage('Open a project folder to check its dependencies.'); return; }
      const current = scannerFor(context, root);
      if (await current.requestConsent(true)) await current.scan('command');
    }),
    vscode.commands.registerCommand('nearAi.addScanWorkflow', async () => {
      if (!root) return;
      const file = await addScanWorkflow(root);
      if (file) await vscode.window.showTextDocument(vscode.Uri.file(file));
    })
  );
  if (!root) return;
  void isNearAiProject(root).then((nearAi) => {
    if (!nearAi) return;
    void scannerFor(context, root).onOpen();
  });
}
