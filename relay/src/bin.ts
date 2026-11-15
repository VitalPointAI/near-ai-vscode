// Guard entry (D-02). It checks the Node version first and only then loads the app, so an older Node prints one plain sentence instead of
// failing on a module it does not have. The app path sits in a variable so neither tsc nor esbuild follows it into the bundle.
export {};

const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
if (!(major === 26 && (minor > 13 || (minor === 13 && patch >= 1)))) {
  process.stderr.write(`near-ai-relay needs Node 26.13.1 or a later 26.x release; this is Node ${process.versions.node}. Install Node 26.13.1 and start again.\n`);
  process.exit(1);
}

const entry = './app.mjs';
const app = (await import(entry)) as { main(argv: readonly string[]): Promise<void> };
try {
  await app.main(process.argv.slice(2));
} catch {
  // No output path exists before the redacting logger (D-11); a failed start is an exit code only.
  process.exit(1);
}
