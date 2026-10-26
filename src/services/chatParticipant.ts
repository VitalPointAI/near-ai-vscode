import * as path from 'node:path';
import * as vscode from 'vscode';
import { hostAttribution } from '../domain/activity';
import { PromptResponse, StructuredPrompt } from '../domain/chatProgress';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { ActivityStore } from './activityStore';
import { AuthService } from './auth';
import { ConversationTurn, defaultChatModel, promptMessage, providerErrorMessage } from './chatBridge';
import { GsdProgressEvent, GsdRunner } from './gsdRunner';
import { GsdUpdater } from './gsdUpdater';
import { UsageMetadata } from './nearAiClient';
import { ProfileStore } from './profileStore';
import { createNearAiProvider } from './providerFactory';
import { readSettings, shouldAutoInstallGsd } from './settings';

export const PARTICIPANT_ID = 'nearAi';
export const RESPOND_TO_GSD_COMMAND = 'nearAi.respondToGsdPrompt';

interface ParticipantResult extends vscode.ChatResult {
  metadata: { command?: string };
}

/**
 * `@nearAi` in VS Code's built-in Chat view. Plain prompts stream from NEAR AI Cloud;
 * slash commands run the matching Open-GSD workflow in the open workspace.
 */
export function registerChatParticipant(context: vscode.ExtensionContext, auth: AuthService): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') return;
  const runner = new GsdRunner();
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token): Promise<ParticipantResult> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (request.command && GSD_COMMANDS.some((definition) => definition.command === request.command)) {
      if (!root) {
        response.markdown('Open a folder first. Open-GSD commands run inside a workspace.');
        return { metadata: { command: request.command } };
      }
      await runGsdInChat(runner, request.command, request.prompt, root, response, token);
      return { metadata: { command: request.command } };
    }
    await answerWithNearAi(auth, root, request.prompt, historyFromChatContext(chatContext.history), response, token);
    return { metadata: {} };
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  participant.followupProvider = {
    provideFollowups(result: ParticipantResult) {
      if (!result.metadata.command) return [];
      return [
        { prompt: '', command: 'next', label: 'Continue with the next step' },
        { prompt: '', command: 'progress', label: 'Show project progress' }
      ].filter((followup) => followup.command !== result.metadata.command);
    }
  };
  context.subscriptions.push(
    participant,
    vscode.commands.registerCommand(RESPOND_TO_GSD_COMMAND, (reply: PromptResponse) => runner.respond(reply))
  );
}

