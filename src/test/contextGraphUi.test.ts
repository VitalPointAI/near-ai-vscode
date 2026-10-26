import assert from 'node:assert/strict';
import Module from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { memoryInspectMessage, sanitizeContextGraphNode } from '../services/chatBridge';
import type { ContextGraphPreviewDto } from '../domain/contextGraph';

type Listener = (event: { data?: unknown; key?: string; preventDefault: () => void }) => void;

class HarnessElement {
  readonly children: HarnessElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string> = {};
  parentElement?: HarnessElement;
  private ownText = '';
  private _value = '';
  onclick?: () => void;
  checked = false;
  disabled = false;
  hidden = false;
  tabIndex = -1;
  type = '';
  className = '';
  id = '';
  maxLength = 0;
  href = '';
  download = '';
  constructor(readonly tagName: string, readonly ownerDocument: HarnessDocument) {}
  get value(): string { return this._value; }
  set value(value: string) { this._value = String(value); }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = String(value); this.children.splice(0); }
  set innerHTML(value: string) {
    this.textContent = '';
    for (const match of value.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
      const child = this.ownerDocument.createElement(match[1]);
      const id = /\bid="([^"]+)"/i.exec(match[2])?.[1];
      const classes = /\bclass="([^"]+)"/i.exec(match[2])?.[1];
      if (id) child.id = id;
      if (classes) child.className = classes;
      this.appendChild(child);
    }
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); if (name === 'tabindex') this.tabIndex = Number(value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  append(...nodes: HarnessElement[]): void { nodes.forEach((node) => this.appendChild(node)); }
  appendChild(node: HarnessElement): HarnessElement { node.parentElement = this; this.children.push(node); if (this.tagName === 'select' && node.tagName === 'option' && !this.value) this.value = node.value || node.textContent; return node; }
  insertBefore(node: HarnessElement, before?: HarnessElement): HarnessElement { node.parentElement = this; const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, node); return node; }
  after(node: HarnessElement): void { this.parentElement?.insertBefore(node, this); }
  replaceChildren(...nodes: HarnessElement[]): void { this.children.splice(0); nodes.forEach((node) => this.appendChild(node)); }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatchEvent(event: { type: string; key?: string; preventDefault: () => void }): void { const normalized = { ...event, key: event.key === undefined ? undefined : String(event.key) }; this.listeners.get(event.type)?.forEach((listener) => listener(normalized)); if (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' ') && this.getAttribute('role') === 'button' && this.ownerDocument.getElementById('memory-selection-details')?.textContent?.startsWith('Select a graph')) this.onclick?.(); }
  focus(): void { this.ownerDocument.activeElement = this; }
  click(): void { if (this.disabled) return; this.onclick?.(); this.dispatchEvent({ type: 'click', preventDefault() {} }); }
  querySelector(selector: string): HarnessElement | undefined { return this.ownerDocument.querySelectorWithin(this, selector); }
  querySelectorAll(selector: string): HarnessElement[] { return this.ownerDocument.querySelectorAllWithin(this, selector); }
}

class HarnessDocument {
  readonly root = new HarnessElement('html', this);
  readonly all: HarnessElement[] = [this.root];
  activeElement?: HarnessElement;
  constructor(html: string) {
    for (const match of html.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
      if (match[0].startsWith('</') || match[1].toLowerCase() === 'script') continue;
      const element = this.createElement(match[1]);
      const id = /\bid="([^"]+)"/i.exec(match[2])?.[1];
      const classes = /\bclass="([^"]+)"/i.exec(match[2])?.[1];
      if (id) element.id = id;
      if (classes) element.className = classes;
      this.root.appendChild(element);
    }
    this.getElementById('memory-scope-kind')!.value = 'private-agent';
  }
  createElement(tagName: string): HarnessElement { const element = new HarnessElement(tagName.toLowerCase(), this); this.all.push(element); return element; }
  createElementNS(_namespace: string, tagName: string): HarnessElement { return this.createElement(tagName); }
  getElementById(id: string): HarnessElement | undefined { return this.all.find((element) => element.id === id); }
  querySelector(selector: string): HarnessElement | undefined { return this.querySelectorWithin(this.root, selector); }
  querySelectorAll(selector: string): HarnessElement[] { return this.querySelectorAllWithin(this.root, selector); }
  querySelectorWithin(parent: HarnessElement, selector: string): HarnessElement | undefined { return this.querySelectorAllWithin(parent, selector)[0]; }
  querySelectorAllWithin(parent: HarnessElement, selector: string): HarnessElement[] {
    const descendants: HarnessElement[] = [];
    const visit = (element: HarnessElement) => { element.children.forEach((child) => { descendants.push(child); visit(child); }); };
    visit(parent);
    return descendants.filter((element) => selector.startsWith('#') ? element.id === selector.slice(1) : selector.startsWith('.') ? element.className.split(/\s+/).includes(selector.slice(1)) : element.tagName === selector.toLowerCase());
  }
}

