#!/usr/bin/env node
// Guest accounts for people from outside your organization who observe shared work (DEP-13, D-58 to D-63). A guest is a member of the
// Keycloak group guests, which carries no role. Keycloak keeps only the account's life cycle (guestUntil, guestRequestedBy, guestApprovedBy,
// guestApprovalRef, guestEndedAt, guestEndedReason) and decides nothing: how the guest serves, their nationality, organization, access
// agreement and visit clearance are credentials the security contact issues to the guest's DID in their own session (Phase 71).
//
//   create  --user <name> --email <address> --first <name> --last <name> --until <UTC time> --requested-by <lead>
//           --approved-by <security contact> --approver-credential <file> --trust <folder> --approval-ref <reference> [--no-link]
//           Creates the account at a lead's request with a security contact's approval. The approver's SecurityContactCredential is
//           checked with deploy/tools/credential-check.mjs against the site's trust folder (your organization's signed rules, DID logs and
//           status lists) for the approver's DID from the site's people directory. Every refusal comes before any Keycloak write. Then
//           Keycloak mails the passwordless registration link (24 hours), unless --no-link.
//   link    --user <name>                       sends the registration link again (not to an ended guest, one past its end, or one with two keys)
//   extend  --user <name> --until <UTC time> --requested-by --approved-by --approver-credential --trust --approval-ref
//           The same rules and approval as create; moves the end and shows the latest approval. An ended guest is enabled again, with its
//           OpenBao entity if it has one. Refused for a guest holding a role, another group or an OpenBao policy.
//   end     --user <name> --reason <text> [--no-sessions]
//           Ends the guest now: Keycloak account disabled and its sessions ended, the end recorded, the OpenBao entity guest-<id> disabled
//           (every token it holds stops at once) and the guest's Theia sessions stopped. An early end also files one revocation request in
//           the site's revocation inbox, so the officers who issued the guest credentials revoke them in their own session. Every end of an
//           enrolled guest also files an end record whose removeAfter (the end plus guests.retentionDays) is when a security officer may
//           remove the guest's secrets in the workbench (D-84). Nothing is deleted here.
//   list    one line per guest: username, end, status (pending-keys, active, overdue, ended), lead and approver
//   expire  [--no-sessions] ends every guest past their end date, and fails closed on any guest holding a realm-management role, another
//           group or an OpenBao policy or group (the automatic end runs the same function in the cluster, 47-20)
//
//   connection flags: --keycloak <https://keycloak.<domain>> --keycloak-token-file <file> [--realm sterling] --bao <https://openbao:8200>
//                     --ca-file <site CA pem> --bao-token-file <file> (a token with policy guest-operator) --realm-site <realm site file>
//
// The realm site file's guests.maxDays limits every end date; 0 or absent turns guests off. Until a release includes the credential issuing
// and revocation card (71-12, whose OpenBao policy credential-issuers apply.mjs then writes), create and extend refuse any nonzero maxDays
// (G449). Tokens come from files, never arguments.
// Node built-ins only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUEST_ACCOUNT_POLICY, openbaoClient, POLICIES } from '../openbao/apply.mjs';
import { countPasswordlessKeys } from '../openbao/enrol.mjs';
import { keycloakAdmin } from './users.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GUESTS_GROUP = '/guests';
export const GUEST_ATTRIBUTES = Object.freeze(['guestUntil', 'guestRequestedBy', 'guestApprovedBy', 'guestApprovalRef', 'guestEndedAt', 'guestEndedReason']);
/** What Keycloak never holds about a guest: these are credentials now (Phase 71). */
export const CREDENTIAL_FIELDS = Object.freeze(['serves', 'nationality', 'organization']);
export const REGISTER_ACTION = 'webauthn-register-passwordless';
export const LINK_LIFESPAN_SECONDS = 86400;
export const APPROVER_CREDENTIAL = 'SecurityContactCredential';
export const CREDENTIAL_CHECK = path.join(HERE, '../tools/credential-check.mjs');
/** The one revocation inbox (71 D-22): kv/data/site/revocation-requests/<entity>-<reason>, written once with cas 0. */
export const REVOCATION_FORMAT = 'sterling-revocation-request/1';
export const REVOCATION_INBOX = 'kv/data/site/revocation-requests';
export const EARLY_END_REASON = 'guest-ended';
/** The end record that starts a guest's retention period (D-84): kv/data/site/guest-ended/guest-<id>-<end time>, written once with cas 0. */
export const END_FORMAT = 'sterling-guest-ended/1';
export const END_RECORDS = 'kv/data/site/guest-ended';
/** A UTC instant as Keycloak stores guestUntil. */
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

export class GuestRefusal extends Error {}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** A time with a zone (Z or an offset) as a UTC instant, or null. */
export function utcInstant(value) {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : iso(ms);
}
export const attribute = (user, name) => user?.attributes?.[name]?.[0];

