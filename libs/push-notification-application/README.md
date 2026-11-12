# Push Notification Application

Tầng application của bounded context `push-notification` (`@ecoma-io/push-notification-application`): use case, port và record — Application API, Admin API, private delivery runtime API, outbox publisher và reconciliation.

Nx project `@ecoma-io/push-notification-application`, tags `type:application`, `scope:notifications`, `runtime:edge`; dependencies là `@ecoma-io/push-notification-contracts` và `@ecoma-io/push-notification-domain`.

## Purpose

- Chứa toàn bộ use case của control plane, mọi I/O đi qua port để composition root (`apps/push-notification`) nối adapter — thư viện không import infrastructure.
- Tách ba bề mặt authorization thành ba vocabulary riêng: Application API (`INVENTORY_REJECTION`, `app` derive từ principal), Admin API (`ADMIN_REJECTION`, actor là operator), và private delivery runtime API.

## Responsibilities

- **Cấu hình fail-closed** (`config-load.ts`, `config-port.ts`): `resolvePushNotificationConfig`, `PushConfigError`, `readHostAllowlist`, `requireSecret` — đây là module **duy nhất** đọc biến môi trường. `SlaParameters` (`idempotencyRetentionMs`, `callerRetryWindowMs`, `maxNotificationTtlMs`…) có tên chốt nhưng giá trị là launch gate: thiếu cấu hình thì fail closed, không tự chọn giá trị; `EngineeringParameters` mang ngưỡng kỹ thuật (lease, batch, rate limit).
- **Application API** (`create-notification.ts`, `inventory-api.ts`): `createNotification`, `canonicalRequestText`, `CREATE_NOTIFICATION_REJECTION`, `registerDevice`, `unregisterDevice`, `registerSubscription`, `unregisterSubscription`, `disableSubscriptionByApplication`, `getDevice`.
- **Endpoint validation** (`endpoint-validation.ts`, `endpoint-revalidation.ts`): `validatePushEndpoint`, `revalidateStoredEndpoint`, `revalidateSubscriptionEndpoints`, `DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST`, `MAX_PUSH_ENDPOINT_LENGTH`.
- **Private delivery runtime API** (`delivery-runtime.ts`): `claimDelivery`, `releaseDelivery`, `recordOutcome`, `invalidateSubscription` với `FencedWriteOutcome`.
- **Outbox và reconciliation** (`outbox-publisher.ts`, `reconciliation.ts`, `idempotency-cleanup.ts`): `createOutboxIntent`, `buildDeliveryCommand`, `publishOutbox`, `reconcileDeliveries`, `reconcileOutbox`, `cleanupIdempotencyRecords`.
- **Admin API** (`admin-provider.ts`, `admin-delivery.ts`, `admin-subscription.ts`): `createProvider`, `updateProvider`, `holdProvider`, `releaseProvider`, `rotateCredential`, `runProviderTest`, `verifyVapidKeyPair`, `listProviders`, `listDeliveries`, `listNotifications`, `listSubscriptions`, `listDevices`, `listPrimaryMappings`, `republishDelivery`, `administrativeRetry`, `deleteProviderByAdmin`, `disableSubscriptionByAdmin`, `removeSubscriptionByAdmin`.
- **Ports và records** (`ports.ts`, `records.ts`): `PushNotificationPorts` và tập record dùng chung (`NotificationRecord`, `DeliveryRecord`, `SubscriptionRecord`, `ProviderRecord`, `OutboxRecord`, `IdempotencyRecord`, `RoutingPolicyRecord`…), cùng `PushClock`, `IdGenerator`, `RequestHasher`, `PayloadDigester`, `CredentialCipher`, `RateLimitStore`, `QueuePublisher`.

Consumer: `apps/push-notification` — composition root `src/main.ts` dựng adapter và nối route với use case (`src/application-routes.ts`, `src/devices.ts`, `src/subscriptions.ts`, `src/config.ts`, `src/provider-probe.ts`, `src/wire.ts`); `libs/push-notification-infrastructure` implement các port.

## Boundaries

- Không import infrastructure: mọi persistence, queue, clock, id generator, cipher và rate limit đi qua port — thư viện không biết D1, binding hay Worker API.
- Không có `export *` trong barrel: `src/index.ts` chỉ export những gì composition root thật sự dùng, để lựa chọn implementation của tầng infrastructure không trở thành API công khai.
- Ba authorization boundary dùng ba cơ chế khác nhau và đều xác thực trước mọi lookup; response của private delivery runtime API không phân biệt "không có quyền" với "không tìm thấy" — chi tiết cơ chế ở [`docs/applications/push-notification/01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) §8.1, §8.2.
- Use case của Admin API và của Application API không trộn: actor và vocabulary rejection khác nhau, một client của Application API không cần hiểu vocabulary quản trị.

## Development

```bash
pnpm nx run @ecoma-io/push-notification-application:lint
pnpm nx run @ecoma-io/push-notification-application:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm use case mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/push-notification-application:test      # vitest — spec colocated trong src/
```

Spec colocated cho từng use case (`create-notification.spec.ts`, `delivery-runtime.spec.ts`, `outbox-publisher.spec.ts`, `admin-provider.spec.ts`, `config-load.spec.ts`…); `fixture-ports.ts` cung cấp port giả cho unit test. Hành vi qua D1 thật thuộc suite app-owned của `apps/push-notification` (`tests/integrations/`), chạy qua target `test-integration` của app.

## Related Documentation

- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context `push-notification`.
- [`docs/applications/push-notification/01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) — Application flow, transaction/outbox boundary (§6), interface boundary (§8).
- [`docs/applications/push-notification/02-requirements.md`](../../docs/applications/push-notification/02-requirements.md) — requirement của use case (FR-002–FR-004 cho inventory, FR-008 cho idempotency, FR-015 cho runtime API, FR-017–FR-020 cho Admin API).
- [`docs/applications/push-notification/03-operations.md`](../../docs/applications/push-notification/03-operations.md) — vận hành outbox, provider, credential; tên và ý nghĩa các tham số SLA.
- [`libs/push-notification-infrastructure/`](../push-notification-infrastructure/) — implementation D1 của các port.
- [`docs/architecture/06-testing.md`](../../docs/architecture/06-testing.md) — phân tầng test và target canonical.
