# Auth Nonce Prune Job

Cron Worker dọn nonce hết hạn cho hai kho nonce của đường nội bộ: `auth.internal_nonces` (database `db-auth`, thuộc `auth`) và `account.internal_nonces` (database `db-account`, thuộc `account`). Đây là component maintenance plane của context `auth`, không phải bounded context: Worker không nằm trên serving path của service nào, không expose HTTP, và không sở hữu storage — nó xoá dữ liệu trong đúng một bảng của mỗi owner bằng role tối thiểu của owner đó.

Nx project `@ecoma-io/auth-nonce-prune-job`, tags `type:composition`, `scope:auth`, `runtime:edge`.

## Purpose

- Thay workflow cron GitHub cũ bằng một Cloudflare Worker chỉ có entrypoint `scheduled` (`src/main.ts`): mỗi cron tick chạy `runOnce` cho cả hai kho, và mọi lỗi của một kho đều làm run đỏ — không có nhánh "đỏ một nửa thành công".
- Giữ retention học thuyết cũ: xoá theo `expires_at` của từng bảng nonce, không xoá trắng, nên replay window của envelope HMAC vẫn đúng.
- Thuật toán, cap và phân loại lỗi là nội dung canonical của `docs/applications/auth-nonce-prune-job/01-architecture.md`; README này chỉ định vị các phần tử trong project.

## Responsibilities

- **Hai target, hai database** (`targets` trong `src/main.ts`): `{ service: 'auth', schema: 'auth' }` với expected identity `ecoma_auth_nonce_pruner|deletable`, và `{ service: 'account', schema: 'account' }` với expected identity `ecoma_account_nonce_pruner|deletable`. DSN dán nhầm service bị chặn ở `identity_mismatch` trước khi một DELETE nào chạy.
- **Load cấu hình fail-closed** (`src/config.ts`): hai Hyperdrive binding `DB_AUTH` và `DB_ACCOUNT` bắt buộc; thiếu binding là `throw`, để Cron runtime ghi run đỏ ở Past events của dashboard chứ không "bỏ qua run này". Cap của thuật toán là hằng số trong application lib `@ecoma-io/auth-nonce-prune-job-application` (`prune-caps.ts`), không có env override.
- **Chạy song song, log tách kho**: `Promise.allSettled` để một kho throw không cản kho kia, mỗi kho ghi một dòng JSON (`nonce_prune` hoặc `nonce_prune_error`) qua `writeLog`; composition root re-throw sau `allSettled`.
- **Binding** khai trong `wrangler.jsonc`: `hyperdrive` `DB_AUTH` và `DB_ACCOUNT`, khai lặp ở cả `env.staging` và `env.production` vì Wrangler không inherit binding giữa các env; `triggers.crons` một nhịp `17 3 * * *` (03:17 UTC); `workers_dev: false`.

## Boundaries

- Hai database thuộc hai owner khác nhau; job dùng chung thuật toán qua application lib, không import code của `apps/auth` hay `apps/account`, và mỗi principal chỉ có quyền DELETE trên bảng nonce của owner mình.
- Không có route, hostname, `fetch` export, Queue, KV hay D1 — không có HTTP surface để smoke check; xác minh deploy là run history của Cron Dashboard và `wrangler tail` (`docs/applications/auth-nonce-prune-job/03-operations.md` §3).
- Không có deploy project Pulumi: entry `auth-nonce-prune-job` trong `DEPLOYMENT_MAP` (`tools/dx/src/architecture/deployment-map.ts`) có `owner: null`, `status: 'none'`; deploy đi qua Wrangler.
- Retention policy canonical và giới hạn của cron → `docs/applications/auth-nonce-prune-job/01-architecture.md`; platform fact Hyperdrive và trần cron → `docs/architecture/04-platform-facts.md`.

## Development

```bash
pnpm nx run @ecoma-io/auth-nonce-prune-job:serve   # wrangler dev — không có HTTP route, chỉ để chạy Worker cục bộ
pnpm nx run @ecoma-io/auth-nonce-prune-job:lint
pnpm nx run @ecoma-io/auth-nonce-prune-job:typecheck
pnpm nx run @ecoma-io/auth-nonce-prune-job:build   # esbuild bundle → dist/main.js
```

- Worker mang tag `runtime:edge` và không bật `nodejs_compat`; driver `pg` dùng shim Node do nền tảng cấp qua điều kiện resolve của bundle, code của app không import Node builtin.
- Trên lane local, job nằm **ngoài** topology `local-worker-up` (không có `local-worker.jsonc`, không thuộc `apps/*` opt-in của `tools/dx`); prune chạy bằng đường migrator như runbook production khi cần (`docs/architecture/local-development/02-account-auth-topology.md`).

## Testing

```bash
pnpm nx run @ecoma-io/auth-nonce-prune-job:test             # vitest — spec colocated trong src/
pnpm nx run @ecoma-io/auth-nonce-prune-job:test-integration # tests/integrations — PostgreSQL thật (testcontainers)
```

- `test-integration` chạy config riêng `vitest.integration.config.mts` với Docker probe fail-loud: vắng Docker là đỏ, không skip.
- Phân loại và canonical target theo `docs/architecture/06-testing.md` §3–§4.

## Related Documentation

- [`docs/applications/auth-nonce-prune-job/README.md`](../../docs/applications/auth-nonce-prune-job/README.md) — component doc.
- [`docs/applications/auth-nonce-prune-job/01-architecture.md`](../../docs/applications/auth-nonce-prune-job/01-architecture.md) — boundary, thuật toán, caps, phân loại lỗi, permission model, invariants.
- [`docs/applications/auth-nonce-prune-job/03-operations.md`](../../docs/applications/auth-nonce-prune-job/03-operations.md) — deploy, cron config, runbook hỏng.
- [`docs/applications/auth/03-operations.md`](../../docs/applications/auth/03-operations.md) — cơ chế prune cũ mà job này thay thế.
- [`docs/architecture/04-platform-facts.md`](../../docs/architecture/04-platform-facts.md) — platform fact Hyperdrive và trần cron.
