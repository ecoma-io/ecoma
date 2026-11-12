# Transactional Mail Application

Tầng application của control plane `transactional-mail` (`@ecoma-io/transactional-mail-application`): ports persistence + use-case orchestration thuần thuật toán cho nhận message intent, render template, publish outbox và retention. Không type nào ở đây rò rỉ binding Cloudflare (`D1Database`, `Env`), type Hono hay driver SQL — ranh giới mà `pnpm dx arch-check` và spec trong lib cùng giữ.

Nx project `@ecoma-io/transactional-mail-application`, tags `type:application`, `scope:messaging`, `runtime:edge`.

## Purpose

- Giữ orchestration của control plane kiểm được không cần D1 thật: mọi use-case nhận ports qua tham số và mọi ngưỡng vận hành là config truyền vào.
- Tách hai lớp rõ ràng: ports (interface + record thuần) mà infrastructure cài, và use-case chỉ gọi qua ports.

## Responsibilities

Ports công khai (`records.ts` và các file port): `MailTemplateRepository`, `MailMessageRepository`, `MailOutboxRepository`, `InternalNonceStore`, `MailRateLimitStore`, `MailRetentionQueries`.

Use-case orchestration, nhóm theo yêu cầu kỹ thuật của application:

- **FR-002 — idempotency theo fingerprint**: `jcsCanonicalize` chuẩn hoá JSON theo RFC 8785; `normalize-request` chuẩn hoá recipient/locale và kiểm shape `variables`; `request-fingerprint` tính HMAC-SHA-256 có khoá (profile `p1`, key tag `k1`) và verify fingerprint đã lưu.
- **FR-003 — template và render**: `parseTemplateSchema` đọc subset JSON schema của một template version; `validateVariablesAgainstSchema` kiểm variables theo schema; `validateTemplateUrl` áp URL allowlist; `renderMail` render `{{ var }}` một lượt với HTML escape (`escapeHtmlText`, `escapeHtmlAttribute`).
- **FR-001 — tạo message**: `createMailMessage` — normalize → lookup idempotency (replay trả trước khi chạm schema và dưới rate limit) → rate limit (principal trước system) → render → ghi.
- **FR-005 — outbox**: `publishOutboxBatch` (claim → `QUEUE.send` ngoài transaction D1 → `markPublished`, kèm `sanitizePublishErrorToken` và `backoffDelayMs`); `runOutboxReconciler` quét dispatch-incomplete và re-dispatch qua callback; `runNoncePrune` dọn nonce hết hạn theo lô.
- **FR-007 — retention**: `runRetentionCycle` redact nội dung message quá hạn và phát alert cho delivery dở dang qua `MailRetentionQueries`.
- **SR-001 — authorization template**: `isTemplateAuthorized` — verdict default-deny theo allowlist của principal.
- Consumer hiện tại: `apps/transactional-mail` (composition root) và `libs/transactional-mail-infrastructure` (cài ports).

## Boundaries

- Không chứa HTTP route, không binding, không SQL — adapter D1 nằm ở `libs/transactional-mail-infrastructure`, chỉ composition root của app được ghép hai bên.
- Không định nghĩa shape trên wire: contract của context nằm ở `libs/transactional-mail-contracts`; lib này tiêu thụ contract, không khai lại.
- Ngữ nghĩa nghiệp vụ của mail (template, message, vòng đời delivery) thuộc bounded context `transactional-mail` — lib chỉ hiện thực orchestration, không định nghĩa lại rule.
- Quy tắc chuỗi phụ thuộc `domain ↑ application ↑ infrastructure` → `docs/architecture/05-code-architecture.md` §3.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mail-application:lint
pnpm nx run @ecoma-io/transactional-mail-application:typecheck
```

Thêm use-case đồng nghĩa với thêm file và spec colocated cạnh nó, rồi export tường minh qua `src/index.ts` — barrel này không có `export *`.

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mail-application:test    # vitest, environment node
```

Spec colocated phủ từng use-case và port (`create-mail-message.spec.ts`, `outbox-publisher.spec.ts`, `mail-render.spec.ts`, `persistence-ports.spec.ts`, …); dependency D1/Queue được thay bằng giả lập đúng shape port.

## Related Documentation

- [`docs/applications/transactional-mail/README.md`](../../docs/applications/transactional-mail/README.md) — control plane tiêu thụ lib này.
- [`docs/applications/transactional-mail/01-architecture.md`](../../docs/applications/transactional-mail/01-architecture.md) — composition, flow, outbox và private interface mà use-case hiện thực.
- [`docs/applications/transactional-mail/02-requirements.md`](../../docs/applications/transactional-mail/02-requirements.md) — nguồn của các nhãn FR-001–FR-007, SR-001 dùng trong lib.
- [`docs/domains/transactional-mail/domain-model.md`](../../docs/domains/transactional-mail/domain-model.md) — ngữ nghĩa nghiệp vụ canonical của context.
- [`libs/transactional-mail-infrastructure/README.md`](../transactional-mail-infrastructure/README.md) — adapter D1 cài ports.
- [`libs/transactional-mail-contracts/README.md`](../transactional-mail-contracts/README.md) — contract surface của cùng context.
