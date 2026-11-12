# Transactional Mail Contracts

Contract surface của bounded context `transactional-mail` (`@ecoma-io/transactional-mail-contracts`): kiểu và validator cho ba đường — public API `POST /v1/messages`, Queue command `mail.send`, và private delivery interface giữa delivery worker và control plane. Lib chỉ mô tả **shape trên wire**; quy tắc nghiệp vụ vận hành không nằm ở đây trừ phần tài liệu đã chốt tường minh.

Nx project `@ecoma-io/transactional-mail-contracts`, tags `type:contracts`, `scope:messaging`, `runtime:universal`.

## Purpose

- Cho consumer phụ thuộc contract thay vì implementation của provider, theo đúng vai trò provider-owned của `type:contracts` (`docs/architecture/05-code-architecture.md` §4).
- Đóng băng bộ giá trị trên wire mà cả hai phía dùng: một union được khai lại ở contracts theo quy tắc `type:contracts` không phụ thuộc `type:domain`, kể cả gián tiếp — contract là thứ provider publish, không phải một tầng để đi theo chiều phụ thuộc.

## Responsibilities

- **`shared.ts`** — bộ union dùng chung cho mọi đường: `MAIL_MESSAGE_STATUS_VALUES` (`accepted`, `queued`, `sent`, `failed`, `blocked`), `MAIL_OUTCOME_VALUES` (`sent`, `failed`, `blocked`), `MAIL_ERROR_CLASS_VALUES` (năm loại: `retryable`, `permanent`, `credential`, `contract`, `internal-auth`), `OUTCOME_RESULT_VALUES` (`applied`, `duplicate`, `stale`), hằng `MAIL_CONTENT_TYPE = 'text/html'`, và hai guard tối thiểu `isNonEmptyString`, `isPositiveSafeInteger`.
- **`public-messages.ts`** — contract `POST /v1/messages`: field bắt buộc `template`, `recipient`; `app` trong body bị bỏ qua hoàn toàn (nguồn duy nhất của `app`/`principal_id` là authenticated principal); response 201/200 có closed schema tám field; bộ error code và error body của provider; `template` trên wire là logical string mở, không phải union đóng.
- **`mail-command.ts`** — Queue command `mail.send` với đúng hai field `version` (= `MAIL_COMMAND_VERSION`, hiện `1`) và `delivery_id`; mọi field khác là `forbidden-field`. Command là wake-up signal, không phải authorization token; `dispatch_generation` bị cấm trong body.
- **`delivery-interface.ts`** — private delivery interface: `GET /internal/deliveries/:delivery_id` trả envelope `{message, dispatch_generation}`; `POST .../outcome` nhận `{outcome, error_class?, dispatch_generation}` và trả `{result: 'applied'|'duplicate'|'stale', status}` kèm `current_dispatch_generation` khi stale. Mỗi message/response có validator và tập field được phép/bắt buộc riêng.
- Consumer hiện tại: `apps/transactional-mail` và `libs/transactional-mail-application` (provider), `apps/transactional-mailer-job` cùng hai lib của nó (consumer delivery), và `apps/account` (`server/lib/mail.ts` — client gọi `POST /v1/messages`, kèm validator trước khi gửi).

## Boundaries

- Không chứa business logic hay domain implementation: validator chỉ kiểm kiểu và field được phép, không áp đặt toàn bộ quy tắc nghiệp vụ vận hành.
- Guard định danh chỉ kiểm non-empty string sau trim: mẫu `delivery_id` (`dlv_`) là khai báo schema ở `docs/applications/transactional-mail/01-architecture.md` §4.2, còn ID strategy vẫn là mục chưa chốt ở `docs/architecture/01-architecture.md` §10 — vì vậy guard không hard-code tiền tố và không kiểm nó.
- Không phải shared domain model: nhiều consumer cùng phụ thuộc là bình thường, nhưng contract vẫn thuộc provider và không trở thành model dùng chung giữa các bounded context.
- Nội dung và tooling của contract delivery → `docs/architecture/02-delivery.md` §3.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mail-contracts:lint
pnpm nx run @ecoma-io/transactional-mail-contracts:typecheck
```

Mỗi module wire đi kèm spec colocated; đổi shape trên wire là đổi contract của provider và phải đi cùng cập nhật tài liệu `docs/applications/transactional-mail/`.

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mail-contracts:test    # vitest, environment node
```

Spec colocated (`shared.spec.ts`, `mail-command.spec.ts`, `public-messages.spec.ts`, `delivery-interface.spec.ts`) ghim hành vi validator và closed set của từng union.

## Related Documentation

- [`docs/applications/transactional-mail/01-architecture.md`](../../docs/applications/transactional-mail/01-architecture.md) — nguồn canonical của wire shape (§5 command, §6.2.2 outcome, §7.2 delivery interface).
- [`docs/applications/transactional-mail/02-requirements.md`](../../docs/applications/transactional-mail/02-requirements.md) — FR-001–FR-005 và SR-001 mà contract phản ánh.
- [`docs/applications/transactional-mailer-job/02-requirements.md`](../../docs/applications/transactional-mailer-job/02-requirements.md) và [`03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — phía consumer delivery của contract.
- [`docs/domains/transactional-mail/domain-model.md`](../../docs/domains/transactional-mail/domain-model.md) — ngữ nghĩa nghiệp vụ đằng sau các union.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) §4 — vai trò provider-owned của contract project.
