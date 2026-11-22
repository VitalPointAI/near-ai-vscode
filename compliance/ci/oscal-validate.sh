#!/bin/sh
# Run the pinned oscal-cli commands confirmed from the 3.2.0 built-in help.
#
#   oscal-validate.sh <oscal-file>
#   oscal-validate.sh resolve <profile> <resolved-output>
#   oscal-validate.sh package <package-directory>
set -eu

if [ "$#" -eq 2 ] && [ "$1" = "package" ]; then
  node --input-type=module - "$2" <<'NODE'
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const oscal = realpathSync(join(process.argv[2], 'oscal'));
const scratch = mkdtempSync(join(tmpdir(), 'near-ai-oscal-validation-'));
const isAssessment = name => /^assessment-(?:plan|results)(?:-[a-z0-9-]+)?\.json$/.test(name);
try {
  // OSCAL CLI 3.2.0 resolves a profile imported by an assessment's SSP against
  // the assessment directory. Keep the shipped paths relative and normalize
  // the SSP references in a scratch copy for the assessment validation only.
  cpSync(join(oscal, 'ssp'), join(scratch, 'ssp'), { recursive: true });
  for (const name of readdirSync(join(scratch, 'ssp'))) {
    const file = join(scratch, 'ssp', name);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    const reference = document['system-security-plan']['import-profile'];
    const href = reference.href;
    const original = realpathSync(resolve(oscal, 'ssp', href));
    if (!original.startsWith(oscal + sep)) throw new Error(`SSP profile escapes the package: ${name}`);
    reference.href = pathToFileURL(original).href;
    writeFileSync(file, JSON.stringify(document));
  }
  const documents = readdirSync(oscal, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(entry.parentPath, entry.name))
    .sort();
  const assessments = documents.filter(file => dirname(file) === oscal && isAssessment(basename(file)));
  for (const file of assessments) cpSync(file, join(scratch, basename(file)));
  for (const file of documents) {
    const target = assessments.includes(file) ? join(scratch, basename(file)) : file;
    const result = spawnSync('oscal-cli', ['validate', target], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
NODE
  exit $?
fi

if [ "$#" -eq 3 ] && [ "$1" = "resolve" ]; then
  oscal-cli profile resolve --to=json --overwrite -q "$2" "$3"
  exit 0
fi

if [ "$#" -eq 1 ]; then
  oscal-cli validate "$1"
  exit 0
fi

echo "usage: oscal-validate.sh <oscal-file> | resolve <profile> <resolved-output> | package <package-directory>" >&2
exit 2
