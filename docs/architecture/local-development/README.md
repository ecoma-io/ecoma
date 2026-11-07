# Local Platform

Hạ tầng deployment **local** dùng chung cho mọi deploy unit, chạy trên Docker của máy developer: một Docker network, Traefik (HTTPS entrypoint duy nhất), PostgreSQL với persistent volume — mỗi Git worktree một bộ riêng, cách ly bằng namespace hash. Deploy unit đầu tiên dùng nó là `home` (`apps/home`, Nitro preset `node-server`). Image PostgreSQL (`timescale/timescaledb`) **kèm sẵn** extension TimescaleDB + pgvector nhưng **chưa enable** — chỉ `POSTGRES_SHARED_PRELOAD_LIBRARIES=timescaledb` được set; deploy unit muốn dùng phải tự `CREATE EXTENSION` trong database mà nó sở hữu (chi tiết ở bảng Ownership của [`01-platform.md`](./01-platform.md)).

Đây là hạ tầng **local**, không phải environment: staging/production của app đi đường Cloudflare Workers qua Wrangler và không đi qua đây ([`../02-delivery.md`](../02-delivery.md) §7.4.1).

⚠️ **Lệch có chủ ý so với contract stack ở `../02-delivery.md` §7.4.1**: ở đó `local` là stack _dùng một lần_ trên `file://` để xác minh contract, _không chạm tài nguyên thật_, tên thuộc bộ `local`/`staging`/`production`. Local platform ở đây dùng stack `local-<namespace>` **mang vĩnh viễn** (volume PostgreSQL `retainOnDelete` — sống qua `pulumi destroy`, xoá tường minh qua down platform mỗi lần chạy) và provision resource thật trên máy developer. §7.4.1 là hợp đồng cho đường environment thật, chưa cập nhật theo local platform này.

Local platform là tài nguyên sở hữu của **Architecture**, phục vụ mọi component và deploy unit trong kho lưu trữ — nó không phải một Application, không phải một bounded context, và không nằm trong `domains/`. Nó cung cấp mạng, Traefik, PostgreSQL và cách ly worktree mà mọi deploy unit (home, backoffice, account, auth, ...) đọc qua Pulumi stack reference.

## Documents

- [01-platform.md](./01-platform.md) — ownership, namespace cách ly worktree, contract outputs, invariants.
- [02-account-auth-topology.md](./02-account-auth-topology.md) — topology của hai bounded context `account` + `auth` trên local: hostname, database access, service bindings, dependency graph.
- [03-operations.md](./03-operations.md) — prerequisites, luồng deploy, URL/certificate, teardown, smoke, giới hạn đã biết.
- [evidence/worker-runtime-spike.md](./evidence/worker-runtime-spike.md) — spike `wrangler dev` làm Worker local runtime: readiness, queue, cron, persist dir.
- [evidence/worker-runtime-e2e.md](./evidence/worker-runtime-e2e.md) — bằng chứng E2E Worker local runtime trên wrangler thật + script E2E in-repo lặp lại được.
