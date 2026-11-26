---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 35
status: complete
completed: 2026-11-26
---

# Offline lab-core configuration

The isolated lab has a checked site template and four release overrides. The existing site loader refuses the template until the operator supplies the lab bundle signing public key in a separate run directory. The template uses the restricted VM network, one Zot registry and hub, a static storage class on the encrypted VM disk, and the KVM PTP clock as its only time source.

The offline check exercised the pinned nginx placeholder, the single OpenBao replica and token volume reference, and the Theia Cloud lab hosts. It used the normal realm validator for the lab HTTPS redirects, passkeys and notices in English and French. The OpenBao descriptor supplied its ordinary image reference for this render. Plan 47-18 still needs the exact signed lab-only image and the token volume it will use. The placeholder has no Workbench activity tracker, so validation covers the configured idle timing only.

The new render check first failed because the lab site file was missing. After the files were added, all seven site render checks passed. The final offline run passed all 66 related render, realm and clock checks using Helm 4.3.2 and Node 26.13.1, with no skips. One regression check was added. The run used the existing render fixture's public key. It did not build or install any images, start a VM, sign a bundle, or contact a live realm.

## Open conditions

- G423: Plan 47-18 must install the complete lab-core release set from the exact signed bundle in the isolated VM, verify passkeys and the session lifecycle, and walk the install and recovery runbooks against the observed results.
