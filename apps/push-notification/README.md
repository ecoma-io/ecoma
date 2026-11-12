# Push Notification

Control plane của hệ thống Push Notification — Cloudflare Worker (Hono) nhận notification intent, quyết định routing, tạo delivery và publish `Delivery Command` vào Cloudflare Queue cho delivery plane `apps/web-push-notification-job`. Domain state của bounded context `push-notification` nằm tại `docs/domains/push-notification/`; thiết kế component là nội dung canonical của `docs/applications/push-notification/`.

Nx project `@ecoma-io/push-notification`, tags `type:composition`, `scope:notifications`, `runtime:edge`.

## Purpose

- Worker `ecoma-push-notification` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`): composition root `src/main.ts` dựng adapter từ binding (D1 `push`, Queue `QUEUE`, Worker Secret) rồi nối route với use case của `@ecoma-io/push-notification-application` — không business rule nào nằm ở tầng HTTP.
- Ba authorization boundary, ba cơ chế, xác thực trước mọi lookup: Application API (bearer token của application), Admin API (bearer token cho Backoffice), private delivery runtime API (shared secret + `X-ECOMA-PRINCIPAL`); response của private API không phân biệt "không có quyền" với "không tìm thấy".
- Fail-closed ở biên: thiếu cấu hình bắt buộc → 503 nêu tên biến; D1 unreachable → 503 + `Retry-After`; còn lại → 500 với thông điệp hằng.
- Không có entry point `scheduled`: outbox publish và reconcile được trigger đã chốt gọi vào qua route `/internal/**`, không phải cron.

## Responsibilities

- **Application API** (`/v1/**`): tạo notification (`POST /v1/notifications`), device (`POST /v1/devices`, `GET|DELETE /v1/devices/:deviceId`), push subscription (`POST /v1/subscriptions`, `PATCH|DELETE /v1/subscriptions/:subscriptionId`); `app` derive từ principal đã xác thực chứ không lấy từ body.
- **Admin API** (`/admin/v1/**`): inventory notification/delivery/device/subscription, quản lý provider (create, status, hold/release, primary, rotate credential, test), republish/retry delivery — cho Backoffice.
- **Private delivery runtime API** (`/internal/**`): `claim`/`release`/`outcome` delivery, invalidate subscription, revalidate endpoints, outbox publish, reconcile outbox/deliveries, idempotency cleanup — operation set đóng, không có `GET`.
- **Persistence**: D1 `push` (binding `push`) là authoritative storage của control plane; schema và migration D1 tại `migrations/`; mọi repository là adapter trong `@ecoma-io/push-notification-infrastructure`.
- **Outbox**: `Push Notification`, `Push Delivery` và `Outbox Entry` ghi trong cùng `db.batch()` của D1, publisher đưa `Delivery Command` vào Queue `ecoma-push-delivery` (binding `QUEUE`) sau khi transaction commit.
- **Provider credential**: mã hoá at rest qua `WebCryptoCredentialCipher`, root key rotation multi-version (`CREDENTIAL_KEY_VERSION`, `CREDENTIAL_SERVING_VERSIONS`); credential chỉ trả khi claim thành công và không bao giờ xuất hiện trong Queue/API response/log.
- Rate limit notification theo cấu hình (`NOTIFICATION_RATE_LIMIT*`); vượt hạn mức trả 429 kèm `Retry-After`.

## Boundaries

- Chỉ làm control plane: routing không bao giờ diễn ra lại ở delivery worker; component không thực thi Web Push — delivery plane là `apps/web-push-notification-job` qua Queue `ecoma-push-delivery` và private runtime API.
- `workers_dev` tắt (`wrangler.jsonc`), không public hostname; Cloudflare không phân biệt Service Binding với internet nên `/internal/**` xác thực ở tầng ứng dụng thay vì dựa vào network isolation.
- Không sở hữu ý nghĩa nghiệp vụ của dữ liệu push — business model, routing policy và delivery lifecycle tại `docs/domains/push-notification/domain-model.md`.
- Tham số SLA (lease, retention, rate limit, credential versioning) là launch gate: config thiếu là 503 fail-closed với tên biến, không có default đoán được.

## Development

```bash
pnpm nx run @ecoma-io/push-notification:serve          # wrangler dev — cần env/secret đủ theo src/config.ts
pnpm nx run @ecoma-io/push-notification:build          # esbuild → dist/main.js
pnpm nx run @ecoma-io/push-notification:lint
pnpm nx run @ecoma-io/push-notification:typecheck
```

- Biến cấu hình chính: `ADMIN_API_TOKEN`, `ADMIN_API_PRINCIPAL`, `APPLICATION_API_TOKEN`, `APPLICATION_API_PRINCIPAL`, `RUNTIME_API_SHARED_SECRET`, `RUNTIME_API_EXPECTED_PRINCIPAL`, `CREDENTIAL_KEY_VERSION`, `CREDENTIAL_SERVING_VERSIONS`, cùng tham số SLA `*_MS` và rate limit được liệt kê trong `libs/push-notification-application/src/config-load.ts`.
- Tham gia local worker runtime qua marker `local-worker.jsonc` với `readiness: "log-banner"` (Worker này không serve `/health`), chạy qua `pnpm dx local-worker-up`.

## Testing

```bash
pnpm nx run @ecoma-io/push-notification:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/push-notification:test-integration # tests/integrations — D1 thật qua harness
```

- Suite integration dùng harness D1 thật (`tests/integrations/d1-harness.ts`) để ghim hành vi migration và serving path.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/push-notification/README.md`](../../docs/applications/push-notification/README.md) — component doc; [`01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) (runtime boundary, flow, API surface, persistence, security), [`02-requirements.md`](../../docs/applications/push-notification/02-requirements.md), [`03-operations.md`](../../docs/applications/push-notification/03-operations.md).
- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context; [`domain-model.md`](../../docs/domains/push-notification/domain-model.md) — device, subscription, provider, routing policy, delivery lifecycle.
- [`apps/web-push-notification-job/README.md`](../web-push-notification-job/README.md) — delivery plane consume Queue này.
- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — composition consumer của Admin API.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và data ownership.
