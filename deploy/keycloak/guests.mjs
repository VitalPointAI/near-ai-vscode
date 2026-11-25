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
//   end     --user <name> --reason <text> [--no-sessions]
//           Ends the guest now: Keycloak account disabled and its sessions ended, the end recorded, the OpenBao entity guest-<id> disabled
//           (every token it holds stops at once) and the guest's Theia sessions stopped. An early end also files one revocation request in
//           the site's revocation inbox, so the officers who issued the guest credentials revoke them in their own session. Nothing is deleted.
//
//   connection flags: --keycloak <https://keycloak.<domain>> --keycloak-token-file <file> [--realm sterling] --bao <https://openbao:8200>
//                     --ca-file <site CA pem> --bao-token-file <file> (a token with policy guest-operator) --realm-site <realm site file>
//
// The realm site file's guests.maxDays limits every end date; 0 or absent turns guests off. Tokens come from files, never arguments.
// Node built-ins only.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openbaoClient } from '../openbao/apply.mjs';
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

/** The guests settings of the realm site file: { maxDays, checkMinutes, sessionsNamespace }. Guests are off when maxDays is 0 or absent. */
export function guestSettings(realmSite) {
  const guests = realmSite?.guests ?? {};
  return { maxDays: Number(guests.maxDays ?? 0) || 0, checkMinutes: Number(guests.checkMinutes ?? 15), sessionsNamespace: guests.sessionsNamespace || 'theia-cloud' };
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
async function checkApproval({ request, keycloak, bao, checkCredential, now }) {
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
  const where = `${REVOCATION_INBOX}/${entity}-${reason}`;
  const result = await bao('POST', where, { options: { cas: 0 }, data: { format: REVOCATION_FORMAT, entity, keycloakId, reason, seenAt, job } });
  if (result.status < 300) return 'filed';
  const errors = JSON.stringify(result.data?.errors ?? '');
  if (result.status === 400 && /check-and-set/.test(errors)) return 'already filed';
  if (result.status === 403) {
    const capabilities = await bao('POST', 'sys/capabilities-self', { paths: [where] });
    const held = capabilities.status < 300 ? (capabilities.data?.data?.[where] ?? capabilities.data?.[where] ?? []) : [];
    if (held.includes('create')) return 'already filed';
  }
  throw new Error(`filing the revocation request ${where}: OpenBao answered ${result.status} ${errors}`);
}

/**
 * Ends a guest now (D-63): disables the Keycloak account, ends its Keycloak sessions, records guestEndedAt and guestEndedReason (the full
 * representation is written back, because a PUT with attributes replaces them all), disables the OpenBao entity guest-<id> if it exists (read
 * first: a write to a missing name would create one), files a revocation request for an early end, and stops the guest's Theia sessions.
 * Deletes nothing. Every side is tried even when another fails. Returns { steps, failures, request }.
 */
export async function endGuest({ userId, reason, early = false, job = 'guests.mjs end', keycloak, bao, sessions, now = Date.now() }) {
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

export const SUBCOMMANDS = Object.freeze(['create', 'link', 'end']);
const USAGE = `usage: guests.mjs <command> [flags] <connection flags>
  create --user <name> --email <address> --first <name> --last <name> --until <UTC time> --requested-by <lead>
         --approved-by <security contact> --approver-credential <file> --trust <folder> --approval-ref <reference> [--no-link]
  link   --user <name>
  end    --user <name> --reason <text> [--no-sessions]
  connection flags: --keycloak <url> --keycloak-token-file <file> [--realm sterling] --bao <url> --ca-file <pem> --bao-token-file <file>
                    --realm-site <realm site file>`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  if (!command || command === '--help' || argv.includes('--help')) { console.log(USAGE); process.exit(command ? 0 : 2); }
  try {
    if (!SUBCOMMANDS.includes(command)) throw new Error(USAGE);
    const needed = ['--keycloak', '--keycloak-token-file', '--bao', '--ca-file', '--bao-token-file', '--user', ...(command === 'end' ? ['--reason'] : []), ...(command === 'create' ? ['--realm-site'] : [])];
    const missing = needed.filter((flag) => !option(flag));
    if (missing.length) throw new Error(`${USAGE}\nmissing: ${missing.join(' ')}`);
    const caPem = readFileSync(option('--ca-file'), 'utf8');
    const keycloak = keycloakAdmin({ base: option('--keycloak'), realm: option('--realm') ?? 'sterling', token: readFileSync(option('--keycloak-token-file'), 'utf8').trim(), caPem });
    const bao = openbaoClient({ addr: option('--bao'), token: readFileSync(option('--bao-token-file'), 'utf8').trim(), caPem });
    const realmSite = option('--realm-site') ? JSON.parse(readFileSync(option('--realm-site'), 'utf8')) : {};
    const settings = guestSettings(realmSite);
    const username = option('--user');
    let exit = 0;
    if (command === 'create') {
      const request = { user: username, email: option('--email'), first: option('--first'), last: option('--last'), until: option('--until'),
        requestedBy: option('--requested-by'), approvedBy: option('--approved-by'), approverCredential: option('--approver-credential'), trust: option('--trust'),
        approvalRef: option('--approval-ref'), ...Object.fromEntries(CREDENTIAL_FIELDS.filter((field) => argv.includes(`--${field}`)).map((field) => [field, option(`--${field}`) ?? ''])) };
      const { user, link } = await createGuest({ request, settings, keycloak, bao, noLink: argv.includes('--no-link') });
      console.log(`created guest ${user.username} (Keycloak id ${user.id}) until ${attribute(user, 'guestUntil')}, requested by ${request.requestedBy}, approved by ${request.approvedBy} (${request.approvalRef}).`);
      if (!link) console.log(`The account is ready. Send the registration link with ${NEXT_LINK(user.username)} when the guest is at the enrolment desk.`);
      else if (link.sent) console.log(link.message);
      else { console.error(link.message); exit = 1; }
    } else if (command === 'link') {
      const { link } = await linkGuest({ username, keycloak });
      if (link.sent) console.log(link.message); else { console.error(link.message); exit = 1; }
    } else {
      const user = await findUser(keycloak, username);
      if (!user?.id) throw new GuestRefusal(`There is no account named ${username}.`);
      if (!isGuestGroups(await groupsOf(keycloak, user.id))) throw new GuestRefusal(`${username} is not a guest; this command ends guest accounts only.`);
      const sessions = argv.includes('--no-sessions') ? null : kubectlSessions(settings.sessionsNamespace);
      // Before the end date this is an early end; after it, the guest's credentials have ended on their own (validUntil is guestUntil).
      const early = Date.parse(attribute(user, 'guestUntil') ?? '') > Date.now();
      const result = await endGuest({ userId: user.id, reason: option('--reason'), early, job: 'guests.mjs end', keycloak, bao, sessions });
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
