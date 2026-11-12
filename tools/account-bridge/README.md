# Account Bridge

Shim Worker `ecoma-account-bridge` — mặt trước service-binding cho container account trên local platform. Tồn tại vì dev registry của `wrangler dev` chỉ nhận entry do process workerd đăng ký, còn `account` trên lane local là container Node thuần; shim bọc container để binding `ACCOUNT_SERVICE` mà `ecoma-auth` gọi (`apps/auth/src/account-client.ts`) giữ nguyên 100% shape contract thật:

```text
auth → binding ACCOUNT_SERVICE → shim (worker) → HTTP plain → container account
```

Worker này chỉ là một phần của topology local — không có `env.staging`/`env.production`, không `routes` trong `wrangler.jsonc`.

Nx project `@ecoma-io/account-bridge`, tags `type:composition`, `scope:auth`, `runtime:edge`.

## Purpose

- Giữ contract `auth → account` không đổi trên lane local: auth không biết và không cần biết nó đang nói chuyện với shim.
- Bảo mật lớp application là envelope HMAC `ecoma-internal-v1` do auth và account tự ký/verify ở hai đầu — shim chuyển tiếp mù: không giữ khoá, không parse body có ý nghĩa.

## Responsibilities

- Chuyển tiếp request `GET`/`POST` tới upstream khai qua biến `BRIDGE_TARGET_ORIGIN`: giữ nguyên path/query (auth ký envelope trên path thật), đổi protocol + host, loại hop-by-hop headers, đặt `Host` bằng host upstream, không theo redirect.
- `GET /health` — liveness của shim, không chạm upstream; được orchestration local poll theo marker `readiness: "http-health"` trong `local-worker.jsonc`.
- Fail-closed: thiếu/sai `BRIDGE_TARGET_ORIGIN` → `503 upstream_unconfigured`; upstream không tới được → `503 upstream_unreachable`; method khác GET/POST → `405 method_not_allowed`.
- Ghi một dòng log JSON cho mỗi lần reject/fail — không kèm giá trị header hay origin.

## Boundaries

- Không phải mock: contract và HMAC là hợp đồng thật; bên trong là HTTP plain, đúng ngữ nghĩa service binding production (binding không cung cấp TLS).
- Chạy bên trong container WIC của `auth-deploy` cùng `ecoma-auth` — entrypoint khởi bridge trước auth; không có topology production nào cho worker này.
- `BRIDGE_TARGET_ORIGIN` inject lúc runtime (`.dev.vars` của shim), không hard-code trong config committed.
- Không bật `nodejs_compat`: shim không import Node builtin nào (`runtime:edge`).

## Development

```bash
pnpm nx run @ecoma-io/account-bridge:build      # esbuild bundle → dist/main.js (entry `main` của wrangler.jsonc)
pnpm nx run @ecoma-io/account-bridge:lint
pnpm nx run @ecoma-io/account-bridge:typecheck
```

Thời điểm chạy thật là `wrangler dev` bên trong WIC của auth (khởi bởi topology `auth-deploy`), không phải qua target của project này.

## Testing

```bash
pnpm nx run @ecoma-io/account-bridge:test       # vitest — spec colocated (src/main.spec.ts)
```

Unit test phủ hành vi forward và fail-closed của `src/main.ts`; hành vi qua dev registry thật thuộc phạm vi của các system-test suite đi qua topology local.

## Related Documentation

- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — vị trí của shim trong topology (§Service bindings, §Dependency graph).
- [`docs/architecture/04-platform-facts.md`](../../docs/architecture/04-platform-facts.md) — platform facts được trích dẫn trong comment mã nguồn (PF6/PF7/PF8).
- [`apps/auth/`](../../apps/auth/) — caller giữ binding `ACCOUNT_SERVICE`.
- [`apps/account/README.md`](../../apps/account/README.md) — upstream container mà shim trỏ tới.
