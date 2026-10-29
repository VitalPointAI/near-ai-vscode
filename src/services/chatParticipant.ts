import * as path from 'node:path';
import * as vscode from 'vscode';
import { hostAttribution } from '../domain/activity';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { ActivityStore } from './activityStore';
import { AuthService } from './auth';
import { ConversationTurn, defaultChatModel, modelPrivacyLabel, providerErrorMessage } from './chatBridge';
import { OutboundGuard } from './outboundGuard';
import { spendAccountOf } from './agentSession';
import { nanoToUsd, withSpendTag } from './spendLedger';
import { activeProvider, clientFor } from './providerCache';
import { isEmergencyStopped } from './emergencyStop';
import { UsageMetadata } from './nearAiClient';
import { readSettings } from './settings';

export const PARTICIPANT_ID = 'nearAi';

interface ParticipantResult extends vscode.ChatResult {
  metadata: { command?: string };
}

/**
 * `@nearAi` in VS Code's built-in Chat view. Plain prompts stream from NEAR AI Cloud;
 * slash commands run the matching Open-GSD workflow in the open workspace.
 */
export function registerChatParticipant(context: vscode.ExtensionContext, auth: AuthService, runInSidebar: (command: string, args: string) => Promise<void>): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') return;
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, response, token): Promise<ParticipantResult> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (request.command && GSD_COMMANDS.some((definition) => definition.command === request.command)) {
      // Workflows need approvals, questions, and diffs, which the NEAR AI view provides.
      if (isEmergencyStopped()) { response.markdown('Emergency stop is on. Run **NEAR AI: Resume** first.'); return { metadata: { command: request.command } }; }
      if (!root) { response.markdown('Open a folder first. Open-GSD workflows run inside a workspace.'); return { metadata: { command: request.command } }; }
      await runInSidebar(`gsd-${request.command}`, request.prompt.trim());
      response.markdown(`Started \`/gsd-${request.command}${request.prompt.trim() ? ` ${request.prompt.trim()}` : ''}\` in the **NEAR AI** view, where you can approve changes and answer its questions.`);
      response.button({ command: 'nearAi.openChat', title: 'Show NEAR AI' });
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
  context.subscriptions.push(participant);
}

async function answerWithNearAi(auth: AuthService, root: string | undefined, prompt: string, history: ConversationTurn[], response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
  if (!root) {
    response.markdown('Open a folder first. NEAR AI keys and profiles are scoped to a project.');
    return;
  }
  let active;
  try {
    active = await activeProvider(root, auth);
  } catch (error) {
    response.markdown(providerErrorMessage(error));
    response.button({ command: 'nearAi.selectProfile', title: 'Review profile' });
    return;
  }
  if (!active) {
    response.markdown('This project has no validated NEAR AI profile yet. Set one up to start chatting.');
    response.button({ command: 'nearAi.setup', title: 'Set up NEAR AI' });
    return;
  }
  const settings = readSettings();
  const model = defaultChatModel(active.models, settings.defaultModel);
  if (!model) {
    response.markdown('NEAR AI returned no chat models for this key.');
    return;
  }
  const modelInfo = active.models.find((candidate) => candidate.id === model);
  const activity = new ActivityStore(root);
  const account = spendAccountOf(active.provider.client);
  await account?.ledger.refresh();
  const verdict = new OutboundGuard(settings).check({ model, modelInfo, text: prompt }, account?.spentTodayUsd().usd ?? 0);
  if (verdict.outcome !== 'allow') {
    response.markdown(`${verdict.reason}\n\nNothing was sent.${verdict.overrideToken ? ' To send it anyway, use the NEAR AI sidebar, which can send a flagged message once.' : ''}`);
    return;
  }
  const session = await activity.start({ project: path.basename(root), attribution: hostAttribution(active.profiles.projectScopeId, path.basename(root), active.profile.profileId, active.profile.organization), model, summary: 'Chat view session started.' });
  const abort = new AbortController();
  const cancel = token.onCancellationRequested(() => abort.abort());
  response.progress(`Asking ${model}…`);
  try {
    const route = clientFor(active, model);
    // Recorded in the key's spend ledger as a chat view request.
    await withSpendTag({ kind: 'participant', conversationId: session.sessionId }, async () => {
      for await (const event of route.client.streamChatEvents(model, [...history, { role: 'user', content: prompt }], abort.signal)) {
        if (event.type === 'text') response.markdown(event.text);
        else if (event.type === 'done') {
          let actualCostUsd: number | undefined;
          let pending = false;
          const requestId = event.metadata.requestId;
          if (requestId && !route.local && account) {
            // The ledger asks NEAR's billing API; NEAR may need a few seconds to record the usage.
            for (const delay of [0, 1_500]) {
              if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
              await account.settleNow((entry) => entry.requestId === requestId);
              const totals = account.totals({ requestId });
              if (totals.requests && !totals.pendingRequests) { actualCostUsd = nanoToUsd(totals.confirmedNanoUsd); break; }
            }
            pending = actualCostUsd === undefined;
          } else if (requestId && !route.local) {
            try { actualCostUsd = (await route.client.reconcileUsage(requestId, abort.signal)).actualCostUsd; } catch { actualCostUsd = undefined; }
          }
          response.markdown(`\n\n${usageFooter(model, { ...event.metadata, actualCostUsd }, modelPrivacyLabel(modelInfo), pending)}`);
          await activity.append(session.sessionId, { status: 'completed', kind: 'message', model, requestId, summary: 'Assistant response completed.', estimatedCostUsd: event.metadata.estimatedCostUsd, actualCostUsd, inputTokens: event.metadata.inputTokens, outputTokens: event.metadata.outputTokens, durationMs: event.metadata.latencyMs });
        } else if (event.type === 'status' && event.status === 'cancelled') {
          await activity.append(session.sessionId, { status: 'cancelled', summary: 'Chat request cancelled by the user.' });
        }
      }
    });
  } catch (error) {
    if (!abort.signal.aborted) {
      await activity.append(session.sessionId, { status: 'failed', summary: 'Chat request failed.', errorCode: error instanceof Error ? error.name : 'unknown' });
      response.markdown(providerErrorMessage(error));
    }
  } finally {
    cancel.dispose();
  }
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

/** The reply footer: `$X` once NEAR confirmed the cost, `~$X pending` while the ledger waits for NEAR, `~$X est.` otherwise. */
export function usageFooter(model: string, usage: UsageMetadata, privacy?: string, pending = false): string {
  const parts = [model];
  if (privacy) parts.push(privacy);
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
  if (usage.actualCostUsd !== undefined) parts.push(`$${usage.actualCostUsd.toFixed(4)}`);
  else if (usage.estimatedCostUsd !== undefined) parts.push(`~$${usage.estimatedCostUsd.toFixed(4)} ${pending ? 'pending' : 'est.'}`);
  return `*${parts.join(' · ')}*`;
}
