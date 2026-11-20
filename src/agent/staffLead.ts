// What the lead of a staff section team's run is told on top of teamLeadPrompt (design 10, 3.1 "Who leads"): it coordinates, the section's chief
// member integrates, and the members do the section's work with the tools their own tools lines grant. Pure: no I/O, no vscode.
//
// 0.4.35 (owner's D-48): the J2 lead, on the chat's model, spent its first minutes reading the scenario, the skills and the feeds itself, tried the
// COP map (a member's tool) and had tasked no member after nearly three minutes. The lead's tools now match what it may call (offeredTools), and this
// note says what a staff lead does first: mark the step and start the step's lanes, all in one turn.
import { STAFF_PRODUCTS_SERVER, staffTeamInfo, staffToolName } from './staffTools';
import type { TeamDefinition } from './teams';

/** The staff lead's note for a team with a `staff:` block, or undefined for any other team. */
export function staffLeadNote(team: Pick<TeamDefinition, 'slug' | 'members' | 'staff'>): string | undefined {
  const info = staffTeamInfo(team);
  if (!info) return undefined;
  const chief = info.sectionLead;
  return `# Leading a staff section
- You coordinate this section; you are not one of its members. ${chief} is the section's integrator: it merges the members' products into the section's deliverables. The members draft, check and submit the products; you never write a product yourself.
- Your tools are the ones you may use. The registers, the map, the feeds and the workbenches are the members' (each gets what its tools line grants), so you learn the picture from their reports. You can read the project, the products' status (${staffToolName(STAFF_PRODUCTS_SERVER, 'status')}, ${staffToolName(STAFF_PRODUCTS_SERVER, 'list')}) and mark the step (${staffToolName(STAFF_PRODUCTS_SERVER, 'step')}).
- Do not do the members' reading for them: each member reads the profile, the scenario, its skills and the feeds itself. Read only what you need to split the task: the section's workflow in your instructions (AGENTS.md) and what already exists.
- **Start the work early: within your first two turns, mark the step you are working with ${staffToolName(STAFF_PRODUCTS_SERVER, 'step')} and, in the same turn, start every lane of that step's row of the workflow with the Agent tool** (one call per member, each with run_in_background, each prompt complete). Then the merge (${chief}), then the gates the row names, in order.
- Nobody on the team approves or releases anything, you included: a named person decides. Report what is waiting for that person.`;
}
