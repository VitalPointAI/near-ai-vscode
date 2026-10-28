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
  spawn(request: { type: string; agent?: GsdAgent; prompt: string; description: string; model?: string; background: boolean; isolation?: 'worktree'; task?: string }, signal: AbortSignal): Promise<string>;
}


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

  const agentRun = async (raw: { type: string; prompt: string; description: string; model?: string; background: boolean; isolation?: 'worktree'; task?: string }, signal: AbortSignal) => {
    const agent = services.agents.find((candidate) => candidate.name === raw.type);
    if (!agent && raw.type && raw.type !== 'general-purpose') throw new ToolError(`No agent definition named "${raw.type}". Available: ${services.agents.map((candidate) => candidate.name).join(', ')}, or general-purpose.`);
    return services.spawn({ type: raw.type || 'general-purpose', agent, prompt: raw.prompt, description: raw.description, model: raw.model, background: raw.background, ...(raw.isolation ? { isolation: raw.isolation } : {}), ...(raw.task ? { task: raw.task } : {}) }, signal);
  };

  const agentParse = (raw: Record<string, unknown>) => {
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new ToolError('Missing required parameter "prompt".');
    return {
      type: typeof raw.subagent_type === 'string' ? raw.subagent_type.trim() : '',
      prompt: raw.prompt,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 120) : '',
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
      background: raw.run_in_background === true,
      ...(raw.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
      ...(typeof raw.task === 'string' && raw.task.trim() ? { task: raw.task.slice(0, 300) } : {})
    };
  };
  const agentParameters = { type: 'object', properties: { description: { type: 'string', description: 'Three to five words on the task.' }, prompt: { type: 'string', description: 'The complete task for the agent; it sees nothing else from this conversation.' }, subagent_type: { type: 'string', description: `One of: ${services.agents.map((agent) => agent.name).join(', ')}, or general-purpose.` }, model: { type: 'string', description: 'Optional tier or model ID.' }, run_in_background: { type: 'boolean' }, isolation: { type: 'string', enum: ['worktree'], description: 'Run the agent in its own git worktree on a new branch; its changes stay on that branch for you to merge.' }, task: { type: 'string', description: 'The exact content of the task-list item this agent works on. The task list then shows it in progress while the agent runs and completed when it finishes.' } }, required: ['prompt'], additionalProperties: false };
  const agentTool: AgentTool<ReturnType<typeof agentParse>> = {
    name: 'Agent',
    description: 'Start a sub-agent with its own context to do a self-contained task, and get back its final report. Give it everything it needs in the prompt. Several Agent calls in one turn run in parallel. With run_in_background the call returns at once and the report arrives in a later message when the agent finishes. When the agent does an item from your task list, pass that item\'s exact content as task.',
    parameters: agentParameters,
    // Its own tool calls go through the same permission checks; the call itself only reads.
    capability: 'plan',
    parse: agentParse,
    title: (input) => `${input.type || 'Agent'}: ${input.description || input.prompt.slice(0, 60)}`,
    run: (input, context) => agentRun(input, context.signal)
  };
  // Earlier Claude Code releases named this tool Task; GSD workflows may use either name.
  const taskTool: AgentTool<ReturnType<typeof agentParse>> = { ...agentTool, name: 'Task' };

  return [skillTool, slashTool, askTool, agentTool, taskTool];
}

// WebFetch and its address checks moved to ../agent/webTools; re-exported for existing callers.
export { fetchPublic, isPublicAddress } from '../agent/webTools';
