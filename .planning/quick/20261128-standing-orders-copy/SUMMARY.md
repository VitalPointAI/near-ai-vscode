# Standing Orders terminology verification

The editor, its palette command, status, setup and policy actions now use **Standing Orders**. The direct Workbench shortcut uses **Standing Orders** in Canadian English and **Ordres permanents** in Canadian French. The Features and settings, Getting started, Administration and trust-model guides use those labels. The separate [security guide follow-up](SECURITY-DOCS-FOLLOWUP.md) tracks legacy captions in the protected source and its rendered copies.

The branch starts from integration commit `10e2a8578dcd346b9ca60bd3f9d8d7fe3dbe9077`, which contains the verified diagnostic on #255 and the approved installer wording. The reviewed plan has SHA-256 `2085516d90ce81dea22ea3d42f146ef6f19a09ec2f70489a1832452b6f212e9e`.

## Verification

- Both existing editor fixtures reproduced the old title on the pre-change source. Before that assertion, the exact no-store and bad-signature audit reasons, draft origin and fixed proposal hash matched their baseline values. All of those comparisons passed after the rename, including the unchanged actionable no-store message and refusal to write or sign.
- Strict TypeScript checks passed for the extension test graph and Workbench extension. All 263 focused tests passed across nine extension suites and the two Workbench offline documentation suites. The webview script passed syntax checking. The Workbench dependency lock matched the existing read-only donor. Node 26.13.1 checks shared the heavy-job lock and a 4 GB memory cap.
- A source comparison verified only four manifest titles changed, the Workbench shortcut still targets `nearAi.policy.open`, and the gate, agent, installer, protected `SECURITY.md` and historical changelog have no diff. Raw reasons and proposal data stay in their original form. Legacy labels in protected documentation and shared recorded reasons remain separate.
- The Workbench locale passed type checking and the shortcut labels were checked against source.
- Private native browser verification used combined source `eebf9517bd8dd6532ae94fdab66b162e93a09226` with the published v0.4.43 extension. The existing French Get Started language case passed. The English rail labels passed on the first run, which later failed its Chat assertion because the test harness described the bundled extension as unbundled. With the bundled flag corrected, the targeted English rail case passed once with zero skips.

| Local evidence | SHA-256 |
| --- | --- |
| `dist/standing-orders.vSdyUt/red.log` | `7349b40de3e61f3560b559b9a555d425c27e26f3ca49899df08edb9cfda17902` |
| `dist/standing-orders.vSdyUt/final.log` | `0846ae945b26f8b2938b84f038194b1681f7ef418aa3533f5877f7fbea2df6b7` |
| `sovai-feedback-live.cpr2v6/standing-check/standing-rail-browser.log` | `c7b7dd671c0ad37b3cfb5c6a1baee8393ee2e2e406ab723b4a39d90aa49c4a38` |
| `sovai-feedback-live.cpr2v6/standing-rail2/rail-retry.log` | `879dd1e5c2883750566a07f4b3aafee0c1dd37547a03b470eb147e4bdedfcf4a` |

The #258 review fix reproduced one display-copy failure with 32 other checks passing. After the fix, 116 focused extension checks and eight bundled Workbench documentation checks passed with zero skips. The actual offline renderer retained the former Administration heading ID, and the policy webview script passed its syntax check.

## Open conditions

- Browser verification of the revised extension editor remains open. The native rail runs used the published v0.4.43 extension.
- G561 remains open for qualified Canadian French review and broader coverage.
