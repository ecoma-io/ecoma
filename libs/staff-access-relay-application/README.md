# Staff Access Relay Application

Tầng use-case của relay outbox entitlement của bounded context `staff-access` (`@ecoma-io/staff-access-relay-application`): claim event chưa publish, gửi vào Cloudflare Queues với idempotency key = `event_id`, rồi đánh dấu đã publish. Mọi I/O đi qua hai port (`OutboxRepository`, `QueuePublisher`); type công khai không rò rỉ binding Cloudflare hay driver `pg` — ranh giới đó được `pnpm dx arch-check` và spec trong lib cùng giữ.

Nx project `@ecoma-io/staff-access-relay-application`, tags `type:application`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Đưa entitlement event ra khỏi database của `staff-access` theo mô hình transactional outbox: event commit cùng transaction với state change, relay chỉ chịu trách nhiệm publish.
- Chip thuật toán relay khỏi môi trường chạy — cùng một use-case chạy được với port thật và port giả, và mọi ngưỡng vận hành là tham số.

## Responsibilities

- **`runRelayCycle`** (`run-relay-cycle.ts`): một lượt relay — `claimPending` một batch (repository tăng `attempts` ngay tại claim, đóng vai fencing token), publish từng row với parse lại payload từ chuỗi JSON đã commit (nguồn sự thật), retry trong run theo backoff exponential có cap, rồi `markPublished` hoặc `recordFailure`.
- **Kết quả có cấu trúc**: `RelayCycleResult` mang `claimed`, `published`, `failed`, `dlq`, `retried`, `deadlineExceeded` và `deadlineExceededByClass` — đủ để composition root ghi một dòng JSON tổng kết.
- **Deadline theo event class**: `RELAY_EVENT_DEADLINES_MS` đặt `high` = 5 000 ms, `normal` = 60 000 ms; row publish quá deadline của class mình bị đếm vào `deadlineExceeded`.
- **`backoffDelayMs`**: backoff exponential có cap, dùng cho retry trong cùng một run.
- **Port** (`outbox-repository.ts`, `queue-publisher.ts`, `records.ts`): `OutboxRepository` (`claimPending`, `markPublished`, `recordFailure`, `replay`, `markSettled`), `QueuePublisher.send(message, idempotencyKey)`, và `OutboxRow` mô tả một hàng `staff_access.entitlement_outbox_events`.
- **DLQ không tự replay**: repository filter `attempts < maxAttempts`, nên row đạt trần attempts không được claim lại; replay là đường vận hành tường minh.
- Consumer hiện tại: `apps/staff-access-relay` (`src/main.ts`, `src/config.ts`) và adapter `libs/staff-access-relay-infrastructure`.

## Boundaries

- Không quyết định ai nhận event: shape envelope thuộc contract của `staff-access` (`libs/staff-access-contracts`), relay parse lại chứ không sáng tác.
- Không tự tính deadline wall-clock của consumer — deadline trong lib đo tuổi producer-to-relay; settlement thuộc đường consumer/reconciler.
- Không ghi SQL: dòng outbox chỉ tồn tại qua port; adapter PostgreSQL ở `libs/staff-access-relay-infrastructure`.
- Cơ chế relay là quyết định của context → `docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md`.

## Development

```bash
pnpm nx run @ecoma-io/staff-access-relay-application:lint
pnpm nx run @ecoma-io/staff-access-relay-application:typecheck
```

Ngưỡng vận hành (`maxAttempts`, `batchSize`, `backoffBaseMs`, `backoffCapMs`, `maxInRunRetries`) nằm trong `RelayCycleDeps`; composition root của `apps/staff-access-relay` ghim giá trị cụ thể.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-relay-application:test    # vitest, environment node
```

Spec colocated `src/run-relay-cycle.spec.ts` phủ claim rỗng (no-op), publish thành công, thất bại hết lượt thử trong run, DLQ và deadline theo class, với port giả và clock/sleep inject.

## Related Documentation

- [`docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md`](../../docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md) — cơ chế cron Worker + Cloudflare Queues của relay.
- [`docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md`](../../docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md) — deadline theo risk class và ràng buộc lên relay.
- [`docs/applications/staff-access-relay/README.md`](../../docs/applications/staff-access-relay/README.md) — application chạy use-case này.
- [`libs/staff-access-relay-infrastructure/README.md`](../staff-access-relay-infrastructure/README.md) — adapter PostgreSQL implement `OutboxRepository`.
