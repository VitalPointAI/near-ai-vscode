#!/bin/bash
# Run INSIDE the sandbox. Each case tries to read a key file by a route the
# extension's text guard cannot see. Prints PASS when the read fails.
cd /sandbox/project
t() { local name="$1"; shift; local out; out=$("$@" 2>&1); local rc=$?
  if echo "$out" | grep -q 'FAKE-'; then echo "FAIL(read succeeded) $name :: $(echo "$out"|head -c 120)"; else echo "PASS rc=$rc $name :: $(echo "$out"|tr '\n' ' '|head -c 140)"; fi; }
echo "== whoami: $(id)"
echo "== A. project copy (keys folder absent by construction)"
t "A1 literal path"            cat .near-ai/state/keys/local.key
t "A2 split string"            bash -c 'p=".near-ai/st""ate/keys"; cat $p/local.key'
t "A3 base64 path"             bash -c 'cat "$(echo Lm5lYXItYWkvc3RhdGUva2V5cy9sb2NhbC5rZXk= | base64 -d)"'
t "A4 node path.join env"      env P1=.near-ai P2=state P3=keys node -e 'const p=require("path");console.log(require("fs").readFileSync(p.join(process.env.P1,process.env.P2,process.env.P3,"local.key"),"utf8"))'
t "A5 grep -r"                 grep -r FAKE- /sandbox
t "A6 find"                    find / -name local.key -not -path '/proc/*'
echo "== B. decoy key present in the image at /opt, outside the policy allowlist (Landlock)"
D=/opt/nearai-decoy/.near-ai/state/keys/local.key
t "B0 ls /opt"                 ls -la /opt
t "B1 literal path"            cat $D
t "B2 split string"            bash -c 'p="/opt/nearai-decoy/.near-ai/st""ate/keys"; cat $p/local.key'
t "B3 base64 path"             bash -c "cat \"\$(echo $(printf %s $D | base64 -w0) | base64 -d)\""
t "B4 node path.join env"      env P0=/opt/nearai-decoy P1=.near-ai P2=state P3=keys node -e 'const p=require("path");console.log(require("fs").readFileSync(p.join(process.env.P0,process.env.P1,process.env.P2,process.env.P3,"local.key"),"utf8"))'
t "B5 grep -r /opt"            grep -r FAKE- /opt
t "B6 find /opt"               find /opt -name local.key
t "B7 symlink in workspace"    bash -c 'ln -sf /opt/nearai-decoy/.near-ai/state/keys/local.key /sandbox/project/link.key && cat /sandbox/project/link.key; rm -f /sandbox/project/link.key'
t "B8 symlink dir"             bash -c 'ln -sfn /opt/nearai-decoy /sandbox/project/linkdir && cat /sandbox/project/linkdir/.near-ai/state/keys/local.key; rm -f /sandbox/project/linkdir'
t "B9 hardlink"                bash -c 'ln /opt/nearai-decoy/.near-ai/state/keys/local.key /sandbox/project/hard.key && cat /sandbox/project/hard.key; rm -f /sandbox/project/hard.key'
t "B10 /proc/1/root"           cat /proc/1/root$D
t "B11 python-less: node child_process via npm-style script" node -e 'console.log(require("child_process").execSync("sh -c \"cat /opt/nearai-decoy/.near-ai/state/keys/local.key\"").toString())'
t "B12 cp to /tmp"             bash -c "cp $D /tmp/x && cat /tmp/x"
t "B13 dd"                     dd if=$D status=none
