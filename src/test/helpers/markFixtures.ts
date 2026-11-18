// Fixtures for the session mark tests (plans 22 and 23, D-60): a project with an unsigned label file (read the way a run with no gate host reads one, so
// every label only raises), a scripted model, and a run with given grants. Every project is under the temporary folder; nothing reaches the network.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunCheckpoints } from '../../agent/checkpoints';
import type { AgentEvent } from '../../agent/loop';
import { OutboundFingerprints } from '../../agent/outboundCheck';
import { DEFAULT_RULES, RunGrants } from '../../agent/permissions';
import { ShellSession } from '../../agent/shell';
import { bashTool, globTool, grepTool, readTool } from '../../agent/tools';
import type { AgentTool } from '../../agent/tools';
import type { GateRuntime } from '../../domain/gate/decide';
import { SessionMark } from '../../domain/gate/dominance';
import type { Mark } from '../../domain/gate/dominance';
import type { Label } from '../../domain/gate/labels';
import { LABEL_MAP_FILE } from '../../gate/labelMapStore';
import type { CompletionEvent, ToolCall } from '../../services/nearAiClient';
import { newTestRun, testGateRuntime } from './gatedRuns';

export const RESTRICTED_TEXT = 'THE RESTRICTED PLAN for the northern site';

export function label(scale: string, level: string, compartments: string[] = []): Label {
  return { scale, level, compartments, releasability: [], handling: [] };
}
export const keys = (mark: Mark): string[] => mark.map((each) => `${each.scale}/${each.level}${each.compartments.length ? `+${each.compartments.join('+')}` : ''}`).sort();

/** A project with docs/plan.md at org/Restricted, conf.md at org/Confidential, internal.md at org/Internal and public notes, in an unsigned label file. */
export function labelledProject(extra: { project?: Label; entries?: Record<string, Label> } = {}): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-mark-')));
  mkdirSync(path.join(root, 'docs'));
  mkdirSync(path.join(root, '.planning', '.near-ai'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'plan.md'), `${RESTRICTED_TEXT}\n`);
  writeFileSync(path.join(root, 'conf.md'), 'CONFIDENTIAL budget lines for the next year\n');
  writeFileSync(path.join(root, 'internal.md'), 'INTERNAL notes about the team rota\n');
  writeFileSync(path.join(root, 'notes.md'), 'PUBLIC notes anyone may read\n');
  const entries = { 'docs/plan.md': label('org', 'Restricted'), 'conf.md': label('org', 'Confidential'), 'internal.md': label('org', 'Internal'), ...(extra.entries ?? {}) };
  const payload = { labelMapVersion: 1, vocabulary: 1, ...(extra.project === undefined ? {} : { project: extra.project }), entries };
  writeFileSync(path.join(root, ...LABEL_MAP_FILE.split('/')), JSON.stringify({ v: 1, purpose: 'label-map', signer: { fingerprint: 'x', publicKey: 'A'.repeat(43) }, signedAt: '2026-11-17T00:00:00.000Z', payload, sig: 'x' }));
  return root;
}

export function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/** A fake model that makes one call per turn, then answers. */
export function scripted(calls: ToolCall[]) {
  let turn = 0;
  const usage = { verificationStatus: 'unknown', latencyMs: 1 };
  return {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const next = calls[turn];
      turn += 1;
      if (!next) { yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage } as CompletionEvent; return; }
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [next] }, finishReason: 'tool_calls', usage } as CompletionEvent;
    },
    async actualCostsUsd() { return undefined; }
  };
}

/** A run with the given grants, in Full auto, whose cards are declined. */
export async function runWith(root: string, calls: ToolCall[], grants: RunGrants, gate: GateRuntime = testGateRuntime(), tools: AgentTool<any>[] = [readTool, globTool, grepTool, bashTool], policyMode: 'fully-autonomous' | 'approve-risky' = 'fully-autonomous'): Promise<{ outputs: string[]; transcript: string }> {
  const events: AgentEvent[] = [];
  const shell = new ShellSession(root);
  const agent = newTestRun({
    client: scripted(calls) as never, model: 'm', tools, gate, grants,
    context: { root, checkpoints: new RunCheckpoints('mark'), shell, readFiles: new Set() },
    policy: { mode: policyMode, emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: 'deny' }), emit: (event) => events.push(event)
  });
  const result = await agent.run([{ role: 'user', content: 'go' }], new AbortController().signal).finally(() => shell.dispose());
  const outputs = events.filter((event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end').map((event) => event.output);
  return { outputs, transcript: JSON.stringify(result.messages) };
}

export function grantsAt(mark: Mark): RunGrants {
  const grants = new RunGrants();
  grants.mark = new SessionMark(mark);
  grants.outbound = new OutboundFingerprints();
  return grants;
}

