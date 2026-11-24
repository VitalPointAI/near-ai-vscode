# Incident response plan

Last reviewed: 2026-11-24

This plan says what the maintainers of Sterling Sovereign AI do when someone reports a security
problem in the product, from the first report to telling users, and what stays with your
organization. It covers the extension, the Sterling workbench image that ships it, the messaging
relay (`relay/`) and the sync hub (`hub/`) in this repository, and the pipeline that releases
them. It does not cover NEAR AI Cloud, other model providers, GitHub or its Container Registry, or
the Visual Studio Marketplace that hosts versions before 0.4.37, which run their own processes.

The response times below are the maintainers' commitment for the supported versions listed in
the [security policy](../../SECURITY.md#supported-versions). They are a published commitment, not a
contract.

| Step | Commitment |
| --- | --- |
| Acknowledge a report | Within 7 days of the report |
| A high or critical issue | A fix, or a published mitigation, within 30 days of the report |
| A medium or low issue | Fixed in a normal release, in the order the maintainers set |

## Reporting

- **Where a report arrives.** Reports come through GitHub's private vulnerability reporting, on
  the repository's **Security** tab with **Report a vulnerability**, as the security policy says
  under [Reporting a vulnerability](../../SECURITY.md#reporting-a-vulnerability). Only the
  maintainers see the report.
- **When that page is not offered.** The reporter opens an issue that asks only for a private
  way to send a report, with no details of the problem, and a maintainer replies there.
- **What is never asked for.** API keys, raw prompts, private file contents or recovery codes.
  A maintainer who receives one in a report treats it as exposed and asks the reporter to replace
  it.
- **A report found another way.** A problem a maintainer, a review or a scan finds is handled the
  same way: it is opened as a private draft advisory, not as a public issue.

## Triage

1. **Acknowledge.** A maintainer replies to the reporter within 7 days, says the report was
   received, and names who handles it.
2. **Reproduce.** The maintainer reproduces the problem on the newest release and on `main`, and
   records which components (extension, relay, hub, release pipeline) and which versions are
   affected.
3. **Rate the severity.** The maintainer rates it critical, high, medium or low from what an
   attacker gains and what they need first, using the CVSS 3.1 or 4.0 base metrics as a guide:
   - **Critical:** a remote attacker, with no help from the user, reads or changes a project's
     code, keys or state, or runs code on the user's computer or an operator's server.
   - **High:** the same with one ordinary user action, or a check the security policy describes
     (the outbound check, the route check, an approval, a signature check) can be bypassed.
   - **Medium:** a leak of limited data, or a bypass that needs local access or an unusual setup.
   - **Low:** hardening, or a problem with little effect.
4. **Decide the path.** Critical and high issues get the 30-day commitment and a security
   advisory. A problem outside the product (in NEAR AI Cloud, a model provider, VS Code, GitHub or
   a dependency) is reported to its owner, and the maintainers publish a mitigation where the
   product can add one.

## Fix and advisory

- **Fix in private.** The fix is made in a private draft security advisory and its temporary
  private fork, so the problem is not public before a release carries the fix.
- **Same gates as every change.** The fix reaches `main` through a pull request with CI, the
  security and code review, and the owner's approval for gate files, as described in
  [How changes reach a release](../../SECURITY.md#how-changes-reach-a-release). An urgent fix for an
  older release is a hotfix branch, as the development workflow describes under
  [A bad version reached users: hotfix](../development-workflow.md#a-bad-version-reached-users-hotfix).
- **A test for the problem.** The fix carries a test that fails without it.
- **Mitigation first when a fix takes longer.** When a fix cannot ship within 30 days, the
  maintainers publish a mitigation: a setting or a step that removes the risk, in the advisory
  and in the security policy.
- **Advisory.** When the release with the fix is out, the maintainers publish the GitHub security
  advisory with the affected and fixed versions, the severity, the mitigation and credit for the
  reporter when they want it, and request a CVE identifier through GitHub where one applies. The
  advisory gives only the detail users need to judge the risk and update.

## Rolling back a release

- **No release is changed in place.** Release tags are never moved, reused or deleted, and the
  Release workflow refuses to push a different image under a version that is already in the
  registry. A bad release is replaced by the next patch version: a fix, or a revert of the change
  that caused the problem.
- **What the release workflow allows.** A tag on a reviewed commit of `main`, or on the head of
  `hotfix/<version>`, starts the Release workflow. It builds the VSIX, builds the Sterling
  workbench image with that VSIX inside, starts the image and checks it, and then waits. Pushing
  the image to the GitHub Container Registry runs only after the owner approves it in the
  protected `container-release` environment. The GitHub release then records the image digest
  beside the VSIX, its SHA-256 checksum and the assessor package.
- **What needs the owner.** Approving the image publication, and removing an image version from
  the GitHub Container Registry when that is needed, are the owner's steps. Agents and the
  repository's scripts never take them.
- **What a user can do at once.** Stop the container and start the earlier release's image by the
  digest its GitHub release records. In VS Code, install the earlier release's VSIX with
  **Extensions: Install from VSIX...**. For versions before 0.4.37, which came from the Visual
  Studio Marketplace, **Install Specific Version** in the Extensions view still works. The
  advisory names the version to go back to.
- **The relay and the hub.** Your organization builds and runs these from this repository. To go
  back, its operator checks out the earlier release, rebuilds and restarts the service, following
  the upgrade and restore steps in the [operator guide](../../relay/README.md). The hub refuses a
  store that a newer hub wrote; the operator restores the backup taken before the upgrade.

## Telling users

- **The advisory.** The published advisory on the repository's **Security** tab is the main
  notice. Anyone can watch the repository for security alerts to be told when one is published.
- **The release.** The release notes and the CHANGELOG of the fixed version name the advisory.
- **The security policy.** When a problem is fixed only in part, or needs a step from users, the
  security policy's "Known limitations" table says so until it is fully fixed.
- **No message from the product.** The extension sends no telemetry and has no way to message its
  users, so the maintainers cannot tell who is affected. The advisory, the release and the
  security policy are the channels.
- **The reporter.** The reporter is told before the advisory is published and is asked how they
  want to be credited.

## Your organization's part

The product's plan covers the product. Your organization's own incident response stays its
responsibility, and this plan does not replace it. In particular, your organization:

- keeps its own incident response plan, contacts and reporting duties for the systems it runs
  with this product;
- watches the repository's advisories and applies fixed versions on its computers, and rebuilds
  the relay and the hub it runs when a fix covers them;
- handles an incident on its own computers or servers: a stolen device, a leaked API key or
  recovery code, an exposed relay or hub, or content sent where it should not have gone. The
  security policy says what each key and code protects, so your organization can judge what to
  replace;
- reports any breach to the people and regulators it must tell. The product never reports to a
  regulator for your organization.

A suspected problem in the product itself goes to the maintainers through private vulnerability
reporting, as above.
