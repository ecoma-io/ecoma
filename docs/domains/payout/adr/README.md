# Payout — ADR index

Bounded context `payout` không có ADR riêng tại thời điểm này. Các quyết định kiến trúc liên quan được ghi nhận tại [`docs/domains/llm-financial/adr/`](../../llm-financial/adr/README.md):

| #    | Quyết định                                                    | File                                                                                                                              |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0003 | Financial ownership: LLM Financial vs Payment vs Payout       | [`docs/domains/llm-financial/adr/0003-financial-ownership.md`](../../llm-financial/adr/0003-financial-ownership.md)               |
| 0009 | Payment/Payout integration, saga, idempotency, reconciliation | [`docs/domains/llm-financial/adr/0009-payment-payout-integration.md`](../../llm-financial/adr/0009-payment-payout-integration.md) |
| 0010 | Manual payout MVP và operator controls                        | [`docs/domains/llm-financial/adr/0010-manual-payout-mvp.md`](../../llm-financial/adr/0010-manual-payout-mvp.md)                   |

Nếu `payout` cần quyết định riêng (schema, state machine payout request), tạo ADR tại thư mục này với số thứ tự mới và cập nhật index này.
