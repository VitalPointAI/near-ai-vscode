---
sidebar_label: The trust model in plain words
sidebar_position: 1
---

# The trust model in plain words

This page is a short summary. The [security policy](./policy.synced.md) is the full and exact
description, and wins wherever the two seem to differ.

## What the extension trusts, and what it does not

- **You decide; the agent asks.** Under the default setting the agent reads and searches freely,
  and asks before it changes a file or runs a command. Some actions always ask, in every mode:
  publishing, pushing, signing in or out, and writing into the places where git or the extension
  keep their own settings. See
  [What the agent can do without asking](./policy.synced.md#what-the-agent-can-do-without-asking).
- **Everything from outside is data, never instructions.** Web pages, documents, command output,
  scan results and MCP tool results are fenced as data, hidden text is stripped, likely prompt
  injections are flagged, and after reading outside content, commands that could send data out
  always ask. See
  [Outside content and prompt injection](./policy.synced.md#outside-content-and-prompt-injection).
- **Every message is checked before it leaves.** The emergency stop, the daily spend limit, the
  private-models-only mode and a privacy check on the message itself all run before anything is
  sent. See [The outbound check](./policy.synced.md#the-outbound-check).
- **Your organization's Standing Orders set the ceiling.** A signed policy file, kept in the extension's own
  storage and never in your project, sets the most the agent may do. Your settings can only narrow
  it. Your organization can hand every computer its rules as a signed file, added with **SovAI:
  Add Your Organization's Rules** after you compare twelve words with its security contact; your
  own rules can then only narrow your organization's. **SovAI: Standing Orders** shows the rules in force
  and every proposed change before it is made, and **Reset my Standing Orders** there resets your own rules
  only. See [Your policy file and decision records](./policy.synced.md#your-policy-file-and-decision-records).
- **Labels decide where content may go.** Files, folders and projects carry labels, agents cannot
  read what your clearances do not cover, and a chat's label rises with what its agents read. See
  [Classification labels and routing](./policy.synced.md#classification-labels-and-routing).

## Where answers come from, and how you can tell

Models run either on NEAR AI Cloud or on a model runtime you choose, including one on this
computer. Some cloud models run inside attested private hardware; others are forwarded to another
provider, and the model picker says which. Each cloud answer from the lead agent carries a trust
badge that is set only from checks that actually ran, and a line that says where the answer ran,
what was checked and what allowed it. See
[Which models are private](./policy.synced.md#which-models-are-private) and
[The trust badge on each answer](./policy.synced.md#the-trust-badge-on-each-answer).

## What stays on your computer

API keys live in VS Code's encrypted secret storage. Saved conversations are encrypted in the
project's own state folder, and leave it only as ciphertext, and only after you turn sync on. The
extension sends no telemetry. The full list of what goes where is in
[Where your data goes](./policy.synced.md#where-your-data-goes).

## The Sterling workbench image

The workbench image is a local preview. It has no sign-in of its own and includes a terminal, so
anyone who can reach its port gets a shell inside the container and everything you entered there. Publish it on `127.0.0.1` only; it refuses to
start until you confirm that. Pull it by the digest the GitHub release records, so you run exactly
the image that was tested and approved. Sign-in for each person comes with hosting at your
organization's own sites, which is planned and not yet released. See
[Getting started](../using/getting-started.md#run-the-sterling-workbench-image).

## Limits

Labels and routing are an organizational control that helps prevent mistakes; they are not an
accreditation. What the extension does not protect against yet is listed in
[Known limitations](./policy.synced.md#known-limitations). Every known gap and open condition, and
what changes at each higher classification level, is listed in
[Road to production and higher classification](./road-to-production.md). To report a problem, see
[Reporting a vulnerability](./policy.synced.md#reporting-a-vulnerability).
