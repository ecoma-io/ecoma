# ADR-0001 — Independent Seller and Console tenant/membership/authorization

Status: Accepted.

Context: LLM product hỗ trợ hai loại tenant độc lập: Seller tenant (tổ chức seller) và Console tenant (tổ chức consumer/customer). Một Identity `sub` có thể thuộc nhiều Seller và Console tenant.

Decision: Seller và Console tenant có tenant ID, lifecycle, membership, role/permission, workspace/resource scope, audit history, authorization decision độc lập. Membership/permission ở một tenant không bao giờ ngụ ý membership/permission ở tenant khác. Không có global owner role vượt qua tenant isolation. Tenant ID/selector: authenticated actor (`sub`) luôn lấy từ verified authentication context; tenant selector có thể do client cung cấp để chọn scope, nhưng backend phải xác minh membership/permission/tenant active/resource ownership tại write boundary (fail closed). Không ngầm chọn tenant mặc định/UI state. Billing account ≠ tenant.

Alternatives: single shared tenant model (rejected — phá vỡ isolation và tách biệt seller/customer).

Consequences: mọi authorization check dùng tenant scope từ principal; cross-tenant inference bị cấm; `llm-consumer-tenant` và `llm-seller-tenant` vẫn là ownership boundary độc lập (tách theo [ADR-0018](../../llm-seller-governance/adr/0018-seller-bounded-context-split.md)).

Security/failure: forged tenant selector bị từ chối tại write boundary; composite DB constraints enforce isolation.

Related: docs/domains/llm-consumer-tenant/domain-model.md; docs/domains/README.md §2, §3.
