// The two tools a team's agents use on their team's knowledge graph (owner, 2026-11-08). Knowledge is added as STRUCTURE, not prose: actors, what they
// do, how they relate, and how strongly, each with the Admiralty grade of the evidence. Prose alone cannot be drawn, compared, or questioned, which is the
// point of the graph.
import type { KnowledgeAddition, NodeKind, EdgeKind, Grading, KnowledgeOrigin } from '../domain/teamKnowledge';
import { neighbours, type TeamKnowledge } from '../domain/teamKnowledge';
import type { AgentTool } from './tools';
import { ToolError } from './workspace';

const RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const NODE_KINDS: NodeKind[] = ['actor', 'person', 'organisation', 'system', 'document', 'fact', 'place', 'product', 'event'];
const EDGE_KINDS: EdgeKind[] = ['supplies', 'certifies', 'regulates', 'funds', 'employs', 'partners', 'competes', 'depends-on', 'contradicts', 'supports', 'owns', 'reports-to', 'related'];
const SHOW_NODES = 60;

function gradingOf(raw: unknown, where: string): Grading | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const reliability = String(value.reliability ?? '').toUpperCase();
  const credibility = Number(value.credibility);
  if (!RELIABILITY.includes(reliability as (typeof RELIABILITY)[number])) throw new ToolError(`${where}: grading.reliability must be one of A to F.`);
  if (!Number.isInteger(credibility) || credibility < 1 || credibility > 6) throw new ToolError(`${where}: grading.credibility must be a whole number from 1 to 6.`);
  return { reliability: reliability as Grading['reliability'], credibility: credibility as Grading['credibility'] };
}

/**
 * Whether a source is an address on the web rather than a named document. The scheme is optional, because `evil.test/about` and `https://evil.test/about`
 * are the same thing to a reader, and a cap that misses the first is a cap an agent can step around (0.4.19 review).
 */
