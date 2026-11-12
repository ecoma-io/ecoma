# Transactional Mailer Job Application

Tầng application của delivery worker `transactional-mailer-job` (`@ecoma-io/transactional-mailer-job-application`): port và use-case cho xử lý một Queue command `mail.send` — parse → claim lease → gọi provider → persist kết quả → báo outcome về control plane — cộng các sweep định kỳ và lifecycle event ingest.

Nx project `@ecoma-io/transactional-mailer-job-application`, tags `type:application`, `scope:messaging`, `runtime:edge`.

## Purpose

- Là nơi **duy nhất** quyết định `ack` hay `retry` cho một message, dựa trên kết quả port trả về — port không tự quyết định, và composition root chỉ map kết quả đó thành `ack()`/`retry()`.
- Giữ invariant "một command, một lần gọi provider": provider chỉ được gọi sau khi đã claim lease và re-validate lease ngay trước lúc gọi.

## Responsibilities

- **`processMailCommand`** (`process-mail-command.ts`): orchestration một command; parse bằng `validateMailSendCommand` từ contracts, resolve authority, claim, gọi `MailProviderPort`, persist, rồi trả `MailCommandOutcome`.
- **Model và rule state** (`mail-job-model.ts`, `mail-job-rules.ts`): union `MAIL_JOB_STATUS_VALUES`, `OUTCOME_REPORT_STATE_VALUES`, `QUARANTINE_REASON_VALUES`; hằng số class lỗi nội bộ (`budget-exhausted`, `delivery-not-found`, `provider-ambiguous` — không bao giờ gửi làm `error_class` trên wire); guard `assert*`, `sanitizeErrorToken`, `sanitizeFieldName`; các hàm classify denial (claim, lease, report, ambiguity) và predicate eligibility cho sweep.
- **Ports**: `MailJobRepository`, `QuarantineRepository` (repository state trên D1 `mail-job`), `MailProviderPort`, `MailDeliveryGateway` (sang private delivery interface của `transactional-mail`).
- **`report-sweeps`**: ba sweep định kỳ — `runReportSweep`, `runStaleLeaseSweep`, `runBlockedBacklogSweep`, kèm union alert.
- **`lifecycle-events`**: `ingestLifecycleEventMessage`, `normalizeLifecycleEventMessage` — chuẩn hoá, dedupe và correlate lifecycle event trung tính của provider.
- **`quarantine-digest`**: `computeQuarantineId` — HMAC digest của raw Queue body thành `quarantine_id`, không lộ payload.
- Consumer hiện tại: `apps/transactional-mailer-job` (composition root) và `libs/transactional-mailer-job-infrastructure` (cài ports).

## Boundaries

- Không render template, không quyết định recipient, không chọn/reroute provider — đó là quyết định đã materialize ở control plane; worker chỉ thực thi.
- Không truy cập D1 `mail` của control plane; dữ liệu control plane chỉ đến qua `MailDeliveryGateway`.
- Không có HTTP route, không binding, không driver SQL trong lib.
- Ngữ nghĩa nghiệp vụ mail delivery thuộc `docs/domains/transactional-mail/domain-model.md`; wire shape thuộc `libs/transactional-mail-contracts`.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mailer-job-application:lint
pnpm nx run @ecoma-io/transactional-mailer-job-application:typecheck
```

Barrel `src/index.ts` export tường minh theo nhóm (port, model/rule, use-case) — không có `export *`.

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mailer-job-application:test    # vitest, environment node
```

Spec colocated cho từng module (`process-mail-command.spec.ts`, `mail-job-rules.spec.ts`, `mail-job-model.spec.ts`, `report-sweeps.spec.ts`, `lifecycle-events.spec.ts`, `quarantine-digest.spec.ts`, `mail-provider-port.spec.ts`) — provider và repository được thay bằng giả lập đúng shape port.

## Related Documentation

- [`docs/applications/transactional-mailer-job/README.md`](../../docs/applications/transactional-mailer-job/README.md) — delivery worker tiêu thụ lib này.
- [`docs/applications/transactional-mailer-job/01-architecture.md`](../../docs/applications/transactional-mailer-job/01-architecture.md) — lease protocol, ma trận transition, blocked/redrive, lifecycle ingest mà use-case hiện thực.
- [`docs/applications/transactional-mailer-job/03-operations.md`](../../docs/applications/transactional-mailer-job/03-operations.md) — bảng xử lý lỗi và bộ phân loại `error_class` canonical.
- [`docs/domains/transactional-mail/domain-model.md`](../../docs/domains/transactional-mail/domain-model.md) — ngữ nghĩa nghiệp vụ canonical.
- [`libs/transactional-mailer-job-infrastructure/README.md`](../transactional-mailer-job-infrastructure/README.md) — adapter cài ports.
