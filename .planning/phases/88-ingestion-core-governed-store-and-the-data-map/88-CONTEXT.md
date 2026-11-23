# Phase 88 context

## Scope

Phase 88 builds the ingestion core, governed PostgreSQL store and data map on the Phase 85 host. Real organizational data requires the existing Stage 1 gate. Use synthetic sources to verify storage, authorization and concurrency. Phase 100 owns approved departmental connectors and L1b owns full production Theia integration.

## Decisions

- **D-01:** Run the governed API and PostgreSQL as separate services. Theia reads through the API. The inventory opens automatically with authorized records and shows freshness as changes arrive.
- **D-02:** Keep provisional public catalogue entries distinct from verified physical holdings. Each verified asset has a stable DID and may share versioned specifications and imagery with other instances of its model. Copy approved media into governed storage.
- **D-03:** Provide scoped steward create, read, update, archive and restore. Keep credentials for discrete assertions and signed inventory events for assignment, use, custody and corrections.
- **D-04:** Accept thousands of changes as a durable job. Apply bounded transactions in parallel across independent assets. Check record versions, acquire cross-record locks in stable order and keep a transfer or reservation atomic.
- **D-05:** Commit state, signed history, idempotency receipt and outbox together. Advance a source checkpoint only across contiguous durable outcomes. Surface stale edits, conflicting evidence and backpressure. Verify a 10,000-change burst against the synthetic inventory fixture while interactive work continues.

## Canonical references

- [Phase 88 requirements and acceptance](../../ROADMAP.md)
- [Governed data platform](../../research/data-platform/00-DESIGN.md)
- [Source cursors, outbox and reconciliation](../../research/data-platform/01-connectors-extraction-etl.md)
- [Classification and source ACLs](../../research/data-platform/02-classification-tagging-data-centric-security.md)
- [Inventory identity, stewardship and bulk concurrency](../../research/data-platform/05-defence-digital-twin.md)
