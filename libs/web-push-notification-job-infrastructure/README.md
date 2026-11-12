# Web Push Notification Job Infrastructure

Adapter của delivery worker `web-push-notification-job` (`@ecoma-io/web-push-notification-job-infrastructure`): client của private delivery runtime API trên Service Binding, repository job state trên D1 `push-job`, observability JSON-line, và protocol adapter Web Push (RFC 8291 `aes128gcm`, VAPID, Base64URL trên WebCrypto) cài port `WebPushSender`.

Nx project `@ecoma-io/web-push-notification-job-infrastructure`, tags `type:infrastructure`, `scope:notifications`, `runtime:edge`.

## Purpose

- Giữ chi tiết vendor và chi tiết protocol ngoài tầng application: pipeline không biết D1 hay WebCrypto, adapter protocol không biết `dispatch_generation` hay `delivery_id`.
- Cài idempotency ở nơi chứng minh được, không ở call site: `INSERT OR IGNORE` + `meta.changes` ở repository là điều kiện đủ để Queue redelivery không sinh state mâu thuẫn.

## Responsibilities

- **`runtime-control-plane.ts`**: `RuntimeControlPlaneClient` hiện thực `DeliveryRuntimePort` trên Service Binding — dựng request có xác thực, đọc status, validate body bằng chính validator canonical của `@ecoma-io/push-notification-contracts` (body lệch vocabulary là `RuntimeContractError` → bounded retry → DLQ, không rơi vào nhánh "thua claim"). Secret được resolve lại mỗi request, fail-closed trước mọi byte, không cache ở constructor.
- **`d1-job-state-repository.ts`**: `D1JobStateRepository` cài `JobStatePort` trên D1 `push-job` — bốn nhóm FR-022: envelope ghi đúng một lần (`beginAttempt` trả `false` khi `(delivery_id, attempt)` đã tồn tại), attempt record theo phase/outcome, processed marker, terminal outcome của job. Không chứa logical delivery state — `Push Delivery.status` thuộc control plane.
- **`observability.ts`**: `createLogger` (JSON-line, redact theo `DeliveryLogFields`), `createMetrics` (bộ đếm in-process với `MetricsSnapshot`), `resolveLogLevel`.
- **Protocol adapter** (`src/web-push/`): `web-push-sender.ts` cài `WebPushSender` — gửi **một** request rồi phân loại kết quả; không ghi state, không log, không trả endpoint hay key; `encryption.ts` (RFC 8291 `aes128gcm`, trần 3993 octets plaintext), `vapid.ts` (JWT VAPID), `base64url.ts`, `webcrypto.ts`, `classify.ts` (map HTTP status theo error matrix), `constants.ts`. Spec ghim chuẩn bằng RFC 8291 test vectors (`rfc8291-vectors.spec.ts`) và receiver roundtrip.
- Consumer hiện tại: `apps/web-push-notification-job` (`src/main.ts`, `src/env.ts`, suite `tests/integrations/`) và `apps/push-notification` (`src/provider-probe.ts`).

## Boundaries

- Protocol adapter là một **subpath export riêng** (`@ecoma-io/web-push-notification-job-infrastructure/web-push`, chỉ `createWebPushSender`); barrel gốc `src/index.ts` **không** import `./web-push`, nên composition root là nơi duy nhất nối hai bên.
- Adapter protocol không quyết định retry hay invalidate — chỉ pipeline làm, và chỉ class `endpoint_invalid` (404/410) mới cho phép invalidate subscription.
- Không có lệnh log nào trong protocol adapter: `p256dh`/`auth`, VAPID key, JWT, endpoint và body provider không bao giờ ra ngoài port.
- Không sở hữu schema `push-job` — migration thuộc app.

## Development

```bash
pnpm nx run @ecoma-io/web-push-notification-job-infrastructure:lint
pnpm nx run @ecoma-io/web-push-notification-job-infrastructure:typecheck
```

## Testing

```bash
pnpm nx run @ecoma-io/web-push-notification-job-infrastructure:test    # vitest, environment node
```

Spec colocated: protocol được ghim bằng RFC 8291 vectors, receiver roundtrip và Workers runtime (`src/web-push/*.spec.ts`); control-plane client, D1 repository và observability có spec riêng ở gốc `src/`. Hành vi trên D1 thật thuộc suite `apps/web-push-notification-job/tests/integrations/`.

## Related Documentation

- [`docs/applications/web-push-notification-job/01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) — state ownership (FR-022), runtime resolution và private runtime API mà adapter gọi.
- [`docs/applications/push-notification/01-architecture.md`](../../docs/applications/push-notification/01-architecture.md) — control plane và private delivery runtime API phía đối diện.
- [`docs/domains/push-notification/domain-model.md`](../../docs/domains/push-notification/domain-model.md) — ngữ nghĩa nghiệp vụ canonical.
- [`libs/web-push-notification-job-application/README.md`](../web-push-notification-job-application/README.md) — ports mà adapter cài.
- [`apps/web-push-notification-job/`](../../apps/web-push-notification-job/) — app lắp ráp adapter.
