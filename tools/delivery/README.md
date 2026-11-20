# Delivery Machinery

Machinery delivery của repository cho lane Continuous Staging (issue #351; hợp đồng [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) §6 mục 7, §6.12, §6.13, §7.4): đảm bảo GitHub Environments `staging-<slug>` tồn tại sẵn với protection đúng trước khi workflow nào tham chiếu, và pipeline `wrangler secret` có kiểm soát cho Worker staging. Đây là **tooling vận hành**, không phải application hay bounded context — nó sở hữu GitHub repo settings thông qua API, không sở hữu dữ liệu ứng dụng nào.

Nx project `@ecoma-io/delivery`, tags `type:tooling`, `runtime:native`, `scope:shared`. Entry CLI `src/cli.ts` chạy qua `npx tsx` (import `@ecoma-io/deployment` dùng specifier `.js` mà node type-stripping thuần không remap được — cùng runner với entry `deploys/*`); logic nằm trong hai module có spec colocated `src/staging-environments.ts` và `src/worker-secrets.ts`.

## Purpose

- Chống auto-create-không-bảo-vệ của GitHub Environments (§6.13): khai `environment:` trong workflow khiến GitHub tự tạo Environment không có protection nào. Script `ensure-staging-environments` tạo Environment cùng `deployment_branch_policy` trong MỘT lời gọi PUT — không có cửa sổ Environment tồn tại mà trống protection — và idempotent để chạy lại an toàn.
- Inventory fail-closed: danh sách unit suy từ `config/deploy-eligibility.jsonc` (nguồn phân loại canonical, chỉ nhận `staging: "releaseable"`); inventory rỗng hoặc slug không suy được an toàn là dừng, không đoán.
- Một control-plane credential duy nhất cho pipeline secret (§6.12): org secret `ECOMA_CLOUDFLARE_API_TOKEN` map vào `CLOUDFLARE_API_TOKEN` chỉ trong env của subprocess wrangler; không per-env token, không alias; giá trị secret chỉ qua stdin, không bao giờ qua argv.

## Responsibilities

- `ensure-staging-environments [--check] [--repo owner/name]` — ensure + verify mỗi Environment `staging-<slug>`: tạo cùng policy custom khi thiếu; thiếu pattern `main` thì thêm; sau mutation đọc lại từ API để violations phản ánh state cuối. Gate thủ công (`required_reviewers`, `wait_timer`) trên staging là violation được BÁO, không tự xoá (xoá cấu hình repo là mutation ngoài phạm vi setup). `--check` chỉ đọc — đường guard CI chống auto-create. Exit 0 khi mọi Environment đạt, exit 1 khi còn violation.
- `worker-secret put|stage <SECRET_NAME> --config <wrangler.jsonc>` (giá trị qua stdin) — `put` provision lần đầu, deploy ngay một version mới (WS1); `stage` xoay vòng qua `wrangler versions secret put`, KHÔNG deploy — publish đi qua delivery gate, đường này không bao giờ bypass gate. Worker bắt buộc là identity `stg-` đọc từ `env.staging.name` của wrangler.jsonc; tên khác `stg-` (ví dụ production) là TỪ CHỐI trước khi wrangler chạy.
- Thứ tự kiểm của `worker-secret` fail-closed: action hợp lệ → tên secret hợp lệ → giá trị không rỗng → inventory token → worker identity staging → wrangler chạy. Bất kỳ bước nào fail là dừng TRƯỚC khi subprocess chạy.

## Boundaries

- Không sở hữu phân loại eligibility: `config/deploy-eligibility.jsonc` là input đọc-only (unit provisioning khác sở hữu entry); script chỉ suy inventory từ nó.
- Không bootstrap hạ tầng Cloudflare: Worker staging `stg-<...>` được tạo bởi chuỗi deploy staging (#353+, bootstrap Pulumi §7.4.1); `worker-secret` chỉ ghi secret lên Worker đã tồn tại.
- Không chứa credential: Environments không mang secret; token là org secret GitHub, giá trị thật theo checklist [`docs/architecture/staging-prerequisites.md`](../../docs/architecture/staging-prerequisites.md).
- Không đặt required reviewers/wait_timer cho staging: lane staging là continuous (§7.4); manual gate là production-only — script báo violation, không tự sửa cấu hình GitHub ngoài shape policy đã nêu.

## Development

Chạy CLI trực tiếp bằng `npx tsx`:

```bash
# Ensure/verify Environments cho toàn bộ inventory staging-releaseable
npx tsx tools/delivery/src/cli.ts ensure-staging-environments --repo ecoma-io/ecoma
# Guard chỉ đọc (không mutation)
npx tsx tools/delivery/src/cli.ts ensure-staging-environments --repo ecoma-io/ecoma --check

# Provision secret Worker staging (giá trị qua stdin, KHÔNG qua argv, KHÔNG ghi giá trị vào log stdout/stderr)
echo "<value>" | npx tsx tools/delivery/src/cli.ts worker-secret put AXIOM_INGEST_TOKEN --config apps/home/wrangler.jsonc
# Xoay vòng — chỉ stage version, publish vẫn qua delivery gate
echo "<rotated>" | npx tsx tools/delivery/src/cli.ts worker-secret stage AXIOM_INGEST_TOKEN --config apps/home/wrangler.jsonc
```

KHÔNG BAO GIỜ ghi giá trị secret ra stdout/stderr hay log CI/CD — CLI chỉ in tên secret và tên Worker, không in giá trị. Nếu một wrapper phía ngoài log lại input, purge log ngay.

Token đọc từ `ECOMA_CLOUDFLARE_API_TOKEN` trong env gọi CLI (org secret GitHub khi chạy trong CI); thiếu token là dừng với đúng tên biến, không fallback credential nào khác.

## Testing

```bash
pnpm nx run @ecoma-io/delivery:lint
pnpm nx run @ecoma-io/delivery:typecheck
pnpm nx run @ecoma-io/delivery:test       # vitest — spec colocated trong src/
```

- Toàn bộ unit test chạy trên fake `gh api` và fake wrangler (`deps` inject): không test nào gọi GitHub hay Cloudflare thật, nên một lần test xanh không chứng minh quyền của token.
- Bằng chứng vận hành thật là lần chạy `ensure-staging-environments` trên repo (idempotent, exit 0) và kiểm độc lập bằng `gh api` — xem PR #518.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md` §3–§4.

## Related Documentation

- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) — hợp đồng pipeline: §6 mục 7 (controlled secret pipeline), §6.12 (một control-plane token), §6.13 (Environment protection + anti auto-create), §7.4 (lane continuous staging), §7.4.1 (inventory staging).
- [`docs/architecture/staging-prerequisites.md`](../../docs/architecture/staging-prerequisites.md) — checklist bootstrap một lần cho operator (domain, Cloudflare token, org secret, Axiom `stg`, Environments, provision secret).
- [`tools/delivery/config/deploy-eligibility.jsonc`](./config/deploy-eligibility.jsonc) — nguồn inventory (đọc-only).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) §6.1 — ý nghĩa tag `type:tooling`.
