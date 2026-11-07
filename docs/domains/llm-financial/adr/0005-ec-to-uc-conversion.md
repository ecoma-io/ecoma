# ADR-0005 — EC→UC cross-tenant conversion và dual authorization

Status: Accepted (conversion ratio/fee OPEN).

Context: Operation vượt qua financial boundaries của source Seller tenant và destination Console tenant.

Decision: Internal LLM Financial operation, không phải fiat Payment/Payout. Yêu cầu: cùng authenticated Identity sub hành động ở cả hai phía; active membership ở source Seller tenant; payout permission ở Seller tenant đó; active membership ở destination Console tenant; payment permission ở Console tenant đó; cả hai tenant active; source EC available và không held/reserved; idempotency và financial invariants. Authorization: same_identity AND seller_tenant.payout AND console_tenant.payment (independent tenant scopes). Backend derive actor từ verified authentication; client-supplied tenant IDs/resource selectors không phải proof. Revalidate tại write boundary, prevent TOCTOU, durable idempotency, outbox/inbox hoặc saga, trạng thái pending/completed/failed/reconciliation, prevent double debit/double credit/duplicate conversion, không cross-database ACID assumptions, một conversion command chuyển một Seller tenant sang một Console tenant. Irreversible: converted UC không thể convert ngược lại EC hay withdraw như fiat.

OPEN: conversion ratio và fee chưa explicitly decided; ghi là OPEN, không assume 1:1 hay tự bịa fee.

Related: docs/domains/llm-financial/domain-model.md §2; docs/domains/README.md.

## Accounting invariants & failure recovery

- Source account: Seller tenant EC available (not held/reserved). Destination: Console tenant UC available.
- Idempotency scope: conversion command idempotent by `conversion_id` + `(source_seller_tenant, destination_console_tenant, sub)`; same key never double-debits/double-credits.
- Debit/credit: EC debit in source Seller tenant ledger; UC credit in destination Console tenant ledger; both recorded as double-entry within their own ledger (no cross-database ACID assumed).
- Transaction boundary: EC và UC đều thuộc `llm-financial` và cùng authoritative database `db-llm-gateway`; nếu cùng transaction boundary, ưu tiên một atomic database transaction cho EC debit và UC credit (bảo đảm double-entry, idempotency, audit). Chỉ dùng reservation/pending/outbox/saga/reconciliation nếu có nhiều transactional boundaries thực sự; không đưa distributed ACID vào như assumption.
- Pending reservation behavior: on conversion request, `llm-financial` may create a pending conversion reservation holding source EC (available→held) until credit is confirmed; release only on confirmed failure or reconciliation-resolved failure.
- Failure handling: if debit succeeds but credit fails, state becomes `pending`/`reconciliation_required`; recovery reconciles; no silent loss. Converted UC is irreversible (cannot convert back to EC or withdraw as fiat).
- Recovery/reconciliation: periodic + on-demand reconciliation between source EC ledger, destination UC ledger, and conversion records; mismatch creates alert + audit; correction via adjustment entry, not mutation of historical entries.
