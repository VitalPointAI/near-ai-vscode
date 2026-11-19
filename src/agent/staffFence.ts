// One rule for what the built-in staff servers hand a model (drop 2 review): every read tool's answer is fenced as untrusted content, whole. A read
// tool answers from files other members, other sections, units or a person wrote (products, registers, LOGSTATs, map layers, proposals, planning
// factors, a readiness CSV), so any of its text can carry instructions; the fence tells the model it is data. Fencing the whole answer, rather than the
// parts a tool's author judged to be party-written, means a new field or a new read tool is covered without anyone remembering to fence it.
//
// The observations server fences its rows itself, with its heads and notes outside the fence, and is not wrapped here; a test walks every staff
// server's read tools and checks that each answer is fenced.
//
// The wrapper below is one of the listed places a tool's run is called (src/test/gateEnumeration.test.ts TOOL_RUN_SITES): the loop's gated executeCall
// runs the wrapper, which calls the wrapped run inside that same call and keeps every other field of the tool, so the gate sees the same tool.
import type { AgentTool, ToolContext } from './tools';
import { fenceUntrusted } from './untrusted';

/** The fence's source for a tool named `mcp__<server>__<verb>`: "<server>: <verb>". */
function sourceOf(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[1]}: ${match[2]}` : name;
}

/** Fences one answer from a staff tool. `notes` go inside the fence, above the text (for example "this is a draft to write"). */
export function fenceStaffText(tool: string, text: string, notes: string[] = []): string {
  return fenceUntrusted(sourceOf(tool), text, notes).text;
}

/**
 * The tools with every read tool's answer fenced whole. Write tools are left as they are: their answers are the server's own account of what it
 * wrote, and a write tool that also returns stored text (a ledger read, validation findings) fences that part itself.
 */
export function fenceReadResults(tools: AgentTool<any>[], notes: Readonly<Record<string, string[]>> = {}): AgentTool<any>[] {
  return tools.map((tool) => tool.capability !== 'read' ? tool : {
    ...tool,
    run: async (input: unknown, context: ToolContext) => fenceStaffText(tool.name, await tool.run(input as never, context), notes[tool.name] ?? [])
  });
}