/**
 * Whether officers can issue and revoke a guest's credentials on this release (71-12's card): it ships the OpenBao policy credential-issuers,
 * which apply.mjs then lists, and the card is reachable in a hosted session. Without both a guest would hold no credentials and an early end's
 * revocation request would reach no officer (G449).
 *
 * 71-12 is in this release, but its card is not reachable in a hosted session until 71-13 gives the session your organization's rules (G465),
 * so guests stay off. Set this to true only in the change that closes G465.
 */
export const CREDENTIAL_CARD_REACHABLE = false;
export const credentialIssuingShipped = () => POLICIES.includes('credential-issuers') && CREDENTIAL_CARD_REACHABLE;

/**
 * The guests settings of the realm site file: { maxDays, checkMinutes, sessionsNamespace, retentionDays, issuing }. Guests are off when
 * maxDays is 0 or absent. issuing comes from this release, never from the file: whether the 71-12 card is here (credentialIssuingShipped).
 */
export function guestSettings(realmSite, issuing = credentialIssuingShipped()) {
  const guests = realmSite?.guests ?? {};
  return { maxDays: Number(guests.maxDays ?? 0) || 0, checkMinutes: Number(guests.checkMinutes ?? 15), sessionsNamespace: guests.sessionsNamespace || 'theia-cloud',
    retentionDays: Number(guests.retentionDays ?? 0) || 0, issuing: issuing === true };
}

/**
 * The rules a guest request must keep before anything is read or written (D-61, D-63). `request` holds user, until, requestedBy, approvedBy,
 * approverCredential, trust and approvalRef (and must not hold serves, nationality or organization). Returns { problems, until } with until
 * the end as a UTC instant.
 */
export function checkGuestRequest(request, settings, now = Date.now()) {
  const problems = [];
  const maxDays = Number(settings?.maxDays ?? 0);
  if (!(maxDays > 0)) problems.push('Guests are off at this site. Set guests.maxDays in the realm site file.');
  else if (settings?.issuing !== true) {
    problems.push(`Guests stay off on this release: the realm site file sets guests.maxDays to ${maxDays}, but this release does not include the credential issuing and revocation card (71-12), so a guest would hold no credentials and ending one early could not revoke them. Set guests.maxDays to 0 until your organization runs a release that includes it.`);
  }
  if (!(Number(settings?.retentionDays ?? 0) > 0)) problems.push('Set guests.retentionDays in the realm site file: how long an ended guest\'s records are kept before a security officer removes their secrets (D-84).');
  for (const field of CREDENTIAL_FIELDS) {
    if (request[field] !== undefined) problems.push(`--${field} is not kept in Keycloak any more: how a guest serves, their nationality and organization are credentials the security contact issues to the guest in their own session (Phase 71). Leave it out.`);
  }
  let until = null;
  if (request.until === undefined || request.until === '') problems.push('The end date is missing. Give --until as a UTC time, for example 2026-12-31T17:00:00Z.');
  else {
    until = utcInstant(request.until);
    if (!until) problems.push(`The end date ${JSON.stringify(request.until)} has no time zone. Give it as a UTC time ending in Z (for example 2026-12-31T17:00:00Z) or with an offset.`);
    else if (Date.parse(until) <= now) problems.push(`The end date ${until} is in the past. Give an end date in the future.`);
    else if (maxDays > 0 && Date.parse(until) > now + maxDays * DAY_MS) problems.push(`The end date is more than ${maxDays} days away. This site allows guests for at most ${maxDays} days (guests.maxDays).`);
  }
  if (!request.requestedBy) problems.push('A guest is created only at a lead\'s request. Name the lead with --requested-by.');
  if (!request.approvedBy) problems.push('Every guest needs a security contact\'s approval. Name them with --approved-by.');
  if (!request.approverCredential) problems.push('Give the security contact\'s SecurityContactCredential file with --approver-credential.');
  if (!request.trust) problems.push('Give the site\'s trust folder (your organization\'s signed rules, DID logs and status lists) with --trust.');
  if (!request.approvalRef) problems.push('Give the reference of the security contact\'s written approval with --approval-ref.');
  if (request.approvedBy && (request.approvedBy === request.requestedBy)) problems.push('The approver must be someone other than the lead who asked.');
  if (request.approvedBy && request.user && request.approvedBy === request.user) problems.push('A guest cannot approve their own account.');
  return { problems, until };
}

const answer = (result, what) => {
  if (result.status >= 300) throw new Error(`${what}: Keycloak answered ${result.status} ${JSON.stringify(result.data?.errorMessage ?? result.data?.error ?? result.data ?? '')}`);
  return result.data;
};
const ok = (result, what) => {
  if (result.status >= 300) throw new Error(`${what}: OpenBao answered ${result.status} ${JSON.stringify(result.data?.errors ?? result.data)}`);
  return result.data?.data ?? null;
};
const enc = encodeURIComponent;

