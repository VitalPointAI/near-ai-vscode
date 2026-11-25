// The hub pod's init container runs this with the hub image's own Node, as the hub's user: node -e (this file) (Secret folder) (copy folder).
// The hub refuses a key file that group or others can read (hub/src/secrets.ts). The kubelet writes Secret files owned by root and, under the
// pod's fsGroup, makes each one at least 0440, so the hub cannot use them as they are (G540). Each file of the Secret folder is copied into the
// pod's memory folder, created 0400 and owned by the user running this, which is the hub's. Names starting with a dot are the kubelet's own.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [from, to] = process.argv.slice(1);
for (const name of fs.readdirSync(from)) {
  if (name.startsWith('.')) continue;
  const copy = path.join(to, name);
  fs.rmSync(copy, { force: true }); // the copy an earlier run of this container left in the same pod
  fs.writeFileSync(copy, fs.readFileSync(path.join(from, name)), { mode: 0o400, flag: 'wx' });
}