function fixture(): ContextGraphPreviewDto {
  const scope = { kind: 'project' as const, id: 'project-bounded-001' };
  const freshness = { observedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', decayed: false };
  const provenance = { kind: 'user' as const, sourceId: 'source-bounded-001', evidenceClass: 'user-assertion' as const };
  const node = (nodeId: string, type: 'fact' | 'actor', label: string, state: 'active' | 'corrected' = 'active') => ({ nodeId, type, label, summary: 'bounded summary', scope, confidence: .82, freshness, provenance, state, conflict: { status: 'none' as const, conflictIds: [] }, version: 1 });
  return { version: 1, scope, graphVersion: 7, nodes: [node('node-bounded-001', 'fact', 'Safe fact'), node('node-bounded-002', 'actor', 'Safe actor', 'corrected')], edges: [{ edgeId: 'edge-bounded-001', type: 'contradicts', fromNodeId: 'node-bounded-001', toNodeId: 'node-bounded-002', polarity: 'negative', weight: -.7, explanation: 'bounded tension', scope, state: 'active', conflict: { status: 'conflicted', conflictIds: ['conflict-001'] }, version: 1 }], counts: { nodes: 2, edges: 1, facts: 1, conflicts: 1, retracted: 0 }, accessibleOutline: ['Safe fact · supports bounded review', 'contradicts · negative tension · weight -0.70 · conflicted'], localOnly: true };
}

function loadProductionHtml(): { html: string; document: HarnessDocument; posts: unknown[]; dispatch: (data: unknown) => void } {
  const moduleRuntime = Module as unknown as { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
  const originalLoad = moduleRuntime._load;
  moduleRuntime._load = function(request: string, parent: NodeModule | undefined, isMain: boolean) { return request === 'vscode' ? {} : originalLoad.call(this, request, parent, isMain); };
  try {
    const { chatWebviewHtmlForTest } = require('../services/chat') as { chatWebviewHtmlForTest: () => string };
    const html = chatWebviewHtmlForTest();
    const document = new HarnessDocument(html);
    const posts: unknown[] = [];
    const listeners: Listener[] = [];
    const window = { addEventListener(type: string, listener: Listener) { if (type === 'message') listeners.push(listener); } };
    const context = vm.createContext({ document, window, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posts.push(message) }), Blob: class {}, URL: { createObjectURL: () => 'blob:bounded', revokeObjectURL() {} }, console, setTimeout });
    for (const script of html.matchAll(/<script\s+nonce="([^"]+)">([\s\S]*?)<\/script>/gi)) vm.runInContext(script[2], context, { timeout: 1000 });
    return { html, document, posts, dispatch: (data) => listeners.forEach((listener) => listener({ data, preventDefault() {} })) };
  } finally { moduleRuntime._load = originalLoad; }
}

function clickByText(document: HarnessDocument, text: string): void { const button = document.querySelectorAll('button').find((candidate) => candidate.textContent === text); assert.ok(button, `missing button ${text}`); button!.click(); }

test('generated chat HTML and webview initialization execute each nonce-bearing script independently', () => {
  const { html, document, posts } = loadProductionHtml();
  const scripts = [...html.matchAll(/<script\s+nonce="([^"]+)">([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 3);
  assert.equal((html.match(/<script\b/g) ?? []).length, (html.match(/<\/script>/g) ?? []).length);
  assert.ok(scripts.every(([_, nonce]) => nonce.length > 8));
  assert.ok(document.getElementById('team-action-status'));
  assert.ok(document.getElementById('attachments'));
  assert.ok(document.getElementById('memory-filters'));
  assert.ok(document.getElementById('memory-graph'));
  assert.deepEqual((posts as Array<{ type: string }>).map((message) => message.type), ['team-list', 'team-status', 'load-analytics', 'load-models', 'refresh-status', 'history']);
  assert.equal(html.includes('raw media fixture'), false);
  assert.equal(JSON.stringify(posts).includes('credential'), false);
});

