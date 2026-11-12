# Web Push Notification Job Application

Tầng application của delivery worker `web-push-notification-job` (`@ecoma-io/web-push-notification-job-application`): pipeline xử lý **một** Queue message từ byte trên Queue tới `ack()`/`retry()`, cộng port cho control plane, job state, observability và authorization của endpoint reconciliation nội bộ.

Nx project `@ecoma-io/web-push-notification-job-application`, tags `type:application`, `scope:notifications`, `runtime:edge`.

## Purpose

- Là nơi duy nhất quyết định vòng đời của một Web Push delivery message: validate → guard scope → claim → kiểm hạn → gửi → ghi outcome → ack/retry.
- Giữ port gửi Web Push tách khỏi protocol: pipeline chỉ thấy `WebPushSender`, adapter protocol nằm ở infrastructure.

## Responsibilities

- **Pipeline** (`delivery-pipeline.ts`, `queue-consumer.ts`): `processDeliveryMessage` chạy đúng thứ tự tài liệu — validate envelope bằng `validateDeliveryCommand` của `@ecoma-io/push-notification-contracts`, guard scope `transport = app` **trước** claim (để không thắng lease một delivery worker này không gửi được), ghi processed marker/attempt, claim kèm runtime resolution, guard scope trên runtime material, kiểm `expires_at` một lần ngay trước provider call, gửi qua `WebPushSender`, phân loại, ghi outcome, ACK/retry. `consumeQueueBatch` xử lý một batch.
- **Port gửi Web Push** (`web-push-sender.ts`): `WebPushSender`, `WebPushSendRequest`, `WebPushSendResult`, `WebPushTransientPhase` (`before_send` / `after_send`) và `WebPushPermanentFailureClass` (`endpoint_invalid`, `provider_auth`, `payload_too_large`, `redirect_not_followed`, `vapid_key_missing`). Port không mang `dispatch_generation`/`delivery_id` và không bao giờ trả secret.
- **Error matrix** (`error-matrix.ts`, `timing.ts`): `classifySendResult`/`projectAttempt` ánh xạ kết quả port sang hành động provider theo bảng canonical; `computeTtlSeconds`, `queueRetryDelaySeconds`, `WEB_PUSH_REQUEST_TIMEOUT_MS`.
- **Ports hạ tầng** (`runtime-control-plane-port.ts`, `job-state-port.ts`, `observability-port.ts`, `ports.ts`): `DeliveryRuntimePort` (claim/release/outcome/invalidate qua private API), `JobStatePort` (state trên D1 `push-job`), `LoggerPort`/`MetricsPort`, `PipelineClock`, `QueueProducerPort`.
- **Reconciliation** (`job-reconciliation.ts`, `reconciliation-auth.ts`): `runJobReconciliation` sweep các job treo; `authenticateReconciliationCaller` bảo vệ endpoint nội bộ `POST /internal/reconcile/jobs` bằng shared secret so sánh constant-time + principal header, `401` trước mọi việc khác.
- Consumer hiện tại: `apps/web-push-notification-job` (composition root) và `libs/web-push-notification-job-infrastructure` (cài ports).

## Boundaries

- Chỉ xử lý `transport = web` / `provider.type = web-push`; message ngoài scope bị từ chối an toàn, không routing lại và không reroute.
- Không ghi trạng thái delivery của control plane trực tiếp: chỉ `DeliveryRuntimePort` ghi outcome với fencing token.
- Không chứa protocol Web Push (mã hoá, VAPID, Base64URL) — phần đó thuộc `libs/web-push-notification-job-infrastructure/src/web-push/`.
- Không có `export *` trong barrel: export tường minh buộc mỗi symbol thêm vào là một quyết định.
- Ngữ nghĩa nghiệp vụ push thuộc `docs/domains/push-notification/domain-model.md`.

## Development

```bash
pnpm nx run @ecoma-io/web-push-notification-job-application:lint
pnpm nx run @ecoma-io/web-push-notification-job-application:typecheck
```

Thêm bước vào pipeline là đổi thứ tự đọc được của tài liệu worker — đọc `docs/applications/web-push-notification-job/01-architecture.md` trước khi chèn bước mới.

## Testing

```bash
pnpm nx run @ecoma-io/web-push-notification-job-application:test    # vitest, environment node
```

Spec colocated phủ pipeline và từng port (`delivery-pipeline.spec.ts`, `queue-consumer.spec.ts`, `error-matrix.spec.ts`, `timing.spec.ts`, `job-reconciliation.spec.ts`, `reconciliation-auth.spec.ts`) với fixture trong `delivery.fixtures.ts`.

## Related Documentation

- [`docs/applications/web-push-notification-job/README.md`](../../docs/applications/web-push-notification-job/README.md) — delivery worker tiêu thụ lib này.
- [`docs/applications/web-push-notification-job/01-architecture.md`](../../docs/applications/web-push-notification-job/01-architecture.md) — boundary, idempotency, runtime resolution, state ownership và thứ tự pipeline.
- [`docs/applications/push-notification/03-operations.md`](../../docs/applications/push-notification/03-operations.md) §5 — error matrix canonical dùng chung cho control plane và delivery plane.
- [`docs/domains/push-notification/domain-model.md`](../../docs/domains/push-notification/domain-model.md) — ngữ nghĩa nghiệp vụ canonical.
- [`libs/web-push-notification-job-infrastructure/README.md`](../web-push-notification-job-infrastructure/README.md) — adapter cài ports.
