import type * as vscode from 'vscode';
import type { StaffSetupFixture } from '../../../services/staffSetupCommand';
import type { MementoLike } from '../../../services/stateHome';
import { planInstitutionalStaffSetup, persistInstitutionalStaffSetup, type InstitutionalStaffSetupPlan } from './institutionalSetup';
import {
  INSTITUTIONAL_ACCESSIBILITY_TEAM, INSTITUTIONAL_COMMAND_GROUP_PROFILE, INSTITUTIONAL_COMMAND_GROUP_TEAM, INSTITUTIONAL_J1_MONITORING_TEAM, INSTITUTIONAL_J2_CATALOGUE_TEAM, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, INSTITUTIONAL_J4_INVENTORY_TEAM, INSTITUTIONAL_J5_EVIDENCE_TEAM, INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM, INSTITUTIONAL_J7_LESSONS_TEAM, INSTITUTIONAL_J8_BUDGET_TEAM, INSTITUTIONAL_J9_REMIT_TEAM,
  institutionalRole, isInstitutionalRole, type InstitutionalRoleId,
} from './institutionalCommand';

const catalogueStewardDecision = 'The fictional domain steward decides what the metadata means and which fields people can see.';

const businessServicesOwnerDecision = 'The fictional service portfolio owner approves service entries.';

const planningOwnerDecision = 'The fictional plan owner decides whether to carry unresolved assumptions.';

const remitLiaisonResponsibility = 'The fictional liaison lead verifies each organization’s remit. A legal reviewer handles unclear jurisdiction.';

const inventoryCustodianDecision = 'The fictional property custodian decides how to resolve count differences and custody questions.';

const budgetHumanDecisions = 'The fictional finance reporting officer validates the draft. The fictional comptroller decides on release.';

const monitoringHumanDecisions = 'The fictional HR services supervisor validates the aggregate. The fictional feed custodian owns source correction.';

const accessibilityHumanDecisions = 'The fictional accessibility adviser owns accessibility advice. The fictional help-sheet product owner decides remediation.';

const institutionalChoices = ([INSTITUTIONAL_COMMAND_GROUP_TEAM, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, INSTITUTIONAL_J7_LESSONS_TEAM, INSTITUTIONAL_J2_CATALOGUE_TEAM, INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM, INSTITUTIONAL_J5_EVIDENCE_TEAM, INSTITUTIONAL_J9_REMIT_TEAM, INSTITUTIONAL_J4_INVENTORY_TEAM, INSTITUTIONAL_J8_BUDGET_TEAM, INSTITUTIONAL_J1_MONITORING_TEAM, INSTITUTIONAL_ACCESSIBILITY_TEAM] as const).map((value) => ({
  value,
  label: institutionalRole(value).label,
  detail: value === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM
    ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office-hours action register draft for a local test fixture.`
    : value === INSTITUTIONAL_J7_LESSONS_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office-hours observation draft for a local test fixture.`
    : value === INSTITUTIONAL_J2_CATALOGUE_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office records catalogue draft for a local test fixture. ${catalogueStewardDecision}`
    : value === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional business-service catalogue for a local test fixture. ${businessServicesOwnerDecision}`
    : value === INSTITUTIONAL_J5_EVIDENCE_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional evidence and assumptions register for a local test fixture. ${planningOwnerDecision}`
    : value === INSTITUTIONAL_J9_REMIT_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional library remit comparison for a local test fixture. ${remitLiaisonResponsibility}`
    : value === INSTITUTIONAL_J4_INVENTORY_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office inventory reconciliation for a local test fixture. ${inventoryCustodianDecision}`
    : value === INSTITUTIONAL_J8_BUDGET_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office budget evidence reconciliation for a local test fixture. ${budgetHumanDecisions}`
    : value === INSTITUTIONAL_J1_MONITORING_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office help aggregate for a local test fixture. ${monitoringHumanDecisions}`
    : value === INSTITUTIONAL_ACCESSIBILITY_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional help-sheet review for a local test fixture. ${accessibilityHumanDecisions}`
    : `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Local draft setup for a test fixture.`,
}));

