// Key status for signed payloads (D-09, D-21). Pure: no I/O, no vscode.
// A status lookup answers one question for one key: is it active, rotated, revoked or unknown. verifyPayload asks the lookup its caller passes, so the
// caller decides which sources apply. The team roster is the first source (teamKeyStatus). The person's own key history is the second (plan 11).
// Callers choose the sources. A solo check never combines a team's roster: a person removed from team A is revoked in A's roster and still active in
// their own history, so mixing A's answer into a solo check would refuse keys that are fine on their own.
import type { TeamState } from './types';

export type KeyState = 'active' | 'rotated' | 'revoked' | 'unknown';

// since is an ISO time. For a rotated key it is the time the rotation event was written. replacedBy is the fingerprint that took over.
export interface KeyStatus { state: KeyState; since?: string; replacedBy?: string; reason?: string }

export type KeyStatusLookup = (key: { fingerprint: string; publicKey: string }) => KeyStatus;

// The source that knows nothing: every key is unknown, so a payload is refused rather than trusted.
export const NO_KNOWN_KEYS: KeyStatusLookup = () => ({ state: 'unknown' });

export const REMOVED_FROM_TEAM = 'removed from the team';
export const REVOKED_BY_TEAM = 'revoked in the team';

// The roster as a status source. The fingerprint finds the member through deviceIndex, and the stored public key must be the one presented.
export function teamKeyStatus(state: Pick<TeamState, 'members' | 'deviceIndex'>): KeyStatusLookup {
  return (key) => {
    const memberId = state.deviceIndex.get(key.fingerprint);
    if (memberId === undefined) return { state: 'unknown' };
    const member = state.members.get(memberId);
    const device = member?.devices.find((candidate) => candidate.fingerprint === key.fingerprint);
    if (member === undefined || device === undefined || device.publicKey !== key.publicKey) return { state: 'unknown' };
    if (member.removedEvent !== undefined) {
      return member.removedAt === undefined ? { state: 'revoked', reason: REMOVED_FROM_TEAM } : { state: 'revoked', since: member.removedAt, reason: REMOVED_FROM_TEAM };
    }
    if (device.revokedEvent !== undefined) return { state: 'revoked', reason: REVOKED_BY_TEAM };
    if (device.rotatedEvent !== undefined) {
      const status: KeyStatus = { state: 'rotated' };
      if (device.rotatedAt !== undefined) status.since = device.rotatedAt;
      if (device.rotatedTo !== undefined) status.replacedBy = device.rotatedTo;
      return status;
    }
    return { state: 'active' };
  };
}

// Higher is worse. A key one source calls unknown and another calls active is active: unknown means "not seen here", not "refused".
const SEVERITY: Readonly<Record<KeyState, number>> = { unknown: 0, active: 1, rotated: 2, revoked: 3 };

function sinceMillis(status: KeyStatus): number {
  return status.since === undefined ? Number.NaN : Date.parse(status.since);
}

// The worst answer wins: revoked, then rotated, then active, then unknown. For two rotated answers the earlier since wins, because the earlier
// rotation is the stricter one. An answer whose time cannot be read never beats one whose time can.
export function combineKeyStatus(...lookups: KeyStatusLookup[]): KeyStatusLookup {
  return (key) => {
    let worst: KeyStatus = { state: 'unknown' };
    for (const lookup of lookups) {
      const answer = lookup(key);
      const rank = SEVERITY[answer.state] - SEVERITY[worst.state];
      if (rank > 0) {
        worst = answer;
      } else if (rank === 0 && answer.state === 'rotated') {
        const earlier = sinceMillis(answer);
        const current = sinceMillis(worst);
        if (!Number.isNaN(earlier) && (Number.isNaN(current) || earlier < current)) worst = answer;
      }
    }
    return worst;
  };
}
