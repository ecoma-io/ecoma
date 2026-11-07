# Staff Access Relay — Application Architecture

`staff-access-relay` là background job (Worker cron) thực thi **relay outbox entitlement** của bounded context `staff-access`: claim event chưa publish trong bảng outbox, publish vào Cloudflare Queues, đánh dấu đã publish.

> `staff-access-relay` có lifecycle riêng (Worker cron độc lập), nên tài liệu hóa thành Application component ngang hàng theo [`docs/AGENTS.md`](../../AGENTS.md) §3. Business semantics entitlement thuộc [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md); cơ chế relay được chốt bởi [ADR-0016](../../domains/staff-access/adr/0016-outbox-relay-mechanism.md).

## 1. Composition và ranh giới runtime

- **Component type:** background job (Worker cron), chạy độc lập khỏi `staff-access`.
- **Runtime boundary:** Worker chạy cron mỗi phút, claim hàng chưa publish trong `staff_access.entitlement_outbox_events` bằng `FOR UPDATE SKIP LOCKED` qua partial index.
- **Không có NATS, không có route HTTP.**
- **Không phải bounded context:** job này thực thi cơ chế relay của `staff-access`; business rules entitlement ở Domain.

## 2. Application flow

1. Worker cron (một phút một nhịp — không phải cam kết SLA) claim event chưa publish trong outbox.
2. Publish event vào Cloudflare Queues với idempotency key = `event_id`.
3. Đánh dấu event đã publish trong outbox.
4. Outbox trong `db-staff-access` là source of truth (A8); Queue chỉ là delivery channel.
5. Consumer ở từng sản phẩm tự idempotent và xử lý out-of-order theo version (P2.3, không chốt bởi ADR này).

## 3. API/protocol surfaces

- Cloudflare Queues: delivery channel cho entitlement event, idempotency key = `event_id`.
- Không có HTTP route public.

## 4. Integrations và adapters

- `db-staff-access`: đờ bảng `entitlement_outbox_events` (schema `staff_access`), claim bằng `FOR UPDATE SKIP LOCKED`.
- Cloudflare Queues: publish và consumer (settlement receipt, nhánh settlement — không phải consumer entitlement của sản phẩm khác).

## 5. Persistence implementation

- Outbox bảng `staff_access.entitlement_outbox_events` trong `db-staff-access`.
- Idempotency key = `event_id` (invariant 8 — consumer idempotent).
- Migration/datasource dùng cùng pattern ba tầng role của `staff-access` (migrator/runtime).

## 6. Runtime security

- Least-privilege runtime DB credential cho Worker.
- Envelope HMAC không áp tại relay (relay đọc outbox nội bộ, không gọi internal contract qua mạng).

## 7. Execution/failure model

- Nhịp cron một phút không phải cam kết SLA; ADR-0014 đòi deadline theo event class (`high` ≤ 5s, `normal` ≤ 60s), relay đo tuổi event theo class và đánh dấu `delivery_deadline_exceeded`.
- Retry của Queue và replay của relay không tạo bản ghi trùng ở consumer (idempotency key = `event_id`).
- Không dùng NATS cho đường này (ADR-0016).

## 8. Dependency trên Domain contexts

- `staff-access` (nguồn sự kiện entitlement outbox — trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)).

## 9. Application-level invariants

- Outbox là source of truth; Queue là delivery channel (A8).
- Idempotency key = `event_id`.
- Không release reservation chỉ vì timeout; unknown outcome → reconciliation_required (ADR-0014 freshness bound + fail-closed).
