// ORG-01 to ORG-04. Pure: no I/O, no clock, no vscode, no package.
import type { ModeId } from '../org/modes';
import { modeName, term } from '../org/terms';
import type { KindOfWorkAnswer } from './answers';
import type { GuideModePolicy } from './policy';

export interface ModeSuggestion {
  readonly mode: ModeId;
  readonly source: 'suggested' | 'set-by-organization' | 'set-by-project' | 'policy-default';
  readonly changeable: boolean;
  readonly choices: readonly ModeId[];
}

export interface ModeRow {
  readonly name: string;
  readonly join: string;
  readonly source: string;
}

interface ModeInput {
  readonly kind?: KindOfWorkAnswer;
  readonly policy: GuideModePolicy;
  readonly setByOrganization: boolean;
  readonly fixedByProject?: ModeId;
}

export const SET_BY_PROJECT_TEXT = 'Set by this project';
export const MODE_SET_BY_ORGANIZATION_TEXT = 'Set by your organization';
export const MODE_SUGGESTED_TEXT = 'Suggested from your kind of work';

export const MODE_FOR_KIND: Readonly<Partial<Record<KindOfWorkAnswer, ModeId>>> = Object.freeze({
  staff: 'military',
  'capital-projects': 'capital',
  software: 'corporate'
});

const MODE_SOURCE_TEXT: Readonly<Record<ModeSuggestion['source'], string>> = {
  'set-by-project': SET_BY_PROJECT_TEXT,
  'set-by-organization': MODE_SET_BY_ORGANIZATION_TEXT,
  suggested: MODE_SUGGESTED_TEXT,
  'policy-default': ''
};

export function suggestMode({ kind, policy, setByOrganization, fixedByProject }: ModeInput): ModeSuggestion {
  if (fixedByProject !== undefined) {
    return { mode: fixedByProject, source: 'set-by-project', changeable: false, choices: [fixedByProject] };
  }
  if (!policy.projectMayChoose) {
    return {
      mode: policy.mode,
      source: setByOrganization ? 'set-by-organization' : 'policy-default',
      changeable: false,
      choices: [policy.mode]
    };
  }

  const suggested = kind === undefined ? undefined : MODE_FOR_KIND[kind];
  if (suggested !== undefined && policy.allowedModes.includes(suggested)) {
    return { mode: suggested, source: 'suggested', changeable: true, choices: policy.allowedModes };
  }
  return { mode: policy.mode, source: 'policy-default', changeable: true, choices: policy.allowedModes };
}

export function modeRowOf({ mode, source }: ModeSuggestion): ModeRow {
  return { name: modeName(mode), join: term('join', mode), source: MODE_SOURCE_TEXT[source] };
}
