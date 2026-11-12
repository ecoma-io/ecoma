# Push Notification Contracts

Contract library giữa control plane `push-notification` và delivery plane `web-push-notification-job` (`@ecoma-io/push-notification-contracts`): hình dạng message/envelope, validator hình thức chạy ở runtime, và vocabulary mà cả hai plane phải đọc giống nhau.

Nx project `@ecoma-io/push-notification-contracts`, tags `type:contracts`, `scope:notifications`, `runtime:universal`; `package.json` không có dependency nào — đúng ràng buộc `type:contracts` của `.oxlintrc.json`: không phụ thuộc bất kỳ project implementation nào, kể cả transitive.

## Purpose

- Là boundary artifact được provider publish để consumer phụ thuộc vào — không phải một tầng đi theo chiều phụ thuộc; `Transport`, provider type và delivery state được **khai báo lại** ở mức hình thức wire thay vì import từ tầng domain của `push-notification`.
- Cho hai plane deploy unit độc lập nói cùng một vocabulary: delivery status, transport, provider type, subscription status và tập khoá bị cấm.

## Responsibilities

- **Vocabulary và guard** (`shared.ts`): `DELIVERY_STATUS_VALUES`, `TRANSPORT_VALUES`, `PROVIDER_TYPE_VALUES`, `SUBSCRIPTION_STATUS_VALUES`, terminal/non-terminal set, `isRfc3339Timestamp`, `isPlainObject`, `isPositiveInteger`.
- **Execution scope** (`shared.ts`): `V1_EXECUTABLE_TRANSPORT`, `V1_EXECUTABLE_PROVIDER_TYPE`, `validateV1ExecutionTransport`, `validateV1ExecutionMaterialScope` — guard mà delivery consumer đọc ở biên, không hard-code lại giá trị.
- **Notification payload** (`notification-payload.ts`): `validateNotificationPayload` với tập khoá bắt buộc và rejection reason đóng.
- **Delivery command** (`delivery-command.ts`): `deliveryCommandV1`, `validateDeliveryCommand`, `DELIVERY_COMMAND_VERSION`, tập khoá bị cấm.
- **Claim** (`claim.ts`): `validateClaimRequest`, `validateDeliveryClaim`, `claimRejection` — envelope claim/rejection giữa hai plane.
- **Delivery write** (`delivery-write.ts`): `validateOutcomeRequest`, `validateReleaseRequest`, `validateLeaseFencedRejection`, `outcomeAck`, `releaseAck`.
- **Invalidate** (`invalidate.ts`): `validateInvalidateRequest`, `validateInvalidateAck`, `INVALIDATE_RESULT_SUBSCRIPTION_STATUS`.
- Helper test nội bộ `src/testing/` (`hostile-reflection.ts`, `prototype-pollution.ts`) — dùng bởi spec colocated, không thuộc export công khai.

Consumer: `libs/push-notification-application` (`delivery-runtime.ts`, `outbox-publisher.ts`), `libs/push-notification-infrastructure` (dependency khai trong `package.json`), `libs/web-push-notification-job-application`, `libs/web-push-notification-job-infrastructure` (`runtime-control-plane.ts`), `apps/push-notification` (`src/main.ts`) và `apps/web-push-notification-job`.

## Boundaries

- Không chứa implementation: không Hono handler, không D1/SQL, không Queue producer/consumer, không state machine, không Cloudflare binding, không credential lookup/key management, không HMAC/encryption, không network call.
- Không dùng API riêng của Workers, browser hay Node (không WebCrypto, không `node:*`) — nền của tag `runtime:universal`.
- Contract không tự biết plane nào đang gọi: validator chấp nhận toàn bộ vocabulary chung, việc giới hạn execution scope là việc của consumer qua guard ở biên ([`docs/applications/web-push-notification-job/01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) §5, §7).
- Hai lib mirror cùng vocabulary (`Transport`, provider type, subscription/delivery status) và không được phép import lẫn nhau — nguồn canonical cho cả hai là [`docs/domains/push-notification/`](../../docs/domains/push-notification/README.md); một thay đổi vocabulary phải đổi cả hai lib trong cùng một thay đổi.

## Development

```bash
pnpm nx run @ecoma-io/push-notification-contracts:lint
pnpm nx run @ecoma-io/push-notification-contracts:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm contract mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/push-notification-contracts:test       # vitest — spec colocated trong src/
```

Spec colocated cho từng contract (`delivery-command.spec.ts`, `claim.spec.ts`, `delivery-write.spec.ts`, `invalidate.spec.ts`…), gồm Input Fuzzing chống prototype pollution (`testing/prototype-pollution.ts`) và hostile reflection (`testing/hostile-reflection.ts`).

## Related Documentation

- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context `push-notification`, nguồn canonical của vocabulary.
- [`docs/applications/push-notification/01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) — interface boundary của control plane (§8.1) và Delivery Command (§6.3).
- [`docs/applications/web-push-notification-job/01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) — Delivery Command và Delivery Runtime của delivery plane (§5, §7).
- [`docs/applications/push-notification/02-requirements.md`](../../docs/applications/push-notification/02-requirements.md) — requirement liên quan payload và idempotency mà contract phục vụ (FR-013).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — dependency rule cho `type:contracts` (§7).
- [`libs/push-notification-domain/`](../push-notification-domain/) — lib mirror phía domain, sở hữu business rule chứ không sở hữu wire.
