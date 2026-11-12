# Staff Access Relay

Background job (Worker cron) relay outbox entitlement của bounded context `staff-access`: claim event chưa publish trong bảng outbox, publish vào Cloudflare Queues, đánh dấu đã publish, rồi nhận settlement receipt từ consumer. Đây là plane relay, không phải API service và không phải bounded context.

Nx project `@ecoma-io/staff-access-relay`, tags `type:composition`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Worker `ecoma-staff-access-relay` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`) chạy theo cron `*/1 * * * *` — một entrypoint duy nhất là `scheduled`; không có `fetch` export, nên Worker này không expose HTTP.
- Relay là cầu nối giữa outbox trong `db-staff-access` (nguồn sự thật) và Cloudflare Queues (đường giao event sang các service consuming), theo cơ chế transactional outbox và idempotency.
- Idempotency key của message là `event_id`: envelope được parse từ chuỗi JSON đã commit trong outbox rồi gửi kèm key này, nên consumer dedupe được trước at-least-once của Queue.
- Thiết kế component, boundary và lifecycle là nội dung canonical của `docs/applications/staff-access-relay/01-architecture.md`.

## Responsibilities

- **Publish pass** (`runRelayCycle`): claim row chưa publish bằng `FOR UPDATE SKIP LOCKED`, gửi vào Queue `ecoma-staff-access-entitlement-events` (binding `ENTITLEMENT_EVENTS_QUEUE`, idempotency key = `event_id`), đánh dấu published; ngưỡng chạy: max 5 attempt, batch 100, backoff base 250ms cap 4s, tối đa 3 retry trong một run.
- **Reconciliation pass** (`runReconciliationCycle`): quét row đã publish nhưng chưa settle (`settled_at IS NULL`) sau 300s, redrive bằng `outbox.replay` — không hồi sinh tự động entry DLQ.
- **Settlement consumer**: entrypoint `queue` của Queue `ecoma-staff-access-entitlement-settlement` nhận receipt từ consumer (`pact-broker-api`) sau khi event đã `applied`, đánh dấu `settle_status = 'applied'`; receipt trùng là no-op hiệu quả.
- **Log**: một dòng JSON tổng kết mỗi run (`claimed`/`published`/`failed`/`dlq`/`retried`/`deadline_exceeded`); không log envelope đầy đủ, không log prompt/response body.
- Handler `await` trực tiếp, không `ctx.waitUntil` cho đường chính: lỗi phải hiện thành trạng thái đỏ của cron invocation ở Cron dashboard.

## Boundaries

- Chỉ có một entrypoint `scheduled` và một entrypoint `queue`; không có HTTP surface — mọi endpoint mới là một ranh giới cần auth mà không use case nào định nghĩa.
- Fail-closed: thiếu Hyperdrive binding `DB_STAFF_ACCESS` hoặc Queue binding là `RelayConfigError` ⇒ cron invocation đỏ, không "bỏ qua run này"; backlog chưa publish được claim lần cron sau vì outbox là nguồn sự thật.
- Không sở hữu nghiệp vụ entitlement — business model tại `docs/domains/staff-access/domain-model.md`; nguồn event là outbox của `apps/staff-access`.
- Relay không viết dữ liệu staff/role/permission; consumer nhận event áp dụng vào membership của context riêng (ví dụ `pact-broker-api`).

## Development

```bash
pnpm nx run @ecoma-io/staff-access-relay:serve   # wrangler dev — chỉ dùng để quan sát log, không có HTTP
pnpm nx run @ecoma-io/staff-access-relay:build   # esbuild → dist/main.js
pnpm nx run @ecoma-io/staff-access-relay:lint
pnpm nx run @ecoma-io/staff-access-relay:typecheck
```

- Binding cần: Hyperdrive `DB_STAFF_ACCESS` và Queue producer `ENTITLEMENT_EVENTS_QUEUE`; loader `src/config.ts` kiểm từng binding và chỉ nêu **tên binding** trong message lỗi, không nêu giá trị.
- Worker dùng `pg` Pool với `max: 4`, `idleTimeoutMillis: 600_000`, `connectionTimeoutMillis: 15_000`; listener `error` bắt idle client bị Hyperdrive đóng.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-relay:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/staff-access-relay:test-integration # tests/integrations — PostgreSQL thật (testcontainers)
```

- Suite integration dựng outbox thật trên PostgreSQL thật để ghim relay cycle, redrive và settlement.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/staff-access-relay/README.md`](../../docs/applications/staff-access-relay/README.md) — component doc; [`01-architecture.md`](../../docs/applications/staff-access-relay/01-architecture.md) (boundary, claim/publish, reconciliation).
- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context nguồn của event; [`domain-model.md`](../../docs/domains/staff-access/domain-model.md).
- [`apps/staff-access/README.md`](../staff-access/README.md) — Worker sở hữu outbox mà relay đọc.
- [`apps/pact-broker-api/README.md`](../pact-broker-api/README.md) — consumer áp dụng entitlement event và gửi settlement receipt.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — outbox, idempotency và ranh giới giao tiếp liên service.
