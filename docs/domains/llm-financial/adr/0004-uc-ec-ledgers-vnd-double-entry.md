# ADR-0004 — UC/EC ledgers, VND denomination, double-entry invariants

Status: Accepted.

Context: Cần các loại credit khác biệt và monetary correctness nghiêm ngặt.

Decision: Hai loại credit: Usage Credits (UC) thuộc Console tenant, purchased/prepaid cho LLM consumption, internal ledger denomination VND, non-transferable, non-refundable theo policy hiện tại. Earnings Credits (EC) thuộc Seller tenant, accrued từ eligible LLM usage delivered qua seller offers, internal ledger denomination VND, có thể convert sang UC hoặc pay out qua Payout, không được nhầm với fiat funds đã disburse. Không mô hình hóa như arbitrary multi-currency wallets. Ledger: append-only double-entry, debit=credit per posted transaction, integer minor units / precise fixed-point only, không floating-point, không edit/delete historical entries, correction qua reversal/adjustment, idempotency keys cho mọi financial mutation, immutable references đến source usage/settlement/deposit/payout/conversion/adjustment, reconciliation và audit, không negative balance trừ khi policy cấp phép rõ ràng. Distinct balances: available, held/reserved, accrued earnings, settled earnings, available earnings, converted EC, paid earnings, tax withholding, payout reservation.

Alternatives: multi-currency wallet (rejected), mutable ledger (rejected).

Related: docs/domains/llm-financial/domain-model.md §4, §5.
