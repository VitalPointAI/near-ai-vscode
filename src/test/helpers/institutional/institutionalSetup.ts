import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { parseTeam } from '../../../agent/teams';
import type { StaffRoster } from '../../../services/staffSetup';
import type { MementoLike } from '../../../services/stateHome';
import { withRegisterLock } from '../../../staff/registerLock';
import {
  INSTITUTIONAL_COMMAND_GROUP_TEAM, institutionalDigest, institutionalRole, institutionalRoleBinding, isInstitutionalRole,
  readInstitutionalRoleBinding, type InstitutionalRoleBinding, type InstitutionalRoleId,
} from './institutionalCommand';

export interface InstitutionalStaffSetupPlan {
  readonly roster: StaffRoster;
  readonly institutional: {
    readonly root: string;
    readonly binding: InstitutionalRoleBinding;
  };
}

async function institutionalProject(root: string, team: InstitutionalRoleId): Promise<InstitutionalStaffSetupPlan['institutional']> {
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root)) {
    throw new Error('Institutional setup requires the real project folder.');
  }
  const identity = await lstat(canonicalRoot, { bigint: true });
  if (!identity.isDirectory() || await realpath(root) !== canonicalRoot) {
    throw new Error('The selected project changed during setup.');
  }
  const digest = institutionalDigest(`${identity.dev}:${identity.ino}:${identity.birthtimeNs}`);
  return { root: canonicalRoot, binding: institutionalRoleBinding(canonicalRoot, digest, team) };
}

/** Captures the selected directory before roster confirmation. No project files are needed. */
export async function planInstitutionalStaffSetup(target: string | { root: string; team: InstitutionalRoleId }): Promise<InstitutionalStaffSetupPlan> {
  const { root, team } = typeof target === 'string' ? { root: target, team: INSTITUTIONAL_COMMAND_GROUP_TEAM } : target;
  if (!isInstitutionalRole(team)) throw new Error('Unknown institutional staff role.');
  const institutional = await institutionalProject(root, team);
  const role = institutionalRole(team);
  const parsed = parseTeam(role.definition, `${institutional.binding.team}.md`);
  return {
    institutional,
    roster: {
      teamName: parsed.name,
      description: parsed.description,
      fileName: institutional.binding.team,
      humanLead: role.lead,
      members: parsed.members.map(({ name, role }) => ({ name, ...(role ? { role } : {}) })),
    },
  };
}

export function institutionalStaffSetupKey(binding: InstitutionalRoleBinding): string {
  return `nearAi.staff.institutional.${institutionalRole(binding.team).keySegment}.v1.${binding.rootDigest}`;
}

// A rejected Memento update may leave its value in the current cache. Require
// another confirmed update before treating that exact value as staged.
const unconfirmedInstitutionalWrites = new WeakMap<MementoLike, Set<string>>();

export async function persistInstitutionalStaffSetup(
  plan: InstitutionalStaffSetupPlan,
  state: MementoLike | undefined,
  projectStillSelected: () => boolean
): Promise<void> {
  if (!state) throw new Error('Profile-local storage is unavailable.');
  const { root, binding } = plan.institutional;
  const key = institutionalStaffSetupKey(binding);
  const selectionChanged = 'The selected project changed during confirmation. Run institutional setup again.';
  const assertOriginalIdentity = async (failure: string): Promise<void> => {
    const current = await institutionalProject(root, binding.team);
    if (!readInstitutionalRoleBinding(current.binding, binding)) throw new Error(failure);
  };
  await withRegisterLock(root, async () => {
    // Recheck inside the same-root lock, immediately before reading or updating
    // the local record. Concurrent first writes produce the same v1 value.
    await assertOriginalIdentity(selectionChanged);
    if (!projectStillSelected()) throw new Error(selectionChanged);
    const existing = state.get<unknown>(key);
    if (existing !== undefined && !readInstitutionalRoleBinding(existing, binding)) {
      throw new Error('The institutional setup record is incomplete or inconsistent.');
    }
    const pending = unconfirmedInstitutionalWrites.get(state);
    if (existing !== undefined && !pending?.has(key)) return;
    try {
      await state.update(key, binding);
      // The write belongs to the confirmed root once started. Editor selection may have moved on.
      await assertOriginalIdentity('The confirmed project folder changed while its profile record was being saved.');
      if (!readInstitutionalRoleBinding(state.get<unknown>(key), binding)) {
        throw new Error('The stored record does not match the confirmed definition.');
      }
    } catch (cause) {
      const failures = unconfirmedInstitutionalWrites.get(state) ?? new Set<string>();
      failures.add(key);
      unconfirmedInstitutionalWrites.set(state, failures);
      const detail = cause instanceof Error ? ` ${cause.message}` : '';
      throw new Error(`Could not persist or verify the institutional setup record.${detail}`, { cause });
    }
    pending?.delete(key);
  });
}