/** The account with this username (full representation, attributes included), or undefined. */
export async function findUser(keycloak, username) {
  const found = answer(await keycloak('GET', `users?username=${enc(username)}&exact=true&briefRepresentation=false`), `look up ${username}`) ?? [];
  return found.find((user) => user.username === String(username).toLowerCase() || user.username === username);
}
const groupsOf = async (keycloak, id) => answer(await keycloak('GET', `users/${enc(id)}/groups`), 'read groups') ?? [];
const isGuestGroups = (groups) => groups.some((group) => group.path === GUESTS_GROUP);

/**
 * The approver's authority (D-61): the lead exists, is enabled and is not a guest; the approver exists, is enabled and is not a guest, has a
 * DID in the site's people directory, and holds a SecurityContactCredential that the verifier tool accepts now. Only reads; throws GuestRefusal.
 */
export async function checkApproval({ request, keycloak, bao, checkCredential, now }) {
  const lead = await findUser(keycloak, request.requestedBy);
  if (!lead?.id) throw new GuestRefusal(`The lead ${request.requestedBy} has no account at this site.`);
  if (lead.enabled === false) throw new GuestRefusal(`The lead ${request.requestedBy}'s account is disabled.`);
  if (isGuestGroups(await groupsOf(keycloak, lead.id))) throw new GuestRefusal(`${request.requestedBy} is a guest; only a member of your organization may ask for a guest.`);
  const approver = await findUser(keycloak, request.approvedBy);
  if (!approver?.id) throw new GuestRefusal(`The approver ${request.approvedBy} has no account at this site.`);
  if (approver.enabled === false) throw new GuestRefusal(`The approver ${request.approvedBy}'s account is disabled.`);
  if (isGuestGroups(await groupsOf(keycloak, approver.id))) throw new GuestRefusal(`${request.approvedBy} is a guest and cannot approve guests.`);
  const entity = await bao('GET', `identity/entity/name/keycloak-${approver.id}`);
  if (entity.status === 404) throw new GuestRefusal(`${request.approvedBy} is not enrolled in OpenBao, so their DID cannot be found. They enrol and sign in once first.`);
  const entityId = ok(entity, `read ${request.approvedBy}'s OpenBao entity`)?.id;
  const entry = await bao('GET', `kv/data/site/people/${entityId}`);
  const did = entry.status === 404 ? undefined : ok(entry, `read ${request.approvedBy}'s people directory entry`)?.data?.did;
  if (!did) throw new GuestRefusal(`${request.approvedBy} has no DID in the site's people directory yet. They sign in once on a release with Phase 71 first.`);
  const result = await checkCredential({ holder: did, type: APPROVER_CREDENTIAL, credential: request.approverCredential, trust: request.trust, at: iso(now), holderName: request.approvedBy });
  if (!result.ok) throw new GuestRefusal(`${request.approvedBy}'s SecurityContactCredential does not hold: ${result.message}`);
  return { lead, approver };
}

/** The verifier tool (Phase 71 plan 08): { ok, message }. */
export function credentialCheck({ holder, type, credential, trust, at, holderName }) {
  const run = spawnSync(process.execPath, [CREDENTIAL_CHECK, '--holder', holder, '--type', type, '--credential', credential, '--trust', trust, '--at', at,
    ...(holderName ? ['--holder-name', holderName] : [])], { encoding: 'utf8' });
  return { ok: run.status === 0, message: (run.status === 0 ? run.stdout : run.stderr || run.stdout || 'the check could not run').trim() };
}

const NEXT_LINK = (username) => `guests.mjs link --user ${username}`;

/**
 * Sends the registration link through Keycloak's execute-actions email, after checking the realm has a mail server. Returns { sent, message };
 * never throws for a refused send, so the account that exists is always reported.
 */
export async function sendLink({ keycloak, user }) {
  const realm = await keycloak('GET', '');
  const host = realm.status < 300 ? String(realm.data?.smtpServer?.host ?? '').trim() : '';
  if (!host || host === 'not-set') {
    return { sent: false, message: `No registration link was sent for ${user.username}: this realm has no mail server. Set smtp (host, port, from) in the realm site file, apply the realm again with deploy/keycloak/apply.mjs, then send it with ${NEXT_LINK(user.username)}. The account is kept.` };
  }
  const sent = await keycloak('PUT', `users/${enc(user.id)}/execute-actions-email?lifespan=${LINK_LIFESPAN_SECONDS}`, [REGISTER_ACTION]);
  if (sent.status < 300) return { sent: true, message: `Keycloak sent the registration link to ${user.email}; it works for 24 hours.` };
  return { sent: false, message: `Keycloak did not send the registration link for ${user.username}: it answered ${sent.status} ${JSON.stringify(sent.data?.errorMessage ?? sent.data ?? '')}. `
    + `Check the realm's mail settings (smtp in the realm site file) and the site mail server, then send it again with ${NEXT_LINK(user.username)}. The account is kept; nothing was removed.` };
}

