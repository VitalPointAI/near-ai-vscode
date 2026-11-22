# Controlled goods and ITAR

Last reviewed: 2026-11-21

Meeting the Controlled Goods Program and the ITAR is your organization's obligation. This page
shows what the product does and what it leaves to you. Your counsel and your designated official
and empowered official decide.

The Controlled Goods Program is Canada's, under Part 2 of the Defence Production Act and the
Controlled Goods Regulations, administered by Public Services and Procurement Canada. The ITAR are
the United States' International Traffic in Arms Regulations (22 CFR parts 120 to 130). The US
Export Administration Regulations (EAR) are named here too, because the product marks them the
same way. The wording on this page is ours, not the regulators'. For the official text and
guidance, see the [PSPC guidance on using and providing cloud solutions](https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/program-requirements/guidance-using-providing-cloud-solutions.html)
and [22 CFR part 120](https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120).

In our reading, which your counsel should confirm, sending controlled technical data to an AI
model can be a transfer or an export to whoever runs that model, because the model must read the
data to answer. That is why the product's starting rules keep such content on this computer.

## What the product does

- **Three markings.** Content can be marked Controlled goods (Canada), ITAR, or US
  export-controlled (EAR), shown after its level, for example "Organization: Internal · ITAR". In
  policy files and records they are the compartments `CGP`, `ITAR` and `EAR`. **NEAR AI: Set
  Label** marks a file, a folder or the project.
- **Marked content stays on this computer under the starting rules.** The starting rules route
  all three markings to local-only, so content that carries one goes only to a model on this
  computer. A fresh install gets these entries. An install upgraded from an earlier version whose
  starting rules nobody edited gets them when its policy is next renewed, in the last 30 days
  before it ends; until then those markings are routed by their level. A policy someone edited is
  not changed in place; it gets them through a change on the policy page.
- **No network calls from a marked chat.** While a chat holds content routed local-only, a web
  fetch, a web search, an add-on server call or a command that could send data off this computer
  is refused, in every mode.
- **Room for your officials' decisions.** Your organization's signed rules can already carry its
  export-control decisions: who may see controlled content (an `export-person` authorization, at
  most five years) and which AI service may receive it (an `export-endpoint` authorization, at most
  365 days), with the rule `route.export-control`. In this version these are shapes that are read
  and recorded only; they never decide a request. Enforcement, with records, retention and
  incidents, is planned for Phase 45.
- **Everything is in the security policy.** The section
  [Export-controlled content](../../SECURITY.md#export-controlled-content) of the security policy
  is the authority on what this version does.

## What it does not do

- **It decides no one's eligibility.** The product does not decide who may examine, possess or
  receive controlled goods or technical data. Registration, assessments, licences, agreements and
  exemptions are your organization's, and clearances in the product are declared, not verified.
- **It gives no endpoint a legal basis.** The product does not say that any model service,
  server or provider may receive controlled content. Only your organization's officials, with
  counsel, can decide that, and the product does not yet use such a decision to allow anything.
- **It cannot stop a person pasting content elsewhere.** A person who can open a file on their
  computer can copy it into a browser, another tool or a message. Preventing that is your
  organization's data-loss and training responsibility, enforced by its devices, sites and
  security plan.
- **Unmarked content is treated by its level only.** The markings apply only to content someone
  has marked. Deciding what is controlled, and marking it, is your organization's.
- **It does not report.** The product never reports a breach or makes a disclosure to a regulator.
  Reporting duties stay with your organization.
- **Some questions are unsettled.** Whether a model running in a trusted execution environment
  that its operator cannot read counts as no release to that operator has no official answer, and
  neither does encrypted storage of controlled data at a third party (such as an encrypted copy on
  a git host or your organization's hub). The product treats both as unsettled and counts neither
  as eligible by itself. Your organization records its own legal basis, if it has one.
- **It does not make your organization meet either regime.** Nothing in the product, this page or
  the Accreditation pages is a finding about your organization.

## Interim settings

Until enforcement arrives, these settings exist on `main` today. Each is an option your
organization's officials may choose for their own system:

1. **Mark controlled content.** Mark controlled files and folders with the compartments `CGP`,
   `ITAR` or `EAR` through **NEAR AI: Set Label**.
2. **Keep marked content on this computer.** In your organization's signed policy, keep
   `routing.compartments` for those three markings at `local-only` (the starting rules' value), and
   keep the list of places where AI may run (`endpoints`) empty or limited to servers your officials
   have approved.
3. **Keep agents away from it.** Add the `no-agent-tools` handling flag to those labels, so agents
   do not read the content at all.
4. **Do not share it.** Do not share projects that hold such content through Team Mode, a
   multi-user staff project or the messaging relay.

This page is not legal advice; your counsel and your officials decide.
