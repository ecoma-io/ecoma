# Transactional Mail Deploy

Pulumi deployment project đưa **cặp worker `transactional-mail` (control plane) + `transactional-mailer-job` (queue consumer)** lên lane local trong MỘT WIC container. Image mỏng (`Dockerfile`) ghim `node:24-bookworm-slim` + `ca-certificates` và chứa hai process `wrangler dev` theo `wic-entrypoint.sh`; chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`.

Nx project `transactional-mail-deploy`, tags `type:deployment`, `scope:messaging`, `runtime:native`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Chạy đủ boot path của cặp worker trên local: D1 migrations (`mail`, `mail-job`), queue local, service binding `TRANSACTIONAL_MAIL_SERVICE` resolve qua dev registry; migration `0009` của `mail` tự seed template `account.login-otp` mà path OTP login của account dùng.
- Provider local là `MAIL_PROVIDER_KIND=fake` — không provider SMTP/email thật nào được cấu hình; message row trong D1 `mail` là assertion local.

## Responsibilities

- **Secret bảng** (`local.ts`): `mailInternalAuthSecret` đọc cross-stack từ stack config của `account-deploy` (account là producer, persist khi up trước theo `dependsOn`); ba secret còn lại sinh tại chỗ mỗi lần up — `mailerJobInternalSecret` (HMAC consumer ↔ control plane), `mailFingerprintKey`, `mailQuarantineHmacKey` (hình 64 hex chữ thường là contract loader). Control plane nhận bốn credential slot `MAIL_INTERNAL_AUTH_SECRET_SVC_*` với giá trị phân biệt; consumer nhận cùng giá trị với slot `SVC_TRANSACTIONAL_MAILER_JOB` qua env riêng.
- **Migrations D1** (`index.ts`): container ephemeral chạy `wrangler d1 migrations apply mail` và `mail-job --local --persist-to /state` trên cùng volume với WIC; SQLite trên volume, không đụng PostgreSQL platform.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): control plane port 4206 boot trước consumer port 4207, readiness gate poll `GET /health` của control plane trước khi spawn consumer; healthcheck `GET /health` với `wait: true` nên `pulumi up` xanh là bằng chứng "container phục vụ HTTP"; alias `ecoma-mail` — account gọi `http://ecoma-mail:4206`; không route Traefik, không publish port ra host.
- **Platform dependency** (`index.ts`): `StackReference` đọc `networkName` + `namespace`, fail-closed khi stack platform thuộc namespace khác; volume `/state` được init chown 1000:1000 trước khi migrate và WIC lên.
- Stack exports: `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (D1/Queue/Email Sending) — identity Cloudflare của hai app khai trong `wrangler.jsonc` của từng app và thuộc delivery lane.
- Không sở hữu code hai app — bundle build trên host bởi target `build` Nx; container chỉ chạy bundle được mount vào.
- Ownership nghiệp vụ của context `transactional-mail` → `docs/domains/transactional-mail/`; outbox/queue/retry ở mức vận hành → `docs/applications/transactional-mail/03-operations.md`.

## Development

```bash
pnpm nx run transactional-mail-deploy:lint
pnpm nx run transactional-mail-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run transactional-mail-deploy:local-up -c local   # dependsOn: platform + account-deploy + build hai app
pnpm nx run transactional-mail-deploy:local-down -c local # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Target `test` chạy Vitest trên `local-env.spec.ts` — hợp đồng `generateHexKey64` đúng 64 ký tự hex chữ thường. Không có target `test-integration`/`system-test`.

Kiểm vòng đời thật: ba e2e suite khai `transactional-mail-deploy:local-up` làm prerequisite (đối chiếu `dependsOn` trong `system-tests/e2e/`) — `identity-login-e2e`, `identity-oidc-e2e`, `backoffice-access-control-e2e`.

## Related Documentation

- [`docs/applications/transactional-mail/03-operations.md`](../../docs/applications/transactional-mail/03-operations.md) — vận hành control plane: outbox, retention, scheduled trigger.
- [`docs/applications/transactional-mailer-job/03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — vận hành delivery job: retry policy, provider credential.
- [`docs/domains/transactional-mail/README.md`](../../docs/domains/transactional-mail/README.md) — bounded context: template, message, delivery lifecycle.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — quan hệ account ↔ mail trên lane local (mail sink, provider `fake`).
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — bất biến cross-stack account → transactional-mail và graph `local-up`.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