/**
 * Creates a guest (see the top of this file). Returns { user, link: { sent, message } }; with noLink, link is null. Throws GuestRefusal,
 * before any Keycloak write, when a rule fails.
 */
export async function createGuest({ request, settings, keycloak, bao, checkCredential = credentialCheck, now = Date.now(), noLink = false }) {
  const { problems, until } = checkGuestRequest(request, settings, now);
  if (!request.user) problems.push('Name the guest\'s username with --user.');
  if (!request.email) problems.push('Give the guest\'s address with --email (a site-issued guest address read at the enrolment desk, by default).');
  if (problems.length) throw new GuestRefusal(problems.join('\n'));
  if (await findUser(keycloak, request.user)) throw new GuestRefusal(`An account named ${request.user} exists already.`);
  const sameEmail = answer(await keycloak('GET', `users?email=${enc(request.email)}&exact=true`), 'look up the email') ?? [];
  if (sameEmail.length) throw new GuestRefusal(`An account with the email ${request.email} exists already.`);
  await checkApproval({ request, keycloak, bao, checkCredential, now });
  answer(await keycloak('POST', 'users', {
    username: request.user, email: request.email, firstName: request.first, lastName: request.last, enabled: true, emailVerified: false,
    groups: [GUESTS_GROUP], requiredActions: [REGISTER_ACTION],
    attributes: { guestUntil: [until], guestRequestedBy: [request.requestedBy], guestApprovedBy: [request.approvedBy], guestApprovalRef: [request.approvalRef] }
  }), `create ${request.user}`);
  const user = await findUser(keycloak, request.user);
  if (!user?.id) throw new Error(`Keycloak created ${request.user} but does not find it; check the account in the admin console.`);
  return { user, link: noLink ? null : await sendLink({ keycloak, user }) };
}

/** Sends the registration link again. Refuses a non-guest, an ended guest, one past its end and one with two passwordless keys. */
export async function linkGuest({ username, keycloak, now = Date.now() }) {
  const user = await findUser(keycloak, username);
  if (!user?.id) throw new GuestRefusal(`There is no account named ${username}.`);
  if (!isGuestGroups(await groupsOf(keycloak, user.id))) throw new GuestRefusal(`${username} is not a guest; staff enrolment follows deploy/runbooks/enrolment.md.`);
  if (user.enabled === false || attribute(user, 'guestEndedAt')) throw new GuestRefusal(`${username}'s guest account has ended. Extend it first with guests.mjs extend.`);
  const until = attribute(user, 'guestUntil');
  if (!until || !(Date.parse(until) > now)) throw new GuestRefusal(`${username}'s end date (${until ?? 'none'}) has passed. Extend it first with guests.mjs extend.`);
  const keys = countPasswordlessKeys(answer(await keycloak('GET', `users/${enc(user.id)}/credentials`), 'read credentials'));
  if (keys >= 2) throw new GuestRefusal(`${username} has registered ${keys} keys already; no link is needed. Enrol them with deploy/openbao/enrol.mjs enrol.`);
  return { user, link: await sendLink({ keycloak, user }) };
}

/**
 * Files one sterling-revocation-request/1 in the site's revocation inbox (71 D-22), written once with cas 0: { format, entity, keycloakId,
 * reason, seenAt, job } and nothing else. Returns 'filed' or 'already filed'. A writer that may only create gets 403 for a request that exists
 * (OpenBao counts the second write as an update); that is told apart from a token that may not file at all by the token's own capabilities.
 */
export async function fileRevocationRequest({ bao, entity, keycloakId, reason, seenAt, job }) {
  return fileOnce(bao, `${REVOCATION_INBOX}/${entity}-${reason}`, { format: REVOCATION_FORMAT, entity, keycloakId, reason, seenAt, job });
}

/**
 * Files one sterling-guest-ended/1 (D-84): { format, entity, keycloakId, endedAt, removeAfter }, removeAfter being the end plus the site's
 * guests.retentionDays. Keyed by the end time, so ending the same end again files nothing new, and a guest extended and ended later gets a new
 * record (the newest counts). Returns 'filed' or 'already filed'.
 */
export async function fileEndRecord({ bao, entity, keycloakId, endedAt, retentionDays }) {
  const removeAfter = iso(Date.parse(endedAt) + Number(retentionDays) * DAY_MS);
  return fileOnce(bao, `${END_RECORDS}/${entity}-${endedAt.replace(/[-:]/g, '')}`, { format: END_FORMAT, entity, keycloakId, endedAt, removeAfter });
}

