# Web Push Notification Job

Delivery plane của bounded context `push-notification` — Cloudflare Worker thực thi Web Push cho các `Push Delivery` mà control plane `apps/push-notification` đã tạo và enqueue. Worker không routing, không reroute, không chọn provider — chỉ thực thi quyết định đã được control plane materialize, cho message `transport = web` / provider `web-push`. Domain model tại `docs/domains/push-notification/`; thiết kế component là nội dung canonical của `docs/applications/web-push-notification-job/`.

Nx project `@ecoma-io/web-push-notification-job`, tags `type:composition`, `scope:notifications`, `runtime:edge`.

## Purpose

- Worker `ecoma-web-push-notification-job` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`) với hai bề mặt platform: `queue` consumer của `ecoma-push-delivery` (max_retries 3, DLQ `ecoma-push-delivery-dlq`, per-message ack/retry không `ackAll`/`retryAll`) và `fetch` trả 404 cho mọi thứ trừ `POST /internal/reconcile/jobs`.
- Không có entry point `scheduled`: sweep job reconciliation tồn tại như hàm thuần `runJobReconciliation`, được expose tại endpoint có xác thực và gọi bởi trigger đã chốt.
- Bề mặt HTTP chỉ có ba nhánh: method → path (so khớp phân đoạn, `/internal/reconcile/jobsx` vẫn 404) → auth; mọi path khác trả 404 không leak.
- Thiết kế boundary, idempotency, runtime resolution và state ownership là nội dung canonical của `docs/applications/web-push-notification-job/01-architecture.md`.

## Responsibilities

- **Queue pipeline**: consume `Delivery Command`, resolve runtime qua Service Binding `PUSH_NOTIFICATION_SERVICE` tới `ecoma-push-notification` (claim delivery, nhận provider credential khi claim thành công), thực thi Web Push qua `createWebPushSender`, báo outcome về private runtime API.
- **Job execution state**: D1 `push-job` (binding `push-job`) là storage riêng của component; schema và migration D1 tại `migrations/`.
- **Reconciliation endpoint**: `POST /internal/reconcile/jobs` chạy một lần sweep, xác thực bằng `RUNTIME_API_SHARED_SECRET` + `RUNTIME_API_EXPECTED_PRINCIPAL`; cấu hình thiếu là lỗi runtime có metric (`runtime_resolution_errors`) kèm bounded retry rồi DLQ, không phải lỗi compose-time.
- **Producer path**: binding `QUEUE` cho phép re-enqueue trên cùng Queue `ecoma-push-delivery` theo chính sách retry của pipeline.
- Credential và message không bao giờ vào log; log qua logger cấu trúc với level từ `LOG_LEVEL`.

## Boundaries

- Không truy cập D1 `push` của control plane; hai deploy unit có storage độc lập, dữ liệu resolve qua private delivery interface.
- Chỉ xử lý message trong scope web push; message ngoài scope bị từ chối an toàn, không retry vô hạn.
- Không có application API: đường HTTP duy nhất là endpoint reconciliation một hàm, không dùng Hono hay router.
- `workers_dev` tắt (`wrangler.jsonc`); Component không sở hữu nghiệp vụ push — routing policy và delivery lifecycle tại `docs/domains/push-notification/domain-model.md`.

## Development

```bash
pnpm nx run @ecoma-io/web-push-notification-job:serve   # wrangler dev — chỉ dùng để quan sát log, không có HTTP API
pnpm nx run @ecoma-io/web-push-notification-job:build   # esbuild → dist/main.js
pnpm nx run @ecoma-io/web-push-notification-job:lint
pnpm nx run @ecoma-io/web-push-notification-job:typecheck
```

- Binding cần: D1 `push-job`, Queue `QUEUE`, Service Binding `PUSH_NOTIFICATION_SERVICE` (`wrangler.jsonc`); secret `RUNTIME_API_SHARED_SECRET`, `RUNTIME_API_EXPECTED_PRINCIPAL` và var `LOG_LEVEL` được resolve lúc runtime theo `src/env.ts`.
- Tham gia local worker runtime qua marker `local-worker.jsonc` với `readiness: "log-banner"` (không có route `/health` để poll HTTP thành công), chạy qua `pnpm dx local-worker-up`.

## Testing

```bash
pnpm nx run @ecoma-io/web-push-notification-job:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/web-push-notification-job:test-integration # tests/integrations — D1 thật qua harness
```

- Suite integration ghim pipeline consume, runtime resolution và reconciliation trên runtime thật.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/web-push-notification-job/README.md`](../../docs/applications/web-push-notification-job/README.md) — component doc; [`01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) (boundary, idempotency, runtime resolution, state ownership), [`02-requirements.md`](../../docs/applications/web-push-notification-job/02-requirements.md), [`03-operations.md`](../../docs/applications/web-push-notification-job/03-operations.md).
- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context; [`domain-model.md`](../../docs/domains/push-notification/domain-model.md).
- [`apps/push-notification/README.md`](../push-notification/README.md) — control plane của cùng context, owner của Queue `ecoma-push-delivery` và private delivery runtime API.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — transactional outbox, idempotency và topology deploy.
