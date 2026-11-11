// A team drawn as a shape rather than a list (owner, 2026-11-08: "teams represented graphically with ability to click on a member and get a member
// card detailing their capabilities and expectations. Should show hierarchy if one exists.")
//
// Pure: no DOM, no I/O. The page draws what this returns, and the tests check the shape rather than the drawing.
import type { TeamDefinition, TeamMember } from './teams';

/** One member in the drawing: what it is called, who it answers to, and what its card says. */
export interface MemberNode {
  name: string;
  role?: string;
  /** The member this one reports to, or undefined when it answers to the lead. */
  reportsTo?: string;
  /** Its children, in the order they appear in the team file. */
  children: MemberNode[];
  card: MemberCard;
}

/**
 * What the member card says. `capabilities` are what this member can actually do, derived from its tools (a member with no Bash cannot run commands,
 * whatever its instructions say); `expectations` are what the lead may ask of it and what it gives back, taken from its instructions.
 */
export interface MemberCard {
  name: string;
  role?: string;
  model?: string;
  tools: string[];
  capabilities: string[];
  /** The first paragraph of the member's instructions: what it is for. */
  purpose: string;
  /** Every later paragraph, which is where a member's steps and its output format usually are. */
  expectations: string[];
  reportsTo?: string;
  /** The members that answer to this one. */
  leads: string[];
  abliterated: boolean;
}

/** What each tool means in plain words, so a card describes capability rather than listing names. */
const TOOL_CAPABILITY: Array<[RegExp, string]> = [
  [/^(Read|Glob|Grep)$/, 'Read files'],
  [/^(Edit|Write|NotebookEdit)$/, 'Change files'],
  [/^Bash/, 'Run commands'],
  [/^(WebSearch|WebFetch)$/, 'Use the web'],
  [/^(TodoWrite|Task|Agent)$/, 'Plan and coordinate'],
  [/^(Remember|Recall)$/, 'Keep and use memory'],
  [/^(VectorizeImage|RenderSvg|CreatePresentation|GenerateImage)$/, 'Make media'],
  [/^(CreatePdf|CreateDocument)$/, 'Deliver documents']
];

function capabilitiesOf(member: TeamMember): string[] {
  const found: string[] = [];
  for (const tool of member.tools) {
    for (const [pattern, label] of TOOL_CAPABILITY) {
      if (label && pattern.test(tool) && !found.includes(label)) found.push(label);
    }
  }
  if (member.tools.some((tool) => /^mcp__/.test(tool))) found.push('Use connected tools');
  return found;
}

/** The instructions split into the opening purpose and the later expectations, which is how the studio's own templates are written. */
function splitInstructions(instructions: string): { purpose: string; expectations: string[] } {
  const paragraphs = instructions.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return { purpose: paragraphs[0] ?? '', expectations: paragraphs.slice(1) };
}

export interface TeamGraph {
  /** The root of the drawing: the team itself, whose children are the members that answer to no one else. */
  team: { name: string; description: string; members: number };
  roots: MemberNode[];
  /** Every node by member name, for the page to open a card from anywhere. */
  byName: Map<string, MemberNode>;
  /** Members whose `reports-to` names someone not on the team: drawn at the top and named, never dropped. */
  orphaned: Array<{ name: string; reportsTo: string }>;
}

/**
 * Builds the shape. A member whose `reports-to` names another member becomes that member's child; a member naming someone who is not on the team is
 * treated as reporting to the lead, and named in `orphaned`. A cycle cannot hang the drawing: the first member of a loop to be placed keeps its place
 * and the rest become its children in file order, so every member appears exactly once.
 */
export function buildTeamGraph(team: TeamDefinition, isAbliterated: (model: string) => boolean = () => false): TeamGraph {
  const nodes = new Map<string, MemberNode>();
  for (const member of team.members) {
    const { purpose, expectations } = splitInstructions(member.instructions);
    nodes.set(member.name, {
      name: member.name,
      ...(member.role ? { role: member.role } : {}),
      ...(member.reportsTo ? { reportsTo: member.reportsTo } : {}),
      children: [],
      card: {
        name: member.name,
        ...(member.role ? { role: member.role } : {}),
        ...(member.model ? { model: member.model } : {}),
        tools: [...member.tools],
        capabilities: capabilitiesOf(member),
        purpose,
        expectations,
        ...(member.reportsTo ? { reportsTo: member.reportsTo } : {}),
        leads: [],
        abliterated: member.model ? isAbliterated(member.model) : false
      }
    });
  }
  const roots: MemberNode[] = [];
  const orphaned: Array<{ name: string; reportsTo: string }> = [];
  const placed = new Set<string>();
  for (const member of team.members) {
    const node = nodes.get(member.name) as MemberNode;
    const parent = node.reportsTo ? nodes.get(node.reportsTo) : undefined;
    // Names itself, or names someone missing: the lead.
    if (!node.reportsTo) { roots.push(node); placed.add(node.name); continue; }
    if (node.reportsTo === node.name || !parent) {
      orphaned.push({ name: node.name, reportsTo: node.reportsTo });
      roots.push(node);
      placed.add(node.name);
      continue;
    }
    parent.children.push(node);
  }
  // `leads` is filled ONCE, at the end, after any cycle promotion has moved a member, so a promoted node never reports stale children.
  // A cycle puts every member of the loop under a parent that is itself, so nothing reaches a root. Any member not reachable from a root is promoted, so
  // every member appears exactly once and the drawing terminates.
  const reachable = new Set<string>();
  const walk = (node: MemberNode) => { if (reachable.has(node.name)) return; reachable.add(node.name); node.children.forEach(walk); };
  roots.forEach(walk);
  for (const member of team.members) {
    if (reachable.has(member.name)) continue;
    const node = nodes.get(member.name) as MemberNode;
    // Detach it from its parent so it is not drawn twice.
    for (const other of nodes.values()) other.children = other.children.filter((child) => child.name !== node.name);
    orphaned.push({ name: node.name, reportsTo: node.reportsTo ?? '' });
    roots.push(node);
    walk(node);
  }
  for (const node of nodes.values()) node.card.leads = node.children.map((child) => child.name);
  return { team: { name: team.name, description: team.description, members: team.members.length }, roots, byName: nodes, orphaned };
}