/** Writes a KV v2 record once (cas 0) and tells a record that exists from a token that may not write (see fileRevocationRequest). */
async function fileOnce(bao, where, data) {
  const result = await bao('POST', where, { options: { cas: 0 }, data });
  if (result.status < 300) return 'filed';
  const errors = JSON.stringify(result.data?.errors ?? '');
  if (result.status === 400 && /check-and-set/.test(errors)) return 'already filed';
  if (result.status === 403) {
    const capabilities = await bao('POST', 'sys/capabilities-self', { paths: [where] });
    const held = capabilities.status < 300 ? (capabilities.data?.data?.[where] ?? capabilities.data?.[where] ?? []) : [];
    if (held.includes('create')) return 'already filed';
  }
  throw new Error(`filing ${where}: OpenBao answered ${result.status} ${errors}`);
}

/**
 * Ends a guest now (D-63): disables the Keycloak account, ends its Keycloak sessions, records guestEndedAt and guestEndedReason (the full
 * representation is written back, because a PUT with attributes replaces them all), disables the OpenBao entity guest-<id> if it exists (read
 * first: a write to a missing name would create one), files a revocation request for an early end, and stops the guest's Theia sessions.
 * Deletes nothing. Every side is tried even when another fails. Returns { steps, failures, request }.
 */
export async function endGuest({ userId, reason, early = false, job = 'guests.mjs end', keycloak, bao, sessions, now = Date.now(), retentionDays }) {
  const steps = [];
  const failures = [];
  const at = iso(now);
  let user;
  let request = 'none';
  try {
    user = answer(await keycloak('GET', `users/${enc(userId)}`), 'read the guest');
    answer(await keycloak('PUT', `users/${enc(userId)}`, { ...user, enabled: false }), 'disable the account');
    steps.push('Keycloak account disabled');
    answer(await keycloak('POST', `users/${enc(userId)}/logout`), 'end the Keycloak sessions');
    steps.push('Keycloak sessions ended');
    // A second end (to finish a side that failed before) keeps the first end's time and reason.
    if (attribute(user, 'guestEndedAt')) steps.push(`end already recorded at ${attribute(user, 'guestEndedAt')}`);
    else {
      answer(await keycloak('PUT', `users/${enc(userId)}`, { ...user, enabled: false, attributes: { ...(user.attributes ?? {}), guestEndedAt: [at], guestEndedReason: [String(reason)] } }), 'record the end');
      steps.push('end recorded');
    }
  } catch (error) {
    failures.push(`Keycloak: ${error.message}`);
  }
  const entity = `guest-${userId}`;
  try {
    const found = await bao('GET', `identity/entity/name/${entity}`);
    if (found.status === 404) steps.push('no OpenBao entity (never enrolled)');
    else {
      ok(found, `read ${entity}`);
      ok(await bao('POST', `identity/entity/name/${entity}`, { disabled: true }), `disable ${entity}`);
      steps.push(`OpenBao entity ${entity} disabled`);
      // The end record starts the retention period after which a security officer removes the guest's secrets (D-84).
      if (Number(retentionDays) > 0) {
        const recorded = await fileEndRecord({ bao, entity, keycloakId: userId, endedAt: attribute(user, 'guestEndedAt') ?? at, retentionDays });
        steps.push(recorded === 'filed' ? 'end record filed' : 'end record already filed');
      } else {
        failures.push('OpenBao: guests.retentionDays is not set in the realm site file, so no end record was filed and the guest\'s secrets are never offered for removal; set it and end the guest again');
      }
      if (early) {
        request = await fileRevocationRequest({ bao, entity, keycloakId: userId, reason: EARLY_END_REASON, seenAt: at, job });
        steps.push(`revocation request ${request}`);
      }
    }
  } catch (error) {
    failures.push(`OpenBao: ${error.message}`);
  }
  if (sessions) {
    try {
      if (!user?.email) throw new Error('the guest\'s email is unknown, so their sessions cannot be found');
      const stopped = await sessions.stop(user.email);
      steps.push(`${stopped} Theia session${stopped === 1 ? '' : 's'} stopped`);
    } catch (error) {
      failures.push(`Theia sessions: ${error.message}`);
    }
  }
  return { steps, failures, request };
}

/** A guest's state (deploy/runbooks/guest-accounts.md): ended, overdue (past the end but still enabled), pending-keys (fewer than two keys) or active. */
export function guestStatus(user, keyCount, now = Date.now()) {
  if (user.enabled === false || attribute(user, 'guestEndedAt')) return 'ended';
  const until = attribute(user, 'guestUntil');
  if (!until || !(Date.parse(until) > now)) return 'overdue';
  return keyCount < 2 ? 'pending-keys' : 'active';
}

/**
 * What a guest must never hold (D-60, fail closed): a realm-management role, a group besides guests, or an OpenBao policy or group on its
 * entity besides guest-account. Returns { reasons, entity } (entity null when the guest has none); a read that fails is thrown, so it is
 * reported, never ignored.
 */
