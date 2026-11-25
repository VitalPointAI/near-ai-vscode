---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 22
subsystem: deploy
status: complete
tags: [time, chrony, au-8, sc-45, air-gap, rke2, lab-vm]
requires: [47-05]
provides:
  - "deploy/bundle/lib/clock.mjs: checkTimeSettings, chronyConf, writeClockFiles, parseTracking, clockProblems, checkHostClock; CLI --site --out and --check-host"
  - "deploy/rke2/check-time.sh: the node clock verdict in POSIX sh and awk, the same four rules as clockProblems"
  - "install-node.sh requires chrony.conf, clock.env and check-time.sh, installs chrony.conf and stops before any RKE2 change on a bad clock"
  - "Site setting time { servers, refclocks, nts, maxClockErrorMs: 1000 } in the site example and the CI site"
  - "deploy/test/time.test.mjs and four chronyc fixtures (three from a real chronyd 4.8 on the air-gapped lab VM)"
affects: [47-16, 47-17, 47-18, 47-26, 47-27, 47-28]
tech-stack:
  added: []
  patterns:
    - "One verdict, two implementations (Node on the import host, sh and awk on the nodes), held together by shared fixtures run through both"
key-files:
  created:
    - deploy/bundle/lib/clock.mjs
    - deploy/rke2/check-time.sh
    - deploy/test/time.test.mjs
    - deploy/test/fixtures/chrony/synced.csv
    - deploy/test/fixtures/chrony/unsynced.csv
    - deploy/test/fixtures/chrony/local.csv
    - deploy/test/fixtures/chrony/far.csv
  modified:
    - deploy/rke2/install-node.sh
    - deploy/values/site.example.yaml
    - deploy/test/fixtures/site.ci.yaml
key-decisions:
  - "NTS trust points at /etc/chrony-site-ca.crt (0644), which install-node.sh writes from the node folder's site-ca.crt before chronyd restarts, not at /etc/rancher/rke2/site-ca.crt: that copy is 0600 root and is written only after RKE2 is unpacked, so chronyd could not have read it at the time check"
  - "minsources 2 counts servers and refclocks together; a site with one source gets no minsources line, which one source could never meet"
  - "A server name made only of digits and dots must be a valid IP address (999.1.1.1 is refused), so a mistyped address is not taken for a host name"
  - "The clock check runs after chronyd is installed and restarted and before the etcd user, the RPM and the RKE2 tarball; installing /etc/chrony.conf and the CA copy are the only node changes before it"
requirements-completed: [DEP-02, DEP-12]
duration: ~25min
completed: 2026-11-24
estimate:
  tokens: 45000
  tasks: 2
actuals:
  tokens: 7300
  tasks: 2
  commits: 2
plan_head_before: faf87769d8728c566e5981117f57a968e69065c6
plan_head_after: 48b8941f
---

# Phase 47 Plan 22: Time for air-gapped sites Summary

**Every node's chrony.conf is generated from the site file's own time sources, and on the air-gapped lab VM install-node.sh refused a node whose clock followed nothing, leaving RKE2 uninstalled, then accepted the same node on the KVM PTP clock (reference PHC0, bound printed) and RKE2 came up.**

## Performance

- Tasks: 2 of 2. Commits: `42b3639b` (Task 1), `48b8941f` (Task 2). The plan's commits are interleaved with 47-25's on the same branch
  (one lab VM served both), so `commits: 2` counts this plan's own (`git log faf87769..HEAD --grep '(47-22)'`), not every commit in the range.
- Lab: one air-gapped VM run shared with 47-25, under the host's heavy-run lock.

## Task 1: one node's clock end to end on the air-gapped lab VM

`deploy/lab/vm.sh up` with `LAB_MEMORY=4608M LAB_MEMORY_MAX=6G LAB_CPUS=4 LAB_LOCK=/home/aaron/.cache/claude-code-tmp/heavy.lock`, the
operator's Rocky 9.9 GenericCloud image (sha256 `4f88f420...46d50e`) and a fresh LUKS overlay. The node folder was made as 47-05 made it
(the four pinned RKE2 artifacts, `pins.sha256`, the four node files substituted with `render.mjs --substitute`, the lab bootstrap CA), plus the
clock files from `node deploy/bundle/lib/clock.mjs --site site.lab.yaml --out node`, the lab site being the CI site with
`time: { servers: [], refclocks: ["PHC /dev/ptp0 poll 2"], nts: false, maxClockErrorMs: 1000 }`.

### Guest

```
/proc/sys/crypto/fips_enabled -> 1;  getenforce -> Enforcing
ip route -> 10.0.2.0/24 dev eth0 ... (no default route)
curl -m 5 https://registry.access.redhat.com/v2/ -> curl: (6) Could not resolve host (exit 6)
rpm -q chrony -> chrony-4.8-1.el9.x86_64
modprobe ptp_kvm -> exit 0; /dev/ptp0 (clock_name "KVM virtual PTP")
chronyc -c tracking (image's own chrony.conf, internet pool unreachable):
  00000000,,0,...,1.000000000,1.000000000,0.0,Not synchronised
```

### Generated chrony.conf (lab)

```
refclock PHC /dev/ptp0 poll 2
driftfile /var/lib/chrony/drift
makestep 1 3
rtcsync
cmdport 0
```

### Refusal path first, on the fresh VM

The refusal folder held the same files with a chrony.conf naming only `server 192.0.2.1 iburst` (TEST-NET-1, unreachable).

```
check-time: refusing: the clock is not synchronised to any time source (reference , stratum 0, bound 1500.000 ms)
install-node: the node clock does not follow the site's time source within the limit; RKE2 was not installed
install-node exit 1
/usr/local/bin/rke2 does not exist
id: 'etcd': no such user
Failed to get unit file state for rke2-server.service: No such file or directory
```

