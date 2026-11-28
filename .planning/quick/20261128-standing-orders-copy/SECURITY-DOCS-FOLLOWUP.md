# Standing Orders wording in the security guide

The protected `SECURITY.md` still uses the previous Command Palette, button and page names. The documentation site synchronizes that source into its Security policy page. Workbench Documentation also renders that source. The Administration guide now explains the old and current names.

Carry the source wording correction into the next combined gate review. Update the visible instructions and editor names in `SECURITY.md`, then verify both generated copies. Update exact-caption assertions for that document alongside the wording. Preserve the existing scope of reset, proposal and signing actions, as well as the historical wording in signed records.

The review on #258 identified this difference. Changing the protected source needs its own gate approval. [Review finding](https://github.com/VitalPointAI/near-ai-vscode/pull/258#issuecomment-7241060022)

The separate protected candidate updates the visible captions and restores the exact guide checks. The regression first failed on the missing current command. TypeScript and all 55 guide checks then passed. The actual docs-site sync and Workbench renderer both showed the current labels and kept the existing section anchor. Historical decision and signing wording remain intact.

## Open conditions

- The protected documentation candidate needs the combined gate and exact owner approval. G561 remains open for qualified Canadian French review.
