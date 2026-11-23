import { isLoopbackEndpointHost, parseEndpoints, type EndpointRegion, type PolicyEndpoint } from '../../domain/gate/endpoints';
import { parseHostPattern } from '../../domain/gate/vocabulary';
import { SERVER_KINDS, type ServerCandidate, type ServerIdentity } from '../../domain/setup/servers';
import { normaliseFingerprint } from '../connectionBinding';
import type { PolicyChange } from '../policyEditor';
import { NO_TLS_TEXT } from './certPin';
import { probeOrigin } from './probe';

export { NO_TLS_TEXT };
export const APPROVAL_FROM_TEXT = 'Get Started';
export const APPROVAL_ASK_TEXT = 'Ask {contact} to approve it.';
export const FOUND_NOT_APPROVED_TEXT = 'Found on your network, not approved';
const APPROVAL_REASON_TEXT = 'Found on your network:';
const INVALID_SERVER_TEXT = 'The proposal needs one exact network server address and port.';
const INVALID_PIN_TEXT = 'The proposal needs the certificate pin observed for this server.';
const WRONG_LAYER_TEXT = 'The proposal is for a different set of rules.';
const INVALID_PROPOSAL_TEXT = 'These rules cannot include the proposed server. Check the existing servers and the proposed label.';

export interface ApprovalInput {
  readonly candidate: ServerCandidate;
  readonly identity: ServerIdentity;
  readonly pin: string;
  readonly region: EndpointRegion;
  readonly maxLabel: readonly string[];
  readonly organization: boolean;
  readonly personalApprovals: boolean;
}

/** The policy id has room for the port even if the host has to be shortened. */
export function foundEndpointId(host: string, port: number): string {
  const suffix = `-${port}`;
  const prefix = `found-${host.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  return `${prefix.slice(0, 64 - suffix.length)}${suffix}`;
}

/** Prepare a pinned proposal. The policy editor retains responsibility for applying or exporting it. */
export function endpointProposalFor(input: ApprovalInput): PolicyChange {
  const { candidate, identity, pin, region, organization, personalApprovals } = input;
  const { target } = candidate;
  const { host, port } = target;
  if (target.scheme !== 'https') throw new Error(NO_TLS_TEXT);
  if (!parseHostPattern(host, 'host', 'request').ok || probeOrigin(target)?.hostname !== host || isLoopbackEndpointHost(host) ||
      target.source !== candidate.foundBy || !SERVER_KINDS.includes(identity.kind)) {
    throw new Error(INVALID_SERVER_TEXT);
  }
  if (typeof pin !== 'string' || normaliseFingerprint(pin) !== pin || (target.tlsPin !== undefined && target.tlsPin !== pin)) {
    throw new Error(INVALID_PIN_TEXT);
  }

  const layer = organization && !personalApprovals ? 'organization' : 'personal';
  const maxLabel = organization && layer === 'personal' ? ['org/Public'] : [...input.maxLabel];
  const entry: PolicyEndpoint = {
    id: foundEndpointId(host, port), class: 'org-plain', host, scheme: 'https',
    tlsPins: [pin], region, maxLabel, provider: identity.kind
  };
  const version = identity.version?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return {
    from: APPROVAL_FROM_TEXT,
    reason: `${APPROVAL_REASON_TEXT} ${identity.kind}${version ? ` ${version}` : ''}`,
    target: layer,
    ...(!organization ? { requiresPersonalAuthority: true } : {}),
    next(current) {
      if (current.layer !== layer) throw new Error(WRONG_LAYER_TEXT);
      const entries = [...(current.endpoints ?? []), entry].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const endpoints = parseEndpoints(entries, current.labels.scales);
      if (!endpoints.ok) throw new Error(INVALID_PROPOSAL_TEXT);
      const requires = current.requires.includes('endpoints@1') ? current.requires : [...current.requires, 'endpoints@1' as const].sort();
      return { ...current, endpoints: endpoints.value, requires };
    }
  };
}
