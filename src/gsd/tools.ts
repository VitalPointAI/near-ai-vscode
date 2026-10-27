import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AgentTool } from '../agent/tools';
import { ToolError } from '../agent/workspace';
import { expandPrompt, GsdAgent, GsdSkill } from './library';

export interface Question {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export interface GsdServices {
  home: string;
  root: string;
  skills: GsdSkill[];
  agents: GsdAgent[];
  /** Shows the questions in the chat and resolves with one answer per question. */
  ask(questions: Question[], signal: AbortSignal): Promise<string[]>;
  /**
   * Runs a sub-agent. In the foreground it resolves with the final report; in the background it
   * resolves at once with the agent's id, and the report reaches the caller when it finishes.
   */
  spawn(request: { type: string; agent?: GsdAgent; prompt: string; description: string; model?: string; background: boolean; isolation?: 'worktree' }, signal: AbortSignal): Promise<string>;
}

const MAX_FETCH_BYTES = 2 * 1024 * 1024;

/** Tools Open-GSD's Claude runtime expects, implemented for this runner. */
export function gsdTools(services: GsdServices): AgentTool<any>[] {
  const findSkill = (name: string) => services.skills.find((skill) => skill.name === name || skill.name === `gsd-${name}` || skill.name === name.replace(/^\//, '') || skill.name.replace(/:/g, '-') === name);

  const skillTool: AgentTool<{ name: string; args: string }> = {
    name: 'Skill',
    description: `Load an installed skill's instructions and follow them. Available skills: ${services.skills.map((skill) => skill.name).join(', ')}.`,
    parameters: { type: 'object', properties: { skill: { type: 'string', description: 'Skill name, e.g. gsd-progress.' }, args: { type: 'string', description: 'Arguments for the skill.' } }, required: ['skill'], additionalProperties: false },
    capability: 'plan',
    parse: (raw) => {
      const name = typeof raw.skill === 'string' ? raw.skill.trim() : typeof raw.command === 'string' ? raw.command.trim() : '';
      if (!name) throw new ToolError('Missing required parameter "skill".');
      return { name, args: typeof raw.args === 'string' ? raw.args : '' };
    },
    title: (input) => `Load skill ${input.name}${input.args ? ` ${input.args}` : ''}`,
    async run(input) {
      const skill = findSkill(input.name);
      if (!skill) throw new ToolError(`No installed skill named "${input.name}".`);
      return `Follow these instructions for ${skill.name}:\n\n${await expandPrompt(skill.body, { args: input.args, home: services.home, root: services.root })}`;
    }
  };

  // Workflows chain to the next command with SlashCommand("/gsd-plan-phase 1 --auto").
  const slashTool: AgentTool<{ name: string; args: string }> = {
    ...skillTool,
    name: 'SlashCommand',
    description: 'Run an installed slash command, e.g. "/gsd-plan-phase 1 --auto": loads its instructions to follow now.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command with its arguments, starting with /.' } }, required: ['command'], additionalProperties: false },
    parse: (raw) => {
      const match = typeof raw.command === 'string' ? /^\/?([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(raw.command.trim()) : null;
      if (!match) throw new ToolError('command must look like "/gsd-progress" followed by any arguments.');
      return { name: match[1], args: (match[2] ?? '').trim() };
    },
    title: (input) => `Run /${input.name}${input.args ? ` ${input.args}` : ''}`
  };

  const askTool: AgentTool<{ questions: Question[] }> = {
    name: 'AskUserQuestion',
    description: 'Ask the user one to four multiple-choice questions and wait for the answers. Each question has 2-4 options; the user can also type their own answer. Use when a decision is genuinely theirs to make.',
    parameters: { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { question: { type: 'string' }, header: { type: 'string', description: 'A short label, at most 12 characters.' }, options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } }, multiSelect: { type: 'boolean' } }, required: ['question', 'options'] } } }, required: ['questions'], additionalProperties: false },
    capability: 'plan',
    parse: (raw) => {
      if (!Array.isArray(raw.questions) || !raw.questions.length) throw new ToolError('questions must be a non-empty array.');
      const questions = raw.questions.slice(0, 4).map((value) => {
        const item = (value ?? {}) as Record<string, unknown>;
        if (typeof item.question !== 'string' || !item.question.trim()) throw new ToolError('Every question needs text.');
        const options = Array.isArray(item.options) ? item.options.map((option) => {
          const entry = (option ?? {}) as Record<string, unknown>;
          if (typeof entry.label !== 'string' || !entry.label.trim()) throw new ToolError('Every option needs a label.');
          return { label: entry.label.slice(0, 200), ...(typeof entry.description === 'string' ? { description: entry.description.slice(0, 400) } : {}) };
        }) : [];
        if (!options.length) throw new ToolError('Every question needs options.');
        return { question: item.question.slice(0, 1000), ...(typeof item.header === 'string' ? { header: item.header.slice(0, 40) } : {}), options: options.slice(0, 6), multiSelect: item.multiSelect === true };
      });
      return { questions };
    },
    title: (input) => input.questions.length === 1 ? `Ask: ${input.questions[0].question.slice(0, 80)}` : `Ask ${input.questions.length} questions`,
    async run(input, context) {
      const answers = await services.ask(input.questions, context.signal);
      return input.questions.map((question, index) => `Q: ${question.question}\nA: ${answers[index] ?? '(no answer)'}`).join('\n\n');
    }
  };

  const agentRun = async (raw: { type: string; prompt: string; description: string; model?: string; background: boolean; isolation?: 'worktree' }, signal: AbortSignal) => {
    const agent = services.agents.find((candidate) => candidate.name === raw.type);
    if (!agent && raw.type && raw.type !== 'general-purpose') throw new ToolError(`No agent definition named "${raw.type}". Available: ${services.agents.map((candidate) => candidate.name).join(', ')}, or general-purpose.`);
    return services.spawn({ type: raw.type || 'general-purpose', agent, prompt: raw.prompt, description: raw.description, model: raw.model, background: raw.background, ...(raw.isolation ? { isolation: raw.isolation } : {}) }, signal);
  };

  const agentParse = (raw: Record<string, unknown>) => {
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new ToolError('Missing required parameter "prompt".');
    return {
      type: typeof raw.subagent_type === 'string' ? raw.subagent_type.trim() : '',
      prompt: raw.prompt,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 120) : '',
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      background: raw.run_in_background === true,
      ...(raw.isolation === 'worktree' ? { isolation: 'worktree' as const } : {})
    };
  };
  const agentParameters = { type: 'object', properties: { description: { type: 'string', description: 'Three to five words on the task.' }, prompt: { type: 'string', description: 'The complete task for the agent; it sees nothing else from this conversation.' }, subagent_type: { type: 'string', description: `One of: ${services.agents.map((agent) => agent.name).join(', ')}, or general-purpose.` }, model: { type: 'string', description: 'Optional tier or model ID.' }, run_in_background: { type: 'boolean' }, isolation: { type: 'string', enum: ['worktree'], description: 'Run the agent in its own git worktree on a new branch; its changes stay on that branch for you to merge.' } }, required: ['prompt'], additionalProperties: false };
  const agentTool: AgentTool<ReturnType<typeof agentParse>> = {
    name: 'Agent',
    description: 'Start a sub-agent with its own context to do a self-contained task, and get back its final report. Give it everything it needs in the prompt. Several Agent calls in one turn run in parallel. With run_in_background the call returns at once and the report arrives in a later message when the agent finishes.',
    parameters: agentParameters,
    // Its own tool calls go through the same permission checks; the call itself only reads.
    capability: 'plan',
    parse: agentParse,
    title: (input) => `${input.type || 'Agent'}: ${input.description || input.prompt.slice(0, 60)}`,
    run: (input, context) => agentRun(input, context.signal)
  };
  // Earlier Claude Code releases named this tool Task; GSD workflows may use either name.
  const taskTool: AgentTool<ReturnType<typeof agentParse>> = { ...agentTool, name: 'Task' };

  const webFetchTool: AgentTool<{ url: string; prompt?: string }> = {
    name: 'WebFetch',
    description: 'Fetch a public web page (https) and return its text. Pass prompt to say what you are looking for.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } }, required: ['url'], additionalProperties: false },
    capability: 'network',
    parse: (raw) => {
      if (typeof raw.url !== 'string') throw new ToolError('Missing required parameter "url".');
      let url: URL;
      try { url = new URL(raw.url); } catch { throw new ToolError('url is not a valid URL.'); }
      if (url.protocol !== 'https:') throw new ToolError('Only https:// URLs can be fetched.');
      return { url: url.toString(), prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined };
    },
    title: (input) => `Fetch ${new URL(input.url).host}${new URL(input.url).pathname}`,
    async preview(input) { return { kind: 'note', text: `Fetch ${input.url}. The page's text is sent to the model.` }; },
    async run(input, context) {
      const response = await fetchPublic(input.url, context.signal);
      if (!response.ok) throw new ToolError(`The page returned HTTP ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, MAX_FETCH_BYTES);
      const body = new TextDecoder().decode(bytes);
      const text = /html/i.test(response.headers.get('content-type') ?? '') ? htmlToText(body) : body;
      return `${input.prompt ? `Looking for: ${input.prompt}\n\n` : ''}${text.slice(0, 40_000)}`;
    }
  };

  return [skillTool, slashTool, askTool, agentTool, taskTool, webFetchTool];
}

/**
 * Fetches a public https page, following up to five redirects by hand so that every hop is
 * checked: https only, and the host must not resolve to a loopback, private, link-local, or
 * other non-public address (no reaching localhost services or cloud metadata endpoints).
 */
export async function fetchPublic(start: string, signal?: AbortSignal, lookup: (host: string) => Promise<string[]> = resolveHost, fetchFn: typeof fetch = fetch): Promise<Response> {
  let url = new URL(start);
  for (let hop = 0; hop <= 5; hop += 1) {
    if (url.protocol !== 'https:') throw new ToolError(`Refused to fetch ${url.toString()}: only https:// URLs can be fetched.`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await lookup(host).catch(() => { throw new ToolError(`Could not resolve ${host}.`); });
    const blocked = addresses.find((address) => !isPublicAddress(address));
    if (blocked) throw new ToolError(`Refused to fetch ${url.host}: it resolves to ${blocked}, which is not a public address.`);
    const response = await fetchFn(url.toString(), { signal, redirect: 'manual', headers: { 'user-agent': 'NEAR-AI-VSCode/1.0', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    url = new URL(location, url);
  }
  throw new ToolError('Too many redirects.');
}

async function resolveHost(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPublicAddress(mapped[1]);
  return !(lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower));
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
