// A staff section's project guidance lives in AGENTS.md between markers of its own, `near-ai:staff-section:<template id>`, beside any project type's
// block and any other section's, so a project can hold a J2 and a J5 team at once and Update Team can rewrite one block without touching the rest.
// Pure: no I/O, no clock, no vscode.

export const staffGuidanceStart = (id: string): string => `<!-- near-ai:staff-section:${id}:start -->`;
export const staffGuidanceEnd = (id: string): string => `<!-- near-ai:staff-section:${id}:end -->`;

/** AGENTS.md with a section's guidance between its own markers, replacing an earlier copy; everything else in the file is kept as it was. */
export function withStaffGuidance(existing: string, id: string, guidance: string): string {
  const startMarker = staffGuidanceStart(id);
  const endMarker = staffGuidanceEnd(id);
  const block = `${startMarker}\n${guidance}${guidance.endsWith('\n') ? '' : '\n'}${endMarker}`;
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start >= 0 && end > start) return `${existing.slice(0, start)}${block}${existing.slice(end + endMarker.length)}`;
  return existing.trim() ? `${existing.replace(/\s*$/, '')}\n\n${block}\n` : `# Agent instructions\n\n${block}\n`;
}

/** The text between a section's markers in AGENTS.md, or undefined when the file has no block for it. */
export function staffGuidanceIn(agents: string, id: string): string | undefined {
  const start = agents.indexOf(staffGuidanceStart(id));
  const end = agents.indexOf(staffGuidanceEnd(id));
  if (start < 0 || end <= start) return undefined;
  return agents.slice(start + staffGuidanceStart(id).length, end).replace(/^\r?\n/, '');
}
