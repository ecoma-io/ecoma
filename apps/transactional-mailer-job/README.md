# Transactional Mailer Job

Delivery plane của bounded context `transactional-mail` — Cloudflare Worker queue consumer thực thi mail delivery cho các `Mail Message` mà control plane `apps/transactional-mail` đã render và enqueue. Worker không render template, không quyết định recipient, không chọn/reroute provider. Domain model tại `docs/domains/transactional-mail/`; thiết kế component là nội dung canonical của `docs/applications/transactional-mailer-job/`.

Nx project `@ecoma-io/transactional-mailer-job`, tags `type:composition`, `scope:messaging`, `runtime:edge`.

## Purpose

- Worker `ecoma-transactional-mailer-job` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`) với hai entrypoint của platform, không có `fetch` export và không có HTTP route nào: `queue` xử lý Mail Command, `scheduled` chạy sweep theo cron `*/5 * * * *`.
- Queue consumer `ecoma-mail-delivery` (max_retries 3, DLQ `ecoma-mail-delivery-dlq`): một message một lần `processMailCommand`, disposition của orchestration quyết định ack/retry — `ack-processed`/`quarantined`/`internal-blocked` → ack, `retry` → `message.retry()`, lỗi ngoài phân loại throw để Queue retry theo `max_retries` + DLQ.
- Queue consumer thứ hai `ecoma-mail-lifecycle-events` (max_retries 2, DLQ riêng) cho lifecycle event ingest của provider: `stored`/`duplicate`/`quarantined` → ack, `transient` → retry; payload hỏng vào bảng `quarantine` với reason riêng, không bao giờ retry.
- Thiết kế boundary, lifecycle, idempotency và retry model là nội dung canonical của `docs/applications/transactional-mailer-job/01-architecture.md`.

## Responsibilities

- **Job execution state**: D1 `mail-job` (binding `mail-job`) là storage riêng của component — lease/claim, attempt, quarantine, report; schema và migration D1 tại `migrations/`.
- **Material từ control plane**: resolve qua Service Binding `TRANSACTIONAL_MAIL_SERVICE` tới `ecoma-transactional-mail` (`GET /internal/deliveries/:deliveryId`), kèm internal HMAC secret — chỉ runtime data, không provider credential.
- **Provider adapter** theo `MAIL_PROVIDER_KIND`: `cloudflare` qua binding `SEND_EMAIL` (`send_email` với `allowed_sender_addresses: ["no-reply@ecoma.io"]`), `resend` qua HTTP endpoint + token là Worker Secret của chính worker này, `fake` không gửi mail nào và ghi log `fake_provider_in_use` mỗi lần dựng deps (fail-noisy).
- **Scheduled sweep** (`src/main.ts`): report sweep (báo nốt outcome của row terminal cho control plane) chạy trước, sau đó là stale execution lease sweep và blocked backlog sweep — chỉ alert, không claim execution; mỗi sweep bắt lỗi riêng.
- **Credential hygiene**: provider credential không bao giờ vào Queue message, log hay DLQ; HMAC quarantine key `MAIL_QUARANTINE_HMAC_KEY` chỉ dùng cho digest.
- Tham số lease/attempt/window qua biến `MAIL_JOB_*` (`src/config.ts`), fail-closed khi thiếu.

## Boundaries

- Không truy cập D1 `mail` của control plane; hai deploy unit có storage và lifecycle độc lập, giao tiếp qua Queue, Service Binding và Mail Command contract (`docs/applications/transactional-mail/01-architecture.md` §5/§7).
- Không có API public và không có `fetch` export — một HTTP surface là một ranh giới mới cần auth mà không endpoint nào được định nghĩa.
- Không render template, không quyết định recipient, không chọn/reroute provider — mọi quyết định đã được control plane materialize.
- Queue `ecoma-mail-lifecycle-events` có producer ngoài repo (Cloudflare Email Service Event Subscriptions); marker `local-worker.jsonc` khai `external_queue_producers` để orphan guard của local runtime không coi consumer này là lỗi cấu hình.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mailer-job:serve   # wrangler dev — chỉ dùng để quan sát log, không có HTTP
pnpm nx run @ecoma-io/transactional-mailer-job:build   # esbuild → dist/main.js
pnpm nx run @ecoma-io/transactional-mailer-job:lint
pnpm nx run @ecoma-io/transactional-mailer-job:typecheck
```

- Biến cấu hình chính: `MAIL_PROVIDER_KIND`, `MAIL_PROVIDER_ENDPOINT`, `MAIL_PROVIDER_TOKEN`, `MAIL_PROVIDER_FROM`, `MAIL_PROVIDER_TIMEOUT_MS`, `MAIL_CF_SENDER`, `MAIL_QUARANTINE_HMAC_KEY`, `MAIL_INTERNAL_AUTH_SECRET_*`, `MAIL_JOB_*` (đầy đủ trong `src/config.ts`).
- Tham gia local worker runtime qua marker `local-worker.jsonc` với `readiness: "log-banner"` (không expose HTTP để poll HTTP thành công), chạy qua `pnpm dx local-worker-up`.

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mailer-job:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/transactional-mailer-job:test-integration # tests/integrations — D1 thật qua harness
```

- Suite integration ghim pipeline Mail Command, lifecycle ingest và quarantine trên runtime thật.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/transactional-mailer-job/README.md`](../../docs/applications/transactional-mailer-job/README.md) — component doc; [`01-architecture.md`](../../docs/applications/transactional-mailer-job/01-architecture.md) (boundary, lifecycle, state ownership, retry model), [`02-requirements.md`](../../docs/applications/transactional-mailer-job/02-requirements.md), [`03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md).
- [`docs/domains/transactional-mail/README.md`](../../docs/domains/transactional-mail/README.md) — bounded context; [`domain-model.md`](../../docs/domains/transactional-mail/domain-model.md).
- [`apps/transactional-mail/README.md`](../transactional-mail/README.md) — control plane của cùng context, producer của Queue `ecoma-mail-delivery`.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — transactional outbox, idempotency và topology deploy.
