# Staff Access Reconciler Application

Tầng use-case của reconciliation job của bounded context `staff-access` (`@ecoma-io/staff-access-reconciler-application`): quét outbox entitlement **đã publish nhưng chưa settle** và phát tín hiệu điều tra. Toàn bộ I/O đi qua một port đọc (`OutboxReconcileRepository`); không có type nào rò rỉ binding Cloudflare hay type driver `pg`.

Nx project `@ecoma-io/staff-access-reconciler-application`, tags `type:application`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Phát hiện outbox row đã publish mà consumer chưa xác nhận, để operator điều tra delivery rớt mà không cần đoán qua log.
- Tách thuật toán reconciliation khỏi adapter: cùng một use-case chạy được với bất kỳ port đọc nào, và ngưỡng vận hành là tham số truyền vào chứ không phải hằng số module scope.

## Responsibilities

- **`runReconciliationCycle`** (`run-reconciliation-cycle.ts`): một lượt quét — validate `nowMs` hữu hạn, validate `limit` là số nguyên dương và không vượt `MAX_RECONCILIATION_LIMIT` (10 000) trước khi truyền xuống port, rồi gọi `outbox.listStalePublished` và trả về `ReconciliationCycleResult` (`stalePublished`, `staleEventIds`, `redriven`).
- **Alert-only**: job không ghi gì vào outbox — không claim, không tăng `attempts`, không reset `published_at`. Redrive là đường vận hành đã có của relay (`replay(event_id)`), chỉ chạy khi có callback `redrive` từ settle evidence.
- **Port** (`outbox-reconcile-repository.ts`): `OutboxReconcileRepository` với `listStalePublished`, và kiểu `StalePublishedEvent` mang `event_id`, `event_type`, `occurred_at`, `published_at`, `attempts`, `last_error`, `settled_at`. `last_error` là hợp đồng bắt buộc: giá trị phải đã được sanitize ở infrastructure; adapter vi phạm thì adapter throw, không trả raw error.
- **Không log payload**: kết quả chỉ mang mã row và tuổi publish; `staleEventIds` là payload để điều tra, không phải metric label (độ lớn cardinality cao).
- Consumer hiện tại: `apps/staff-access-relay` (`src/main.ts`) — composition root ghép use-case này với adapter PostgreSQL.

## Boundaries

- Không phải đường redrive tự động: ngưỡng `published_at` là **proxy alert-only**, không phải bằng chứng delivery rớt — một row cũ có thể đã được consume bình thường.
- Không có port ghi nào được expose, vì job không ghi.
- Không import adapter: adapter PostgreSQL nằm ở `libs/staff-access-reconciler-infrastructure` và implement port của lib này.
- Cơ chế deadline và settlement là quyết định của context → `docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md`.

## Development

```bash
pnpm nx run @ecoma-io/staff-access-reconciler-application:lint
pnpm nx run @ecoma-io/staff-access-reconciler-application:typecheck
```

Mọi ngưỡng vận hành (`staleAfterMs`, `limit`) nằm trong `ReconciliationCycleDeps` — đổi ngưỡng là đổi config ở composition root, không sửa thuật toán trong lib.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-reconciler-application:test    # vitest, environment node
```

Spec colocated `src/run-reconciliation-cycle.spec.ts` phủ validate fail-fast, no-op khi quét rỗng và hành vi alert-only với port giả.

## Related Documentation

- [`docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md`](../../docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md) — cơ chế deadline và settle evidence mà job này theo dõi.
- [`docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md`](../../docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md) — cơ chế relay outbox, nơi có đường `replay`.
- [`docs/applications/staff-access-relay/README.md`](../../docs/applications/staff-access-relay/README.md) — application chạy job này.
- [`libs/staff-access-reconciler-infrastructure/README.md`](../staff-access-reconciler-infrastructure/README.md) — adapter PostgreSQL implement port.
