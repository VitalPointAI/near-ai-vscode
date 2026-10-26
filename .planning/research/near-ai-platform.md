# NEAR AI platform notes

Source: [NEAR AI documentation](https://docs.near.ai/), accessed 2026-10-25.

- NEAR AI Cloud documents private inference in Trusted Execution Environments and an OpenAI-compatible API.
- The documentation index lists model discovery, model pricing, streaming chat completions, a stateless Responses API, usage reporting, cost-by-request-ID, and verification/attestation APIs.
- The docs also list JavaScript, Python, Rust, and Go SDKs, plus integrations with coding tools.
- Product implication: keep the provider boundary OpenAI-compatible, but preserve a NEAR-specific adapter for pricing, usage, verification, and authentication details.
- Security implication: show verification/attestation state as evidence, not as an unconditional privacy claim; handle unavailable verification explicitly.
