---
phase: "88"
slug: "ingestion-core-governed-store-and-the-data-map"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-23"
---

# Phase 88 validation

## PostgreSQL mechanics checked

Four isolated PostgreSQL 18 checks used generated records and ordinary PostgreSQL transactions.

- Two writers attempted to reserve the final unit of the same asset. One succeeded. A read and a write on an independent asset completed while the first transaction held the lock.
- Duplicate replay did not create another receipt or outbox entry. Rolling back a transaction cleared its state, receipt and outbox, and retry applied the change once.
- Workers applied 10,000 fixture changes in 500-record chunks. This was a database smoke check and supplied no service throughput or latency budget.
- A completed position beyond a gap left the checkpoint in place. Filling the gap advanced it across both dispositions. Terminating a worker before commit rolled back its disposition and cursor update, and replay resumed from the prior checkpoint.
- A rejected destination update rolled back its source decrement. Opposite transfers acquired locks in the same key order and preserved the total quantity.
- A worker with an expired lease could not write state, outbox, or checkpoint effects after a replacement worker reclaimed it. The active claim committed those effects together.

## Phase acceptance still pending

Run each plan's automated check after its relevant task. Run the full relevant suite once after the waves integrate. Use PostgreSQL 18 for transaction, concurrency and row-level authorization tests. Use approved Phase 85 hardware and the complete service path for the performance gate.

| Requirement | Required evidence |
| --- | --- |
| DATA-01, DATA-02, DATA-04 | Connector resume, duplicate and out-of-order delivery, contiguous checkpoint, crash before and after commit, bounded retries, and rejection of a stale worker after its lease is reclaimed. |
| DATA-03, DATA-05, DATA-06, DATA-08 | A synthetic folder fills the data map. Lifecycle transitions, degraded recovery, permissions, freshness and reconciliation stay visible at their intended scope. Fail the final run if measured backfill or delete, rename and permission changes exceed the approved freshness budget. |
| DATA-07, DSEC-01, DSEC-02, DSEC-03 | Prove that a denied or unavailable gate blocks all real source I/O, including preapproval metadata reads. Prove dry-run and metadata-only behavior, no restricted records or facets, stale ACLs hidden, signed governance events and no canary content in logs or caches. |
| INV-03 | Verify scoped catalogue and asset lifecycle, version conflicts, shared model records, stable per-instance DIDs, and an approved image available from stored bytes after upstream removal. |
| INV-04 | Apply 10,000 changes against the 100,000-entity fixture with concurrent interactive operations. Verify atomic signed audit and outbox, stock and transfer invariants, checkpoint recovery and scoped live updates. Record throughput, lock wait, p95 interaction latency, backlog drain and projection lag. |

Phase 88 planning and implementation verification have separate evidence. The database checks above cannot satisfy the service-path or host performance acceptance.
