# Staff Access Deploy

Pulumi deployment project của `apps/staff-access` — service Staff Access (staff directory, role/permission catalog, entitlement, authorization audit API): lane LOCAL dạng WIC container một worker kèm provision `db-staff-access` + hai role PostgreSQL, migration đi đúng đường canonical của app; lane STAGING khai HyperdriveConfig của `db-staff-access`. Entry chương trình Pulumi ở `index.ts` (lane guard), thân lane local ở `local-program.ts`, thân lane staging ở `staging-program.ts`; entry lifecycle local ở `local.ts`, entry lifecycle staging ở `staging.ts`; bundle-hash trigger ở `bundle-hash.ts`.

Nx project `staff-access-deploy`, tags `type:deployment`, `scope:staff-access`, `runtime:native`. Worker staging của app khai trong `apps/staff-access/wrangler.jsonc` và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa service lên local với đủ vòng đời: provision database → migration → image → container readiness `/ready`.
- Cấp HyperdriveConfig staging của `db-staff-access` (`db-staff-access-staging`, §9.1) cho lane staging — id thật đọc từ stack output `hyperdriveConfigId` sau lần `up` xanh đầu tiên và fill vào `env.staging.hyperdrive` của `apps/staff-access/wrangler.jsonc` (id do Pulumi cung cấp, Wrangler không tự tạo config).

## Responsibilities

- **Provisioning lane local** (`local-program.ts`): tạo `db-staff-access` + hai role `ecoma_staff_access_migrator`/`ecoma_staff_access_runtime` qua `docker exec` psql trong container PostgreSQL của platform; guard-create role/database, `ALTER ROLE ... PASSWORD` mỗi lần up (mật khẩu do entry up sinh); `REVOKE CONNECT` chéo khỏi `db-account`, `db-auth`, `db-backoffice` (điều kiện hoá theo sự tồn tại của database đích); hardening schema `public`.
- **Migration** (`local-program.ts`): container ephemeral trên platform network chạy runner thật của `databases/staff-access-db` — chuỗi `adopt && migrate` (advisory lock giữ nguyên khóa của runner cũ, không qua binding Hyperdrive). Không có bước seed riêng: permission catalog đi cùng migration, first-admin bootstrap là procedure offline theo ADR-0003 — deploy không seed staff.
- **Secret lifecycle** (`local.ts`): `runtimePassword`, `migratorPassword`, `internalHmacSecret` sinh mỗi lần up; `internalHmacSecret` là credential dùng chung với backoffice — `backoffice-deploy` đọc lại bằng `pulumi config get` và cả hai stack truyền cùng giá trị thành `AUTH_INTERNAL_SECRET`. Ranh giới kênh truyền (đã chấp nhận, cùng hình auth-deploy): secret đi vào script/container qua map `environment` / `envs` bọc `pulumi.secret` — kênh này chỉ cách ly argv, KHÔNG bảo vệ trước việc xem process environ ở tầng host; ai đọc được environ của process Pulumi (hoặc của container) đọc được giá trị plaintext. State Pulumi mã hoá secret (decode đòi passphrase per-stack).
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `local-program.ts`): một worker `ecoma-staff-access` port 4206 (`dev.port` của app), alias `ecoma-staff-access`; env gồm `AUTH_INTERNAL_SECRET` và Hyperdrive local connection string (binding `DB_STAFF_ACCESS`); label `io.ecoma.bundle-hash` (SHA-256 của cây `dist`, `bundle-hash.ts`) recreate container khi bundle build lại trên host; healthcheck `GET /ready` yêu cầu 2xx — readiness nghiệp vụ (config nạp được + DB trả lời bằng credential runtime); `wait: true`; không route Traefik, không publish port ra host.
- **Provisioning lane staging** (`staging-program.ts`, `staging-run.ts`, `staging.ts`): `preview`/`up` trên stack `staging` backend R2 khai HyperdriveConfig `db-staff-access-staging` — origin đọc từ stack config và FAIL CLOSED khi chưa có (đường tới origin private là Tunnel/VPC Service của #349); cache OFF tường minh theo yêu cầu documented của `db-staff-access` (ADR-0001 — một assignment đã revoke trả về từ cache là lần cấp quyền thứ hai); inventory credential fail-closed với danh sách đầy đủ khóa thiếu; evidence record JSON append-only mỗi lần chạy trong `.staging-evidence/`; KHÔNG có phase down/destroy.
- Stack exports lane local: `provisionCommandName`, `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`; lane staging: `hyperdriveConfigId`.

## Boundaries

- Lane local không provision hạ tầng Cloudflare; lane staging chỉ khai HyperdriveConfig (owner Pulumi theo §9.1) — KHÔNG deploy Worker, KHÔNG khai route/DNS (Worker deploy là Wrangler, hostname staging thuộc Router non-production A13/MOD1; service nội bộ không có public surface nào).
- Không seed dữ liệu nghiệp vụ — nội dung system-defined role và first-admin bootstrap thuộc procedure của context, được ghi trong `docs/domains/staff-access/` và `docs/applications/staff-access/03-operations.md`.
- Không sở hữu code của `apps/staff-access` — bundle build trên host bởi target `build` Nx; container chỉ chạy bundle được mount vào.
- Consumer local duy nhất là backoffice qua alias nội bộ; đường gọi có chữ ký backoffice ↔ staff-access được chứng minh bởi system-test, không bởi healthcheck — sự phân biệt này do `docs/architecture/local-development/03-operations.md` sở hữu.

## Development

```bash
pnpm nx run staff-access-deploy:lint
pnpm nx run staff-access-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack:

```bash
pnpm nx run staff-access-deploy:local-up -c local         # lane local: dependsOn platform-deploy:local-up + build app
pnpm nx run staff-access-deploy:local-down -c local       # lane local: destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
pnpm nx run staff-access-deploy:staging-preview -c staging  # lane staging: pulumi preview --json trên stack staging (fail-closed khi thiếu credential/origin)
pnpm nx run staff-access-deploy:staging-up -c staging       # lane staging: pulumi up --yes --json; sau khi xanh surface output hyperdriveConfigId
```

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `staging-preview`, `staging-up`, `test`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Kiểm unit (`test`): `bundle-hash.spec.ts` — hash của cây `dist` deterministic, đổi nội dung lẫn đổi tên file đều làm hash đổi, fail-loud khi `dist` thiếu; và `staging-run.spec.ts` — engine staging dạng pure functions + exec inject: fail-closed inventory credential, origin fail-closed (#349), id thật vs placeholder, tên config per-database, phân loại stack theo lane.
- Kiểm vòng đời thật: `backoffice-access-control-e2e` (`system-tests/e2e/`) khai `staff-access-deploy:local-up` làm prerequisite — `local-up` xanh đồng nghĩa healthcheck `/ready` đã `healthy`; smoke của cả platform là target `local-smoke` của `platform-deploy`.

## Related Documentation

- [`docs/applications/staff-access/03-operations.md`](../../docs/applications/staff-access/03-operations.md) — procedure first-admin bootstrap và runtime credential.
- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context: staff, permission catalog, entitlement, audit.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — bất biến cross-stack staff-access → backoffice và graph `local-up`.
- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) — §4.2 topology staging, §7.4.1 Pulumi stack & lifecycle, §9.1 bảng sở hữu resource (Hyperdrive config owner Pulumi).
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
