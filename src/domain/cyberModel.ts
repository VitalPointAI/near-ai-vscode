// Which model a Cybersecurity engagement runs on (owner decision 2026-11-05). A scan sends exploits, payloads and attack
// strings, which the safety-tuned chat models refuse or water down, so a scan runs on an abliterated model (the model id
// says "abliterated") and the chat is switched to it for that run. There is exactly one such model today; when a second
// appears the person chooses, and nothing here guesses between equals.
//
// Pure: no vscode, no I/O, no clock.

/** True for a model whose safety tuning was removed (NEAR AI names them "<...>-abliterated"). */
export function isAbliteratedModel(modelId: string): boolean {
  return /abliterated/i.test(modelId);
}

export type CyberModelChoice =
  /** Use this model: it is the only abliterated one, or the person chose it. */
  | { kind: 'use'; model: string }
  /** Several abliterated models are offered and none is chosen yet: ask the person. */
  | { kind: 'choose'; models: string[] }
  /** No abliterated model is offered by this profile: the plain default stands and the panel says so. */
  | { kind: 'none'; fallback: string };

/**
 * The model an engagement should run on. A model already chosen for the engagement wins; otherwise the only abliterated
 * model offered is used; otherwise, with several, the person is asked; with none, the default stands.
 * `available` is the model list the panel offers (chat models only), `stored` the engagement's own choice.
 */
export function chooseCyberModel(available: readonly string[], stored: string | undefined, fallback: string): CyberModelChoice {
  const chosen = stored?.trim();
  if (chosen) return { kind: 'use', model: chosen };
  const unfiltered = available.map((model) => model.trim()).filter((model) => model.length > 0);
  // One entry per model id, in the order the panel lists them, so a duplicate never counts as a second choice.
  const abliterated = [...new Set(unfiltered.filter(isAbliteratedModel))];
  if (abliterated.length === 1 && abliterated[0] !== undefined) return { kind: 'use', model: abliterated[0] };
  if (abliterated.length > 1) return { kind: 'choose', models: abliterated };
  return { kind: 'none', fallback };
}

/** The sentence the panel shows when no abliterated model is offered, and the one it shows for several. */
export const NO_ABLITERATED_TEXT = 'This profile offers no abliterated model, so a scan may be refused by the model\'s safety measures. Add one to your organization, then reopen this panel.';
export const CHOOSE_ABLITERATED_TEXT = 'Several abliterated models are offered. Choose the one this scan runs on.';
