# Backoffice Deploy

Pulumi deployment project provision **deploy unit của `apps/backoffice` trên lane LOCAL**: database `db-backoffice`, hai role PostgreSQL, migration, image (Nuxt preset `node-server` build trong Docker) và container phía sau Traefik. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`.

Nx project `backoffice-deploy`, tags `type:deployment`, `scope:backoffice`, `runtime:native`. Chỉ có lane local (`configurations: local`); staging/production của app khai trong `apps/backoffice/wrangler.jsonc` và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa `apps/backoffice` (composition + UI/BFF vận hành nội bộ) lên local platform với đủ vòng đời: provision database → migration → image → container → readiness.
- Ghim đúng cấu hình OIDC BFF và hai đường fetch nội bộ (auth, staff-access) để middleware authn của app hoạt động fail-closed ngay trên lane local.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config — mật khẩu hai role PostgreSQL (migrator/runtime, xoay mỗi lần `up`) và `internalHmacSecret` ĐỌC LẠI từ stack config của `staff-access-deploy` (staff-access sở hữu, hai stack dùng chung một giá trị để ký/verify envelope HMAC của management API).
- **Provisioning** (`index.ts`): tạo `db-backoffice` + hai role `ecoma_backoffice_{migrator,runtime}` (guard-create bằng shell `if`, password `ALTER` idempotent mỗi lần up), grant migrator, hardening schema public, rồi áp migration bằng cách nối các file `apps/backoffice/db/migrations/*.sql` qua psql trong container PostgreSQL của platform (advisory lock `hashtext('db-backoffice')`; platform không publish host port nên mọi SQL đi qua `docker exec`).
- **Image + container** (`Dockerfile`, `index.ts`): multi-stage build Nuxt từ repo root (builder `default`, `load: true`, `push: false`), container ghim `tag@sha256:<digest>`; alias `ecoma-backoffice`, router Traefik `Host(office.<rootHostname>)` TLS, healthcheck `GET /health` và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Env inject** (`index.ts`): `NITRO_BACKOFFICE_DATABASE_URL` (role runtime qua network nội bộ); bộ OIDC `NUXT_BACKOFFICE_AUTH_ISSUER`/`AUDIENCE` dựng từ `rootHostname` + `traefikHostPort` của platform (ghim cùng chuỗi mà `auth-deploy` cấp cho provider — phép so `iss`/`aud` exact khớp theo cấu trúc) và `NUXT_BACKOFFICE_AUTH_CLIENT_ID` là hằng dùng chung với client public mà `auth-deploy` seed; `AUTH_INTERNAL_SECRET` (secret envelope staff-access ↔ backoffice, bọc `pulumi.secret`); `NUXT_BACKOFFICE_STAFF_ACCESS_SERVICE_URL=http://ecoma-staff-access:4206` — Nitro plugin `server/plugins/staff-access-service-shim.ts` của app biến URL này thành binding `STAFF_ACCESS_SERVICE` lúc runtime; `NUXT_BACKOFFICE_AUTH_INTERNAL_ORIGIN=http://ecoma-<ns>-auth:4203` cho fetch JWKS/token exchange server-side; `NITRO_PUBLIC_BACKOFFICE_DATA_MODE=prototype`.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up` và `staff-access-deploy:local-up` (secret cross-stack).
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — chương trình này chỉ phủ lane local.
- Không sở hữu code của `apps/backoffice` — image build từ source của app; sửa hành vi app thì sửa `apps/backoffice`.
- Không gọi `auth` hay `staff-access` trực tiếp ngoài hai origin khai trong env — mọi contract liên unit là trách nhiệm của app, deploy chỉ cấp origin.
- Thiết kế composition và ranh giới BFF không được restatement ở đây → `docs/applications/backoffice/`.

## Development

```bash
pnpm nx run backoffice-deploy:lint
pnpm nx run backoffice-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run backoffice-deploy:local-up -c local    # provision unit này (kéo platform + staff-access chạy trước)
pnpm nx run backoffice-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Project không có target `test` — targets đã xác nhận từ project graph: `local-up`, `local-down`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Kiểm vòng đời thật: các system-test suite khai `backoffice-deploy:local-up` làm prerequisite — `system-tests/e2e/backoffice-access-control-e2e` (đường gọi có chữ ký tới staff-access) và `system-tests/e2e/identity-oidc-e2e` (flow OIDC backoffice ↔ auth).

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle.
- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — application được deploy và composition của nó.
- [`docs/applications/backoffice/01-architecture.md`](../../docs/applications/backoffice/01-architecture.md) — kiến trúc runtime của app mà env inject ở trên phục vụ.