async function forbiddenHoldings({ keycloak, bao, userId, reasons = [] }) {
  const mappings = answer(await keycloak('GET', `users/${enc(userId)}/role-mappings`), 'read role mappings') ?? {};
  for (const role of mappings.clientMappings?.['realm-management']?.mappings ?? []) reasons.push(`holds the realm-management role ${role.name}`);
  for (const group of await groupsOf(keycloak, userId)) if (group.path !== GUESTS_GROUP) reasons.push(`member of ${group.path}`);
  const found = await bao('GET', `identity/entity/name/guest-${userId}`);
  const entity = found.status === 404 ? null : ok(found, `read guest-${userId}`);
  // guest-account is the one policy a guest entity carries (enrol.mjs): it only keeps the guest's secrets under kv/guests/ (D-84).
  for (const policy of entity?.policies ?? []) if (policy !== GUEST_ACCOUNT_POLICY) reasons.push(`OpenBao entity holds the policy ${policy}`);
  for (const group of entity?.direct_group_ids ?? entity?.group_ids ?? []) reasons.push(`OpenBao entity is in the group ${group}`);
  return { reasons, entity };
}

/**
 * Extends a guest under the create rules (D-63): a new end, the latest lead, approver and approval reference. An ended guest is enabled
 * again with the ended attributes cleared, and its entity, if it has one, enabled again (read first; extend never creates an entity, enrol.mjs
 * does). Refuses a guest who holds a role, another group or an OpenBao policy. Returns { user, entity: 'enabled again' | 'none' | 'unchanged' }.
 */
export async function extendGuest({ request, settings, keycloak, bao, checkCredential = credentialCheck, now = Date.now() }) {
  const { problems, until } = checkGuestRequest(request, settings, now);
  if (!request.user) problems.push('Name the guest\'s username with --user.');
  if (problems.length) throw new GuestRefusal(problems.join('\n'));
  const user = await findUser(keycloak, request.user);
  if (!user?.id) throw new GuestRefusal(`There is no account named ${request.user}.`);
  if (!isGuestGroups(await groupsOf(keycloak, user.id))) throw new GuestRefusal(`${request.user} is not a guest.`);
  const { reasons, entity } = await forbiddenHoldings({ keycloak, bao, userId: user.id });
  if (reasons.length) throw new GuestRefusal(`${request.user} cannot be extended: the account ${reasons.join('; ')}. Remove it first; a guest holds nothing but the group guests.`);
  await checkApproval({ request, keycloak, bao, checkCredential, now });
  const ended = user.enabled === false || Boolean(attribute(user, 'guestEndedAt'));
  const { guestEndedAt, guestEndedReason, ...kept } = user.attributes ?? {};
  answer(await keycloak('PUT', `users/${enc(user.id)}`, { ...user, enabled: ended ? true : user.enabled,
    attributes: { ...kept, guestUntil: [until], guestRequestedBy: [request.requestedBy], guestApprovedBy: [request.approvedBy], guestApprovalRef: [request.approvalRef] } }), `extend ${request.user}`);
  let entityResult = entity ? 'unchanged' : 'none';
  if (ended && entity?.disabled) {
    ok(await bao('POST', `identity/entity/name/guest-${user.id}`, { disabled: false }), `enable guest-${user.id}`);
    entityResult = 'enabled again';
  }
  return { user: await findUser(keycloak, request.user), entity: entityResult };
}

/** The members of guests, with their attributes, page by page. */
async function guestMembers(keycloak) {
  const group = answer(await keycloak('GET', `group-by-path/${GUESTS_GROUP.slice(1)}`), 'find the group guests');
  const members = [];
  for (let first = 0; ; first += 100) {
    const page = answer(await keycloak('GET', `groups/${enc(group.id)}/members?briefRepresentation=false&first=${first}&max=100`), 'list the guests') ?? [];
    members.push(...page);
    if (page.length < 100) return members;
  }
}

/** One row per guest: { username, until, status, requestedBy, approvedBy }. Reads only. */
export async function listGuests({ keycloak, now = Date.now() }) {
  const rows = [];
  for (const user of await guestMembers(keycloak)) {
    const keys = countPasswordlessKeys(answer(await keycloak('GET', `users/${enc(user.id)}/credentials`), 'read credentials'));
    rows.push({ username: user.username, until: attribute(user, 'guestUntil') ?? '', status: guestStatus(user, keys, now), requestedBy: attribute(user, 'guestRequestedBy') ?? '', approvedBy: attribute(user, 'guestApprovedBy') ?? '' });
  }
  return rows;
}

