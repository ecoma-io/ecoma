# staging-bootstrap

Runner bootstrap/seed staging — **skeleton pre-warm cho Issue #352**, chưa
thực thi được và cố ý fail-closed.

## Purpose

Thực thi đúng bảng bước bootstrap/seed canonical của
`docs/architecture/02-delivery.md` §3.2 (dòng 3, 4, 5a, 5b, 6, 7, 8a, 8b, 9, 10), theo hợp đồng
ADR-0020 (`docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md`).

## Responsibilities

- Một bước = một service ghi đúng một database; runner **không import** code
  service nào — chỉ gọi CLI bootstrap của chính service sở hữu dữ liệu như
  subprocess (`apps/*/db/bootstrap*.mts`).
- Idempotency bằng natural key của từng script sở hữu — runner **không giữ
  file trạng thái, không bảng marker**; phục hồi duy nhất là chạy lại toàn
  bộ hợp đồng từ đầu (tiền tố đã hội tụ là hợp lệ, §3a.5 mục F).
- Giá trị xuyên bước duy nhất: `sub` (bước `account` → mọi bước sau) và
  `tenant_id` (bước `llm-consumer-tenant` → `llm-financial`, ADR-0028 §6).
  Truyền qua env của subprocess (`BOOTSTRAP_SUB`, `BOOTSTRAP_TENANT_ID`),
  không qua argv.
- Danh tính canonical là hằng trong code (`ecoma`, `superadmin@ecoma.io`,
  Seller tenant `dronie` theo ADR-0027 §2); env override không khớp bị từ
  chối fail-closed (ADR-0021 Q1).
- Dòng 1 (provision — #349/#368) và dòng 2 (migrate — `deploys/*-db`,
  #374–#378) **không** thuộc runner; runner chỉ chạy sau khi cả hai có
  evidence hoàn tất. Ba lifecycle schema / backfill / bootstrap không trộn
  (§3a.5 mục F).
- Mỗi lần chạy sinh evidence JSON per-run không chứa secret in ra stdout
  cho workflow caller lưu lại theo mẫu §7.4.1.

## Boundaries

- Thực thi bootstrap thật trên staging — chỉ khi cả blocker dưới đây được
  hoá giải bằng evidence thật (không mục nào được "coi như xong" ngầm):
  - `TODO(349/blocking)` — databases + roles staging chưa provision (#349).
  - `TODO(351/blocking)` — credentials + seed inputs chưa inventory (#351).
  - `TODO(349/blocking)` — schema migrations các DB đích chưa hoàn tất
    (#349/#374–#378).
  - `TODO(352/blocking)` — CLI `apps/auth/db/bootstrap-oauth-clients.mts`
    chưa tồn tại; executing PR của #352 phải đặt nó vào app sở hữu, runner
    không tự thay service viết script.
- Sửa `deploy-eligibility.jsonc` — runner không phải deploy unit
  (ADR-0020 Q12: đặt `tools/`, không có DEPLOYMENT_MAP entry).
- Cơ chế `--from <step-id>` để retry từ bước giữa — bỏ chủ ý: giá trị xuyên
  bước chỉ sinh ra khi bước trước chạy, nhảy bước sẽ âm thầm mất `sub`/
  `tenant_id`; phục hồi hợp lệ duy nhất theo ADR-0020 là chạy lại từ đầu.
- Wire-up workflow CI/audit sink thật — cần deciding của executing PR.

## Development

Chạy CLI (từ repo root):

```bash
# Yêu cầu Node ≥ 22.6 (type-stripping để chạy trực tiếp file .ts)
node tools/staging-bootstrap/src/cli.ts staging
```

Hiện tại lệnh luôn exit 2 với danh sách blocker — đúng thiết kế. Evidence
chạy (JSON per-run, không chứa secret) in ra stdout.

## Testing

```bash
pnpm nx run @ecoma-io/staging-bootstrap:test
```

Specs `src/*.spec.ts` (vitest) phủ: `parseArgs` fail-closed, assert danh
tính canonical, danh sách blocker chưa hoá giải, thứ tự bước của runner và
cơ chế skip khi một bước fail, `absorbStepValues` rút giá trị xuyên bước.

## Related Documentation

- `docs/architecture/02-delivery.md` §3.2 — bảng bước bootstrap/seed
  canonical và thứ tự bắt buộc.
- `docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md` — hợp
  đồng runner (Quyết định 6, Quyết định 12).
- Issue #352 (staging bootstrap orchestration), #349 (provisioning), #351
  (credentials inventory).
