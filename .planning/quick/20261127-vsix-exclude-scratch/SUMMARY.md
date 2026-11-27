# Exclude local scratch from the VSIX

The root `.scratch` directory is now excluded by `.vscodeignore`. A local branding build had included 95 scratch entries while passing the release content verifier. This fix keeps local verification notes and other scratch files outside the extension package.

Before the change, the lock-matched `vsce ls --no-dependencies` listed the harmless sentinel. Afterward, all root scratch entries were absent and the complete list was byte-identical to the baseline with scratch entries filtered out. The known shipped `media/policy/policy.css` remained present. The changed paths do not trigger the protected-gate classifier.

## Open conditions

No new gap ID required. The normal PR queue and release packaging checks still apply.