/**
 * The end at the end date, and the fail-closed end (D-63): every enabled member of guests past guestUntil (or without one), and every one
 * found with a realm-management role, another group or an OpenBao policy or group, is ended through endGuest. Each account is read again
 * just before acting, and one whose end moved into the future (with nothing forbidden) is skipped. A fail-closed end before the end date is
 * early, so it files a revocation request. A guest whose fail-closed check could not run (a Keycloak or OpenBao read failed) and who is not
 * past their end is never counted as fine: it is listed as unchecked, with the failure, and ended on a later run if the check finds anything.
 * Every guest is tried; failures are returned, not thrown. Returns { ended, skipped, unchecked, failures }.
 */
export async function expireGuests({ keycloak, bao, sessions, now = Date.now(), job = 'guests.mjs expire', retentionDays }) {
  const ended = [];
  const skipped = [];
  const unchecked = [];
  const failures = [];
  for (const member of await guestMembers(keycloak)) {
    if (member.enabled === false) continue;
    const reasons = [];
    let checkFailed = false;
    try {
      await forbiddenHoldings({ keycloak, bao, userId: member.id, reasons });
    } catch (error) {
      checkFailed = true;
      failures.push(`${member.username}: ${/OpenBao/.test(error.message) ? 'OpenBao' : 'Keycloak'}: ${error.message}`);
    }
    try {
      const fresh = answer(await keycloak('GET', `users/${enc(member.id)}`), `read ${member.username} again`);
      if (fresh.enabled === false) continue;
      const until = attribute(fresh, 'guestUntil');
      const due = !until || !(Date.parse(until) > now);
      if (!due && !reasons.length) {
        if (checkFailed) unchecked.push({ username: member.username, until });
        else if (!attribute(member, 'guestUntil') || !(Date.parse(attribute(member, 'guestUntil')) > now)) skipped.push({ username: member.username, until });
        continue;
      }
      const reason = due ? (until ? `end date ${until} passed` : 'no end date') : reasons.join('; ');
      const result = await endGuest({ userId: member.id, reason: due && reasons.length ? `${reason}; ${reasons.join('; ')}` : reason, early: !due, job, keycloak, bao, sessions, now, retentionDays });
      ended.push({ username: member.username, reason: due && reasons.length ? `${reason}; ${reasons.join('; ')}` : reason, steps: result.steps });
      failures.push(...result.failures.map((failure) => `${member.username}: ${failure}`));
    } catch (error) {
      failures.push(`${member.username}: Keycloak: ${error.message}`);
    }
  }
  return { ended, skipped, unchecked, failures };
}