function looksLikeAddress(source: string): boolean {
  const text = source.trim();
  if (/^https?:\/\//i.test(text)) return true;
  // A host-looking first token with a dot and no space: `evil.test/about`, `www.example.org`, `192.0.2.1/x`.
  const host = text.split(/[/?#\s]/)[0] ?? '';
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i.test(host);
}

/**
 * The grade a claim about something the agent READ is worth: C3 at most. C is "fairly reliable" and 3 is "possibly true", which is what an agent's own reading
 * of a page is worth. Both halves are floored, because a page just read cannot be confirmed by other sources either.
 */
function capForWebSource(grading: Grading): Grading {
  const rank = ['A', 'B', 'C', 'D', 'E', 'F'];
  const reliability = rank.indexOf(grading.reliability) < rank.indexOf('C') ? 'C' : grading.reliability;
  return { reliability, credibility: (grading.credibility < 3 ? 3 : grading.credibility) as Grading['credibility'] };
}

export interface KnowledgeTools {
  /** The graph as it is now, so the agent reads before it researches. */
  read(): Promise<TeamKnowledge>;
  /** Adds what the agent learned; resolves to the merged graph. */
  add(addition: KnowledgeAddition): Promise<TeamKnowledge>;
}

export function knowledgeTools(knowledge: KnowledgeTools, origin: KnowledgeOrigin = 'interaction'): AgentTool<any>[] {
  const lookup: AgentTool<{ query?: string; node?: string }> = {
    name: 'TeamKnowledge',
    description: 'Read this team\'s shared knowledge graph: what the team has already learned, so you do not research it again. Without arguments it lists the most mentioned actors and their strongest relations; with "query" it searches labels, functions and facts; with "node" it shows one actor in full: what it does, its facts with sources and Admiralty grades, and every relation in both directions with the tension of each.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for in a label, a function, or a fact.' }, node: { type: 'string', description: 'The exact name of an actor to show in full.' } }, additionalProperties: false },
    capability: 'read',
    parse: (raw) => ({ ...(typeof raw.query === 'string' && raw.query.trim() ? { query: raw.query.trim().slice(0, 200) } : {}), ...(typeof raw.node === 'string' && raw.node.trim() ? { node: raw.node.trim().slice(0, 200) } : {}) }),
    title: (input) => (input.node ? `Knowledge: ${input.node}` : input.query ? `Knowledge: search "${input.query}"` : 'Knowledge graph'),
    async run(input) {
      const graph = await knowledge.read();
      if (!graph.nodes.length) return 'The team has no knowledge yet. Anything you verify is worth adding with Learn.';
      const grade = (grading?: Grading) => (grading ? `${grading.reliability}${grading.credibility}` : 'ungraded');
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      if (input.node) {
        const wanted = input.node.toLowerCase();
        const node = graph.nodes.find((candidate) => candidate.label.toLowerCase() === wanted) ?? graph.nodes.find((candidate) => candidate.label.toLowerCase().includes(wanted));
        if (!node) return `No actor called "${input.node}" is in the graph.`;
        const lines = [`${node.label} (${node.kind}), ${grade(node.grading)}, mentioned ${node.mentions} time${node.mentions === 1 ? '' : 's'}`];
        if (node.functions.length) lines.push(`Does: ${node.functions.join('; ')}`);
        for (const fact of node.facts.slice(0, 12)) lines.push(`- ${fact.text}${fact.source ? ` [${fact.source}]` : ''} (${grade(fact.grading)}, ${fact.origin})`);
        for (const relation of neighbours(graph, node.id)) {
          lines.push(`${relation.direction === 'out' ? '->' : '<-'} ${relation.edge.kind} ${relation.other.label} (tension ${relation.edge.tension ?? 'unmeasured'}${relation.edge.basis ? `, ${relation.edge.basis}` : ''})`);
        }
        return lines.join('\n');
      }
      const pool = input.query
        ? graph.nodes.filter((node) => `${node.label} ${node.functions.join(' ')} ${node.facts.map((fact) => fact.text).join(' ')}`.toLowerCase().includes(input.query!.toLowerCase()))
        : [...graph.nodes].sort((a, b) => b.mentions - a.mentions);
      const shown = pool.slice(0, SHOW_NODES);
      const lines = [`${pool.length} actor${pool.length === 1 ? '' : 's'}${input.query ? ` matching "${input.query}"` : ''}${pool.length > shown.length ? `, the ${shown.length} most mentioned` : ''}:`];
      for (const node of shown) {
        const relations = neighbours(graph, node.id).length;
        lines.push(`- ${node.label} (${node.kind}) ${grade(node.grading)}: ${node.functions.slice(0, 2).join('; ') || 'no function recorded'}${relations ? `, ${relations} relation${relations === 1 ? '' : 's'}` : ''}`);
      }
      const strongest = [...graph.edges].filter((edge) => edge.tension !== null).sort((a, b) => Math.abs(b.tension ?? 0) - Math.abs(a.tension ?? 0)).slice(0, 5);
      for (const edge of strongest) lines.push(`Strong relation: ${byId.get(edge.from)?.label ?? '?'} ${edge.kind} ${byId.get(edge.to)?.label ?? '?'} (${edge.tension})`);
      return lines.join('\n');
    }
  };

  const learn: AgentTool<KnowledgeAddition> = {
    name: 'Learn',
    description: 'Add what you verified to this team\'s shared knowledge graph, as structure: actors (organisations, people, systems, documents, facts, places), what each does, and how they relate. Every fact and every relation carries where it came from and an Admiralty grade: reliability A-F for the source and credibility 1-6 for the information. A document the team wrote, or a vendor\'s own marketing, is not an A. Give a relation\'s tension from -1 (hostile or contradictory) to 1 (strongly supportive), and say the basis; leave it out rather than guessing zero. The graph is shared with the rest of the team and remembered next time.',
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array', description: 'Actors you learned about.', items: {
            type: 'object', properties: {
              label: { type: 'string', description: 'The actor, as it is usually written.' },
              kind: { type: 'string', enum: NODE_KINDS },
              functions: { type: 'array', items: { type: 'string' }, description: 'What it does or provides, as short phrases.' },
              facts: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string', description: 'The URL, document, or person it came from.' } }, required: ['text'] } },
              grading: { type: 'object', properties: { reliability: { type: 'string', enum: RELIABILITY }, credibility: { type: 'number' } }, description: 'Admiralty grade of the evidence for this actor.' }
            }, required: ['label']
          }
        },
        edges: {
          type: 'array', description: 'How two actors relate. Both ends must be in this addition or already in the graph.', items: {
            type: 'object', properties: {
              from: { type: 'string' }, to: { type: 'string' },
              kind: { type: 'string', enum: EDGE_KINDS },
              tension: { type: 'number', description: 'From -1 to 1. Omit it when the strength is not measured.' },
              basis: { type: 'string', description: 'Why this relation is believed.' },
              grading: { type: 'object', properties: { reliability: { type: 'string', enum: RELIABILITY }, credibility: { type: 'number' } } }
            }, required: ['from', 'to']
          }
        }
      },
      required: ['nodes'],
      additionalProperties: false
    },
    // Learn WRITES: it changes the team's shared graph, which outlives the run, so it is a workspace write and asks where writes ask (0.4.19 review).
    capability: 'workspaceWrite',
    parse: (raw) => {
      if (!Array.isArray(raw.nodes) || !raw.nodes.length) throw new ToolError('Give at least one actor in "nodes".');
      const nodes = raw.nodes.slice(0, 40).map((entry, index) => {
        if (!entry || typeof entry !== 'object') throw new ToolError(`nodes[${index}] must be an object.`);
        const node = entry as Record<string, unknown>;
        if (typeof node.label !== 'string' || !node.label.trim()) throw new ToolError(`nodes[${index}].label is required.`);
        const kind = typeof node.kind === 'string' && NODE_KINDS.includes(node.kind as NodeKind) ? node.kind as NodeKind : 'actor';
        const functions = Array.isArray(node.functions) ? node.functions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 8).map((value) => value.slice(0, 200)) : [];
        const facts = Array.isArray(node.facts) ? node.facts.flatMap((value) => {
          if (!value || typeof value !== 'object') return [];
          const fact = value as Record<string, unknown>;
          if (typeof fact.text !== 'string' || !fact.text.trim()) return [];
          return [{ text: fact.text.slice(0, 400), ...(typeof fact.source === 'string' && fact.source.trim() ? { source: fact.source.slice(0, 300) } : {}) }];
        }).slice(0, 12) : [];
        let grading = gradingOf(node.grading, `nodes[${index}]`);
        // 0.4.19 review: a hostile page an agent read could be given an A1 grade by that agent and become durable team memory. A fact with an external
        // SOURCE but no grade is therefore ungraded on purpose, and one claiming the top grade for a web source is capped at C3: the agent cannot vouch for
        // a page it just read, and the card shows what it claimed rather than silently trusting it.
        // 0.4.19 review: the cap only fired for a source starting `http(s)://`, so an agent could write `evil.test/about` and keep its A1. Any source that
        // LOOKS like an address counts, with or without a scheme.
        const fromWeb = facts.some((fact) => fact.source !== undefined && looksLikeAddress(fact.source));
        if (fromWeb && grading) grading = capForWebSource(grading);
        return { label: node.label.trim().slice(0, 120), kind, functions, facts, ...(grading ? { grading } : {}) };
      });
      const edges = Array.isArray(raw.edges) ? raw.edges.slice(0, 60).flatMap((entry, index) => {
        if (!entry || typeof entry !== 'object') return [];
        const edge = entry as Record<string, unknown>;
        if (typeof edge.from !== 'string' || !edge.from.trim() || typeof edge.to !== 'string' || !edge.to.trim()) return [];
        const kind = typeof edge.kind === 'string' && EDGE_KINDS.includes(edge.kind as EdgeKind) ? edge.kind as EdgeKind : 'related';
        const tension = typeof edge.tension === 'number' && Number.isFinite(edge.tension) ? edge.tension : null;
        let grading = gradingOf(edge.grading, `edges[${index}]`);
        const basis = typeof edge.basis === 'string' && edge.basis.trim() ? edge.basis.slice(0, 300) : undefined;
        // 0.4.19 review: edges were never capped, so a hostile page could be given an A1 RELATION rather than an A1 fact. A relation from an address the agent
        // read, or asserted with no basis at all, is C3 at most, exactly as a fact from the same place is.
        if (grading && (basis === undefined || looksLikeAddress(basis))) grading = capForWebSource(grading);
        return [{ from: edge.from.trim().slice(0, 120), to: edge.to.trim().slice(0, 120), kind, tension, ...(basis ? { basis } : {}), ...(grading ? { grading } : {}) }];
      }) : [];
      return { nodes, edges, origin, at: new Date().toISOString() };
    },
    title: (input) => `Learn ${input.nodes.length} actor${input.nodes.length === 1 ? '' : 's'}${input.edges.length ? `, ${input.edges.length} relation${input.edges.length === 1 ? '' : 's'}` : ''}`,
    async preview(input) {
      // 0.4.19 review: the preview promised that approving once covered every later addition, which is true of "Approve for this run" but was stated as if
      // the graph became approved wholesale. It now says what approving does, and warns that what is added is durable and model-authored.
      return { kind: 'note', text: `Add to the team's knowledge graph: ${input.nodes.map((node) => node.label).join(', ')}${input.edges.length ? `; relations: ${input.edges.map((edge) => `${edge.from} ${edge.kind} ${edge.to}`).join(', ')}` : ''}.\nIt is written to the team's own file, outside this project, and later runs treat it as what the team knows. "Approve for this run" also allows this run's later additions, so a team working in parallel does not stop at every fact. Check the sources: what is added here outlives the run.` };
    },
    async run(input) {
      const graph = await knowledge.add(input);
      return `The team's graph now holds ${graph.nodes.length} actor${graph.nodes.length === 1 ? '' : 's'} and ${graph.edges.length} relation${graph.edges.length === 1 ? '' : 's'}.`;
    }
  };

  return [lookup, learn];
}
