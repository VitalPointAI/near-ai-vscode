// The invite bundle (D-05): one pasteable string, near-ai-invite-v1.<base64url of canonical JSON>, holding the repo URL, team id, coordination
// ref, the invited member id and the single-use code (and the NEAR link when the team has one). The bundle travels over chat or email, so the
// repo URL in it is cleaned of credentials first (D-06) and the parser treats the text as hostile: exact prefix, size cap, strict base64url,
// pattern checks, no echo of the input in any error. A later writer may add keys and keep v1; unknown keys are ignored. Never imports vscode.
import { canonicalize } from '../domain/team/canonical';
import { isGitRefName } from '../domain/team/policy';
import { findSecrets } from '../domain/team/secrets';
import type { NearLink } from '../domain/team/types';
import { MEMBER_ID_PATTERN, TEAM_ID_PATTERN } from '../domain/team/validate';
import { parseInviteCode } from './inviteCode';
import { COORDINATION_REF_PATTERN } from './teamFile';

export const BUNDLE_PREFIX = 'near-ai-invite-v1.';
export const MAX_BUNDLE_BYTES = 4096;

export interface InviteBundle { v: 1; repo: string; team: string; ref: string; member: string; code: string; near?: NearLink }

// Every parse failure is one of a few fixed sentences. None of them contains the input, the URL or the code.
export class InviteBundleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InviteBundleError';
  }
}

const NOT_AN_INVITE = 'This is not a NEAR AI team invite. Paste the whole invite text exactly as you were sent it.';
const TOO_LARGE = 'This invite is far larger than a real one, so it was not used.';
const DAMAGED = 'This invite is damaged or was changed after it was made. Ask for a new one.';
const NEWER = 'This invite was made by a newer version of NEAR AI. Update the extension, then try again.';

// A single character set and length: what generateInviteCode writes. The reader of a bundle never has to guess at spelling.
const CODE_TEXT = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/;
const BASE64URL_TEXT = /^[A-Za-z0-9_-]+$/;
const FUTURE_PREFIX = /^near-ai-invite-v(?!1\.)\d+\./;
// The same shape team.json accepts for a NEAR organization or workspace id.
const NEAR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_OR_SPACE = /[\s\u0000-\u001F\u007F\u2028\u2029]/;
const SSH_URL_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SCP_USER = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const SCP_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])|\[[0-9A-Fa-f:.]+\])$/;
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

export type CleanedRepoUrl = { ok: true; url: string } | { ok: false; reason: string };

function refused(reason: string): CleanedRepoUrl {
  return { ok: false, reason };
}

const LOCAL_PATH = 'A local path cannot be shared with a teammate. Point the remote at a hosted address such as https://github.com/org/repo.git, then invite again.';
const HAS_QUERY = 'The remote address has a query or fragment, which can carry a token, so it cannot go into an invite.';
const HAS_CREDENTIALS = 'The remote address has a password or token in its user part, so it cannot go into an invite.';
const STILL_SECRET = 'The remote address still looks like it holds a secret after the credentials were removed, so it cannot go into an invite.';
const UNSUPPORTED = 'The remote address is not an https, ssh or scp-style address, so it cannot be shared in an invite.';
const NOT_UNDERSTOOD = 'The remote address could not be understood, so it cannot go into an invite.';
const NO_ADDRESS = 'This project has no address for its team remote, so there is nothing to put in the invite.';

function cleanWebOrSshUrl(trimmed: string, scheme: string): CleanedRepoUrl {
  if (trimmed.includes('?') || trimmed.includes('#')) return refused(HAS_QUERY);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // new URL has already decided the text is not an address; the reason below never repeats the text.
    return refused(NOT_UNDERSTOOD);
  }
  if (parsed.hostname === '') return refused(NOT_UNDERSTOOD);
  if (parsed.search !== '' || parsed.hash !== '') return refused(HAS_QUERY);
  if (scheme === 'ssh') {
    // The user of an ssh address is a login name such as git, not a secret, so a plain one stays. A password never does.
    if (parsed.username !== '' && !SSH_URL_USER.test(parsed.username)) return refused(HAS_CREDENTIALS);
    return { ok: true, url: `ssh://${parsed.username === '' ? '' : `${parsed.username}@`}${parsed.host}${parsed.pathname}` };
  }
  return { ok: true, url: `${scheme}://${parsed.host}${parsed.pathname}` };
}

function cleanScpUrl(trimmed: string): CleanedRepoUrl {
  const colon = trimmed.indexOf(':');
  const slash = trimmed.indexOf('/');
  // Git reads a colon before any slash as host:path. Anything else (a path, ./x, ~/x) is local.
  if (colon < 0 || (slash >= 0 && slash < colon)) return refused(LOCAL_PATH);
  const head = trimmed.slice(0, colon);
  const repoPath = trimmed.slice(colon + 1);
  const at = head.lastIndexOf('@');
  const user = at >= 0 ? head.slice(0, at) : '';
  const host = head.slice(at + 1);
  // A single letter before the colon is a Windows drive, not a host.
  if (host.length < 2 || !SCP_HOST.test(host)) return refused(LOCAL_PATH);
  if (user !== '' && !SCP_USER.test(user)) return refused(HAS_CREDENTIALS);
  // user:password@host:path reads as host "user" with a path that contains an @; no real repo path has one before its first slash.
  if (repoPath === '' || repoPath.split('/')[0]?.includes('@') === true) return refused(HAS_CREDENTIALS);
  if (repoPath.includes('?') || repoPath.includes('#')) return refused(HAS_QUERY);
  return { ok: true, url: `${user === '' ? '' : `${user}@`}${host}:${repoPath}` };
}

