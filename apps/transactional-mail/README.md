# Transactional Mail

Control plane của hệ thống Transactional Mail — Cloudflare Worker (Hono) nhận yêu cầu gửi mail từ consumer (`account`, `auth`, `payment`), render template, lưu domain state vào D1 `mail` và đưa việc giao vào Cloudflare Queue qua transactional outbox. Domain model tại `docs/domains/transactional-mail/`; thiết kế component là nội dung canonical của `docs/applications/transactional-mail/`.

Nx project `@ecoma-io/transactional-mail`, tags `type:composition`, `scope:messaging`, `runtime:edge`.

## Purpose

- Worker `ecoma-transactional-mail` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`): control plane không public hostname; consumer `transactional-mailer-job` gọi internal API qua Service Binding `TRANSACTIONAL_MAIL_SERVICE` khai trong `apps/transactional-mailer-job/wrangler.jsonc`.
- Bề mặt HTTP thật (`src/main.ts`, mọi route khác → Hono 404): `GET /health`, `POST /v1/messages` (tạo message + outbox, idempotent theo principal + key), `GET /internal/deliveries/:deliveryId` (runtime material cho delivery worker), `POST /internal/deliveries/:deliveryId/outcome` (nhận outcome worker báo).
- Entrypoint `scheduled` theo cron `*/5 * * * *` chạy bốn việc theo thứ tự có chủ đích: publish outbox → reconciler → prune nonce → retention.
- Thiết kế outbox, private delivery interface, generation authority là nội dung canonical của `docs/applications/transactional-mail/01-architecture.md`.

## Responsibilities

- **Mail template versioned**: tên + locale + version, mỗi version có `variables_schema_json`; authorization template qua `isTemplateAuthorized` trước render.
- **Mail message + outbox**: `POST /v1/messages` render nội dung từ template, lưu domain state vào D1 `mail`, publish Mail Command vào Queue `ecoma-mail-delivery` (binding `QUEUE`) qua Outbox Publisher; idempotency theo `UNIQUE (principal_id, idempotency_key)`.
- **Internal HMAC envelope** (`src/internal-auth.ts`): xác thực mọi request internal, suy principal từ credential đã khớp (envelope không mang caller); permission đối chiếu trước khi xử lý — `message.create`, `delivery.read`, `delivery.outcome`.
- **Body limit**: đọc body theo stream với hạn mức tích lũy, từ chối ngay khi vượt trần.
- **Persistence**: D1 `mail` (binding `mail`) là authoritative storage của control plane; schema và migration D1 tại `migrations/`.
- **Retention/deletion** và rate limit theo authenticated principal và system-wide sending limit (`MAIL_RATE_LIMIT_*`).
- Fail-closed: config thiếu là lỗi nêu tên biến, không có default đoán được; cache config chỉ giữ giá trị thành công.

## Boundaries

- Chỉ là control plane: không relay tới provider, không chọn/reroute provider — delivery plane là Worker riêng `apps/transactional-mailer-job`; provider credential là Worker Secret của job đó, không phải của component này.
- Không đọc D1 `mail-job`; dữ liệu job execution state thuộc delivery plane.
- Service Binding không thay được signature: `/internal/**` xác thực bằng HMAC envelope thay vì dựa vào "chỉ binding mới gọi được".
- Không sở hữu nghiệp vụ mail — `Mail Template`, `Mail Message`, message intent và business delivery lifecycle tại `docs/domains/transactional-mail/domain-model.md`.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mail:serve   # wrangler dev — cần env/secret đủ theo src/config.ts
pnpm nx run @ecoma-io/transactional-mail:build   # esbuild → dist/main.js
pnpm nx run @ecoma-io/transactional-mail:lint
pnpm nx run @ecoma-io/transactional-mail:typecheck
```

- Biến cấu hình chính: `MAIL_INTERNAL_AUTH_SECRET_*`, `MAIL_INTERNAL_AUTH_SKEW_SECONDS`, `MAIL_FINGERPRINT_KEYRING`, `MAIL_QUARANTINE_HMAC_KEY` (nhóm secret) và tham số `MAIL_PUBLISH_*`, `MAIL_RECONCILER_*`, `MAIL_RATE_LIMIT_*`, `MAIL_RETENTION_*`, `MAIL_RENDER_MAX_BYTES`, `MAIL_TEMPLATE_URL_ALLOWED_HOSTS` (đầy đủ trong `src/config.ts`).
- Tham gia local worker runtime qua marker `local-worker.jsonc` với `readiness: "http-health"` (Worker serve `GET /health`), chạy qua `pnpm dx local-worker-up`.

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mail:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/transactional-mail:test-integration # tests/integrations — D1 thật qua harness
```

- Suite integration ghim hành internal auth, route serving và scheduled trên runtime thật.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/transactional-mail/README.md`](../../docs/applications/transactional-mail/README.md) — component doc; [`01-architecture.md`](../../docs/applications/transactional-mail/01-architecture.md) (runtime boundary, outbox, private interface, invariants), [`02-requirements.md`](../../docs/applications/transactional-mail/02-requirements.md), [`03-operations.md`](../../docs/applications/transactional-mail/03-operations.md).
- [`docs/domains/transactional-mail/README.md`](../../docs/domains/transactional-mail/README.md) — bounded context; [`domain-model.md`](../../docs/domains/transactional-mail/domain-model.md) — template, message, intent, delivery lifecycle, retention.
- [`apps/transactional-mailer-job/README.md`](../transactional-mailer-job/README.md) — delivery plane consume Queue `ecoma-mail-delivery`.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — transactional outbox, idempotency và topology deploy.
