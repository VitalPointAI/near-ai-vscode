// What a person is told after choosing "Allow every time" (owner, 2026-11-06): "if they select Allow Every Time, it actually learns to allow it every
// time". The message reports the truth as read back from the settings after the write, never the attempt, so a save that did not stick says so and names
// the one place to fix it. Pure: no vscode, no I/O.
export function rememberedRuleNotice(rule: string, saved: boolean, where: string): string {
  return saved
    ? `Learned: "${rule}" now runs without asking in this ${where}, so this command is not asked about again. Remove it under Settings, NEAR AI, Agent: Allow Commands.`
    : `"${rule}" could not be saved to this ${where}; it is allowed for this run only. Add it under Settings, NEAR AI, Agent: Allow Commands.`;
}
