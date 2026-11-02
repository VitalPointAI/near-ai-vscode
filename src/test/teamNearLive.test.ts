// An opt-in test against the real NEAR AI Cloud (Phase 61 plan 14, success criterion 3), for an owner who has an organization to try it on.
// It is skipped unless NEAR_LIVE_TEAM=1 and the other variables are set, so a normal run, a CI run and every contributor's run never reach the
// network. When it runs it makes one key with a limit of 0, watches NEAR's own answer change as the limit moves (the answer can lag by up to about a
// minute), and revokes the key in a finally block whatever happened. The access token comes from the environment only and is never printed.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_BASE_URL } from '../domain/config';
import { NearOrgClient, checkApiKey } from '../team/nearOrg';
import type { CheckedKey, NearAuth } from '../team/nearOrg';

const REQUIRED = ['NEAR_LIVE_TEAM_ACCESS_TOKEN', 'NEAR_LIVE_TEAM_ORG_ID', 'NEAR_LIVE_TEAM_WORKSPACE_ID'] as const;
const POLL_WINDOW_MS = 70_000;
const POLL_EVERY_MS = 3_000;
const RAISED_LIMIT_NANO_USD = 1_000_000;

interface LiveEnvironment { accessToken: string; organizationId: string; workspaceId: string; inviteEmail?: string }

/** Why the live test cannot run with this environment, naming the variable and never its value; undefined when it can. */
function liveSkipReason(env: NodeJS.ProcessEnv): string | undefined {
  if (env['NEAR_LIVE_TEAM'] !== '1') return 'Live NEAR test skipped: set NEAR_LIVE_TEAM=1 to run it against a real organization.';
  const missing = REQUIRED.filter((name) => (env[name] ?? '') === '');
  return missing.length === 0 ? undefined : `Live NEAR test skipped: set ${missing.join(', ')}.`;
}

function liveEnvironment(env: NodeJS.ProcessEnv): LiveEnvironment {
  const inviteEmail = env['NEAR_LIVE_TEAM_INVITE_EMAIL'] ?? '';
  return {
    accessToken: env['NEAR_LIVE_TEAM_ACCESS_TOKEN'] as string, organizationId: env['NEAR_LIVE_TEAM_ORG_ID'] as string, workspaceId: env['NEAR_LIVE_TEAM_WORKSPACE_ID'] as string,
    ...(inviteEmail === '' ? {} : { inviteEmail })
  };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// Asks NEAR about the key until it answers `wanted` or the window ends. The message names the answers seen, never the key.
async function waitForStatus(secret: Buffer, wanted: CheckedKey['status']): Promise<void> {
  const seen: string[] = [];
  const startedAt = Date.now();
  for (;;) {
    const checked = await checkApiKey(DEFAULT_BASE_URL, secret);
    if (seen[seen.length - 1] !== checked.status) seen.push(checked.status);
    if (checked.status === wanted) return;
    if (Date.now() - startedAt > POLL_WINDOW_MS) assert.fail(`NEAR still did not answer "${wanted}" for the key after ${POLL_WINDOW_MS / 1000} seconds; it answered: ${seen.join(', ')}.`);
    await sleep(POLL_EVERY_MS);
  }
}

test('the skip reason names what is missing and never shows a value', () => {
  assert.match(liveSkipReason({}) ?? '', /NEAR_LIVE_TEAM=1/);
  const secret = `fa-${randomBytes(8).toString('hex')}`;
  const partial = liveSkipReason({ NEAR_LIVE_TEAM: '1', NEAR_LIVE_TEAM_ACCESS_TOKEN: secret });
  assert.match(partial ?? '', /NEAR_LIVE_TEAM_ORG_ID, NEAR_LIVE_TEAM_WORKSPACE_ID/);
  assert.equal((partial ?? '').includes(secret), false);
  assert.equal(liveSkipReason({ NEAR_LIVE_TEAM: '1', NEAR_LIVE_TEAM_ACCESS_TOKEN: secret, NEAR_LIVE_TEAM_ORG_ID: 'org', NEAR_LIVE_TEAM_WORKSPACE_ID: 'ws' }), undefined);
});

const skip = liveSkipReason(process.env);

test('live NEAR: a key made with limit 0 answers 402, answers 200 once the limit is raised, and stops answering once it is set to 0 and revoked', { skip, timeout: 6 * POLL_WINDOW_MS }, async () => {
  const env = liveEnvironment(process.env);
  const auth: NearAuth = { accessToken: async () => env.accessToken, refreshAfterUnauthorized: async () => undefined };
  const org = new NearOrgClient({ baseUrl: DEFAULT_BASE_URL, auth });

  const organizations = await org.listOrganizations();
  assert.ok(organizations.some((entry) => entry.id === env.organizationId), 'the signed-in account belongs to the organization');
  const workspaces = await org.listWorkspaces(env.organizationId);
  assert.ok(workspaces.some((entry) => entry.id === env.workspaceId), 'the workspace is in the organization');

  const created = await org.createKey(env.workspaceId, `near-ai-live-${randomBytes(4).toString('hex')}`, 0);
  const keyId = created.key.id;
  const secret = created.secret;
  try {
    assert.equal(created.key.spendLimitNanoUsd, 0, 'the limit was set in the create call');
    await waitForStatus(secret, 'capped');
    await org.setSpendLimit(env.workspaceId, keyId, RAISED_LIMIT_NANO_USD);
    await waitForStatus(secret, 'valid');
    await org.setSpendLimit(env.workspaceId, keyId, 0);
    await org.revokeKey(env.workspaceId, keyId);
    await waitForStatus(secret, 'invalid');
  } finally {
    // Whatever happened above, the key does not stay alive: zero first, then revoke, each tried even when the other failed.
    try { await org.setSpendLimit(env.workspaceId, keyId, 0); } catch { /* the revoke below is what matters */ }
    try { await org.revokeKey(env.workspaceId, keyId); } catch { /* an already revoked key is fine */ }
    secret.fill(0);
  }
});

test('live NEAR: an invitation to a disposable address at member role is listed as pending and can be cancelled', { skip: skip ?? (process.env['NEAR_LIVE_TEAM_INVITE_EMAIL'] ? undefined : 'Live NEAR invitation check skipped: set NEAR_LIVE_TEAM_INVITE_EMAIL to a disposable address.'), timeout: 120_000 }, async () => {
  const env = liveEnvironment(process.env);
  const email = env.inviteEmail as string;
  const auth: NearAuth = { accessToken: async () => env.accessToken, refreshAfterUnauthorized: async () => undefined };
  const org = new NearOrgClient({ baseUrl: DEFAULT_BASE_URL, auth });
  let invitationId: string | undefined;
  try {
    const outcome = await org.inviteByEmail(env.organizationId, email, 'member');
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason);
    const pending = await org.listInvitations(env.organizationId, 'pending');
    const found = pending.find((invitation) => invitation.email.toLowerCase() === email.toLowerCase());
    assert.ok(found !== undefined, 'the invitation is listed as pending');
    invitationId = found?.id;
  } finally {
    if (invitationId !== undefined) assert.equal(await org.cancelInvitation(env.organizationId, invitationId), 'cancelled');
  }
});