### The real clock files

```
check-time: clock synchronised: reference PHC0, stratum 1, bound 454.032 ms (limit 1000 ms)
(rke2-selinux installed, rke2-server enabled)
chronyc sources -> #* PHC0  0  2  377  4  -1ns[-2ns] +/- 13us
kubectl get nodes -> sterling-lab   Ready   control-plane,etcd   v1.37.2+rke2r1   10.0.2.15   containerd://2.3.7-k3s1
```

The time check passed before RKE2 was touched. The first `systemctl enable --now rke2-server` then failed with RKE2's own
"no default routes found": the IPv4 lab VM has no default route, a lab-only condition 47-13 met and recorded. A route via 10.0.2.2 was added
in the guest (QEMU still refuses every outside connection) and rke2-server restarted; the node was Ready 30 seconds later.

### Fixture captures

```
synced   50484330,PHC0,1,1795558776.740226424,0.000000001,-0.000000001,0.000000352,-48.936,-0.000,0.000,0.000000001,0.000018845,4.0,Normal
unsynced 00000000,,0,0.000000000,0.000000000,0.000000000,0.000000000,0.000,0.000,0.000,1.000000000,1.000000000,0.0,Not synchronised
local    7F7F0101,,10,1795559099.320719112,0.000000000,0.000000000,0.000000000,-48.937,0.000,0.000,0.000000000,0.000000000,0.0,Normal
```

`local` came from a test chrony.conf with no sources and `local stratum 10` (the directive form of `chronyc local stratum 10`), captured after
47-25's steps at the end of the run. `vm.sh down` powered the guest off; `vm.sh status` -> `stopped`, lock released.

## Task 2: the clock rules locked by tests

`deploy/test/time.test.mjs`, 6 cases (one per behaviour line), with `far.csv` derived from `synced.csv` by setting only the system time
offset to 2.5 s. The fake chronyc is a sh file in a temporary folder first on PATH; no test needs root or the network.

- chrony.conf on the CI site: exactly `server time1.site.example iburst` and `server time2.site.example iburst`, minsources 2, makestep 1 3,
  rtcsync, cmdport 0, no pool, allow, peer, local or ntstrustedcerts; one source gives no minsources; a refclock line.
- NTS on adds ` nts` to every server and `ntstrustedcerts /etc/chrony-site-ca.crt`; off adds neither.
- Refusals: no source (the message names the GNSS-disciplined appliance or stratum-1 server and "never an internet pool"), no time object,
  malformed servers, refclocks outside PHC, SHM and SOCK (including `SOCK /run/../etc/x` and trailing directives), non-positive or
  non-integer limits.
- clockProblems accepts synced; refuses unsynced (bound 1500.000 ms), local (7F7F0101) and far (bound 2500.019 ms); checkHostClock
  reports a missing chronyc with the OS-repository message.
- check-time.sh agrees with clockProblems on all four fixtures, takes its limit from clock.env, refuses a non-digit limit, exits 2 without a
  folder.
- install-node.sh lists the three clock files and runs check-time.sh after installing chrony.conf and restarting chronyd, before useradd
  etcd, rpm -i, the RKE2 tarball and `systemctl enable --now rke2-server`.

The cases were written after Task 1's code and the lab captures (the fixtures need the lab), so their first run passed; there was no failing
run to keep.

## Verification

- Task 1 automated verify: syntax checks of both scripts and clock.mjs, the CLI on the CI site, exactly two server lines: passes.
- `node scripts/run-tests.mjs deploy/test/time.test.mjs deploy/test/rke2.test.mjs` under the memory cap: 14 run, 14 pass (6 added here;
  rke2.test.mjs unchanged).
- Wave close, `deploy/test/*.test.mjs` with the pinned helm 4.3.2 and cosign 3.1.4 under the cap: 116 run, 116 pass, 0 skipped (render
  tests load the CI site with its new `time` object).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] NTS trust file readable at the time check**
- Found during: Task 1.
- Issue: the plan's `ntstrustedcerts /etc/rancher/rke2/site-ca.crt` names a file install-node.sh writes only after the RKE2 tarball, with
  mode 0600, so chronyd (user chrony) could not read it when the clock check runs.
- Fix: chrony.conf trusts `/etc/chrony-site-ca.crt`; install-node.sh installs the node folder's `site-ca.crt` there with mode 0644 before
  restarting chronyd. It is a public CA certificate.
- Files: `deploy/bundle/lib/clock.mjs`, `deploy/rke2/install-node.sh`. Commit `42b3639b`.

### Lab-only steps (not in the shipped files)

- The default route via 10.0.2.2 (above), as in 47-13.
- `container-selinux` from the Rocky 9 AppStream for `rke2-selinux`, as in 47-05.

## Hand-offs

- 47-16: wire `checkTimeSettings` into the install preflight, `checkHostClock` (`clock.mjs --check-host`) into the import host checks, and
  `writeClockFiles` into the node folder build. Until then G367 stays open.
- 47-17: the runbook line that workstations sync to the same site source (D-71).
- 48.1: drift alerting (node-exporter timex, H-08 row says no change needed here).

## Known Stubs

None.

## Threat Flags

None. The new surface (chronyd on each node) is the plan's T-47-80 to T-47-82: clients only, no `allow`, `cmdport 0`.

## Self-Check: PASSED

- Files exist: clock.mjs, check-time.sh, time.test.mjs, the four fixtures.
- Commits `42b3639b` and `48b8941f` are ancestors of HEAD.

## Open conditions

- G367: air-gapped time is in the node install; the import host check and the preflight are wired by 47-16, and drift alerting is 48.1's.
- G139: your organization's evidence for its time sources and drift requirements (owner).
