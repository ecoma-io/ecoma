# Payout

Bounded context `payout`: seller payout request, payout quote, beneficiary/destination details, fiat disbursement, manual payout workflow (MVP), payout execution evidence, payout reconciliation.

> **Phạm vi:** chi trả cho seller. `payout` sở hữu payout request/quote/beneficiary/disbursement/evidence/reconciliation. `llm-financial` sở hữu EC và seller liability (accrued/settled/paid/adjusted). `payment` là gateway/execution adapter. Tài liệu này là target architecture, không mô tả implementation hiện có.

## 1. Trách nhiệm

- Payout request/lifecycle (requested → quoted → confirmed → reserved → executing → paid | failed_confirmed | execution_unknown | reconciliation_required | rejected | cancelled).
- Payout quote (immutable snapshot, hard expiry, confirmation window).
- Beneficiary/destination details (bank account, recipient name, currency).
- Fiat disbursement orchestration (manual in MVP) và execution evidence.
- Payout reconciliation và maker/checker authority.
- Invariant: `payout` không trực tiếp chỉnh EC balance — mọi reservation/capture/release EC đi qua contract của `llm-financial`.

## 2. Tài liệu

| Document                               | Nội dung                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Boundary, domain model, state machines, integration lifecycle, failure/recovery |

## 3. Cross-references

- `llm-financial` boundary → [`docs/domains/llm-financial/README.md`](../llm-financial/README.md).
- Payment boundary → [`docs/domains/payment/README.md`](../payment/README.md).
- Domain map → [`docs/domains/README.md`](../README.md).
