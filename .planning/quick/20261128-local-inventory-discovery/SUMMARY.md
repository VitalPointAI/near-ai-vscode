---
status: complete
---

# Local Resource Inventory discovery

Source `50f1fb45037cff342a4ea2dd66f9ecadb31da2ae` adds one Canadian English and French shortcut below the Get Started work-area cards. It invokes the existing native Resource Inventory command without a work-area link request. The Resource Management card still opens its own page. Getting started includes the direct route, Command Palette entry and local snapshot location in the existing offline guide bundle.

## Verification

- Independent plan review accepted SHA-256 `5017f40cb8c2b8a24215e6b29e51b2fb22e80ff360f967c0f41ecc4685eaf695`. The tests-first browser run against the verified base tree `8d5935c07f73e9ee0ae4df3c3da496baca4de38b` failed at the missing shortcut. Evidence `.scratch/inventory-discovery.QhWabv/red/browser.log`.
- Capped Workbench lint and production build passed on Node 26.13.1 under ordinary UID 1000 in a network-isolated environment. A first browser startup stopped before navigation because the lock-matched scripts-disabled dependencies lacked the native drivelist addon. The final build reused the byte-identical addon from the previously verified exact-base build without acquisition. Logs are in `.scratch/inventory-discovery.QhWabv/green/` and `.scratch/inventory-discovery.QhWabv/verified/`.
- The focused private loopback Playwright case passed once in 9.3 seconds with zero skips. It verified both localized labels, narrow layout, keyboard entry from French, the actual restricted-workspace guidance, no display of the valid fictional row and restoration to English. The unchanged inventory parser accepted the fixture, and its on-disk hash remained unchanged. The new guide text appears in the built offline documentation bundle. Final browser evidence SHA-256 `e0632454014711bd1573f20678e7972b8bba6513e3523fa26d3b994b6bfbb9e3`.

## Open conditions

- **G561** remains open for qualified Canadian French review and broader Workbench parity.
- **G62** remains open for source permissions in the governed Data Map. Its reader-specific view and Data Management rail still follow Phase 88. This shortcut uses the existing trusted local inventory boundary.
