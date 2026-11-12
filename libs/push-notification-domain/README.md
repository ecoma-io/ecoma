# Push Notification Domain

Thư viện domain thuần của bounded context `push-notification` (`@ecoma-io/push-notification-domain`): business invariant và state transition cho `Device`, `Push Subscription`, `Push Provider`, `Push Notification`, `Push Delivery`, outbox và routing policy. Ngữ nghĩa nghiệp vụ là nội dung canonical của [`docs/domains/push-notification/`](../../docs/domains/push-notification/README.md).

Nx project `@ecoma-io/push-notification-domain`, tags `type:domain`, `scope:notifications`, `runtime:universal`; `package.json` không có dependency nào — đúng dependency rule cho `type:domain` (không phụ thuộc project nào khác, kể cả `type:contracts`).

## Purpose

- Sở hữu **business rule** ở phía domain: ai được chuyển một delivery sang trạng thái nào, khi nào provider đủ điều kiện nhận routing, khi nào administrative retry/re-publish được phép, bất biến lease/fencing, ngân sách byte của payload.
- Phân biệt với wire: schema và validator cho envelope/claim/payload thuộc `@ecoma-io/push-notification-contracts` — boundary validation chạy khi dữ liệu vào hệ thống, không phải rule của domain.

## Responsibilities

- **Subscription** (`subscription.ts`): `disableSubscription`, `expireSubscription`, `isSubscriptionEligibleForDelivery`, set trạng thái và `SUBSCRIPTION_DISABLE_CAUSE`.
- **Provider** (`provider.ts`): `evaluateProviderRoutingEligibility`, `selectPrimaryProvider`, `resolveSubscriptionSigningKeyId`, `canRetireEncryptionKey`, `PROVIDER_STATUS`, `PROVIDER_TYPE`, `V1_EXECUTABLE_TRANSPORT`.
- **Routing** (`routing.ts`): `selectSubscriptionsForDevice`, `TRANSPORT_PRIORITY_ORDER`.
- **Delivery** (`delivery.ts`): `DELIVERY_TRANSITIONS`, `DELIVERY_TRANSITION_ACTOR`, `decideDeliveryClaim`, `decideFencedWrite`, `validateDeliveryTransition`, `planAdministrativeRetry`, `planDeliveryRepublish`, terminal/non-terminal set, `FENCED_WRITE_OPERATIONS`.
- **Outbox** (`outbox.ts`): `canCreateOutboxIntent`, `decideOutboxClaim`, `applyPublisherSuccess`, set trạng thái mở/kết thúc.
- **Payload budget** (`notification.ts`): `MAX_PAYLOAD_PLAINTEXT_BYTES`, `MAX_PUSH_BODY_BYTES`, `PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES`, `checkPayloadPlaintextBudget`, `serializePayloadCanonically`.
- **Guard nền** (`shared.ts`): `isEpochMillis`, `isNonNegativeInteger`, `isTransport`, kiểu result `DomainOk`/`DomainRejection`.

Consumer: `libs/push-notification-application` (đa số module của nó), `libs/push-notification-infrastructure` (`d1-inventory-repositories.ts`), `libs/web-push-notification-job-application` (`delivery-pipeline.ts`), `apps/push-notification` và `apps/web-push-notification-job`.

## Boundaries

- Thuần TypeScript: không I/O, không Cloudflare, không SDK provider, không Node builtin; mọi giá trị thời gian là epoch millis do caller truyền vào — không đọc `Date.now()`, không parse RFC 3339, không sinh ngẫu nhiên.
- Hàm thuần: không sửa input, không giữ state, trả `null`/result object thay vì ném exception cho dữ liệu hỏng.
- **Vocabulary được khai báo lại, không import**: lib này mirror `Transport`, `ProviderType`, subscription/delivery status của contracts vì `type:domain` không được phụ thuộc `type:contracts`; không có cơ chế compile-time bắt lệch giữa hai tập — nguồn canonical cho cả hai là [`docs/domains/push-notification/`](../../docs/domains/push-notification/README.md) và một thay đổi vocabulary phải đổi cả hai lib trong cùng một thay đổi.
- Domain không định nghĩa wire shape của envelope/claim/payload — phần đó thuộc contracts; enforcement fail-closed ở biên thuộc application/infrastructure của từng plane.

## Development

```bash
pnpm nx run @ecoma-io/push-notification-domain:lint
pnpm nx run @ecoma-io/push-notification-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/push-notification-domain:test        # vitest — spec colocated trong src/
```

Spec colocated: `delivery.spec.ts`, `outbox.spec.ts`, `provider.spec.ts`, `routing.spec.ts`, `subscription.spec.ts`, `notification.spec.ts`, `shared.spec.ts`.

## Related Documentation

- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context `push-notification` sở hữu gì và không sở hữu gì.
- [`docs/domains/push-notification/domain-model.md`](../../docs/domains/push-notification/domain-model.md) — khái niệm, lifecycle và invariant nghiệp vụ.
- [`docs/applications/push-notification/01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) — góc nhìn application của domain model (§5) và Delivery Command (§6.3).
- [`docs/applications/web-push-notification-job/01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) — phía delivery plane tiêu thụ cùng vocabulary.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — dependency rule cho `type:domain` (§7).
- [`libs/push-notification-contracts/`](../push-notification-contracts/) — lib mirror phía wire, sở hữu schema và validator.