export function createInstitutionalStaffSetupFixture(vscode: typeof import('vscode'), setUpAction: string): StaffSetupFixture {
  function rosterItems(plan: InstitutionalStaffSetupPlan): vscode.QuickPickItem[] {
    const { roster } = plan;
    const isActionRegister = plan.institutional.binding.team === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;
    const isLessons = plan.institutional.binding.team === INSTITUTIONAL_J7_LESSONS_TEAM;
    const isCatalogue = plan.institutional.binding.team === INSTITUTIONAL_J2_CATALOGUE_TEAM;
    const isBusinessServices = plan.institutional.binding.team === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM;
    const isPlanningEvidence = plan.institutional.binding.team === INSTITUTIONAL_J5_EVIDENCE_TEAM;
    const isLibraryRemits = plan.institutional.binding.team === INSTITUTIONAL_J9_REMIT_TEAM;
    const isInventory = plan.institutional.binding.team === INSTITUTIONAL_J4_INVENTORY_TEAM;
    const isBudget = plan.institutional.binding.team === INSTITUTIONAL_J8_BUDGET_TEAM;
    const isServiceMonitoring = plan.institutional.binding.team === INSTITUTIONAL_J1_MONITORING_TEAM;
    const isAccessibility = plan.institutional.binding.team === INSTITUTIONAL_ACCESSIBILITY_TEAM;
    const humanDetail = isAccessibility ? 'Owns accessibility advice on the help-sheet evidence draft.'
      : isServiceMonitoring ? 'Validates the office help aggregate.'
      : isBudget ? 'Validates the budget evidence draft.'
      : isInventory ? inventoryCustodianDecision
      : isLibraryRemits ? remitLiaisonResponsibility
      : isPlanningEvidence ? `Reviews evidence, estimates and open items. ${planningOwnerDecision}`
      : isBusinessServices ? `Reviews the business-service catalogue draft. ${businessServicesOwnerDecision}`
      : isCatalogue ? `Reviews the catalogue draft. ${catalogueStewardDecision}`
      : isLessons ? 'Reviews the observation draft. The observer or lessons lead confirms facts and decides any merge or access changes.'
      : isActionRegister
      ? 'Reviews the action register draft. The fictional chair owns the decision, and the assigned person acknowledges any action.'
      : 'Reviews the draft and decides through the authorized process.';
    return [
      { label: isActionRegister || isLessons || isCatalogue || isBusinessServices || isPlanningEvidence || isLibraryRemits || isInventory || isBudget || isServiceMonitoring || isAccessibility ? 'Human review' : 'A person decides', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(person) ${roster.humanLead}`, description: 'human lead', detail: humanDetail },
      ...(isBudget ? [{ label: '$(person) Fictional comptroller', description: 'independent human reviewer', detail: 'Decides on release through separate human review.' }] : []),
      ...(isServiceMonitoring ? [{ label: '$(person) Fictional feed custodian', description: 'independent source owner', detail: 'Owns source correction through a human review.' }] : []),
      ...(isAccessibility ? [{ label: '$(person) Fictional help-sheet product owner', description: 'independent product owner', detail: 'Decides remediation through separate human review.' }] : []),
      { label: 'Agent drafts', kind: vscode.QuickPickItemKind.Separator },
      ...roster.members.map((member) => ({ label: `$(hubot) ${member.name}`, description: member.role, detail: 'Requires an approved local test fixture.' })),
    ];
  }

  async function confirmStaffSetup(plan: InstitutionalStaffSetupPlan): Promise<boolean> {
    const isActionRegister = plan.institutional.binding.team === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;
    const isLessons = plan.institutional.binding.team === INSTITUTIONAL_J7_LESSONS_TEAM;
    const isCatalogue = plan.institutional.binding.team === INSTITUTIONAL_J2_CATALOGUE_TEAM;
    const isBusinessServices = plan.institutional.binding.team === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM;
    const isPlanningEvidence = plan.institutional.binding.team === INSTITUTIONAL_J5_EVIDENCE_TEAM;
    const isLibraryRemits = plan.institutional.binding.team === INSTITUTIONAL_J9_REMIT_TEAM;
    const isInventory = plan.institutional.binding.team === INSTITUTIONAL_J4_INVENTORY_TEAM;
    const isBudget = plan.institutional.binding.team === INSTITUTIONAL_J8_BUDGET_TEAM;
    const isServiceMonitoring = plan.institutional.binding.team === INSTITUTIONAL_J1_MONITORING_TEAM;
    const isAccessibility = plan.institutional.binding.team === INSTITUTIONAL_ACCESSIBILITY_TEAM;
    const skill = isAccessibility ? 'help-sheet accessibility review draft' : isServiceMonitoring ? 'office help aggregate draft' : isBudget ? 'office budget evidence reconciliation draft' : isInventory ? 'office inventory reconciliation draft' : isLibraryRemits ? 'library service remit comparison draft' : isPlanningEvidence ? 'evidence and assumptions register draft' : isBusinessServices ? 'business-service catalogue draft' : isCatalogue ? 'office records catalogue draft' : isLessons ? 'office-hours observation draft' : isActionRegister ? 'office-hours action register draft' : 'decision brief';
    const detail = `Stages the ${INSTITUTIONAL_COMMAND_GROUP_PROFILE} definition and ${skill} skill in this editor profile.`;
    const confirm = { label: `$(check) ${setUpAction}`, detail };
    const answer = await vscode.window.showQuickPick([confirm, ...rosterItems(plan)], {
      title: `${plan.roster.teamName}: check the roster`,
      placeHolder: isAccessibility ? `The member drafts the help-sheet review. ${accessibilityHumanDecisions} Choose the setup action to stage this role.`
        : isServiceMonitoring ? `The member drafts the office help aggregate. ${monitoringHumanDecisions} Choose the setup action to stage this role.`
        : isBudget ? `The member drafts the office budget evidence reconciliation. ${budgetHumanDecisions} Choose the setup action to stage this role.`
        : isInventory ? `The member drafts the office inventory reconciliation. ${inventoryCustodianDecision} Choose the setup action to stage this role.`
        : isLibraryRemits ? `The member drafts the remit comparison. ${remitLiaisonResponsibility} Choose the setup action to stage this role.`
        : isPlanningEvidence ? `The member drafts the evidence and assumptions register. ${planningOwnerDecision} Choose the setup action to stage this role.`
        : isBusinessServices ? `The member drafts the business-service catalogue. ${businessServicesOwnerDecision} Choose the setup action to stage this role.`
        : isCatalogue ? `The member drafts the catalogue. ${catalogueStewardDecision} Choose the setup action to stage this role.`
        : isLessons ? 'The member drafts for human review. Choose the setup action to stage the local test role.'
        : isActionRegister
        ? 'The member drafts for review. The fictional chair owns the decision. Choose the setup action to stage this role.'
        : 'Members draft and recommend; the named person decides. Choose "Set up the team" to write it.',
      ignoreFocusOut: true,
    });
    return answer === confirm;
  }

  async function stageInstitutionalStaffSetup(root: string, team: InstitutionalRoleId, state: MementoLike | undefined): Promise<void> {
    try {
      const plan = await planInstitutionalStaffSetup({ root, team });
      if (!await confirmStaffSetup(plan)) return;
      const projectStillSelected = () => vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === root) === true;
      await persistInstitutionalStaffSetup(plan, state, projectStillSelected);
      const status = projectStillSelected() ? 'Staged for this project.' : `Staged for the confirmed project "${plan.institutional.root}".`;
      const readiness = team === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM
        ? 'The office-hours action register draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J7_LESSONS_TEAM ? 'The office-hours observation draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J2_CATALOGUE_TEAM ? 'The office records catalogue draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM ? 'The business-service catalogue draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J5_EVIDENCE_TEAM ? 'The evidence and assumptions register draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J9_REMIT_TEAM ? 'The library service remit comparison draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J4_INVENTORY_TEAM ? 'The office inventory reconciliation draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J8_BUDGET_TEAM ? 'The office budget evidence reconciliation draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_J1_MONITORING_TEAM ? 'The office help aggregate draft requires the approved local test fixture before the member can run.'
        : team === INSTITUTIONAL_ACCESSIBILITY_TEAM ? 'The help-sheet accessibility review draft requires the approved local test fixture before the member can run.'
        : 'The draft member requires the approved local test fixture before it can run.';
      void vscode.window.showInformationMessage(`${status} ${readiness}`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Institutional setup is on hold. ${(error as Error).message}`);
    }
  }

  return {
    choices: institutionalChoices,
    async stage(root, choice, state) {
      if (isInstitutionalRole(choice)) await stageInstitutionalStaffSetup(root, choice, state);
    },
  };
}