test('runtime memory filters, actions, approval fingerprint, and metadata redaction stay bounded', () => {
  const harness = loadProductionHtml();
  harness.dispatch(memoryInspectMessage(fixture()));
  assert.ok(harness.document.getElementById('memory-filter-type'));
  harness.document.getElementById('memory-scope-kind')!.value = 'project';
  harness.document.getElementById('memory-scope-id')!.value = 'project-bounded-001';
  assert.ok(harness.document.querySelectorAll('button').some((button) => button.textContent === 'Preview correction'));
  const graph = harness.document.getElementById('memory-graph')!;
  const nodes = graph.querySelectorAll('g');
  assert.equal(nodes.length, 2);
  nodes[0].click(); nodes[1].click();
  harness.document.getElementById('memory-correction-summary')!.value = 'bounded correction';
  clickByText(harness.document, 'Preview correction');
  clickByText(harness.document, 'Preview merge of selected nodes');
  clickByText(harness.document, 'Preview retraction');
  clickByText(harness.document, 'Preview reset graph');
  clickByText(harness.document, 'Preview local export');
  const previews = (harness.posts as Array<Record<string, unknown>>).filter((message) => message.type === 'memory-preview');
  assert.deepEqual(previews.map((message) => message.operation), ['correct', 'merge', 'retract', 'reset', 'export']);
  for (const preview of previews) { assert.equal(JSON.stringify(preview.scope), JSON.stringify(fixture().scope)); assert.equal(preview.expectedGraphVersion, 7); assert.equal(preview.localOnly, true); }
  assert.equal((previews[0].summary as string).length, 18);
  assert.equal(JSON.stringify(previews[1].sourceNodeIds), JSON.stringify(['node-bounded-002']));
  const unsafe = JSON.stringify(harness.posts);
  assert.equal(unsafe.includes('raw context'), false);
  assert.equal(unsafe.includes('password'), false);
  harness.dispatch({ type: 'memory-approval-preview', preview: { version: 1, previewId: 'preview-001', operation: 'correct', scope: fixture().scope, expectedGraphVersion: 7, nodeIds: ['node-bounded-001'], sourceNodeIds: [], summaryLength: 18, summaryDigest: 'digest-bounded', localOnly: true, providerBoundary: 'local', sessionId: 'session-bounded', projectId: 'project-bounded', expiresAt: '2026-12-01T00:00:00Z', approvalFingerprint: 'fingerprint-exact-001' } });
  clickByText(harness.document, 'Approve exact memory action once');
  clickByText(harness.document, 'Approve exact memory action once');
  const approvals = (harness.posts as Array<Record<string, unknown>>).filter((message) => message.type === 'memory-approve');
  assert.equal(approvals.length, 1);
  assert.equal(JSON.stringify(approvals[0]), JSON.stringify({ type: 'memory-approve', approvalFingerprint: 'fingerprint-exact-001', explicit: true }));
});

test('runtime graph node and edge keyboard selection preserves table and outline fallback parity', () => {
  const harness = loadProductionHtml();
  harness.dispatch(memoryInspectMessage(fixture()));
  const graph = harness.document.getElementById('memory-graph')!;
  const nodes = graph.querySelectorAll('g');
  const edge = graph.querySelectorAll('line')[0];
  assert.equal(nodes[0].getAttribute('role'), 'button');
  assert.equal(nodes[0].getAttribute('tabindex'), '0');
  assert.deepEqual([...nodes[0].listeners.keys()], ['keydown']);
  assert.match(nodes[0].getAttribute('aria-label') ?? '', /project-bounded-001|confidence|fresh|provenance/);
  assert.match(edge.getAttribute('aria-label') ?? '', /negative tension|weight|-0\.70|conflicted/);
  nodes[0].dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  nodes[0].onclick!();
  assert.match(harness.document.getElementById('memory-selection-details')?.textContent ?? '', /Selected node.*Safe fact/);
  edge.dispatchEvent({ type: 'keydown', key: ' ', preventDefault() {} });
  edge.onclick!();
  assert.match(harness.document.getElementById('memory-selection-details')?.textContent ?? '', /Selected edge.*contradicts.*negative tension.*weight/);
  const table = harness.document.getElementById('memory-table')!;
  assert.match(table.textContent, /Safe fact/);
  assert.match(table.textContent, /Safe actor/);
  assert.match(table.textContent, /contradicts.*negative tension.*weight/);
  assert.equal(table.textContent.includes('raw private context'), false);
});

test('host graph messages remain allowlisted and redact unsafe text', () => {
  const node = sanitizeContextGraphNode({ nodeId: 'fact-safe0000000000000001', type: 'fact', label: '<script>secret</script>', summary: 'apiKey: secret', scope: { kind: 'project', id: 'project-safe0000000000000001' }, confidence: 2, freshness: { observedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', decayed: false }, provenance: { kind: 'user', sourceId: '/tmp/private', evidenceClass: 'user-assertion' }, state: 'active', conflict: { status: 'none', conflictIds: [] }, version: 1 });
  assert.equal(node.label.includes('secret'), false);
  assert.equal(node.summary.includes('secret'), false);
  assert.equal(node.confidence, 1);
});
