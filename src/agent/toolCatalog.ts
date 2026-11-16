import { CORE_TOOLS } from './tools';
import type { AgentTool } from './tools';

// The built-in tools in one list (GATE-02, D-05): every tool that declares a manifest next to its own definition, in the order a run is given them
// (agentSession.toolsFor). The Tools page lists this catalog, and the gate's tests walk it, so a tool added here is checked and shown without another edit.

/**
 * Tools whose own `capability` (today's shorthand, which the settings layer keeps using, D-04) is not what `shorthandFor` gives their manifest, each
 * with the reason. Every entry is a place where the shorthand and the declared effects tell a different story; nothing else may differ (Pitfall 10).
 */
export const SHORTHAND_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  ['BashOutput', 'Reads only the output of a command this run started, which is the run\'s own state; the shorthand stays `read` so the settings layer decides as before.']
]);

/** The built-in tools that declare a manifest so far, in the order `toolsFor` gives them to a run. */
export function builtInTools(): AgentTool<any>[] {
  return [...CORE_TOOLS];
}
