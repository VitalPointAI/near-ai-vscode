---
phase: 46-native-theia-foundation
plan: rail-feedback
completed: 2026-11-26
---

# Workbench shortcut feedback

When an enabled sidebar shortcut fails to open, Workbench shows the shortcut name and a retry message. The rail also announces the message through a persistent status region and leaves keyboard focus on the shortcut. Chat keeps its existing panel animation and collapse path.

Independent plan and source review passed. The focused Get Started browser scenario reproduced the missing Chat toast against the original code, then passed against the production build with the change. It verified normal navigation, keyboard activation, visible feedback, live status, focus, retry availability and mouse activation. Workbench lint passed on Node 26. The local browser run used an isolated loopback workspace with no bundled extension. The existing release-image navigation scenario remains in the release verification suite.

## Open conditions

None.
