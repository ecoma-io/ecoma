# Auth Nonce Prune Job Application

Application lib của maintenance job `auth-nonce-prune-job` (`@ecoma-io/auth-nonce-prune-job-application`): thuật toán prune nonce hết hạn cho hai kho nonce của đường nội bộ — `db-auth` và `db-account` — tách khỏi worker entry và khỏi driver `pg` qua port.

Mọi I/O database đi qua port `QueryPool` (shape subset của `pg.Pool`) và mọi chờ đợi đi qua `Sleep`; composition root `apps/auth-nonce-prune-job/src/main.ts` dựng pool từ Hyperdrive binding rồi tiêm vào — không adapter riêng nào cần tách.

Nx project `@ecoma-io/auth-nonce-prune-job-application`, tags `type:application`, `scope:auth`, `runtime:edge`. Package không có dependency runtime nào.

## Purpose

- Giữ thuật toán prune bounded, idempotent và kiểm soát được: xoá theo lô đã commit, ba trần `BATCH_SIZE`/`MAX_BATCHES`/`MAX_SECONDS`, chạm trần phải kiểm chứng còn backlog trước khi kết luận.
- Tách phần policy thuần khỏi entry của Worker để unit test không cần Hyperdrive hay `pg`.

## Responsibilities

- **Thuật toán** (`prune.ts`): `pruneTarget` cho một database — preflight identity (`current_user` + `has_table_privilege(..., 'DELETE')` so với identity mong đợi của kho, dsn sai service bị chặn `identity_mismatch`), vị `expires_at < now()` của PostgreSQL (không `TRUNCATE`, không xoá theo tuổi, không sửa `expires_at`), `SET LOCAL` statement/lock timeout trong transaction của từng lô, retry chỉ cho nhóm SQLSTATE connection-failure tối đa `MAX_ATTEMPTS` với backoff tuyến tính, log không mang nonce hay connection string. `UnexpectedOutputError`, `defaultSleep`, `oneTargetExpected`, kiểu `PruneOutcome`/`PruneRunResult`/`PruneTarget`; port `QueryPool` và `Sleep`.
- **Trần thuật toán** (`prune-caps.ts`): `BATCH_SIZE = 20_000`, `MAX_BATCHES = 50`, `MAX_SECONDS = 400`, `MAX_ATTEMPTS = 3`, `STATEMENT_TIMEOUT_SECONDS = 60`, `LOCK_TIMEOUT_SECONDS = 30`, `CONNECT_TIMEOUT_SECONDS = 10`, `retryBackoffSeconds` — hằng tập trung, không override qua env.

Consumer hiện tại: `apps/auth-nonce-prune-job` — `src/main.ts` (composition root, chạy hai kho song song qua `Promise.allSettled`), `src/config.ts`, `tests/integrations/prune-job.spec.ts`.

## Boundaries

- Không sở hữu storage: job chỉ xoá hàng nonce hết hạn của hai kho nonce, schema và bảng thuộc `apps/auth` và `apps/account`.
- Không có advisory lock, không `PREPARE`/`EXECUTE`, không `SET` cấp connection — Hyperdrive không hỗ trợ; timeout là `SET LOCAL` trong transaction của từng lô.
- Lịch chạy và cấu hình Worker (binding, secret) thuộc `apps/auth-nonce-prune-job`; lib chỉ giữ thuật toán và policy.

## Development

```bash
pnpm nx run @ecoma-io/auth-nonce-prune-job-application:lint
pnpm nx run @ecoma-io/auth-nonce-prune-job-application:typecheck
```

Mã nguồn nằm dưới `src/`; entry công khai là `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/auth-nonce-prune-job-application:test   # vitest — spec colocated trong src/
```

`prune.spec.ts` phủ preflight identity, biên lô, phân loại retry và các outcome của `pruneTarget`.

## Related Documentation

- [`docs/applications/auth-nonce-prune-job/README.md`](../../docs/applications/auth-nonce-prune-job/README.md) — component doc của job; [`03-operations.md`](../../docs/applications/auth-nonce-prune-job/03-operations.md) — vận hành.
- [`docs/applications/auth/03-operations.md`](../../docs/applications/auth/03-operations.md) — đường vận hành liên quan tới `db-auth` mà job dọn.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — §2 topology: `auth-nonce-prune-job` thuộc maintenance plane.
- [`apps/auth-nonce-prune-job/`](../../apps/auth-nonce-prune-job/) — Worker entry compose lib này.
