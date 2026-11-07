# Payment

Bounded context `payment`: ledger credit và payment transaction (inbound fiat payment). Payment có thể là gateway/execution adapter cho fiat disbursement, nhưng outbound seller payout workflow/state machine thuộc `payout`. Deploy unit `payment` (public + payment webhook tại `payment.ecoma.io`), sở hữu `db-payment` (PostgreSQL). Kiến trúc và data ownership → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, §8 (A2).

## Ranh giới với LLM

- Payment chỉ là payment gateway/provider transaction trong quan hệ với LLM.
- Payment không sở hữu LLM wallet, balance, credit, ledger, usage charges, budget escrow, seller payable hoặc settlement.
- LLM Financial tiếp nhận payment outcome và tự ghi ledger/credit.
- Payment transaction không đồng nghĩa LLM credit.
- Seller payable của LLM không thuộc Payment.
- Nếu cần external payout execution, Payment là gateway/execution adapter, không chuyển quyền sở hữu calculation/liability/settlement của LLM.

Hợp đồng crediting/reconciliation/settlement giữa Payment và LLM là open boundary → [`docs/domains/open-boundaries.md`](../open-boundaries.md) OB-1.

## Documents

- [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, §8 — boundary, data ownership, A2.
- [`docs/domains/README.md`](../README.md) §2 — catalog bounded context.
- [`docs/domains/open-boundaries.md`](../open-boundaries.md) OB-1 — open boundary crediting/reconciliation/settlement.

Chưa có spec riêng của context; khi có implementation/written specification sẽ thêm tài liệu ở đây.
