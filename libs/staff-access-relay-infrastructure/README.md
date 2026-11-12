# Staff Access Relay Infrastructure

Adapter PostgreSQL của relay outbox entitlement (`@ecoma-io/staff-access-relay-infrastructure`): cài port `OutboxRepository` của `libs/staff-access-relay-application` bằng driver `pg` trên Hyperdrive. Lib chỉ có hai export — factory repository và hàm sanitize token lỗi — vì mọi quyết định claim/publish đã nằm ở application layer.

Nx project `@ecoma-io/staff-access-relay-infrastructure`, tags `type:infrastructure`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Thực thi một statement `UPDATE ... RETURNING` nguyên tử cho claim: hai relay chạy song song serialize ở row lock và nhận hai giá trị `attempts` khác nhau trên cùng một row — không có double-publish lặng lẽ.
- Chuyển hàng thô của driver (jsonb, timestamptz) thành `OutboxRow` có type mà application layer định nghĩa.

## Responsibilities

- **`createPostgresOutboxRepository`** (`postgres-outbox-repository.ts`): cài đủ năm operation của `OutboxRepository` — `claimPending` (tăng `attempts` ngay tại claim, filter `attempts < maxAttempts` nên row đạt trần là DLQ), `markPublished`, `recordFailure` (chỉ đặt `last_error`, không tăng lại attempts vì đã tăng ở claim), `replay` (reset `published_at`, `attempts`, `last_error`), và `markSettled` (chỉ settlement reconciler ghi cột này).
- **`errorToken`**: rút token lỗi về một chuỗi ASCII ngắn (tên `Error` khi khớp mẫu, ngoài ra `unknown_error`) — raw error body không bao giờ đi vào cột `last_error`.
- Chuẩn hoá timestamp của driver về ISO string và payload jsonb về chuỗi JSON trước khi trả `OutboxRow`.
- Consumer hiện tại: `apps/staff-access-relay` (`src/main.ts` và suite `tests/integrations/relay.spec.ts`).

## Boundaries

- Không có retry nội bộ hay sleep: một lần gọi port là một operation SQL, backoff là thuật toán của application layer.
- Không thêm cột lease: claim-tăng-`attempts` là thiết kế được chọn trên schema hiện có; đổi cơ chế là một migration và một quyết định của context, không phải một sửa ở adapter.
- Không biết gì về Cloudflare Queues: publisher nằm ở composition root của `apps/staff-access-relay`, không ở lib này.
- Quy tắc tầng `type:infrastructure` → `docs/architecture/05-code-architecture.md` §6.1.

## Development

```bash
pnpm nx run @ecoma-io/staff-access-relay-infrastructure:lint
pnpm nx run @ecoma-io/staff-access-relay-infrastructure:typecheck
```

## Testing

Project không có spec colocated; target `test` chạy vitest với `passWithNoTests: true`. Hành vi repository trên PostgreSQL thật được verify ở suite integration app-owned `apps/staff-access-relay/tests/integrations/relay.spec.ts`, nơi composition root chạy adapter với database thật.

## Related Documentation

- [`libs/staff-access-relay-application/README.md`](../staff-access-relay-application/README.md) — port `OutboxRepository` và hợp đồng claim/fencing mà adapter cài.
- [`docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md`](../../docs/domains/staff-access/adr/0016-outbox-relay-mechanism.md) — cơ chế relay outbox của context.
- [`docs/applications/staff-access-relay/README.md`](../../docs/applications/staff-access-relay/README.md) — application composition root ghép adapter.
- [`apps/staff-access-relay/`](../../apps/staff-access-relay/) — app duy nhất import adapter, chứa suite integration nói trên.
