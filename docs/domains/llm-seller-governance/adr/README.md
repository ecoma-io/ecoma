# LLM Seller Governance — ADR index

Architectural decision record của bounded context **LLM Seller Governance**. Mỗi quyết định có **một** canonical location là ADR tương ứng; [`domain-model.md`](../domain-model.md) giữ con trỏ tới đó, không nhân bản nội dung. Đảo một quyết định đã Accepted phải qua ADR mới, không sửa ADR cũ một cách âm thầm.

ADR `0003`, `0004`, `0006`, `0008` thuộc context này theo phân chia của [ADR-0018](./0018-seller-bounded-context-split.md); nội dung quyết định không đổi khi chuyển context.

| #    | Quyết định                                                                     | Trạng thái                | File                                                                                                   |
| ---- | ------------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| 0003 | Restriction và appeal model: nhiều record độc lập, tách public/internal reason | Accepted                  | [`0003-restriction-and-appeal-model.md`](./0003-restriction-and-appeal-model.md)                       |
| 0004 | Appeal lifecycle và thẩm quyền quyết định                                      | Accepted                  | [`0004-appeal-lifecycle-and-decision-authority.md`](./0004-appeal-lifecycle-and-decision-authority.md) |
| 0006 | Verification và profile versioned                                              | Accepted                  | [`0006-verification-and-versioned-profiles.md`](./0006-verification-and-versioned-profiles.md)         |
| 0008 | Vòng đời dữ liệu: hoãn phạm vi (deferred scope)                                | Accepted (deferred scope) | [`0008-data-lifecycle-deferred.md`](./0008-data-lifecycle-deferred.md)                                 |
| 0018 | Tách bounded context `llm-seller` thành tenant và governance                   | Accepted                  | [`0018-seller-bounded-context-split.md`](./0018-seller-bounded-context-split.md)                       |

Quyết định thuộc context khác, không nhân bản tại đây:

- [`llm-seller-tenant/adr/`](../../llm-seller-tenant/adr/README.md) — tenant ownership, tenant existence tách khỏi eligibility, membership grant và permission identifier boundary.
- [`llm-consumer-tenant/adr/0019`](../../llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md) — ba Nx scope `llm-consumer` / `llm-seller` / `llm-shared` và dependency matrix.
- [`llm-financial/adr/0007`](../../llm-financial/adr/0007-seller-settlement-holds.md) — settlement hold ≠ Seller restriction.
- [`llm-financial/adr/0008`](../../llm-financial/adr/0008-seller-tax-profile.md) — ownership split seller legal/tax profile vs tax calculation.
