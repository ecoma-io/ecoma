# Staging prerequisites — checklist bootstrap một lần

Các bước vận hành **thủ công, ngoài Git** cần hoàn tất trước khi lane Continuous Staging chạy thật (issue #351). Trạng thái hoàn tất không ghi vào file này — checklist được thực thi trong môi trường operator; file này là runbook tham chiếu. Hợp đồng từng bước nằm ở `02-delivery.md` (§6.12, §6.13, §7.4, §7.4.1); tài liệu này không nhân bản hợp đồng.

## 1. Domain `ecoma.io.vn`

- Đăng ký/nắm giữ `ecoma.io.vn` tại registrar (nếu chưa) — DNS zone staging thuộc inventory `platform-deploy` (§7.4.1).
- Verify: nameserver của zone trỏ đúng nhà DNS điều phối; `dig NS ecoma.io.vn` trả về nameserver đó.

## 2. Cloudflare API token `ECOMA_CLOUDFLARE_API_TOKEN`

- Tạo **đúng một** token Cloudflare API cho toàn bộ pipeline — dùng chung cả hai lane, **cấm** token theo environment/alias (`ECOMA_STAGING_*`, `ECOMA_PRODUCTION_*` đều bị cấm, §6.12).
- Quyền thật của token phải **kiểm tra tay trên Cloudflare** — suy quyền từ tên secret là không đủ (§6.12). Verify trên dashboard: token đủ quyền cho mọi Worker mà pipeline chạm; token này không phải ranh giới staging/production — ranh giới là Worker identity + `--env` tường minh + GitHub Environment riêng.
- Token không bao giờ vào Git, PR build, hay log.

## 3. Org secret GitHub

- Settings → Secrets and variables → Actions → New organization secret: tên `ECOMA_CLOUDFLARE_API_TOKEN`, visibility **All repositories** (§6.12).
- **Không** gắn secret này vào Environment nào — credential không scoped theo environment; cái thuộc Environment là approval và audit log (§6.12).

## 4. Axiom dataset `stg` + ingest tokens

- Tạo dataset `stg` trên Axiom và ingest token dành riêng cho lane staging — không dùng token production. Model observability và nguyên tắc "telemetry không bao giờ là serving-path dependency" → `03-operations.md` §4.
- Lưu ý trích dẫn: issue #351 dẫn đường `local-development/03-operations.md` §4 — vị trí hiện tại của nội dung Axiom là `docs/architecture/03-operations.md` §4.

## 5. GitHub Environments `staging-<slug>`

- **Không tạo tay trên UI.** Environment phải tồn tại sẵn với protection đặt đúng TRƯỚC khi workflow nào tham chiếu — khai `environment:` khiến GitHub tự tạo Environment trống protection (§6.13). Đường tạo lặp lại là script idempotent trong repo:

  ```bash
  npx tsx tools/delivery/src/cli.ts ensure-staging-environments          # tạo/sửa + verify
  npx tsx tools/delivery/src/cli.ts ensure-staging-environments --check  # chỉ đọc, không mutation
  ```

- Script tạo mỗi Environment với deployment branch policy custom **chỉ chứa `main`**, và **không** đặt required reviewers/wait timer — lane staging là continuous, chạy từ `main` sau CI (§7.4); gate thủ công trên staging là cấu hình sai và được script báo violation.
- Yêu cầu chạy: `gh` đã xác thực với quyền repo admin (tạo Environment + deployment branch policy), hoặc `GH_TOKEN` tương ứng khi chạy trong CI.
- Inventory unit suy từ `tools/delivery/config/deploy-eligibility.jsonc` (entry `staging: "releaseable"` — cùng tập `nx.json → release.projects`). Thêm unit mới vào làn staging là chạy lại script.
- Chạy lại an toàn (idempotent): mutation và verify nằm trong cùng một lần chạy, kết thúc khác 0 nếu vẫn còn thiếu protection.

## 6. Provision secret cho một Worker staging

```bash
# Provision lần đầu — deploy ngay một version mới (WS1)
echo "$VALUE" | npx tsx tools/delivery/src/cli.ts worker-secret put SECRET_NAME --config apps/home/wrangler.jsonc

# Xoay vòng — chỉ stage version mới; publish vẫn qua delivery gate
echo "$VALUE" | npx tsx tools/delivery/src/cli.ts worker-secret stage SECRET_NAME --config apps/home/wrangler.jsonc
```

- Control-plane credential: `ECOMA_CLOUDFLARE_API_TOKEN` phải có trong môi trường chạy (org secret mục 3; operator export khi chạy tay) — script fail-closed khi thiếu và không nhận credential nào khác (§6.12).
- Script chỉ nhận Worker identity `stg-<...>` đọc từ `env.staging.name` của config; secret **không kế thừa** giữa named environments (WS3), nên mỗi environment đặt riêng.
- Giá trị chỉ đi qua stdin — không qua argv, không log. `SECRET_NAME` là ASCII identifier.
- Runbook xoay vòng và hậu quả sự cố → `03-operations.md` (runbook vận hành, issue #364). Credential migration job (`_migrator` per-DB) **không** đi qua đường này — ranh giới ba identity → issue #373 mục A/E.

## Liên quan và phần gate sau

- Bằng chứng end-to-end ("một Worker staging có secret provision qua pipeline và runtime đọc được") gate vào chuỗi deploy staging (#353 trở đi) — machinery này là điều kiện cần, không phải bằng chứng.
- Bootstrap state backend Pulumi staging (`ECOMA_PULUMI_STATE_URL_STAGING`, R2 token bucket-scoped, passphrase per-stack) — hợp đồng §7.4.1, ngoài checklist này.
- Ruleset required checks cho AUTO4: chỉ thêm khi workflow AUTO4 đã tồn tại — bước cuối của issue #351, phối hợp riêng với AUTO4.
