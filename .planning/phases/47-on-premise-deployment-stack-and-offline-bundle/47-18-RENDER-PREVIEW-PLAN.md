---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 18-render-preview
type: execute
wave: 9
depends_on: ["47-35"]
autonomous: true
requirements: [DEP-12, DEP-01]
files_modified:
  - deploy/lab/render.mjs
  - deploy/test/render-site.test.mjs
must_haves:
  truths:
    - "The lab preview validates the entire planned lab-core release selection with the reviewed site defaults and overrides."
    - "The preview reports unresolved image pins and supplies no persistent install state or manifests."
  artifacts:
    - path: deploy/lab/render.mjs
      provides: offline validation of planned lab releases
  key_links:
    - from: deploy/lab/render.mjs
      to: deploy/bundle/lib/render.mjs
      via: existing descriptor and offline render contract
---

# Preview the complete lab-core release selection

<objective>
Verify the fully assembled lab-core site configuration before a signed bundle or a live VM is involved. This preparatory task uses the exact verified 47-35 result in an isolated child branch. Its submission waits for 47-35 on main.
</objective>

Run `node deploy/lab/render.mjs --public-key <lab-public-key.pem>` from the repository checkout with the pinned Helm tool. This is a render preview. It reports the selected releases and unpublished images.

<tasks>
<task type="auto" tdd="true">
  <name>Resolve, materialize and check all 18 lab-core releases offline</name>
  <files>deploy/lab/render.mjs, deploy/test/render-site.test.mjs</files>
  <read_first>Read Plan 47-18 Task 1, the completed 47-35 template and overrides, install descriptor handling, the existing lab render test and the Keycloak realm preparation path.</read_first>
  <action>Use the exact 18 releases in existing descriptor order. Require zot, sterling-network, kyverno, sterling-admission, cert-manager, sterling-pki-bootstrap, kubernetes-ingress, openbao, sterling-pki, sterling-postgres, sterling-keycloak-theme, keycloakx, sterling-keycloak-realm, theia-cloud-crds, theia-cloud-base, theia-cloud, sterling-sessions and sterling-hub. Exclude harbor, longhorn, sterling-storage, opensearch, fluent-bit and prometheus. Confirm every required release is enabled and require one hub, Zot and lab-static storage. Copy only the selected release overrides and required example defaults to private scratch. Require exactly one valid public PEM before adding it to the scratch site file. Refuse private or malformed PEM without printing its contents. Remove the generated scratch on success and failure. Align the registry address with the Zot bootstrap node port from the reviewed site defaults and verify the rendered service agrees. Use the normal offline renderer and rendered invariants, and the normal realm validator for settings the chart receives at apply time. Print a preview report with the ordered releases and unresolved local image entries. The report must say that signed lab-only OpenBao, VM storage capacity and real install remain unverified. The copied Zot and Postgres defaults are production-sized examples. Reuse this selection as an input to the later signed lab workflow. The preview alone confers no install authority. Keep production render, import, preflight and apply paths intact. Later install work still needs exact signed image selection and admission checks.</action>
  <verify>
    <automated>Use the existing render test to drive the CLI with the public fixture key and pinned Helm. Assert the exact ordered allowlist, exclusions, private/malformed PEM refusal and scratch cleanup. Run under the shared heavy lock and 6 GiB cap. `env HELM="$PWD/compliance/out/tools/linux-amd64/helm" node scripts/run-tests.mjs deploy/test/render-site.test.mjs`.</automated>
    <fails_when>Any of the 18 releases is omitted, an excluded service appears, the bootstrap registry disagrees with Zot, a required override is missing, a normal rendered invariant fails, or published-image readiness is implied for unpublished digests.</fails_when>
  </verify>
  <done>The full lab plan renders offline. No live install, passkey, bundle or recovery acceptance is recorded.</done>
</task>
</tasks>
