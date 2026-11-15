// Guard entry (D-02). It checks the Node version first and only then loads the app, so an older Node prints one plain sentence instead of
// failing on a module it does not have. A failed load of the app prints one fixed sentence too. The app path sits in a variable so neither
// tsc nor esbuild follows it into the bundle.
import { checkNodeVersion } from './nodeVersion';

const refusal = checkNodeVersion(process.versions.node);
if (refusal) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

const entry = './app.mjs';
let app: { main(argv: readonly string[]): Promise<void> };
try {
  app = (await import(entry)) as typeof app;
} catch {
  // A missing or damaged app.mjs. The redacting logger lives in the app, so the failure itself (file paths, a stack) is not printed: one
  // fixed sentence on stderr, like the version refusal, and exit 1 (D-11).
  process.stderr.write('near-ai-relay could not load its code; reinstall it.\n');
  process.exit(1);
}
try {
  await app.main(process.argv.slice(2));
} catch {
  // No output path exists before the redacting logger (D-11); a failed start is an exit code only.
  process.exit(1);
}
