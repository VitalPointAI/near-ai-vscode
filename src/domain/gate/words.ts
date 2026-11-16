// Plain words for a manifest (GATE-03, D-07): the one place a manifest becomes sentences, so the Tools page, the member cards and the gate read the
// same declaration and never disagree. Pure: no I/O, no clock, no vscode, no package. The order is fixed: where it runs, then what it can do in the
// vocabulary's verb order, then the sites it reaches (sorted), then whether it may run when nobody is watching.
import type { GateContextName } from './bundle';
import { isCommandEffect } from './manifest';
import type { EffectTemplate, ToolManifest } from './manifest';
import { CAPABILITY_VERBS } from './vocabulary';
import type { CapabilityVerb } from './vocabulary';

const READS_FILES = 'Reads files in this project';
const CHANGES_FILES = 'Can change files in this project';
const CHANGES_NOTHING = 'Changes nothing outside this run';
const ONLY_WHILE_YOU_ARE_THERE = 'Runs only while you are there';
const ALSO_UNATTENDED = 'Can also run when nobody is watching';

/** Any effect, a template or a capability: only its verb and the plain strings of its fields are read here. */
interface EffectLike { readonly verb: CapabilityVerb }

/** The sentence for a verb, from the effects of that verb. A verb with nothing to say returns no lines. */
function verbLines(verb: CapabilityVerb): string[] {
  switch (verb) {
    case 'read': return [READS_FILES];
    case 'plan': return [CHANGES_NOTHING];
    case 'workspaceWrite': return [CHANGES_FILES];
    default: return [];
  }
}

function effectLines(effects: readonly EffectLike[]): string[] {
  const lines: string[] = [];
  for (const verb of CAPABILITY_VERBS) {
    if (effects.some((effect) => effect.verb === verb)) lines.push(...verbLines(verb));
  }
  return lines;
}

/** The contexts sentence. Any context other than `interactive` is a run with nobody there to answer, so the person is told it can run unattended. */
export function contextLine(contexts: readonly GateContextName[]): string {
  return contexts.some((context) => context !== 'interactive') ? ALSO_UNATTENDED : ONLY_WHILE_YOU_ARE_THERE;
}

/** The manifest of one tool as plain sentences in the fixed order. */
export function describeManifest(manifest: ToolManifest): string[] {
  const effects = manifest.effects.filter((entry): entry is EffectTemplate => !isCommandEffect(entry));
  const lines = effectLines(effects);
  lines.push(contextLine(manifest.contexts));
  return lines;
}
