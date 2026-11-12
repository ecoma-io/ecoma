# Transactional Mailer Job Infrastructure

Adapter của delivery worker `transactional-mailer-job` (`@ecoma-io/transactional-mailer-job-infrastructure`): ba provider mail, repository/quarantine/lifecycle store trên D1 `mail-job`, và client HTTP ký HMAC gọi private delivery interface của `transactional-mail` qua Service Binding. Composition root của app là nơi duy nhất nối các adapter này vào port của tầng application.

Nx project `@ecoma-io/transactional-mailer-job-infrastructure`, tags `type:infrastructure`, `scope:messaging`, `runtime:edge`.

## Purpose

- Giữ mọi chi tiết vendor và chi tiết giao thức ngoài tầng application: port `MailProviderPort` không biết Cloudflare hay Resend tồn tại, và tầng use-case không biết chữ ký nội bộ được dựng ra sao.
- Cài repository state của worker trên D1 riêng `mail-job` — worker không truy cập D1 `mail` của control plane.

## Responsibilities

- **Provider adapters**, đều cài `MailProviderPort`:
  - `cloudflare-mail-provider.ts` — Cloudflare Email Sending qua binding khai trong `wrangler.jsonc` bằng block `send_email` với tên runtime `SEND_EMAIL` (composition root đọc `env.SEND_EMAIL`): `send()` của binding **throw** thay vì trả status nên mọi outcome được bắt và phân loại thành kết quả resolve; `error.code` là dữ liệu untrusted, chỉ tập mã đã liệt kê được map, mã lạ rơi về `retryable` fail-closed; binding không có idempotency API nên mọi lần gọi được coi là có thể trùng.
  - `resend-mail-provider.ts` — HTTP relay với endpoint + credential là Worker Secret của chính worker.
  - `fake-mail-provider.ts` — chỉ cho test/dev, không phải lựa chọn production.
  - Composition root chọn theo `provider.kind` của config (`cloudflare` / `resend` / `fake`).
- **D1 repositories** (`d1-mail-job-repository.ts`, `d1-quarantine-repository.ts`, `d1-lifecycle-event-store.ts`): cài `MailJobRepository` (claim/renew/persist/report/sweep theo lease protocol), `QuarantineRepository` và store cho `mail_lifecycle_events` (migration 0004) với dedupe ở PRIMARY KEY; `mail-job-row.ts` giữ decode cột và bộ hằng cột.
- **`internal-delivery-client.ts` + `internal-delivery-gateway.ts`**: client gọi `GET /internal/deliveries/:delivery_id` và `POST .../outcome` qua Service Binding; ký bằng `signRequest` của `@ecoma-io/internal-auth-contracts` (không tự dựng canonical string); serialize body đúng một lần; validate response bằng validator canonical của `@ecoma-io/transactional-mail-contracts`. Client không retry, không phân loại lỗi mạng, không log secret hay thân request. `createGateway` bọc client thành port `MailDeliveryGateway`.
- **`d1-database-like.ts`**: bề mặt D1 tối giản cho test và để adapter không phụ thuộc `@cloudflare/workers-types`.
- Consumer hiện tại: `apps/transactional-mailer-job` (`src/main.ts` và suite `tests/integrations/`).

## Boundaries

- Không có lệnh log nào trong provider adapter: sender, recipient, subject, body và exception message không bao giờ chạm log hay metric; chỉ token lỗi đã sanitize đi ra ngoài.
- Không retry nội bại: một lần gọi port là một attempt của một execution đã claim; backoff là việc của Queue.
- Không giữ kho nonce: nonce store thuộc phía nhận (`transactional-mail`, D1 `mail`).
- Không sở hữu schema `mail-job` — migration thuộc app.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mailer-job-infrastructure:lint
pnpm nx run @ecoma-io/transactional-mailer-job-infrastructure:typecheck
```

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mailer-job-infrastructure:test    # vitest, environment node
```

Spec colocated cho từng adapter (`cloudflare-mail-provider.spec.ts`, `resend-mail-provider.spec.ts`, `fake-mail-provider.spec.ts`, `internal-delivery-client.spec.ts`, `mail-job-row.spec.ts`) — HTTP và D1 được thay bằng giả lập đúng shape; hành vi trên D1 thật thuộc suite `apps/transactional-mailer-job/tests/integrations/`.

## Related Documentation

- [`docs/applications/transactional-mailer-job/01-architecture.md`](../../docs/applications/transactional-mailer-job/01-architecture.md) — provider seam (§11.1), mô hình idempotency và lease protocol mà adapter phục vụ.
- [`docs/applications/transactional-mailer-job/03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — provider configuration và runbook.
- [`docs/applications/transactional-mail/01-architecture.md`](../../docs/applications/transactional-mail/01-architecture.md) §7 — private delivery interface mà client gọi.
- [`libs/transactional-mailer-job-application/README.md`](../transactional-mailer-job-application/README.md) — ports mà adapter cài.
- [`apps/transactional-mailer-job/`](../../apps/transactional-mailer-job/) — app lắp ráp adapter và chọn provider.
