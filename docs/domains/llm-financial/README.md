# LLM Financial

`llm-financial` là bounded context phụ trách **tính đúng đắn tiền tệ của đường LLM**: billing account, wallet, credit/deposit, available balance, double-entry ledger, reservation, budget escrow, budget lease, customer charge, seller payable, settlement, refund/adjustment, reconciliation và financial audit.

> **Phạm vi:** monetary correctness của LLM product. Không thay thế `payment` (payment transaction và payout execution canonical). `llm-financial` sở hữu monetary state; `llm-inference` sở hữu logical request lifecycle; `llm-usage` sở hữu usage measurement. Quan hệ với `payment` vẫn là open boundary → [`open-boundaries.md`](../open-boundaries.md) OB-1. Tài liệu này là business knowledge, không phải technical architecture.

## Documents

| Document                               | Nội dung                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, state machines, invariants, failure behavior, phân biệt các khái niệm tiền tệ |
| [`adr/README.md`](./adr/README.md)     | ADR index (0001–0010) for LLM Financial decisions                                             |

## Cross-references

- System boundary/data ownership → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, §8 (A7, A9), §9 invariants 16.
- Operations/settlement debt → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md) §3.2b.
- Domain language → [`docs/domains/glossary.md`](../glossary.md), [`open-boundaries.md`](../open-boundaries.md) OB-1.
- `payment` boundary → [`docs/domains/payment/README.md`](../payment/README.md).
- `payout` boundary → [`docs/domains/payout/README.md`](../payout/README.md).
- ADR index → [`adr/README.md`](./adr/README.md).
- `llm` product boundary → [`docs/domains/README.md`](../README.md) §2 (rows `llm-*`).
