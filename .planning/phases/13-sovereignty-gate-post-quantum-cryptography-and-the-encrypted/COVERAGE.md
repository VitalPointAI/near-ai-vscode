# API Coverage — NEAR AI Cloud model API and the vendored post-quantum libraries (Phase 13)

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Every NEAR model-calling capability below is reached only through TeeGatedClient (plan 13-03) at the provider seam (plan 13-07).

| capability | decision | reason |
|---|---|---|
| NEAR streaming chat completions (streamChat, streamChatEvents, streamCompletion) | INTEGRATE | |
| NEAR image analysis through chat (describeImage) | INTEGRATE | |
| NEAR audio transcription (transcribeAudio) | INTEGRATE | |
| NEAR image generation (generateImage) | INTEGRATE | |
| NEAR image edit (editImage) | INTEGRATE | |
| NEAR embeddings (embed, POST /embeddings) | INTEGRATE | |
| NEAR rerank (rerank, POST /rerank) | INTEGRATE | |
| NEAR model list (GET /models) | INTEGRATE | |
| NEAR model pricing (GET /models/pricing) | INTEGRATE | |
| NEAR model privacy metadata (GET /model/list) | INTEGRATE | |
| NEAR response attestation verification (verifyResponse) | INTEGRATE | |
| NEAR billing costs by request id (actualCostUsd, reconcileUsage) | INTEGRATE | |
| Local OpenAI-compatible runtime models and chat (loopback only) | INTEGRATE | |
| NEAR video generation, status, content, cancel | OPT-OUT | NEAR documents no video endpoint; project decision forbids inventing one (Phase 06) |
| NEAR Anthropic-compatible /v1/messages | OPT-OUT | serves only Anthropic-forwarded models; never TEE, excluded by the 2026-10-26 decision |
| NEAR account sign-in and token exchange | OPT-OUT | deferred until NEAR documents a token-exchange contract (2026-10-26 decision) |
| noble X-Wing hybrid KEM ml_kem768_x25519 | INTEGRATE | |
| noble ML-DSA-65 sign and verify with context | INTEGRATE | |
| noble ML-DSA-44 and ML-DSA-87 | OPT-OUT | category 3 ML-DSA-65 matches ML-KEM-768; suite id allows a later level for new segments |
| noble standalone ML-KEM-512, ML-KEM-768, ML-KEM-1024 | OPT-OUT | every key wrap must be hybrid, so only X-Wing is used |
| noble SLH-DSA | OPT-OUT | large signatures and no requirement; tree-shaken out of the bundle |
| noble Falcon | OPT-OUT | not needed; tree-shaken out of the bundle |
| noble combineSigners helper | OPT-OUT | rejects a context and has no domain separation; own labelled AND composition used |
| noble-hashes argon2 | OPT-OUT | unaudited pure JS and slow; scrypt chosen (DR-13-06) with a kdf id for Argon2id later |
| scure-bip39 English mnemonic to entropy and back with checksum | INTEGRATE | |
| scure-bip39 mnemonicToSeed (PBKDF2 seed) | OPT-OUT | the 256-bit entropy is used directly for HKDF derivation (DR-13-05) |
| scure-bip39 non-English wordlists | OPT-OUT | one frozen English wordlist keeps recovery phrases portable across installs |
