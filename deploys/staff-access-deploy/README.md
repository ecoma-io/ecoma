# Staff Access Deploy

Pulumi deployment project của `apps/staff-access` — service Staff Access (staff directory, role/permission catalog, entitlement, authorization audit API) — trên lane local, dạng WIC container một worker kèm provision `db-staff-access` + hai role PostgreSQL; migration đi đúng đường canonical của app. Chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`, bundle-hash trigger ở `bundle-hash.ts`.

Nx project `staff-access-deploy`, tags `type:deployment`, `scope:staff-access`, `runtime:native`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Đưa service lên local với đủ vòng đời: provision database → migration → image → container readiness `/ready`.
- Chỉ có lane local; Hyperdrive/Worker identity của delivery lane khai trong `apps/staff-access/wrangler.jsonc`, không nằm trong chương trình này.

## Responsibilities

- **Provisioning** (`index.ts`): tạo `db-staff-access` + hai role `ecoma_staff_access_migrator`/`ecoma_staff_access_runtime` qua `docker exec` psql trong container PostgreSQL của platform; guard-create role/database, `ALTER ROLE ... PASSWORD` mỗi lần up (mật khẩu do entry up sinh); `REVOKE CONNECT` chéo khỏi `db-account`, `db-auth`, `db-backoffice` (điều kiện hoá theo sự tồn tại của database đích); hardening schema `public`.
- **Migration** (`index.ts`): container ephemeral trên platform network chạy `apps/staff-access/db/apply.mts` (advisory lock, không qua binding Hyperdrive). Không có bước seed riêng: permission catalog đi cùng migration, first-admin bootstrap là procedure offline theo ADR-0003 — deploy không seed staff.
- **Secret lifecycle** (`local.ts`): `runtimePassword`, `migratorPassword`, `internalHmacSecret` sinh mỗi lần up; `internalHmacSecret` là credential dùng chung với backoffice — `backoffice-deploy` đọc lại bằng `pulumi config get` và cả hai stack truyền cùng giá trị thành `AUTH_INTERNAL_SECRET`.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): một worker `ecoma-staff-access` port 4206 (`dev.port` của app), alias `ecoma-staff-access`; env gồm `AUTH_INTERNAL_SECRET` và Hyperdrive local connection string (binding `DB_STAFF_ACCESS`); label `io.ecoma.bundle-hash` (SHA-256 của cây `dist`, `bundle-hash.ts`) recreate container khi bundle build lại trên host; healthcheck `GET /ready` yêu cầu 2xx — readiness nghiệp vụ (config nạp được + DB trả lời bằng credential runtime); `wait: true`; không route Traefik, không publish port ra host.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare và không seed dữ liệu nghiệp vụ — nội dung system-defined role và first-admin bootstrap thuộc procedure của context, được ghi trong `docs/domains/staff-access/` và `docs/applications/staff-access/03-operations.md`.
- Không sở hữu code của `apps/staff-access` — bundle build trên host bởi target `build` Nx; container chỉ chạy bundle được mount vào.
- Consumer local duy nhất là backoffice qua alias nội bộ; đường gọi có chữ ký backoffice ↔ staff-access được chứng minh bởi system-test, không bởi healthcheck — sự phân biệt này do `docs/architecture/local-development/03-operations.md` sở hữu.

## Development

```bash
pnpm nx run staff-access-deploy:lint
pnpm nx run staff-access-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run staff-access-deploy:local-up -c local   # dependsOn: platform-deploy:local-up + build app
pnpm nx run staff-access-deploy:local-down -c local # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Target `test` chạy Vitest trên `bundle-hash.spec.ts` — hash của cây `dist` deterministic, đổi nội dung lẫn đổi tên file đều làm hash đổi, fail-loud khi `dist` thiếu. Không có target `test-integration`/`system-test`.

Kiểm vòng đời thật: `backoffice-access-control-e2e` (`system-tests/e2e/`) khai `staff-access-deploy:local-up` làm prerequisite — `local-up` xanh đồng nghĩa healthcheck `/ready` đã `healthy`.

## Related Documentation

- [`docs/applications/staff-access/03-operations.md`](../../docs/applications/staff-access/03-operations.md) — procedure first-admin bootstrap và runtime credential.
- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context: staff, permission catalog, entitlement, audit.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — bất biến cross-stack staff-access → backoffice và graph `local-up`.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
