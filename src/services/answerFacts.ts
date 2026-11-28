// The facts of a lead answer that never change after it arrived (CLAS-08, D-38): where its model runs, its endpoint, its signature id and its connection,
// read from the client that answered and the usage it returned. The trust badge is chosen from them with the check's result. No vscode import.
import type { TrustBadgeFacts } from '../domain/gate/trustBadge';
import type { ModelInfo, NearAiClient, UsageMetadata } from './nearAiClient';
import type { AgentTurnRequest } from './agentSession';

/** What a lead answer's badge is chosen from, apart from its check and the chat's other checks. */
export type AnswerFacts = Omit<TrustBadgeFacts, 'verification' | 'verificationSummary' | 'earlierCheckFailed'>;

/** Where a model runs, from the page's own privacy words when no catalog entry says (the words come from the same catalog). */
function boundaryFromPrivacy(privacy: string): { boundary: AnswerFacts['boundary']; forwardedTo?: string } {
  // 74.1-12: the Runs on words (modelPrivacyLabel), and the words of answers kept from before them.
  if (privacy.startsWith('Private') || privacy.startsWith('Runs on NEAR AI private hardware')) return { boundary: 'tee' };
  if (privacy.startsWith('Local') || privacy === 'Runs on this computer') return { boundary: 'local' };
  const forwarded = /^(?:Not private · forwarded(?: to (.+))?|Runs on (?:an outside provider|outside provider \((.+)\)))$/.exec(privacy);
  if (forwarded) return { boundary: 'cloud', ...((forwarded[1] ?? forwarded[2]) ? { forwardedTo: (forwarded[1] ?? forwarded[2]) as string } : {}) };
  return { boundary: undefined };
}

/** The facts of a lead answer that never change after it arrived: where its model runs, its endpoint, its signature id and its connection (CLAS-08). */
export function answerFactsOf(request: Pick<AgentTurnRequest, 'client' | 'model' | 'privacy' | 'local' | 'modelCatalog'>, usage: UsageMetadata | undefined): AnswerFacts {
  const client = request.client as Partial<Pick<NearAiClient, 'nearEndpoint' | 'catalogEntry'>>;
  let entry: ModelInfo | undefined;
  try { entry = typeof client.catalogEntry === 'function' ? client.catalogEntry(request.model) : undefined; } catch { entry = undefined; }
  const listed = request.modelCatalog?.find((candidate) => candidate.id === request.model);
  const known = entry?.privacyBoundary ?? listed?.privacyBoundary;
  const named: { boundary: AnswerFacts['boundary']; forwardedTo?: string } = known === 'tee' || known === 'cloud' || known === 'local' ? { boundary: known, ...(entry?.forwardedTo ? { forwardedTo: entry.forwardedTo } : {}) } : boundaryFromPrivacy(request.privacy);
  let nearEndpoint = false;
  try { nearEndpoint = client.nearEndpoint === true; } catch { nearEndpoint = false; }
  return {
    route: request.local ? 'local' : 'near',
    nearEndpoint,
    boundary: named.boundary,
    ...(named.forwardedTo ? { forwardedTo: named.forwardedTo } : {}),
    hasEvidence: usage?.evidence !== undefined,
    ...(usage?.connection === undefined ? {} : { connection: usage.connection }),
    connectionFresh: usage?.connectionPinned === true,
    // D-38: the TrustFacts of the request that answered, read by the badge's trust line.
    ...(usage?.trust === undefined ? {} : { trust: usage.trust })
  };
}
