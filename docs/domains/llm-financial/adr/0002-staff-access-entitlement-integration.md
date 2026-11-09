# ADR-0002 — Tích hợp entitlement Staff Access với LLM internal tenants

Status: Accepted.

Context: Ecoma Staff Access sở hữu internal staff directory, role/permission, product entitlement, authorization audit. Pact Broker provision Ecoma staff vào tenant nội bộ `ecoma` bắt đầu từ Member; revocation không cascade-delete customer membership hay machine credentials.

Decision: Tái sử dụng mô hình Staff Access hiện có và pattern tích hợp Pact Broker. Staff Access entitlement = product availability only, không phải per-request authorization verdict; không bao giờ thay thế authorization bên trong các LLM context. Luồng: (1) Staff Access cấp product entitlement; (2) thay đổi entitlement lan truyền qua event/outbox hiện có; (3) LLM tiêu thụ entitlement state một cách idempotent; (4) staff access vào internal Ecoma tenant được provision tường minh; (5) membership ban đầu nhận minimum privilege; (6) business permission được quản lý bên trong LLM tenant authorization; (7) entitlement revocation không được delete customer membership, financial records, hay unrelated resources. Không có synchronous Staff Access authorization call per LLM request. Staff Access không phải authorization authority cho Seller hay Console customers. Remote Cache defer tích hợp entitlement cho MVP.

Alternatives: central authorization-result service (rejected — docs/domains/staff-access/adr/0009).

Consequences: LLM giữ own tenant membership và business permission; entitlement chỉ là availability signal.

Related: docs/domains/staff-access/adr/0009; docs/applications/pact-broker/01-architecture.md §4; docs/domains/README.md §2.