/** The CLI's sessions client: kubectl lists the Theia Cloud Session records of one namespace and deletes the guest's by name. */
export function kubectlSessions(namespace, kubectl = process.env.KUBECTL || 'kubectl') {
  const run = (args) => {
    const result = spawnSync(kubectl, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`${kubectl} ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
    return result.stdout;
  };
  return {
    stop: async (email) => {
      const items = JSON.parse(run(['get', 'sessions.theia.cloud', '-n', namespace, '-o', 'json'])).items ?? [];
      const mine = items.filter((item) => item.spec?.user === email).map((item) => item.metadata.name);
      for (const name of mine) run(['delete', 'sessions.theia.cloud', name, '-n', namespace]);
      return mine.length;
    }
  };
}

export const SUBCOMMANDS = Object.freeze(['create', 'link', 'extend', 'end', 'list', 'expire']);
const USAGE = `usage: guests.mjs <command> [flags] <connection flags>
  create --user <name> --email <address> --first <name> --last <name> --until <UTC time> --requested-by <lead>
         --approved-by <security contact> --approver-credential <file> --trust <folder> --approval-ref <reference> [--no-link]
  link   --user <name>
  extend --user <name> --until <UTC time> --requested-by <lead> --approved-by <security contact> --approver-credential <file>
         --trust <folder> --approval-ref <reference>
  end    --user <name> --reason <text> [--no-sessions]      (needs --realm-site for guests.retentionDays)
  list
  expire [--no-sessions]                                     (needs --realm-site)
  connection flags: --keycloak <url> --keycloak-token-file <file> [--realm sterling] --bao <url> --ca-file <pem> --bao-token-file <file>
                    --realm-site <realm site file>`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  if (!command || command === '--help' || argv.includes('--help')) { console.log(USAGE); process.exit(command ? 0 : 2); }
  try {
    if (!SUBCOMMANDS.includes(command)) throw new Error(USAGE);
    const needed = ['--keycloak', '--keycloak-token-file', '--bao', '--ca-file', '--bao-token-file', ...(['list', 'expire'].includes(command) ? [] : ['--user']),
      ...(command === 'end' ? ['--reason'] : []), ...(['create', 'extend', 'end', 'expire'].includes(command) ? ['--realm-site'] : [])];
    const missing = needed.filter((flag) => !option(flag));
    if (missing.length) throw new Error(`${USAGE}\nmissing: ${missing.join(' ')}`);
    const caPem = readFileSync(option('--ca-file'), 'utf8');
    const keycloak = keycloakAdmin({ base: option('--keycloak'), realm: option('--realm') ?? 'sterling', token: readFileSync(option('--keycloak-token-file'), 'utf8').trim(), caPem });
    const bao = openbaoClient({ addr: option('--bao'), token: readFileSync(option('--bao-token-file'), 'utf8').trim(), caPem });
    const realmSite = option('--realm-site') ? JSON.parse(readFileSync(option('--realm-site'), 'utf8')) : {};
    const settings = guestSettings(realmSite);
    const username = option('--user');
    let exit = 0;
    const requestFlags = () => ({ user: username, email: option('--email'), first: option('--first'), last: option('--last'), until: option('--until'),
        requestedBy: option('--requested-by'), approvedBy: option('--approved-by'), approverCredential: option('--approver-credential'), trust: option('--trust'),
        approvalRef: option('--approval-ref'), ...Object.fromEntries(CREDENTIAL_FIELDS.filter((field) => argv.includes(`--${field}`)).map((field) => [field, option(`--${field}`) ?? ''])) });
    const sessionsClient = () => (argv.includes('--no-sessions') ? null : kubectlSessions(settings.sessionsNamespace));
    if (command === 'create') {
      const request = requestFlags();
      const { user, link } = await createGuest({ request, settings, keycloak, bao, noLink: argv.includes('--no-link') });
      console.log(`created guest ${user.username} (Keycloak id ${user.id}) until ${attribute(user, 'guestUntil')}, requested by ${request.requestedBy}, approved by ${request.approvedBy} (${request.approvalRef}).`);
      if (!link) console.log(`The account is ready. Send the registration link with ${NEXT_LINK(user.username)} when the guest is at the enrolment desk.`);
      else if (link.sent) console.log(link.message);
      else { console.error(link.message); exit = 1; }
    } else if (command === 'extend') {
      const request = requestFlags();
      const { user, entity } = await extendGuest({ request, settings, keycloak, bao });
      console.log(`extended ${user.username} until ${attribute(user, 'guestUntil')}, requested by ${request.requestedBy}, approved by ${request.approvedBy} (${request.approvalRef}); account enabled ${user.enabled}; OpenBao entity ${entity}.`);
    } else if (command === 'list') {
      const rows = await listGuests({ keycloak });
      if (!rows.length) console.log('No guests at this site.');
      for (const row of rows) console.log(`${row.username}\t${row.until || 'no end date'}\t${row.status}\trequested by ${row.requestedBy || '?'}\tapproved by ${row.approvedBy || '?'}`);
    } else if (command === 'expire') {
      const result = await expireGuests({ keycloak, bao, sessions: sessionsClient(), retentionDays: settings.retentionDays });
      for (const entry of result.ended) console.log(`ended ${entry.username}: ${entry.reason}`);
      for (const entry of result.skipped) console.log(`skipped ${entry.username}: the end moved to ${entry.until}`);
      for (const entry of result.unchecked) console.error(`unchecked ${entry.username}: the check for a role, another group or an OpenBao policy could not run (see the failure below), so this guest is not known to be fine; run expire again`);
      for (const failure of result.failures) console.error(`failed: ${failure}`);
      if (!result.ended.length && !result.failures.length) console.log('No guest is due to end.');
      if (result.failures.length) exit = 1;
    } else if (command === 'link') {
      const { link } = await linkGuest({ username, keycloak });
      if (link.sent) console.log(link.message); else { console.error(link.message); exit = 1; }
    } else {
      const user = await findUser(keycloak, username);
      if (!user?.id) throw new GuestRefusal(`There is no account named ${username}.`);
      if (!isGuestGroups(await groupsOf(keycloak, user.id))) throw new GuestRefusal(`${username} is not a guest; this command ends guest accounts only.`);
      const sessions = sessionsClient();
      // Before the end date this is an early end; after it, the guest's credentials have ended on their own (validUntil is guestUntil).
      const early = Date.parse(attribute(user, 'guestUntil') ?? '') > Date.now();
      const result = await endGuest({ userId: user.id, reason: option('--reason'), early, job: 'guests.mjs end', keycloak, bao, sessions, retentionDays: settings.retentionDays });
      for (const step of result.steps) console.log(`  ${step}`);
      for (const failure of result.failures) console.error(`  failed: ${failure}`);
      console.log(`Ended ${username}.${result.request === 'none' ? '' : ` The officers who issued ${username} credentials see a revocation request on their revocation card and revoke them in their own session.`}`);
      if (result.failures.length) exit = 1;
    }
    process.exit(exit);
  } catch (error) {
    console.error(error instanceof GuestRefusal ? `refused: ${error.message}\nNothing was changed.` : error.message);
    process.exit(1);
  }
}
