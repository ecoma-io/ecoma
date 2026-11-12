# Staff Access Reconciler Infrastructure

Adapter PostgreSQL của reconciliation job (`@ecoma-io/staff-access-reconciler-infrastructure`): cài port `OutboxReconcileRepository` của `libs/staff-access-reconciler-application` bằng driver `pg` trên Hyperdrive, và là nơi duy nhất được phép chạm raw `last_error` của relay trước khi giá trị đó đi qua port.

Nx project `@ecoma-io/staff-access-reconciler-infrastructure`, tags `type:infrastructure`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Chuyển một truy vấn SQL có điều kiện stale (`published_at IS NOT NULL AND settled_at IS NULL AND published_at < cutoff`) thành một lệnh gọi port, mà application layer không thấy chi tiết driver.
- Enforce hợp đồng `last_error` đã sanitize: sanitize là trách nhiệm của infrastructure, vì chỉ infrastructure biết raw error trông như thế nào.

## Responsibilities

- **`createPostgresOutboxReconcileRepository`** (`postgres-outbox-reconcile-repository.ts`): nhận một `Pool` của `pg`, trả về port chỉ có `listStalePublished` — một `SELECT` duy nhất trên `staff_access.entitlement_outbox_events`, sắp theo `published_at`, giới hạn bởi `LIMIT`.
- **Validate defensive ở ranh giới port**: `limit` phải là số nguyên dương và không vượt `MAX_RECONCILIATION_LIMIT` (PostgreSQL hiểu `LIMIT` âm là không giới hạn — quét toàn bảng là read amplification); `staleAfterMs` phải là số nguyên không âm; `nowMs` phải hữu hạn. Mỗi vi phạm là một throw fail-closed, không clamp ngầm.
- **`sanitizeRelayError`**: bỏ ký tự điều khiển (một dòng diagnostics, chống log injection), thay mọi pattern đáng ngờ (SQL fragment, stack trace, error type prefix, đường dẫn file) bằng `[redacted]`, cắt ở 255 ký tự.
- Consumer duy nhất hiện tại: `apps/staff-access-relay` (`src/main.ts`) dựng adapter từ pool Hyperdrive của chính app.

## Boundaries

- **Đọc-only**: không có `UPDATE`, không claim, không redrive trong adapter — role runtime của `db-staff-access` đã có `SELECT` trên bảng này từ migration 0004, không grant mới nào cần thiết.
- Không định nghĩa ngưỡng stale hay logic điều tra: hai thứ đó thuộc application layer; adapter chỉ nhận tham số đã validate.
- Không dùng chung code với adapter relay: hai adapter nhắm hai hướng ghi khác nhau trên cùng một bảng, và việc ghép chúng qua một abstract chung là biến một ranh giới đã tách thành một.
- Quy tắc tầng `type:infrastructure` → `docs/architecture/05-code-architecture.md` §6.1.

## Development

```bash
pnpm nx run @ecoma-io/staff-access-reconciler-infrastructure:lint
pnpm nx run @ecoma-io/staff-access-reconciler-infrastructure:typecheck
```

## Testing

```bash
pnpm nx run @ecoma-io/staff-access-reconciler-infrastructure:test    # vitest, environment node
```

Spec colocated `src/postgres-outbox-reconcile-repository.spec.ts` phủ validate fail-closed của port và hành vi sanitize của `last_error` trên `Pool` giả.

## Related Documentation

- [`libs/staff-access-reconciler-application/README.md`](../staff-access-reconciler-application/README.md) — port và use-case mà adapter này cài.
- [`docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md`](../../docs/domains/staff-access/adr/0014-revocation-sla-mechanism.md) — ngữ nghĩa settle và deadline của event.
- [`docs/applications/staff-access-relay/README.md`](../../docs/applications/staff-access-relay/README.md) — application composition root ghép adapter.
