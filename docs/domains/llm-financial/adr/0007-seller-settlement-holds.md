# ADR-0007 — Seller monthly earnings settlement và dispute holds

Status: Accepted.

Context: Seller earnings grouping và hold semantics.

Decision: Seller earnings grouped theo calendar month. Earnings từ previous month become available vào day 20 của following month. Document accrual time, period close, reconciliation, settlement, availability, holds, conversion, payout reservation, payout completion. Dùng UTC cho stored timestamps và business timezone rõ ràng cho calendar-period calculation. Dispute policy: hold_all — một dispute hold toàn bộ Seller tenant's settlement cho affected period. Distinguish settlement_hold (holds entire affected period) vs account_hold (prevents use of all currently available EC, chỉ cho serious fraud/compliance hoặc explicit policy). Một hold không delete/rewrite earnings; yêu cầu reason, actor, scope, start time, release time; auditable; không tự động disable Seller login hay publishing; explicit release process.

Related: docs/domains/llm-financial/domain-model.md §7, §9.
