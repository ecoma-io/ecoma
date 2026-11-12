# Push Notification Infrastructure

Tầng infrastructure của bounded context `push-notification` (`@ecoma-io/push-notification-infrastructure`): adapter D1, Queue publisher, credential cipher, authentication helper và structured logger — cài các port mà `@ecoma-io/push-notification-application` khai.

Nx project `@ecoma-io/push-notification-infrastructure`, tags `type:infrastructure`, `scope:notifications`, `runtime:edge`; dependencies là `@ecoma-io/push-notification-application`, `@ecoma-io/push-notification-contracts` và `@ecoma-io/push-notification-domain`.

## Purpose

- Dựng adapter thật cho control plane Worker `push-notification`: D1 binding → repository, Worker Secret → cipher, Queue binding → publisher.
- Cung cấp các helper nghi ngờ-low-level mà hai plane cùng cần (auth so sánh constant-time, logger có service/environment, phân loại lỗi storage retry được).

## Responsibilities

- **D1 surface** (`d1-surface.ts`): `D1DatabaseLike`, `D1PreparedStatement`, `D1ResultSet` — hợp đồng giữa adapter và `env` của app; định nghĩa lại ở composition root đồng nghĩa với hai kiểu không liên quan cho cùng một binding.
- **Inventory repositories** (`d1-inventory-repositories.ts`): `D1DeviceRepository`, `D1SubscriptionRepository`, `D1ProviderRepository`, `D1ProviderCredentialRepository`, `D1RoutingPolicyRepository`, `D1IdempotencyRepository`, `D1AuditRepository`.
- **Delivery repositories** (`d1-delivery-repositories.ts`): `D1NotificationRepository`, `D1DeliveryRepository`, `D1OutboxRepository`.
- **Adapter đơn giản** (`adapters.ts`): `BindingQueuePublisher` (Queue `QUEUE` của app), `cryptoRandomIdGenerator`, `systemClock`.
- **Credential cipher** (`credential-cipher.ts`): `WebCryptoCredentialCipher` — AES-256-GCM, ciphertext `iv ‖ ciphertext ‖ tag` với IV 12 byte tự ghép.
- **Rate limit** (`d1-rate-limit-store.ts`): `D1RateLimitStore` — store backing rate limit theo `App`.
- **Auth** (`auth.ts`): `authenticateBearer`, `authenticateRuntimeCaller`, `readBearerToken`, `constantTimeEquals` — ba authorization boundary với cùng nguyên tắc so sánh constant-time và `401` trước lookup.
- **Observability** (`observability.ts`): `createLogger`, `isRetryableStorageError` — structured log có `service`/`environment` theo yêu cầu vận hành.

Consumer: `apps/push-notification` — composition root `src/main.ts` dựng repository từ binding `push` và secret; `src/config.ts` đọc `PushNotificationConfig`; suite `tests/integrations/` dựng adapter thật cho D1 testcontainer. `apps/web-push-notification-job/tests/integrations/cross-plane.spec.ts` dựng adapter để kiểm hợp đồng chéo plane.

## Boundaries

- Runtime `edge`: WebCrypto thay vì `node:crypto` — project không được import Node builtin; `globalThis.crypto.subtle` là API duy nhất có ở cả test runner và Workers runtime.
- Không chứa business rule: trạng thái hợp lệ, điều kiện chuyển giao và budget payload thuộc `@ecoma-io/push-notification-domain`; schema kiểm ở biên thuộc `@ecoma-io/push-notification-contracts`.
- Binding D1 tên `push` và Queue `QUEUE` được khai trong `apps/push-notification/wrangler.jsonc` của app consumer — thư viện chỉ nhận instance qua constructor; provider credential ở at rest được mã hoá bằng root encryption key cấp qua Worker Secret, boundary và quy trình xoay key ở [`docs/applications/push-notification/03-operations.md`](../../docs/applications/push-notification/03-operations.md) §7.
- Composition root chia sẻ một `D1NotificationRepository` duy nhất với `D1DeliveryRepository` qua callback payload — một bảng, một projection; dựng hai repository đọc cùng bảng là hai nơi phải sửa khi projection đổi. Quyết định composition thuộc app, không thuộc thư viện.

## Development

```bash
pnpm nx run @ecoma-io/push-notification-infrastructure:lint
pnpm nx run @ecoma-io/push-notification-infrastructure:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm adapter mới đi kèm export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/push-notification-infrastructure:test      # vitest — spec colocated trong src/
```

Spec colocated: `observability.spec.ts`. Hành vi qua D1 thật thuộc suite app-owned `apps/push-notification/tests/integrations/` (`d1-repositories.spec.ts`, `reconciliation.spec.ts`, `credential-root-key.ts`), chạy qua target `test-integration` của app.

## Related Documentation

- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context `push-notification`.
- [`docs/applications/push-notification/01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) — Security boundary và ba loại secret (§9).
- [`docs/applications/push-notification/03-operations.md`](../../docs/applications/push-notification/03-operations.md) — D1 resources, Queue configuration, credential và secret operations (§2, §3, §7).
- [`docs/applications/web-push-notification-job/01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) — plane tiêu thụ cùng hợp đồng runtime.
- [`libs/push-notification-application/`](../push-notification-application/) — port mà thư viện này cài.
- [`docs/architecture/06-testing.md`](../../docs/architecture/06-testing.md) — phân tầng test và target canonical.
