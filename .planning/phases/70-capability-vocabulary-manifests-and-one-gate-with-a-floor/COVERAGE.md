No external API integration: a local, offline gate in front of calls the extension already makes; it adds no third-party service, SDK or HTTP API and no new endpoint.

Details. The gate signs its policy with the existing node:crypto signer. Its network use is limited to NEAR AI Cloud endpoints the extension already calls: the response signature and attestation report checks of src/services/attestation.ts, now run once per cloud answer from a TEE model for the trust badge (plans 24 and 26), and, for the pre-send connection binding (plan 25), the same attestation report plus a TLS handshake to the same NEAR AI Cloud host. All of it runs out of band and no gate decision waits on it. "OCSF" and "API Activity" in the plans name a record shape, not a service the extension calls.

Requirement coverage (not an API matrix): all 18 Phase 70 requirements (GATE-01 to GATE-07, OFFL-01 to OFFL-03, CLAS-01 to CLAS-08) are mapped to plans in the coverage table of 70-01-PLAN.md.
