# Phase 05 Plan 03 Research: NEAR AI Wallet Entitlements

## Scope

Ground the non-custodial wallet, verified staking, entitlement-status, and safe transaction-preview boundary for the Phase 5 account-entitlement requirement.

## Official findings

- [NEAR AI Cloud Terms, Appendix A — Cloud Staking](https://near.ai/terms-of-service) defines staking as non-custodial: the customer retains ownership and control of the staked NEAR and wallet private keys, while credits may accrue through a validator. The terms also state that balances/credits may be reflected with delay, that organization-scoped credits may be shared, and that unstaking has an unlock period.
- [NEAR AI’s staking announcement](https://near.ai/blog/staking-for-near-ai) describes wallet-native staking for compute credits, separate staking formulas for confidential inference and agent hosting, and a wallet-owned lifecycle for stake changes. It does not publish a stable extension-facing entitlement API or a validator/contract allowlist in the material reviewed.
- [NEAR Wallet Selector’s official API](https://github.com/near/wallet-selector/blob/main/packages/core/docs/api/wallet.md) documents external-wallet `signIn`, account discovery, browser-wallet callbacks, and `signAndSendTransaction(s)`. The wallet API signs and submits user-approved actions; the extension must never receive or store private signing material.
- [NEAR’s official core-contracts repository](https://github.com/near/core-contracts) and [near-cli staking guide](https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md) document the reference staking-pool lifecycle: deposit-and-stake, unstake, and withdrawal after the protocol delay. The configured NEAR AI validator/pool and method arguments must come from a verified product configuration, not user-entered arbitrary receiver IDs.
- [NEAR account data documentation](https://github.com/near/nearcore/blob/master/docs/DataStructures/Account.md) distinguishes liquid/unlocked and locked/staked balance. Read-only status must preserve that distinction and must not convert unavailable provider data into zero.

## Design implications

1. Keep wallet authorization and entitlement state in a separate `StakingService` boundary; it must not depend on `AuthService`, `ProfileStore`, or NEAR AI API-key dispatch.
2. Verify the selected network, signer account, validator/pool receiver, configured method, amount, gas, and attached deposit before creating a transaction preview. Bind the exact preview to the existing approval/audit boundary and require a fresh user confirmation immediately before calling the external wallet.
3. Treat the official entitlement configuration as an input contract. If the release configuration does not contain a verified network, RPC, validator/pool, entitlement endpoint, and supported method definitions, reads are unavailable and writes are denied.
4. Store only account label, network, verified validator, amount, transaction ID, timestamps, bounded status, and outcome in local history. Never store keys, seeds, wallet callback secrets, API keys, profile credentials, prompts, or transaction signing payloads.
5. Render `fresh`, `stale`, and `unavailable` explicitly. A stale last-known snapshot may be shown with its timestamp and error; no synthetic balance or credit value is permitted.

## Package legitimacy audit

No package installation is planned for this slice. The wallet implementation is an injected external-wallet bridge so the extension can fail closed if the official NEAR AI wallet callback/configuration contract is absent. The Wallet Selector API is used as the protocol reference; adopting its packages later requires a fresh package-legitimacy check before changing the dependency graph.

## Open integration precondition

The official NEAR AI staking configuration must provide the current network, RPC, validator/pool account, supported staking method definitions, entitlement read endpoint, and callback/transaction status contract before production writes are enabled. The implementation plan intentionally does not invent these values.
