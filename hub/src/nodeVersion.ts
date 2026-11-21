// Copied from relay/src/nodeVersion.ts and adapted for the hub (D-28).
// The one place that says which Node the hub runs on. src/bin.ts (the start guard) and scripts/check-node.mjs (the install and build guard)
// both call it, so the rule cannot drift. Keep this file free of enums and other syntax Node cannot strip, because check-node.mjs imports it
// as TypeScript directly.

export const MIN_NODE_VERSION = '26.13.1';

// Returns undefined when `version` (for example process.versions.node) is Node 26.13.1 or a later 26.x release, else the sentence to show.
export function checkNodeVersion(version: string): string | undefined {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (major === 26 && (minor > 13 || (minor === 13 && patch >= 1))) return undefined;
  return `near-ai-hub needs Node ${MIN_NODE_VERSION} or a later 26.x release; this is Node ${version}. Install Node ${MIN_NODE_VERSION} and start again.`;
}
