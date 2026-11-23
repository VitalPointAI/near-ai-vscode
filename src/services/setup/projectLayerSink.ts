import { parseProjectLayer } from '../../domain/gate/layers';
import type { PolicyDocument } from '../../domain/gate/policyDocument';
import type { ProjectResidency } from '../../domain/gate/residency';
import type { LockableAnswer } from '../../domain/gate/sections';
import { MODE_IDS, type ModeId } from '../../domain/org/modes';
import { parseSetupGuideEntry, type SetupGuideEntry } from '../../domain/setup/answers';
import { isSharedProject, projectLayerOf, projectModeAllowed, updateProjectJson, PROJECT_JSON_UNREADABLE_TEXT, PROJECT_JSON_WRITE_FAILED_TEXT } from './projectStore';

export const WAITS_SHARED_TEXT = 'Waits for the next update: shared project settings';
export const PROJECT_LAYER_WIDENING_TEXT = "This change would widen this project's rules";
export const PROJECT_LAYER_INVALID_TEXT = "These project settings could not be saved. Check the choices and try again.";

export interface ProjectLayerChange {
  readonly mode?: ModeId;
  readonly exercise?: { reason: string; setAt: string } | null;
  readonly lock?: readonly LockableAnswer[];
  readonly residency?: ProjectResidency;
  readonly setupGuide?: SetupGuideEntry;
}

export type SinkResult =
  | { state: 'written' }
  | { state: 'waits'; for: 'shared-project' }
  | { state: 'refused'; text: string }
  | { state: 'failed'; text: string };

export interface ProjectLayerSink {
  readonly kind: 'single-machine' | 'shared';
  write(change: ProjectLayerChange): Promise<SinkResult>;
}

interface ProjectLayerSinkDeps {
  readonly effective: () => PolicyDocument | undefined;
  readonly source?: { invalidate(root: string): void };
}

const WAITS = Object.freeze({ state: 'waits', for: 'shared-project' } as const);

export function singleMachineSink(root: string, deps: ProjectLayerSinkDeps): ProjectLayerSink {
  return {
    kind: 'single-machine',
    async write(change) {
      try {
        if (await isSharedProject(root)) return WAITS;
      } catch {
        return { state: 'failed', text: PROJECT_JSON_WRITE_FAILED_TEXT };
      }
      let refusal: string | undefined;
      const update = await updateProjectJson(root, (current) => {
        const effective = deps.effective();
        const scales = effective?.labels.scales ?? {};
        const previous = projectLayerOf(current, scales);
        const refuse = (text: string) => {
          refusal = text;
          return current;
        };
        if (previous.state === 'unreadable') return refuse(PROJECT_JSON_UNREADABLE_TEXT);
        const layer = previous.state === 'valid' ? previous.layer : undefined;
        if (change.mode !== undefined && (!MODE_IDS.includes(change.mode) || !projectModeAllowed(change.mode, effective))) {
          return refuse(PROJECT_LAYER_WIDENING_TEXT);
        }
        const required = layer?.residency?.required;
        if (required && change.residency?.required.some((region) => !required.includes(region))) {
          return refuse(PROJECT_LAYER_WIDENING_TEXT);
        }
        const next = { ...layer, v: 1 as const };
        if (change.mode !== undefined) next.mode = change.mode;
        if (change.exercise === null) delete next.exercise;
        else if (change.exercise !== undefined) next.exercise = change.exercise;
        if (change.lock !== undefined) {
          next.locked = { ...next.locked, ...Object.fromEntries(change.lock.map((answer) => [answer, true])) };
        }
        if (change.residency !== undefined) next.residency = change.residency;
        const parsed = parseProjectLayer(next, scales);
        const setupGuide = change.setupGuide === undefined ? undefined : parseSetupGuideEntry(change.setupGuide);
        if (!parsed.ok || (change.setupGuide !== undefined && setupGuide === undefined)) {
          return refuse(PROJECT_LAYER_INVALID_TEXT);
        }
        return { ...current, projectLayer: parsed.value, ...(setupGuide === undefined ? {} : { setupGuide }) };
      }, deps.source);
      if (refusal !== undefined) return { state: 'refused', text: refusal };
      if (!update.ok) return { state: 'failed', text: update.text };
      return { state: 'written' };
    }
  };
}

export function sharedProjectSink(): ProjectLayerSink {
  return { kind: 'shared', write: async () => WAITS };
}

export async function projectLayerSinkFor(root: string, deps: ProjectLayerSinkDeps): Promise<ProjectLayerSink> {
  return await isSharedProject(root) ? sharedProjectSink() : singleMachineSink(root, deps);
}
