# Developer Experience Contract

When product behavior is underspecified, use this chat experience as the default interaction model.

## Required interaction qualities

- Stream the assistant response and operational status rather than waiting silently.
- Tell the developer what is happening, what changed, what is blocked, what requires approval, and what happens next.
- Make model, provider, route, agent role, token/cost estimate, actual cost when known, and elapsed time visible at the appropriate level of detail.
- Show deployed, active, waiting, completed, failed, and cancelled agent counts during multi-agent work.
- Provide structured interactive prompts and free-form input, with cancellation and resumption.
- Keep a durable activity timeline and resumable conversation history linked to Open-GSD phases and artifacts.
- Make every autonomous boundary interruptible: cancel, pause, approve, deny, retry, skip, or emergency-stop.
- Prefer accessible text/status semantics alongside animation and compact visual affordances.
- Keep a persistent status/info line beneath the conversation with project percentage, phase/plan position, execution state, active agents, and cost/budget context; clicking it should open detailed GSD progress.
- For first-time users, offer a visual “first project” path with plain-language explanations, progress steps, checkmarks, and one clear next action at each stage; expose the underlying GSD command only as an optional advanced detail.

## Default verbosity

The default is fairly verbose for developer-facing operational details. Users may switch to concise mode, but concise mode must not hide approvals, failures, costs, model routing, agent counts, or state transitions.

## Privacy boundary

Analytics store structured metadata by default—not raw prompts, source contents, secrets, or model reasoning traces. The UI may summarize activity and outcomes without claiming access to hidden chain-of-thought.
