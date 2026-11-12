# Transactional Mail Infrastructure

Adapter persistence D1 của control plane `transactional-mail` (`@ecoma-io/transactional-mail-infrastructure`): cài sáu port của `libs/transactional-mail-application` trên một D1 database `mail`, và chỉ xuất ra đúng thứ composition root cần — một kiểu bề mặt D1 tối giản cộng một factory lắp ráp.

Nx project `@ecoma-io/transactional-mail-infrastructure`, tags `type:infrastructure`, `scope:messaging`, `runtime:edge`.

## Purpose

- Đóng gói toàn bộ câu lệnh SQL của control plane vào một chỗ, sau sáu interface do application layer định nghĩa.
- Giữ ranh giới `type:application` / `type:infrastructure`: lib này **không** re-export port, vì re-export tạo đường dẫn thứ hai tới cùng một type và làm mờ ranh giới.

## Responsibilities

- **`createD1MailPersistence(db)`** (`create-d1-mail-persistence.ts`): entrypoint duy nhất; nhận một `D1SubsetDatabase` và trả `D1MailPersistence` gồm sáu repository — `templates`, `messages`, `outbox`, `nonces`, `rateLimits`, `retention`.
- **`d1-surface.ts`**: bề mặt D1 tối giản (`D1SubsetDatabase`, `D1SubsetPreparedStatement`, `D1SubsetResult`) để adapter không phụ thuộc `@cloudflare/workers-types` và test được bằng giả lập đúng shape.
- **Sáu cài đặt riêng** (`d1-mail-template-repository.ts`, `d1-mail-message-repository.ts`, `d1-mail-outbox-repository.ts`, `d1-internal-nonce-store.ts`, `d1-mail-rate-limit-store.ts`, `d1-mail-retention-queries.ts`) cộng `rows.ts` giữ kiểu row thô nội bộ.
- **Không có state ngoài `db`**: mỗi instance chỉ giữ tham chiếu tới cùng một connection, nên tạo lại instance mỗi request hay mỗi isolate không mất trạng thái — mọi trạng thái bền nằm trong D1.
- Consumer hiện tại: `apps/transactional-mail` (`src/main.ts`, các suite `tests/integrations/`); `libs/transactional-mail-application` chỉ chạm port, không import adapter.

## Boundaries

- Không chứa quyết định nghiệp vụ hay orchestration: claim, retry, retention policy đã ở application layer; adapter chỉ thực thi câu lệnh.
- Không network call, không credential, không binding nào khác ngoài `db`.
- Không sở hữu migration: schema `mail` thuộc app (`apps/transactional-mail/migrations/`).
- Quy tắc tầng `type:infrastructure` → `docs/architecture/05-code-architecture.md` §6.1.

## Development

```bash
pnpm nx run @ecoma-io/transactional-mail-infrastructure:lint
pnpm nx run @ecoma-io/transactional-mail-infrastructure:typecheck
```

Thêm bảng hay cột đồng nghĩa với thêm migration trong `apps/transactional-mail/migrations/` và cập nhật adapter tương ứng.

## Testing

```bash
pnpm nx run @ecoma-io/transactional-mail-infrastructure:test    # vitest, environment node
```

Target `test` chạy vitest với `passWithNoTests: true`; hành vi trên D1 thật được verify ở các suite integration app-owned của `apps/transactional-mail/tests/integrations/` (`mail-d1.spec.ts`, `store-semantics.spec.ts`).

## Related Documentation

- [`libs/transactional-mail-application/README.md`](../transactional-mail-application/README.md) — sáu port mà adapter cài.
- [`docs/applications/transactional-mail/01-architecture.md`](../../docs/applications/transactional-mail/01-architecture.md) — persistence implementation và bất biến "không có node-local application state" (§8).
- [`docs/architecture/04-platform-facts.md`](../../docs/architecture/04-platform-facts.md) — platform facts D1 mà adapter dựa vào.
- [`apps/transactional-mail/`](../../apps/transactional-mail/) — app duy nhất lắp ráp adapter, cùng chỗ chứa migrations.
