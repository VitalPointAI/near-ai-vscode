---
sidebar_label: Which models may do what
sidebar_position: 2
---

# Which models may do what

This page is a short summary for the people who use SovAI and for those who assess it. The
[security policy](./policy.synced.md#which-models-may-do-what) is the full and exact description,
and wins wherever the two seem to differ.

## Approvals by use

- **Every request is checked before it is sent.** An approval names a model, the uses it is
  approved for, the places it may run and the date it ends. Your organization's signed rules hold
  its approvals, its model policy; without them, the approvals SovAI ships are used, and your
  organization's own approval of a model replaces the shipped one.
- **Four uses.** Each request is research only, chat you review, agent work or operational work,
  worked out on this computer from what the request does. A use only rises during a chat. The
  model picker shows each model's origin, family and "Approved for {use} until {date}" or
  "Research only".
- **Your organization's evaluation first.** Under enforce, a model takes any use above research,
  checking roles included, only when its approval cites your organization's evaluation of those
  model files. The shipped approvals carry none, so under enforce nothing goes above research
  until your organization evaluates its models.
- **Where models come from.** A model from a developer in the People's Republic of China is
  approved for research only, and so is a model with no approval. A model under a non-commercial
  licence is research only except through the vendor's own service. Command A+ is approved on the
  Cohere Model Vault, and on your organization's own on-premise copy when your organization
  approves it with the files' hash, never on NEAR AI's private hardware.
- **A refusal sends nothing and says why.** It starts with "Nothing was sent.", names up to five
  models that would pass, and ends with who to ask. Nothing moves your work to another model by
  itself.

## Report only, until your organization enforces

Until your organization's model policy is set to enforce, and on any computer without your
organization's rules, approvals are only reported: the request is sent and recorded as one the
rules would refuse. From the first such request in a session, a notice that cannot be closed stays
at the top of the chat and in the status bar: "Agent work is running outside your organization's
model policy (report only)." Today's models, including those from developers in the People's
Republic of China, keep doing agent work while it shows.

## The Western defaults

The models for each job come from one list of approvals: Nemotron 3, Command A+ and gpt-oss for
writing, IBM Granite as a third small model, and gpt-oss, Nemotron 3 Nano and Granite Guardian for
safety checks, with Whisper for transcription and FLUX.2 klein 4B for images. A model you set
yourself is kept; otherwise your organization's default is used, then the first model in the list
that the AI service offers and the rules allow.

## The research workspace

**SovAI: Open Research Workspace** opens the one place where a model approved for research only,
including an adversary model, is used on purpose. Its banner reads "Research workspace. Adversary
models allowed. No project data." Anything else is refused with "This is the research workspace. It
cannot open project files, run commands or use tools." Files are copied into its own folder first,
text copied out starts with a line naming the model and saying it is untrusted, and its records say
`lane: t0`. The cybersecurity panel and Compare Models' evaluations run in the same research lane.

## Exceptions, checks and records

- **Exceptions.** Under your organization's rules, a named person can allow one research-only model
  to serve chat you review, for named projects and labels, for at most 90 days. The request is
  signed and saved for your organization; it counts only once your organization's rules carry it,
  and then reads "Allowed for chat you review by {name} until {date}". There is no exception
  without your organization's rules.
- **Checks by another family.** The safety check, reviewers, plan checkers, verifiers, editors, red
  team, the staff release guard and the J2 tradecraft reviewer each run on a model of another
  family than the work they check, or a person decides. The record names both families.
- **Records and the AI bill of materials.** Each model request's record names its use, the approval
  by id and hash, and the reason for a refusal. **SovAI: Export AI Bill of Materials** writes a
  CycloneDX 1.6 list of every model a project used, with its licence, lineage and approval.

## Known limits

Each limit is in the [road to production](./road-to-production.md) with its gap id.

- No Western model runs in NEAR AI's private hardware yet (G408).
- Under enforce nothing goes above research until your organization evaluates its models (G410).
- On NEAR AI's private hardware an approval binds to the model's name, not to the exact files
  (G411).
- How NEAR AI passes the publishers' licence terms on is not answered yet (G412).
- The research workspace is kept apart by SovAI's own checks, not by the operating system (G413).
- Exceptions are signed with a device key (G414), and record the mission benefit but no reference
  to your organization's assessment (G537).
- Stop agent work now, a security officer's signed switch to enforce, is not yet available (G418).
