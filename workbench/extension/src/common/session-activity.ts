/**
 * Idle stop under Theia Cloud (Phase 46 verification W2; Phase 47 DESIGN section 7: active, idle-warned, stopping). Theia Cloud's
 * operator asks each session, once a minute, when its person last used it, and stops the session after the AppDefinition's timeoutAfter
 * minutes of no use; at notifyAfter minutes it asks the session to warn the person. The browser reports use through this service; the
 * backend answers the operator (node/session-activity.ts). Nothing here imports Theia.
 *
 *   off          not started by Theia Cloud with its activity tracker: nothing is reported and nothing is asked
 *   active       the person used the page since the last warning
 *   idle-warned  Theia Cloud asked for the warning and the person has not used the page since
 */

export const SESSION_ACTIVITY_PATH = '/services/sterling-session-activity';
export const SessionActivityService = Symbol('SessionActivityService');

export type SessionActivityState = 'off' | 'active' | 'idle-warned';

export interface SessionActivityService {
  /** The person used the page (a key, a pointer, a scroll or a touch). Returns the state after it. */
  report(): Promise<SessionActivityState>;
  state(): Promise<SessionActivityState>;
}

export const SESSION_ACTIVITY_TEXT = Object.freeze({
  idleWarning: 'This session has not been used for a while and stops soon. Save your work, or select Keep working.',
  keepWorking: 'Keep working',
});