async function answerWithNearAi(auth: AuthService, root: string | undefined, prompt: string, history: ConversationTurn[], response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
  if (!root) {
    response.markdown('Open a folder first. NEAR AI keys and profiles are scoped to a project.');
    return;
  }
  const profiles = new ProfileStore(root, auth);
  const profile = await profiles.getActiveProfile();
  const selection = await profiles.getActiveSelection();
  if (!profile || !selection || profile.validation.status !== 'valid') {
    response.markdown('This project has no validated NEAR AI profile yet. Set one up to start chatting.');
    response.button({ command: 'nearAi.setup', title: 'Set up NEAR AI' });
    return;
  }
  let provider;
  try {
    provider = await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
  } catch (error) {
    response.markdown(providerErrorMessage(error));
    response.button({ command: 'nearAi.setup', title: 'Review setup' });
    return;
  }
  let model: string | undefined;
  try {
    model = defaultChatModel(await provider.client.listModels(), readSettings().defaultModel);
  } catch (error) {
    response.markdown(providerErrorMessage(error));
    return;
  }
  if (!model) {
    response.markdown('NEAR AI returned no chat models for this key.');
    return;
  }
  const activity = new ActivityStore(root);
  const session = await activity.start({ project: path.basename(root), attribution: hostAttribution(profiles.projectScopeId, path.basename(root), profile.profileId, profile.organization), model, summary: 'Chat view session started.' });
  const abort = new AbortController();
  const cancel = token.onCancellationRequested(() => abort.abort());
  response.progress(`Asking ${model}…`);
  try {
    for await (const event of provider.client.streamChatEvents(model, [...history, { role: 'user', content: prompt }], abort.signal)) {
      if (event.type === 'text') response.markdown(event.text);
      else if (event.type === 'done') {
        response.markdown(`\n\n${usageFooter(model, event.metadata)}`);
        await activity.append(session.sessionId, { status: 'completed', kind: 'message', model, requestId: event.metadata.requestId, summary: 'Assistant response completed.', estimatedCostUsd: event.metadata.estimatedCostUsd, actualCostUsd: event.metadata.actualCostUsd, inputTokens: event.metadata.inputTokens, outputTokens: event.metadata.outputTokens });
      } else if (event.type === 'status' && event.status === 'cancelled') {
        await activity.append(session.sessionId, { status: 'cancelled', summary: 'Chat request cancelled by the user.' });
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      await activity.append(session.sessionId, { status: 'failed', summary: 'Chat request failed.', errorCode: error instanceof Error ? error.name : 'unknown' });
      response.markdown(providerErrorMessage(error));
    }
  } finally {
    cancel.dispose();
  }
}

async function runGsdInChat(runner: GsdRunner, command: string, note: string, root: string, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
  if (runner.runningCommand) {
    response.markdown(`\`/${runner.runningCommand}\` is still running. Wait for it to finish or stop it first.`);
    return;
  }
  if (shouldAutoInstallGsd()) {
    response.progress('Checking Open-GSD…');
    if (!await new GsdUpdater(undefined, root).ensureInstalled()) {
      response.markdown('Open-GSD is not installed and could not be installed automatically. Install `@opengsd/gsd-core` and try again.');
      return;
    }
  }
  if (note.trim()) response.markdown(`> ${note.trim()}\n\n`);
  const activity = new ActivityStore(root);
  const session = await activity.start({ project: path.basename(root), plans: [command], summary: `Open-GSD /${command} started.` });
  const cancel = token.onCancellationRequested(() => runner.cancel());
  let writes = Promise.resolve();
  try {
    await runner.run(command, root, (event: GsdProgressEvent) => {
      renderGsdEvent(event, session.sessionId, response);
      writes = writes.then(async () => { await activity.append(session.sessionId, { status: gsdActivityStatus(event.state), kind: 'session', summary: event.text ?? `Open-GSD /${command} ${event.state}.` }); });
    });
  } finally {
    cancel.dispose();
    await writes;
  }
}

function renderGsdEvent(event: GsdProgressEvent, sessionId: string, response: vscode.ChatResponseStream): void {
  const prompt = promptMessage(event.prompt);
  if (prompt) {
    renderPrompt({ ...prompt, sessionId }, response);
    return;
  }
  if (event.state === 'output' && event.text) response.markdown(event.text.endsWith('\n') ? event.text : `${event.text}\n`);
  else if (event.state === 'completed') response.markdown(`\n✓ \`/${event.command}\` finished.`);
  else if (event.state === 'failed') response.markdown(`\n✗ \`/${event.command}\` failed${event.text ? `: ${event.text}` : '.'}`);
  else if (event.state === 'cancelled') response.markdown(`\n\`/${event.command}\` was cancelled.`);
  else response.progress(event.text ?? event.action ?? `/${event.command} ${event.state}…`);
}

function renderPrompt(prompt: StructuredPrompt, response: vscode.ChatResponseStream): void {
  response.markdown(`\n**${prompt.question}**\n`);
  for (const choice of prompt.choices) {
    const reply: PromptResponse = { type: 'prompt-choice', sessionId: prompt.sessionId, promptId: prompt.promptId, choiceId: choice.id };
    response.button({ command: RESPOND_TO_GSD_COMMAND, title: choice.label, tooltip: choice.description, arguments: [reply] });
  }
}

function gsdActivityStatus(state: GsdProgressEvent['state']): 'completed' | 'cancelled' | 'failed' | 'waiting' | 'running' {
  if (state === 'completed' || state === 'cancelled' || state === 'failed' || state === 'waiting') return state;
  return 'running';
}

/** Rebuilds the conversation from this participant's earlier turns in the same chat. */
export function historyFromChatContext(turns: ReadonlyArray<vscode.ChatRequestTurn | vscode.ChatResponseTurn>): ConversationTurn[] {
  const history: ConversationTurn[] = [];
  for (const turn of turns) {
    if (turn.participant !== PARTICIPANT_ID) continue;
    if ('prompt' in turn) {
      if (!turn.command && turn.prompt.trim()) history.push({ role: 'user', content: turn.prompt.trim() });
      continue;
    }
    if (turn.result.metadata?.command) continue;
    const text = turn.response.map((part) => 'value' in part && part.value instanceof vscode.MarkdownString ? part.value.value : '').join('').trim();
    if (text) history.push({ role: 'assistant', content: text });
  }
  return history.slice(-20);
}

export function usageFooter(model: string, usage: UsageMetadata): string {
  const parts = [model];
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  const cost = usage.actualCostUsd ?? usage.estimatedCostUsd;
  if (cost !== undefined) parts.push(`${usage.actualCostUsd === undefined ? '~' : ''}$${cost.toFixed(4)}`);
  if (usage.verificationStatus === 'verified') parts.push('TEE verified');
  return `*${parts.join(' · ')}*`;
}
