// Approvals by named people (48.3-05; D-03, D-18, D-27, D-28). An approver signs in to Keycloak (client sterling-supply-review, passkey
// step-up) and the review command exchanges that token at OpenBao's jwt mount for role supply-approver, which admits only the subjects in the
// site's supply.approvers and only with the step-up acr. OpenBao's answer, never the command line, names the person; its audit log records the
// login. TLS is always verified (against the site CA when given).
import { openbaoClient } from '../../openbao/apply.mjs';

const TIMEOUT_MS = 10_000;

/**
 * Logs in at `<baoAddr>/v1/auth/jwt/login` with the approver's Keycloak token and `role`, then looks the new token up, and returns the
 * approval { subject, entity, at }: the subject from the token's metadata `sub` (the role's claim_mappings), the OpenBao entity id, and the
 * sign-in time from `auth_time`. Any refusal is "OpenBao did not confirm this approver: <status>".
 */
export async function approverFromLogin({ baoAddr, jwt, role, caPem }) {
  const login = openbaoClient({ addr: baoAddr, caPem, timeoutMs: TIMEOUT_MS });
  const answer = await login('POST', 'auth/jwt/login', { role, jwt });
  if (answer.status !== 200 || !answer.data?.auth?.client_token) throw new Error(`OpenBao did not confirm this approver: ${answer.status}`);
  const token = answer.data.auth.client_token;
  const lookup = openbaoClient({ addr: baoAddr, token, caPem, timeoutMs: TIMEOUT_MS });
  const self = await lookup('GET', 'auth/token/lookup-self');
  if (self.status !== 200) throw new Error(`OpenBao did not confirm this approver: ${self.status}`);
  const meta = self.data?.data?.meta ?? {};
  const subject = typeof meta.sub === 'string' ? meta.sub : '';
  if (subject === '') throw new Error("OpenBao did not return the approver's subject; the role supply-approver must map the claim sub.");
  const entity = self.data?.data?.entity_id;
  if (typeof entity !== 'string' || entity === '') throw new Error('OpenBao did not return the approver\'s entity.');
  const seconds = Number(meta.auth_time);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("OpenBao did not return the approver's sign-in time; the role supply-approver must map the claim auth_time.");
  return { subject, entity, at: new Date(seconds * 1000).toISOString() };
}

/**
 * Whether approvals meet the policy: { ok, missing, problems }. Only distinct subjects that your organization lists count.
 * Options: approversNeeded, approvers (the listed subjects).
 */
export function sufficient(approvals, { approversNeeded, approvers }) {
  const problems = [];
  const listed = new Set(approvers ?? []);
  const counted = new Set();
  for (const approval of approvals ?? []) {
    if (!listed.has(approval?.subject)) { problems.push(`${approval?.subject ?? 'An approval without a subject'} is not one of your organization's listed approvers.`); continue; }
    counted.add(approval.subject);
  }
  const missing = Math.max(0, (approversNeeded ?? 0) - counted.size);
  if (missing > 0) problems.push(`${missing} more approval${missing === 1 ? '' : 's'} from a different listed approver ${missing === 1 ? 'is' : 'are'} needed.`);
  return { ok: problems.length === 0, missing, problems };
}
