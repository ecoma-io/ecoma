# Push Notification Deploy

Pulumi deployment project đưa **cặp worker `push-notification` (control plane) + `web-push-notification-job` (queue consumer)** lên lane local trong MỘT WIC container. Image mỏng (`Dockerfile`) ghim `node:24-bookworm-slim` + `ca-certificates` và chứa hai process `wrangler dev` theo `wic-entrypoint.sh`; chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`.

Nx project `push-notification-deploy`, tags `type:deployment`, `scope:notifications`, `runtime:native`; trạng thái `ecoma.deployment.status: "scaffold"` trong `package.json`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Chạy đủ boot path của cặp worker trên local: D1 migrations (`push`, `push-job`), queue local, service binding `PUSH_NOTIFICATION_SERVICE` resolve qua dev registry giữa hai process.
- Provider Web Push thật không được cấu hình ở local — không subscription nào được tạo trong lane nên worker không dial push service thật; consumer boot đầy đủ (queue consumer + service binding) là mức evidence của unit này.

## Responsibilities

- **Secret bảng** (`local.ts`): sinh và persist bốn giá trị vào stack config mỗi lần up — `runtimeSharedSecret` (HMAC control plane ↔ consumer, hai process nhận cùng giá trị trong cùng container), `adminToken`, `applicationToken`, `credentialRootKey` (base64 32 byte AES-256; xoay mỗi lần up vì D1 local trên volume state là ephemeral).
- **Migrations D1** (`index.ts`): container ephemeral chạy `wrangler d1 migrations apply push` và `push-job --local --persist-to /state` trên cùng volume với WIC; SQLite trên volume, không đụng PostgreSQL platform.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): image chỉ là phòng chạy (Node pin + entrypoint, `USER node`); container mount repo read-only + bundle `dist/` của hai app + volume `/state` (state wrangler: D1 local, queue local, dev registry); control plane port 4208 boot TRƯỚC consumer port 4209, readiness gate đọc banner `Ready on http` vì control plane không có route `/health`.
- **Healthcheck** (`index.ts`): `HEAD /__wic_probe` — 404 ổn định của `notFound` chứng minh workerd serve HTTP, không chạm dependency nào; `wait: true` + `waitTimeout 450s` nên `pulumi up` xanh là bằng chứng serving.
- **Platform dependency** (`index.ts`): `StackReference` đọc `networkName` + `namespace`, fail-closed khi stack platform thuộc namespace khác; join platform network với alias `ecoma-push`; không route Traefik, không publish port ra host.
- Stack exports: `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (D1/Queue/Worker identity) — identity Cloudflare của hai app khai trong `wrangler.jsonc` của từng app và thuộc delivery lane.
- Không sở hữu code hai app — bundle build trên host bởi target `build` Nx; container chỉ chạy bundle được mount vào.
- Ownership nghiệp vụ của context `push-notification` → `docs/domains/push-notification/`; topology Worker-as-container ở system level → `docs/architecture/local-development/`.

## Development

```bash
pnpm nx run push-notification-deploy:lint
pnpm nx run push-notification-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run push-notification-deploy:local-up -c local    # dependsOn: platform-deploy:local-up + build hai app
pnpm nx run push-notification-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Target `test` chạy Vitest trên `local-env.spec.ts` — hợp đồng `generateBase64Key32` decode đúng 32 byte. Không có target `test-integration`/`system-test`; không e2e suite nào khai unit này làm prerequisite (đã đối chiếu `dependsOn` của bốn suite trong `system-tests/e2e/`).

## Related Documentation

- [`docs/applications/push-notification/03-operations.md`](../../docs/applications/push-notification/03-operations.md) — vận hành control plane: outbox, retry, provider.
- [`docs/applications/web-push-notification-job/03-operations.md`](../../docs/applications/web-push-notification-job/03-operations.md) — vận hành delivery job: retry policy, DLQ.
- [`docs/domains/push-notification/README.md`](../../docs/domains/push-notification/README.md) — bounded context sở hữu nghiệp vụ push.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — luồng deploy lane và teardown.
- [`docs/architecture/local-development/evidence/worker-runtime-spike.md`](../../docs/architecture/local-development/evidence/worker-runtime-spike.md) — bằng chứng `wrangler dev` làm Worker local runtime: readiness, queue, service binding.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
