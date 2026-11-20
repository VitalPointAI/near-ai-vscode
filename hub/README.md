# Your organization's sync hub

The sync hub is a small service your organization runs to carry shared staff projects between the computers of the people who work on them. It checks every change against the project's member list, reads only that list and the parts of a project the staff lead grants it, keeps everything else as ciphertext, holds no model credential and opens no outbound connection.

It runs as its own service, under the profile `hub`, in the relay's Compose file: the operator guide is [relay/README.md, "Your organization's sync hub"](../relay/README.md#your-organizations-sync-hub), and what the hub can and cannot read is in [SECURITY.md](../SECURITY.md#your-organizations-sync-hub).
