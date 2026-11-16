// Fixtures for tests that build a tool or a home folder by hand (GATE-02, D-10). A tool now needs a manifest to exist; a test that only wants a tool of a
// given shorthand gets the manifest that shorthand implies, so the test keeps meaning what it meant before manifests.
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentTool } from '../../agent/tools';
import { declareManifest, INTERACTIVE_AND_UNATTENDED } from '../../agent/tools';
import type { ToolManifest } from '../../domain/gate/manifest';
import type { ActionCapability } from '../../domain/policy';
import { fromActionCapability } from '../../domain/gate/vocabulary';

/**
 * The manifest a tool of `capability` would declare if it did only what the shorthand says, through the vocabulary's own one-way mapping (D-04): `read` reads
 * the whole project, `network` reaches any site, and so on. For every shorthand except `gitMutation` (which has no word of its own once it is effects: it
 * reads back as `shell`), `shorthandFor` of the result equals `capability`. It runs in every context a test might ask about.
 */
export function testManifest(name: string, capability: ActionCapability): ToolManifest {
  return declareManifest({ tool: name, effects: fromActionCapability(capability).capabilities, contexts: INTERACTIVE_AND_UNATTENDED });
}

/** A tool built by hand for a test: the given fields, and a manifest from the tool's own name and capability unless the test gives one. */
export function testTool<I = Record<string, unknown>>(tool: Omit<AgentTool<I>, 'manifest'> & { manifest?: ToolManifest }): AgentTool<I> {
  return { ...tool, manifest: tool.manifest ?? testManifest(tool.name, tool.capability) };
}

/**
 * An empty folder to stand in for the person's home in a floor test, made under the run's own temporary folder (TMPDIR). It is never the real home, and a
 * test that cannot get a folder apart from the real home fails here, not in the middle of the test.
 */
export function fakeHome(): string {
  const base = path.resolve(tmpdir());
  const made = path.resolve(mkdtempSync(path.join(base, 'near-ai-gate-home-')));
  if (made === path.resolve(homedir()) || path.dirname(made) !== base) throw new Error('The stand-in home folder must be a new folder under the temporary folder, never the real home.');
  return made;
}
