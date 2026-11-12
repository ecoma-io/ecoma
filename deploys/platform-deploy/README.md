# Platform Deploy

Pulumi deployment project provision **nền tảng local dùng chung cho mọi deploy unit của một worktree**: Docker network, Traefik (entrypoint HTTPS duy nhất), PostgreSQL với volume persistent, và object store SeaweedFS dành cho remote-cache. Đây là deploy project (`type:deployment`), không phải application hay bounded context — local platform là tài nguyên sở hữu của Architecture. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, dynamic TLS config tĩnh ở `traefik-dynamic.yml`, certificate tự ký ở `local-certs/`.

Nx project `platform-deploy`, tags `type:deployment`, `scope:platform`, `runtime:native`. Cả ba target lifecycle chỉ có configuration `local` — đây là lane duy nhất của chương trình.

## Purpose

- Cung cấp hạ tầng mà mọi deploy unit join: unit đọc outputs platform qua `StackReference` rồi join network — không unit nào tự tạo network, Traefik hay PostgreSQL.
- Cách ly theo worktree: mọi tên Docker resource và tên Pulumi stack mang namespace hash của worktree root, hai worktree deploy song song trên một host không đụng tài nguyên của nhau.

## Responsibilities

- **Network** (`index.ts`): Docker network mang ownership labels — bộ dữ liệu mà `pnpm dx local-cleanup` đọc để phân loại resource mồ côi.
- **Traefik** (`index.ts`): image ghim theo digest (yêu cầu tối thiểu 3.6.1); một entrypoint HTTPS cổng nội bộ, host port Docker cấp động bind `127.0.0.1`; healthcheck `traefik healthcheck` với `wait: true`; bind-mount certificate, Docker socket (fail-loud khi `DOCKER_HOST`/`DOCKER_SOCKET_PATH` trỏ hai daemon khác nhau) và `traefik-dynamic.yml`; router lọc container theo network của worktree qua `--providers.docker.constraints` để container worktree khác không vào config.
- **PostgreSQL** (`index.ts`): image `timescale/timescaledb` ghim theo digest (TimescaleDB preload, extension pgvector có sẵn); user/database `ecoma_local`; mật khẩu do entry up sinh một lần khi stack mới và volume còn trống, persist vào stack config `postgres:password`; volume `retainOnDelete`; alias `ecoma-postgres`, không publish host port; healthcheck `pg_isready`.
- **Object store SeaweedFS** (`index.ts`): `weed mini` một process (master + volume + filer + S3); hai volume không `retainOnDelete` (config `s3.json` + data cache); command config-init ghi `s3.json` qua stdin của `docker run -i` (secret không qua argv), command bucket guard-create bucket `remote-cache` qua `weed shell` trong container; alias `ecoma-object-store`, healthcheck `/healthz`.
- **Secret lifecycle** (`local.ts`, `platform-env.ts`): `resolvePostgresPassword` fail-loud khi config mất mà volume còn; `resolveObjectStorageSecretKey` sinh `objectStorage:remoteCacheSecretKey` — secret key mà `remote-cache-api-deploy` đọc lại cross-stack. Không secret nào nằm trong stack outputs.
- **Upsert `.env`** (`platform-env.ts`): sau khi up xanh, ghi đúng ba key sở hữu `ROOT_HOST`, `ROOT_DOMAIN`, `POSTGRES_PASSWORD`, giữ nguyên byte các dòng còn lại.
- Stack outputs: hợp đồng `PlatformOutputs` (`namespace`, `networkName`, `postgresHost`/`postgresPort`, bốn field object storage, `traefikHostPort` fail-closed qua `extractTraefikHostPort`, `rootHostname`) cộng hai command name của object store.

## Boundaries

- Chỉ phủ lane local: staging/production của app đi đường Cloudflare Workers qua Wrangler và không đi qua chương trình này.
- Không sở hữu database nghiệp vụ: mỗi deploy unit sở hữu database + role riêng do deploy project của nó provision; `ecoma_local` chỉ là database bootstrap của platform.
- Volume PostgreSQL chỉ bị xoá trong luồng down của chính project này — xoá vô điều kiện sau destroy, không có tuỳ chọn giữ dữ liệu local.

## Development

```bash
pnpm nx run platform-deploy:lint
pnpm nx run platform-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run platform-deploy:local-up -c local    # node gốc của lane, không dependsOn unit nào
pnpm nx run platform-deploy:local-down -c local  # destroy + xoá volume PostgreSQL vô điều kiện
pnpm nx run platform-deploy:local-smoke -c local # smoke HTTPS; dependsOn duy nhất home-deploy:local-up
```

Luồng toàn lane, teardown và `pnpm dx local-status` → `docs/architecture/local-development/03-operations.md`.

## Testing

Target `test` chạy Vitest trên ba spec colocated — đã xác nhận từ project graph: `platform-env.spec.ts` (hợp đồng ba trạng thái đọc password PostgreSQL, guard leak trong error string), `platform-down.spec.ts` (ma trận lỗi destroy/volume với exit code riêng biệt), `object-store-config-init.spec.ts` (secret không nằm trong chuỗi command, payload qua stdin, rotation giữ trigger).

Không có target `test-integration`/`system-test`. Kiểm vòng đời thật của lane là `local-smoke`: `/` trả 302 `/en`, `/en` trả 2xx HTML có title Ecoma.io, TLS verify bằng certificate local — script `system-tests/local-smoke/src/local-smoke.mjs`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — local platform và index tài liệu.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership từng resource, cách ly worktree, hợp đồng outputs, invariants platform.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — luồng deploy toàn lane, teardown, `local-cleanup`, giới hạn đã biết.
- [`libs/deployment/src/platform-outputs-contract.ts`](../../libs/deployment/src/platform-outputs-contract.ts) — hình dạng `PlatformOutputs` mà stack này export.
