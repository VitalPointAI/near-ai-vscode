# Workbench CI startup evidence

The hosted fixture registers retirement immediately after Docker starts. A health or browser failure still captures whatever evidence is available and attempts cleanup. The first failure stays visible if capture also fails. Complete fixture logs are checked in memory. The diagnostic prints only validated counts, browser and container state, elapsed time, and fixed failure classifications.

The HTTP readiness predicate and polling budget, 90-second Get Started assertion, 15-second trust wait, fixture order and security checks remain in place. The shared Docker helper keeps its existing behavior for other callers. The guide's local secret-store assertions sit outside the revised startup hunk.

## Verification

- Base `558ebeb0d1e10e02bdb7419b225d51991652f5ec`. Independently checked plan SHA-256 `c8e707fed5edb2bb58f8c5c860cfdced0d8c7345e77fb943d6c2c50a395a0b2b`.
- The pre-change injected health and browser cases exposed the raw synthetic failure marker. Follow-up tests showed that an invalid OpenBao response escaped the fixed response classification and that a transport exception exposed the marker.
- All 12 final offline checks passed. They cover hosted and local health and browser failures, retirement and preservation of the first failure when capture fails, rejection of a timed-out private child, both Playwright timeout values, safe audit failure output, and OpenBao setup, transport and malformed response failure. The fixtures stubbed Docker, OpenBao and Playwright. The deadline check spawned an inert Node child.
- The Workbench test project passed strict TypeScript checking on pinned Node 26.13.1 with the lock-matched cached dependencies under the shared heavy-job lock and memory cap. Whitespace checks passed.

| Local evidence | SHA-256 |
| --- | --- |
| `dist/ci-startup-red.log` | `fb2f6e3ad9f62294e1a98cf4cc44c449dcb7201de9ea56ab8c1c9d1831b5d65c` |
| `dist/ci-startup-response-red.log` | `a52af744a9f059debc20e485bb8afcafcd230081f5506b756a29470ffdd42a15` |
| `dist/ci-startup-green.log` | `552022b7c040d0d41c0bbb7843c7aa12a1a93a7911aa32bc28d88a2ee2e93487` |
| `dist/ci-startup-typecheck-final.log` | `9b14a08a7d390a5bc0c7464741c6d1d3f00e1abc176da9dbaadabc46e5e98865` |

## Open conditions

- The real hosted CI suite still needs confirmation on the reviewed head. The underlying intermittent startup failure remains open.
