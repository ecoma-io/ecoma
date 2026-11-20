# Transactional Mail Deploy

Pulumi deployment project đưa **cặp worker `transactional-mail` (control plane) + `transactional-mailer-job` (queue consumer)** lên lane local trong MỘT WIC container. Image mỏng (`Dockerfile`) ghim `node:24-bookworm-slim` + `ca-certificates` và chứa hai process `wrangler dev` theo `wic-entrypoint.sh`; chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`.

Nx project `transactional-mail-deploy`, tags `type:deployment`, `scope:messaging`, `runtime:native`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Chạy đủ boot path của cặp worker trên local: D1 migrations (`mail`, `mail-job`), queue local, service binding `TRANSACTIONAL_MAIL_SERVICE` resolve qua dev registry; migration `0009` của `mail` tự seed template `account.login-otp` mà path OTP login của account dùng.
- Provider local là `MAIL_PROVIDER_KIND=fake` — không provider SMTP/email thật nào được cấu hình; message row trong D1 `mail` là assertion local.

## Responsibilities

- **Lane staging** (`index.ts` guard + `staging-program.ts`, #355): trên stack Pulumi `staging`, guard nạp program khai **D1 `stg-mail` + chuỗi bốn Queue** (`stg-ecoma-mail-delivery`, `-dlq`, `stg-ecoma-mail-lifecycle-events`, `-dlq`) — đúng bảng ownership `02-delivery.md` §9.1 (Pulumi tạo/xoá resource, Wrangler chỉ deploy Worker, migration thuộc `tools/dx d1-migrate` #382). Stack `staging-candidate` bị guard **từ chối tường minh** (tên tài nguyên slot `-cand` thuộc #381 — D1/Queue trùng tên trên một account là collision); stack lạ fail-closed. Trên stack `local-<namespace>` guard nạp `local-program.ts` như trước.
- **Engine staging** (`staging-run.ts`, bản copy có chủ đích của pattern `platform-deploy` #453 / `auth-deploy` #539): inventory credential fail-closed (`ECOMA_PULUMI_STATE_URL_STAGING`, `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` — credential chỉ đi qua env, không argv, token không vào provider config/state); chỉ mở phase `preview`/`up`; evidence append-only `.staging-evidence/`. Sau một lần `up` xanh, entry đọc stack output `mailDatabaseId` để operator fill vào `env.staging.d1_databases` của `apps/transactional-mail/wrangler.jsonc` — wiring là commit review-able, không phải ghi-deploy-time.
- **Spec hợp đồng config** (`staging-config.spec.ts` + `wrangler-jsonc.ts`): đọc trực tiếp hai file `wrangler.jsonc` của app và chốt identity `stg-<tên production>`, binding audit (mọi loại binding top-level phải được khai lại trong `env.staging` — Wrangler không kế thừa), chuỗi queue producer↔consumer↔DLQ đồng bộ hai app với hằng `STAGING_QUEUE_NAMES`, trạng thái D1 "chưa provision" đúng §9.1 (thiếu `database_id`, không placeholder), provider `cloudflare` khớp sender ghim, cron kế thừa top-level.

- **Secret bảng** (`local.ts`): `mailInternalAuthSecret` đọc cross-stack từ stack config của `account-deploy` (account là producer, persist khi up trước theo `dependsOn`); ba secret còn lại sinh tại chỗ mỗi lần up — `mailerJobInternalSecret` (HMAC consumer ↔ control plane), `mailFingerprintKey`, `mailQuarantineHmacKey` (hình 64 hex chữ thường là contract loader). Control plane nhận bốn credential slot `MAIL_INTERNAL_AUTH_SECRET_SVC_*` với giá trị phân biệt; consumer nhận cùng giá trị với slot `SVC_TRANSACTIONAL_MAILER_JOB` qua env riêng.
- **Migrations D1** (`local-program.ts`): container ephemeral chạy `wrangler d1 migrations apply mail` và `mail-job --local --persist-to /state` trên cùng volume với WIC; SQLite trên volume, không đụng PostgreSQL platform.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `local-program.ts`): control plane port 4206 boot trước consumer port 4207, readiness gate poll `GET /health` của control plane trước khi spawn consumer; healthcheck `GET /health` với `wait: true` nên `pulumi up` xanh là bằng chứng "container phục vụ HTTP"; alias `ecoma-mail` — account gọi `http://ecoma-mail:4206`; không route Traefik, không publish port ra host.
- **Platform dependency** (`index.ts`): `StackReference` đọc `networkName` + `namespace`, fail-closed khi stack platform thuộc namespace khác; volume `/state` được init chown 1000:1000 trước khi migrate và WIC lên.
- Stack exports: `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Trên lane **local**: không provision hạ tầng Cloudflare — identity Cloudflare của hai app khai trong `wrangler.jsonc` của từng app và thuộc delivery lane. Trên lane **staging** (#355): project provision D1 + Queue per-lane (§9.1) nhưng vẫn không provision Email Sending hay Worker — deploy Worker là Wrangler (lane dùng chung `tools/delivery staging-deploy`, #535), send_email binding không cần provision Pulumi.
- Không sở hữu code hai app — bundle build trên host bởi target `build` Nx; container chỉ chạy bundle được mount vào.
- Không sở hữu migration D1 — migration là việc của `tools/dx d1-migrate` (cutover #382).
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

Target `test` chạy Vitest trên `local-env.spec.ts` (hợp đồng `generateHexKey64` đúng 64 ký tự hex chữ thường), `staging-run.spec.ts` (engine lane staging — pure functions + exec inject, không chạy Pulumi thật) và `staging-config.spec.ts` (hợp đồng `env.staging` hai app + chuỗi queue với hằng provisioning). Không có target `test-integration`/`system-test`.

Lane staging mutate Pulumi state staging thật — chỉ chạy khi chủ đích thay đổi tài nguyên staging, với inventory credential đã set (bootstrap backend #350, token Cloudflare, R2 token bucket-scoped, passphrase per-stack):

```bash
pnpm nx run transactional-mail-deploy:staging-preview -c staging
pnpm nx run transactional-mail-deploy:staging-up -c staging
```

Sau lần `staging-up` xanh đầu tiên: fill `database_id` thật (từ `pulumi stack output mailDatabaseId`, entry `staging.ts` surface id) vào `apps/transactional-mail/wrangler.jsonc`, rồi mới đủ điều kiện flip eligibility (coordinator-owned).

Kiểm vòng đời thật: ba e2e suite khai `transactional-mail-deploy:local-up` làm prerequisite (đối chiếu `dependsOn` trong `system-tests/e2e/`) — `identity-login-e2e`, `identity-oidc-e2e`, `backoffice-access-control-e2e`.

## Related Documentation

- [`docs/applications/transactional-mail/03-operations.md`](../../docs/applications/transactional-mail/03-operations.md) — vận hành control plane: outbox, retention, scheduled trigger.
- [`docs/applications/transactional-mailer-job/03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — vận hành delivery job: retry policy, provider credential.
- [`docs/domains/transactional-mail/README.md`](../../docs/domains/transactional-mail/README.md) — bounded context: template, message, delivery lifecycle.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — quan hệ account ↔ mail trên lane local (mail sink, provider `fake`).
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — bất biến cross-stack account → transactional-mail và graph `local-up`.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
