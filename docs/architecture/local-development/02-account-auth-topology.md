# Local Platform — Account & Auth Topology

> Quyết định topology của hai bounded context **Account** (`account`) và **Auth** (`auth`) trên local platform. Ownership hạ tầng chung và invariants platform nằm ở [`./01-platform.md`](./01-platform.md); docs thiết kế context ở [`../../applications/account/01-architecture.md`](../../applications/account/01-architecture.md) và [`../../applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md).
>
> Các quyết định dưới đây được chứng minh bằng spike đo được — xem platform facts PF1–PF8 ([`../04-platform-facts.md`](../04-platform-facts.md) §2.18) — không phải suy đoán từ tài liệu.

## Hostname

| Unit    | URL local         | Production (tham chiếu) |
| ------- | ----------------- | ----------------------- |
| account | `account.fbi.com` | `account.ecoma.io`      |
| auth    | `auth.fbi.com`    | `auth.ecoma.io`         |

Cả hai hostname thuộc wildcard cert `*.fbi.com` hiện có — không thêm cert, không thêm DNS. Router Traefik của mỗi unit theo mẫu `Host(<sub>.${rootHostname})` như backoffice với `office.fbi.com`.

## Topology và ownership

| Resource                                  | Owner                            | Ghi chú                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-account`, `db-auth` (mỗi DB + 4 role) | `account-deploy` / `auth-deploy` | Provision theo pattern `command.local.Command` + `docker exec` psql của `backoffice-deploy`: mỗi stack tạo 4 role của DB mình (owner/migrator/runtime/pruner, owner `ecoma_owner` dùng chung — account stack sở hữu password, auth stack chỉ guard-create) + thu CONNECT chéo của cả PUBLIC lẫn role runtime; migration chạy qua runner canonical của từng unit (`account:db:migrate` / `auth:db:migrate`) trong container ephemeral trên platform network. Platform giữ invariant: một instance PostgreSQL, không host port. |
| Account container (Nitro `node-server`)   | `account-deploy`                 | Docker image build + container + Traefik labels, theo pattern `home-deploy`/`backoffice-deploy`.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Auth Worker container ("WIC")             | `auth-deploy`                    | `wrangler dev` chạy **trong container** gắn platform network (WIC — worker-in-container), alias DNS `ecoma-<ns>-auth`, port trong của auth `4203`; lý do và cơ chế ở §Database access.                                                                                                                                                                                                                                                                                                                                        |
| Shim worker `ecoma-account-bridge`        | `auth-deploy`                    | Worker cùng container WIC với auth; mặt trước service-binding cho container account (§Service bindings).                                                                                                                                                                                                                                                                                                                                                                                                                      |

`account-deploy`/`auth-deploy` không tự tạo network/Traefik/PostgreSQL — đọc qua stack reference tới `platform-deploy` như home/backoffice.

## Database access (Problem A — đã chốt)

**Quyết định: auth runtime (workerd) chạy trong container gắn platform network (WIC); Hyperdrive local emulation trỏ thẳng alias `ecoma-postgres`.**

Chuỗi bằng chứng (đo 2026-10-23, platform facts PF1–PF5):

1. Container trên platform network kết nối được PostgreSQL bằng wire protocol thật: TCP OK, `pg_isready` accepting, `psql` query auth thành công (PF1) — không cần host port mới.
2. `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` biến env được wrangler tôn trọng làm connection string của Hyperdrive local (PF3); worker boot với binding Hyperdrive `local` khi biến này được set.
3. Với `sslmode=disable`, miniflare **không** dựng proxy trung gian — workerd dial thẳng `host:port` trong connection string (PF4, nguồn: code miniflare `5.20261019.1-beta`, plugin Hyperdrive). Worker dò được DB ⇔ tiến trình chạy wrangler dò được DB.
4. Wrangler dev boot được trong container (`node:24-bookworm-slim`); cần gói `ca-certificates` cho workerd service `internet` (PF2).
5. Wrangler trên **host** không thể tham gia phương án này: nó không dò được IP container (môi trường gvisor-tap-vsock) và không được publish port PostgreSQL (invariant platform). Không dùng đường publish port-loopback vì vi phạm invariant.

Hệ quả, áp dụng cho cả auth lẫn shim bridge:

- WIC container chứa **hai** worker process: auth (`ecoma-auth`, port trong `4203`) và shim bridge (`ecoma-account-bridge`, port trong `4204`), khởi động bởi entrypoint `wic-entrypoint.sh` của image — bridge trước auth (auth đỏ `/ready` qua probe `ACCOUNT_SERVICE` cho tới khi shim đăng ký entry vào dev registry). Một process chết ⇒ entrypoint exit ⇒ container chết ⇒ Docker restart cả cặp.
- Image WIC phái sinh từ image Node pin của repo (`node:24-bookworm-slim` pin digest) + `ca-certificates` + `corepack`; repo mount read-only. `wrangler dev` không ghi được trên repo RO (thư mục `.wrangler/tmp` hard-code theo project root, symlink/mount điểm ghi trên bind RO đều fail): entrypoint dựng **runtime tree mirror** ghi được trong volume `/state` — `node_modules` symlink về repo, `wrangler.jsonc` + `dist/` copy per-app — rồi chạy `wrangler dev` từ bản mirror với `--persist-to /state`.
- Hai process `wrangler dev` khởi động đồng thời đua dò port inspector từ 9229 (devtools, không dùng trong WIC) và chết vì race `Address already in use` — entrypoint ghim `--inspector-port` khác nhau cho mỗi process.
- Secrets của worker đi vào bằng **container envs** (kênh duy nhất — không argv, không labels, không log): orchestration sinh giá trị qua `pulumi.secret` → envs của resource Docker; entrypoint bật `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` để wrangler nạp process env thành bindings của worker (mặc định wrangler dev bỏ qua process env, chỉ đọc `.dev.vars`).
- Volume `/state` là named volume ephemeral của stack (không `retainOnDelete` — chỉ là working dir wrangler, không phải dữ liệu); một container init một-shot `chown 1000:1000` chạy trước WIC vì named volume mới thuộc root.
- Container WIC gia nhập platform network với alias DNS `ecoma-<ns>-auth`; Traefik route `Host(auth.<rootHostname>)` trỏ port trong `4203`.
- `WRANGLER_ENV_ALLOWLIST` trong `tools/dx` phải cho `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` đi xuống process wrangler — hiện allowlist chặn (sửa thuộc PR Worker runtime).

## Service bindings (Problem B — đã chốt)

**Quyết định: giữ nguyên shape binding thật trên cả hai chiều; container account được bọc bằng shim worker; shim và auth cùng container WIC.**

Chuỗi bằng chứng (PF6–PF8):

1. Service bindings của `wrangler dev` giải được **cross-process** qua shared dev registry (`WRANGLER_REGISTRY_PATH`): caller thấy `[connected]` và gọi `env.ACCOUNT_SERVICE.fetch()` thành công tới worker khác process (PF6).
2. Dev registry chỉ chứa entry của workerd process — không thể đăng ký một container Node thuần; phía nhận binding buộc phải là worker (PF7).
3. Shim worker chuyển tiếp fetch qua HTTP thuần tới upstream bất kỳ — chuỗi `auth → ACCOUNT_SERVICE → shim → HTTP → container` chạy end-to-end (PF8). Bên trong là HTTP plain, đúng ngữ nghĩa service binding production (binding không cung cấp TLS); bảo mật lớp application là envelope HMAC `ecoma-internal-v1` — **hợp đồng thật, không mock**.

Hai chiều:

| Chiều          | Hình dạng local                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth → account | Binding `ACCOUNT_SERVICE` (auth) → shim worker `ecoma-account-bridge` (cùng WIC) → `http://ecoma-<ns>-account:3000` (tên container account trên network per-worktree — DNS target, không cần alias thêm). |
| account → auth | Nitro adapter fetch thẳng `http://ecoma-<ns>-auth:4203` (alias DNS của container WIC, port trong của worker auth) — account là HTTP client thuần, không cần binding.                                      |

Envelope `ecoma-internal-v1` chạy nguyên vẹn trên cả hai chiều; secret cấu hình theo đường stack config (không argv/labels/log).

## Dependency graph

```
platform-deploy (network, Traefik, PostgreSQL)
   ├─ account-deploy:  provision db-account + roles → migrations (apply.mts) → image build → container → /ready
   └─ auth-deploy:     provision db-auth + roles → migrations → WIC container (auth + bridge shim) → /ready
```

Không có init-cycle giữa account và auth: account phụ thuộc mail sink (worker runtime) nhưng không phụ thuộc auth; auth phụ thuộc account container cho `ACCOUNT_SERVICE` bridge — bridge fail-closed (auth vẫn boot, readiness đỏ) nên thứ tự up vẫn là account trước auth để smoke không thấy đỏ giả.

## Runtime contracts vẫn nguyên (không đổi)

- Binding names `DB_ACCOUNT`/`HYPERDRIVE`, `AUTH_SERVICE`/`ACCOUNT_SERVICE` chỉ tồn tại trong code — local chỉ cách "nuôi" binding đó, không đổi tên.
- `/ready` của auth phải phản ánh DB + signing config + Account contract; `/ready` của account phản ánh DB — smoke gate dùng `/ready`, không dùng `/health` làm bằng chứng readiness.
- Mail: account gọi `transactional-mail` qua HTTP (`NUXT_MAIL_SERVICE_URL` trỏ sink local D1, provider `fake`).
- `auth-nonce-prune-job`: **ngoài** topology local phiên đầu — cron-only, không HTTP surface, không vào `local-worker-up` (không marker); prune chạy bằng đường migrator như production runbook khi cần. Quyết định không đưa vào local: giảm diện tích orchestration, không có regression nào được phát hiện thêm bởi cron local.