// D-06: the URL that goes into a bundle. Credentials are removed, never reported. Anything that cannot be made safe is refused with a fixed
// reason. The reason never contains the URL, because the URL can hold a credential (Phase 60 D-34).
export function cleanRepoUrl(url: string): CleanedRepoUrl {
  if (typeof url !== 'string') return refused(NOT_UNDERSTOOD);
  const trimmed = url.trim();
  if (trimmed === '') return refused(NO_ADDRESS);
  if (CONTROL_OR_SPACE.test(trimmed)) return refused(NOT_UNDERSTOOD);
  let cleaned: CleanedRepoUrl;
  const scheme = URL_SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === undefined) cleaned = cleanScpUrl(trimmed);
  else if (scheme === 'file') cleaned = refused(LOCAL_PATH);
  else if (scheme === 'http' || scheme === 'https' || scheme === 'ssh') cleaned = cleanWebOrSshUrl(trimmed, scheme);
  else cleaned = refused(UNSUPPORTED);
  if (!cleaned.ok) return cleaned;
  return findSecrets(cleaned.url).length > 0 ? refused(STILL_SECRET) : cleaned;
}

function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(fields: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
}

function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && COORDINATION_REF_PATTERN.test(ref) && isGitRefName(ref);
}

function nearOf(value: unknown): NearLink {
  if (!isFields(value)) throw new InviteBundleError(DAMAGED);
  const organizationId = own(value, 'organizationId');
  const workspaceId = own(value, 'workspaceId');
  if (typeof organizationId !== 'string' || !NEAR_ID_PATTERN.test(organizationId) || typeof workspaceId !== 'string' || !NEAR_ID_PATTERN.test(workspaceId)) throw new InviteBundleError(DAMAGED);
  return { organizationId, workspaceId };
}

// The text a lead copies. The fields are checked on the way out as well, so the lead can never hand over a bundle that no client would accept.
export function encodeInviteBundle(bundle: InviteBundle): string {
  const body: Record<string, unknown> = { v: 1, repo: bundle.repo, team: bundle.team, ref: bundle.ref, member: bundle.member, code: bundle.code };
  if (bundle.near !== undefined) body['near'] = { organizationId: bundle.near.organizationId, workspaceId: bundle.near.workspaceId };
  const text = `${BUNDLE_PREFIX}${Buffer.from(canonicalize(body), 'utf8').toString('base64url')}`;
  parseInviteBundle(text);
  return text;
}

// Hostile input by default. Surrounding whitespace from a paste is dropped; everything else must match exactly.
export function parseInviteBundle(text: string): InviteBundle {
  if (typeof text !== 'string') throw new InviteBundleError(NOT_AN_INVITE);
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_BUNDLE_BYTES) throw new InviteBundleError(TOO_LARGE);
  if (!trimmed.startsWith(BUNDLE_PREFIX)) throw new InviteBundleError(FUTURE_PREFIX.test(trimmed) ? NEWER : NOT_AN_INVITE);
  const payload = trimmed.slice(BUNDLE_PREFIX.length);
  if (payload === '' || !BASE64URL_TEXT.test(payload)) throw new InviteBundleError(DAMAGED);
  const decoded = Buffer.from(payload, 'base64url');
  // A decode and encode round trip refuses a non-canonical tail, so one bundle has one spelling.
  if (decoded.toString('base64url') !== payload) throw new InviteBundleError(DAMAGED);
  const json = decoded.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(decoded)) throw new InviteBundleError(DAMAGED);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // The parse error would quote the input, so only the fixed sentence is thrown.
    throw new InviteBundleError(DAMAGED);
  }
  if (!isFields(parsed)) throw new InviteBundleError(DAMAGED);
  const version = own(parsed, 'v');
  if (typeof version === 'number' && version > 1) throw new InviteBundleError(NEWER);
  if (version !== 1) throw new InviteBundleError(DAMAGED);
  const repo = own(parsed, 'repo');
  const team = own(parsed, 'team');
  const ref = own(parsed, 'ref');
  const member = own(parsed, 'member');
  const code = own(parsed, 'code');
  if (typeof repo !== 'string' || typeof team !== 'string' || !TEAM_ID_PATTERN.test(team) || typeof member !== 'string' || !MEMBER_ID_PATTERN.test(member) || !validRef(ref)) {
    throw new InviteBundleError(DAMAGED);
  }
  if (typeof code !== 'string' || !CODE_TEXT.test(code) || parseInviteCode(code) === undefined) throw new InviteBundleError(DAMAGED);
  // A repo URL that cleaning would change carried a credential or something else that must not travel.
  const cleaned = cleanRepoUrl(repo);
  if (!cleaned.ok || cleaned.url !== repo) throw new InviteBundleError(DAMAGED);
  const bundle: InviteBundle = { v: 1, repo, team, ref, member, code };
  if (Object.prototype.hasOwnProperty.call(parsed, 'near')) bundle.near = nearOf(own(parsed, 'near'));
  return bundle;
}
