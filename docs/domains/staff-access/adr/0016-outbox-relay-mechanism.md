# ADR-0016 — Cơ chế relay outbox cho entitlement event của `staff-access`: cron Worker + Cloudflare Queues

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4). ADR này ghi lại quyết định **đã được hiện thực** ở #449 (P2.2) và đóng mục "relay outbox" từng nằm trong danh sách quyết định mở của `architecture/roadmap.md` — file đó đã bị xoá theo #553. Bối cảnh kỹ thuật của relay nằm ở `apps/staff-access-relay/wrangler.jsonc` và `libs/staff-access-relay-application/src/run-relay-cycle.ts`; ADR này chỉ chốt **lựa chọn cơ chế** và ràng buộc của nó.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Quyết định từ:** [`../../llm-financial/adr/0002-staff-access-entitlement-integration.md`](../../llm-financial/adr/0002-staff-access-entitlement-integration.md) (entitlement chỉ truyền product availability) · [ADR-0014](./0014-revocation-sla-mechanism.md) (deadline theo event class) · [`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §8 A8 · **Issue:** #449

## Bối cảnh

A8 chốt rằng event liên service đi qua **transactional outbox** nằm chung transaction với state, và Queue chỉ là delivery channel — nhưng A8 không chọn cơ chế relay. Roadmap cũ để mở ba ứng viên: Worker relay đọc bảng outbox, Queue, hoặc NATS. [`open-boundaries.md`](../../open-boundaries.md) OB-4 và [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10 từng lặp lại mục mở này; cả hai nay trỏ về ADR này.

Trong lúc đó P2.1 (#437) và P2.2 (#449) đã hiện thực một cơ chế cụ thể trong `apps/staff-access-relay`: một Worker chạy cron mỗi phút, claim hàng chưa publish trong `staff_access.entitlement_outbox_events` bằng `FOR UPDATE SKIP LOCKED` qua partial index, rồi publish vào Cloudflare Queues với idempotency key = `event_id`. Không có NATS, không có route HTTP. Worker có thêm một consumer Queue cho settlement receipt (#497/#498), nhưng đó là nhánh settlement của outbox, không phải consumer entitlement ở sản phẩm khác (P2.3, #451) — quyết định về consumer idempotent vẫn nằm ngoài ADR này.

ADR-0014 đặt ràng buộc bắt buộc lên mọi cơ chế relay: deadline delivery theo event class (`high` ≤ 5s, `normal` ≤ 60s), freshness bound + fail-closed ở consumer, re-check-at-write-time. Ràng buộc đó không phụ thuộc lựa chọn cơ chế.

## Phương án

| #   | Phương án                                                           | Đánh giá                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Cron Worker đọc outbox + Cloudflare Queues** (đã hiện thực, #449) | Chấp nhận — outbox vẫn là source of truth; Queue là delivery channel đúng A8; không thêm hạ tầng mới; đường claim dùng `FOR UPDATE SKIP LOCKED` nên nhiều isolate chạy song song không publish trùng |
| 2   | Queue làm nơi giữ event, không có outbox                            | Loại — vi phạm A8; mất event khi publish thất bại sau commit                                                                                                                                         |
| 3   | NATS (hoặc broker ngoài) làm kênh relay                             | Loại — thêm một hệ thống vận hành thứ hai cho cùng nhu cầu; Cloudflare Queues đã là delivery channel của nền tảng và đã có trong `deploys/*`                                                         |
| 4   | Publish ngay trong request path của management API                  | Loại — biến latency và failure của broker thành failure của write path; outbox sinh ra để tránh đúng điều này                                                                                        |
| 5   | Trigger relay bằng HTTP thay vì cron                                | Loại — không có nguồn trigger đáng tin khi không có traffic; cron là nhịp nhỏ nhất nền tảng hỗ trợ và không phụ thuộc request nào                                                                    |

## Quyết định

- **Relay = Worker chạy cron + Cloudflare Queues.** Outbox trong `db-staff-access` là source of truth; Worker claim, publish, đánh dấu đã publish; Queue chỉ vận chuyển.
- **Không dùng NATS** cho đường này. Lý do phải thêm broker ngoài chưa xuất hiện; nếu xuất hiện, đó là ADR mới.
- **Nhịp cron một phút không phải cam kết SLA.** ADR-0014 đòi deadline theo class; relay đo tuổi event theo class và đánh dấu `delivery_deadline_exceeded` thay vì tuyên bố đã đáp ứng. Deadline là ràng buộc của consumer freshness bound + alert vận hành, không phải promise của cron.
- **Idempotency key = `event_id`**, để retry của Queue và replay của relay không tạo bản ghi trùng ở consumer (invariant 8).

## Hệ quả

- [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10 và [`open-boundaries.md`](../../open-boundaries.md) OB-4 chuyển mục "relay outbox" từ **mở** sang **đã chốt**, chỉ giữ con trỏ tới ADR này.
- Consumer ở từng sản phẩm vẫn phải idempotent và xử lý out-of-order theo version — ADR này không chốt hành vi consumer (P2.3, #451).
- Đổi cơ chế relay (ví dụ sang broker ngoài) cần ADR mới; không sửa ADR này để mô tả lựa chọn khác.
- Ngân sách vận hành: thêm một cron Worker, không thêm hệ thống message broker.

## Cross-reference

- **System:** A8 (transactional outbox, Queue là delivery channel) · invariant 8 (consumer idempotent) · [`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10.
- **Context:** [ADR-0014](./0014-revocation-sla-mechanism.md) (deadline theo event class) · [ADR-0009](./0009-no-internal-authorization-result-contract.md) (không authorization-result contract) · [`../../llm-financial/adr/0002-staff-access-entitlement-integration.md`](../../llm-financial/adr/0002-staff-access-entitlement-integration.md).
- **Hiện thực:** #437 (P2.1, outbox) · #449 (P2.2, relay) · #451 (P2.3, consumer idempotent) · #453 (P2.4, reconciliation job).
- **Index:** [`./README.md`](./README.md).
