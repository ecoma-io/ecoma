# ADR-0009 — Payment/Payout integration, saga, idempotency, reconciliation

Status: Accepted.

Context: Cross-context integration giữa Payment, Payout, LLM Financial.

Decision: Payment sở hữu fiat inbound payment transaction, deposit initiation/confirmation, payment methods/providers, webhook verification, payment transaction state/reconciliation, evidence fiat received. Payment không bao giờ trực tiếp mutate LLM Financial ledger. Sau khi deposit confirmed, Payment emit authenticated idempotent outcome; LLM Financial độc lập validate và credit UC. Payout lifecycle: seller requests payout → Payout tạo immutable quote → seller confirms → Payout requests EC reservation từ LLM Financial → LLM Financial atomically reserves → Payout execute fiat disbursement → on confirmed success LLM Financial captures; on confirmed failure releases; unknown outcomes remain in reconciliation, không release dựa solely trên timeout. Durable idempotency, outbox/inbox, correlation IDs, state transitions, recovery. Manual payout MVP: backoffice workflow cho accounting staff inspect/verify/approve/reject/execute/record evidence/mark paid after evidence/reconcile; maker/checker dual control cho high-risk; operator không bao giờ trực tiếp edit EC balance để mark payout complete.

Related: docs/domains/payment/README.md; docs/domains/payout/README.md; docs/domains/llm-financial/domain-model.md.
