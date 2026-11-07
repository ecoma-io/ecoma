# ADR-0003 — Financial ownership: LLM Financial vs Payment vs Payout

Status: Accepted.

Context: Rủi ro nhầm lẫn ledger của payment domain với ledger tài chính LLM; payment README đã nêu payment là gateway/execution adapter tương đối LLM.

Decision: llm-financial sở hữu LLM financial domain: billing account, wallet, credit/deposit, balance, double-entry ledger, reservation, budget escrow/lease, customer charge, seller payable, settlement, refund/adjustment, reconciliation, audit. Payment sở hữu fiat payment transaction, deposit initiation/confirmation, payment methods/providers, webhook verification, payment reconciliation, evidence of fiat received. Payout sở hữu seller payout request, quote, beneficiary/destination, fiat disbursement, manual payout MVP, execution evidence, payout reconciliation. Payment không bao giờ trực tiếp mutate LLM Financial ledger; sau khi deposit được confirm, Payment emit authenticated idempotent outcome, LLM Financial độc lập validate và credit UC. LLM Financial là owner duy nhất của UC/EC ledger.

Alternatives: Payment sở hữu LLM credits/wallet (rejected — vi phạm one-service-one-database và LLM monetary ownership).

Consequences: deposit crediting và payout capture/release contracts rõ ràng; failure/reconciliation semantics được tài liệu hóa.

Related: docs/domains/payment/README.md; docs/domains/payout/README.md; docs/domains/llm-financial/domain-model.md §1.
