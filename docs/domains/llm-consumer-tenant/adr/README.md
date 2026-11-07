# LLM Consumer Tenant — ADR index

Architectural decision record của bounded context **LLM Consumer Tenant**. Mỗi quyết định có **một** canonical location là ADR tương ứng; [`domain-model.md`](../domain-model.md) giữ con trỏ tới đó, không nhân bản nội dung. Đảo một quyết định đã Accepted phải qua ADR mới, không sửa ADR cũ một cách âm thầm.

| #    | Quyết định                                                                    | Trạng thái | File                                                                                                       |
| ---- | ----------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| 0019 | Ba Nx scope `llm-consumer` / `llm-seller` / `llm-shared` và dependency matrix | Accepted   | [`0019-llm-scope-ownership-and-dependency-matrix.md`](./0019-llm-scope-ownership-and-dependency-matrix.md) |

Quyết định thuộc context khác, không nhân bản tại đây:

- [`llm-seller-governance/adr/0018`](../../llm-seller-governance/adr/0018-seller-bounded-context-split.md) — tách `llm-seller` thành tenant và governance; Seller tenant là organization boundary, không có Seller Workspace, active ngay khi tạo.
- [`llm-financial/adr/0001`](../../llm-financial/adr/0001-independent-seller-console-tenant.md) — Seller tenant và Consumer tenant độc lập.
