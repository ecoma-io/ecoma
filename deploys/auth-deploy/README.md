# Auth Deploy

Pulumi deployment project provision **deploy unit của `apps/auth` trên lane LOCAL**: database `db-auth`, bộ role PostgreSQL, migration, seed client public OAuth, image và container WIC (worker-in-container) phía sau Traefik. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile` với entrypoint `wic-entrypoint.sh`.

Nx project `auth-deploy`, tags `type:deployment`, `scope:auth`, `runtime:native`. Chỉ có lane local (`configurations: local`); staging/production của app khai trong `apps/auth/wrangler.jsonc` và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa `apps/auth` (Worker `ecoma-auth`) lên local platform với đủ vòng đời: provision database → migration → seed client → image → container → readiness.
- Dựng container WIC chạy HAI process `wrangler dev`: worker `ecoma-auth` (cổng nội bộ 4203) và shim `ecoma-account-bridge` (4204, bundle của `tools/account-bridge`) — binding `ACCOUNT_SERVICE` của auth trên lane local đi qua shim này, đúng topology `docs/architecture/local-development/02-account-auth-topology.md` §Service bindings.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config — mật khẩu ba role PostgreSQL (`ecoma_auth_{migrator,runtime,nonce_pruner}`, xoay mỗi lần `up`), `handleKey` và `cookieKeys` (secret ứng dụng 32 byte), `signingKeyId`; `signingKeyPem` đọc lại config trước và chỉ sinh PEM mới khi thiếu (JWKS đổi là mọi token đã cấp không còn verify được); `internalSecret` ĐỌC LẠI từ stack config của `account-deploy` (`namespace:internalHmacSecret` — account sở hữu, hai stack dùng chung một giá trị). Thiếu `ROOT_HOST` trong `.env` là exit 1 với hướng dẫn chạy platform trước.
- **Provisioning** (`index.ts`): tạo `db-auth` + 4 role — owner `ecoma_owner` guard-create khi thiếu và KHÔNG BAO GIỜ `ALTER ROLE ... PASSWORD` (password của role dùng chung hai DB thuộc `account-deploy`; hai stack cùng ALTER là race xoá mật khẩu nhau), `ALTER DATABASE db-auth OWNER TO ecoma_owner`, revoke CONNECT chéo điều kiện hoá theo sự tồn tại của `db-account`, grant per-role, hardening schema public. SQL chạy qua `docker exec` psql trong container PostgreSQL của platform (platform không publish host port).
- **Migration** (`index.ts`): container ephemeral gắn platform network chạy đúng đường canonical `apps/auth/db/apply.mts` (tsx binary của repo, repo mount read-only, credential qua env của container — không argv).
- **Seed client public** (`index.ts`): idempotent upsert client public `backoffice` vào `auth.oauth_clients` và redirect URI `https://office.<rootHostname>:<traefikHostPort>/api/auth/callback` vào `auth.client_redirect_uris` — redirect URI so exact string nên phải mang port động của platform; seed per-environment thuộc deployment chứ không thuộc migration dùng chung mọi môi trường.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): image mỏng ghim `node:24-bookworm-slim` theo digest + `ca-certificates`; repo mount read-only, hai cây bundle `apps/auth/dist` và `tools/account-bridge/dist` mount bind trực tiếp, label `io.ecoma.bundle-hash` (SHA-256 nội dung hai cây dist, tính mỗi lần up) ForceNew — build lại bundle là container recreate; runtime tree mirror ghi được nằm trong volume `/state` (ephemeral, một-shot `chown 1000:1000` chạy trước container). Container: alias DNS `ecoma-<ns>-auth`, router Traefik `Host(auth.<rootHostname>)` TLS, secrets Worker qua container `envs` bọc `pulumi.secret` (không argv, không label, không log), healthcheck `GET /ready` (probe DB thật + binding `ACCOUNT_SERVICE` — `/health` 200 không phải bằng chứng readiness) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`) fail-closed; issuer `https://auth.<rootHostname>:<traefikHostPort>` và audience `https://api.<rootHostname>:<traefikHostPort>` được dựng từ hai output này (port động là bắt buộc trong chuỗi issuer ở local); so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up`, `account-deploy:local-up` (secret cross-stack) và build bundle `auth` + `account-bridge`.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `seedCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — chương trình này chỉ phủ lane local.
- Không sở hữu code của `apps/auth` hay `tools/account-bridge` — container chạy bundle do hai project đó build; sửa hành vi app thì sửa app.
- Password của role `ecoma_owner` thuộc `account-deploy` — stack này guard-create role khi thiếu nhưng không bao giờ đổi password.
- Topology account/auth ở system level và chuẩn SQL role/migration không được restatement ở đây → `docs/architecture/local-development/02-account-auth-topology.md` và `docs/applications/auth/03-operations.md`.

## Development

```bash
pnpm nx run auth-deploy:lint
pnpm nx run auth-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run auth-deploy:local-up -c local    # provision unit này (kéo platform + account + build bundle hai project trước)
pnpm nx run auth-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `test`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`; `test` (vitest, `local-env.spec.ts`) chấm hình giá trị của generator riêng `generateEs256SigningKeyPem` (`local-generators.ts`) — PEM PKCS#8 không trailing newline, đúng contract parse của `SigningKeyProvider.fromPem` phía app.
- Kiểm vòng đời thật: các system-test suite khai `auth-deploy:local-up` làm prerequisite — `system-tests/e2e/identity-oidc-e2e` và `system-tests/e2e/backoffice-access-control-e2e`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — topology account/auth mà stack này hiện thực (§Database access, §Service bindings).
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle.
- [`docs/applications/auth/03-operations.md`](../../docs/applications/auth/03-operations.md) — chuẩn SQL provisioning role mà chương trình mirror và readiness contract `/ready`.
- [`tools/account-bridge/README.md`](../../tools/account-bridge/README.md) — shim worker chạy cùng container WIC.
