# Ecoma DX

Devtools CLI của repository, chạy qua `pnpm dx <command>` (script `dx` trong root `package.json` gọi `npx tsx tools/dx`; script `prepare` gọi `pnpm dx repo-prepare` nên `pnpm install` tự chuẩn bị repository). Đây là **tooling của repository**, không phải application hay bounded context: nó chỉ chạy ở máy developer và trong GitHub Actions, không thuộc topology deploy nào.

Nx project `@ecoma-io/dx`, tags `type:tooling`, `runtime:native`, `scope:local`. Entrypoint `index.ts`, registry lệnh ở `src/index.ts` lazy-load từng command qua `import()` (không auto-discovery). Mỗi command suy `ROOT_DIR` từ vị trí file của chính nó (`src/utils.ts`), nên kết quả không phụ thuộc working directory của caller.

## Purpose

- Giữ policy bắt máy của repository ở một nơi, viết bằng TypeScript: PR policy, tag kiến trúc, chữ ký commit. Hook (`lefthook.yml`) và workflow GitHub Actions chỉ khai báo lệnh — luật nằm ở đây và được test ở đây, nên local và CI chạy đúng một chương trình. Ngoại lệ có chủ đích (issue #217): ba lệnh scanner bảo mật (gitleaks, semgrep) chạy `docker run` trực tiếp trong hook/workflow với image ghim digest ngay tại chỗ; hợp đồng pin, chống drift và độ phủ rule của chúng được ghim bằng spec ở `src/security/`.
- Sinh output committed từ source of truth `.agents/` cho hai coding agent (`.claude/` và `.opencode/`); cấu hình agent không được viết tay ở nơi khác (root `AGENTS.md` §Skills).
- Là điểm điều khiển duy nhất của runtime local — platform stack (`local-status`, `local-cleanup`), worker runtime (`local-worker-*`) và procedure bootstrap first-administrator (`bootstrap-superadmin`).

## Responsibilities

Registry khai 12 subcommand. Từng nhóm dưới đây mô tả input, output và side effect thật của source:

- **`repo-prepare`** — cài git hook (`pnpm exec lefthook install`; bước này exit 1 khi lệnh thất bại), dò tool nền tảng qua `ToolSpec` (`src/repository/tool-specs.ts`): Docker bằng `docker version` (phải có daemon, không chỉ binary), Helm và kustomize bằng `version`, kubeconform bằng `-v` kèm yêu cầu output có số phiên bản. Tool thiếu được liệt kê kèm link cài đặt của vendor và lệnh vẫn exit 0 — command không cài gì cả. Kết thúc bằng `sync-agent-config`.
- **`sync-agent-config`** — sinh `.claude/skills/`, `.claude/agents/`, `.opencode/skills/`, `.opencode/agents/` từ `.agents/skills/` và `.agents/agents/`. Skills mirror toàn bộ file (không chỉ `SKILL.md`), copy file mới/đã đổi, xoá đích không còn đối ứng; source vắng mặt thì giữ nguyên đích, source có nhưng rỗng thì làm trống đích; duyệt tôn trọng `.gitignore` và không đi theo symlink ra ngoài source tree. Agents: file `.claude/agents/<name>.md` giữ nguyên frontmatter Claude, file `.opencode/agents/<name>.md` tính thêm `mode` (`primary`/`subagent`/`all`; vắng key thì mặc định `subagent`) và `permissions` suy từ `tools`, với catch-all `deny` đặt trước các `allow`. `name` lệch tên file, key lạ hoặc tool không nằm trong bảng ánh xạ là lỗi — command dừng thay vì sinh agent sai quyền.
- **`pr-check`** — chạy trong GitHub Actions (`.github/workflows/ci.yaml`): đọc title và `pull_request.base.sha`/`head.sha` từ payload ở `GITHUB_EVENT_PATH`, chấm title bằng commitlint CLI của repository với đúng `commitlint.config.mjs` (syntax Conventional Commits + `scope-enum`), kiểm title có tối đa một scope Nx (scope vắng là hợp lệ; `feat(a,b)` bị chặn — số scope là phần commitlint không chấm), rồi parse từng commit trong `base..head` bằng cùng cặp `@commitlint/load` + `@commitlint/parse` — không giới hạn số lượng hay type development commit. Offline: không gọi GitHub API, không dùng trường `pull_request.commits`. Thiếu event, thiếu SHA hoặc git không đọc được range thì exit 1 thay vì báo xanh.
- **`arch-check`** — đọc toàn workspace qua `nx show projects --json` và `nx graph --print` rồi chạy các lượt kiểm trong `src/architecture/`: tag schema (đúng một `scope:*`/`type:*`/`runtime:*`, value thuộc allowlist, value legacy và mọi prefix `layer:*` là lỗi), runtime compatibility transitive trên graph, bất biến đồ thị deployment, contract edge ownership (`CONTRACT_EDGE_OWNERSHIP`), ranh giới LLM (ADR-0018/ADR-0019), deployment map đối chiếu đĩa cùng marker `ecoma.deployment.status`, và layout test-target của `docs/architecture/06-testing.md`. Mỗi vi phạm in `[kind] project: detail`; có vi phạm là exit 1. Quy tắc của từng lượt là nội dung của `docs/architecture/05-code-architecture.md` §6–§8 — lệnh chỉ thực thi, không định nghĩa lại.
- **`commit-signing`** — ba gate chọn bằng `--check` (mặc định `push`): `config` đọc cấu hình ký (`commit.gpgsign`, `gpg.format`, `user.signingkey` khi SSH), `head` kiểm commit vừa tạo (post-commit, chỉ báo vì commit đã tồn tại), `push` kiểm chữ ký thật của các commit chưa lên remote (pre-push, gate chặn). Thiếu cấu hình hoặc có commit unsigned là exit 1 kèm danh sách vấn đề. pre-commit chạy bản shell mỏng `check-signing-config.sh` thay vì command này để tránh chi phí khởi động `npx tsx` trên đường nóng mỗi commit.
- **Scanner bảo mật (gitleaks, semgrep)** — từ issue #217 không còn là lệnh DX: các lời gọi `docker run` nằm trực tiếp trong `lefthook.yml` (pre-commit `semgrep --test`, pre-push gitleaks dir-mode + semgrep scan kèm điều kiện skip theo file đổi) và trong job `semgrep`/`gitleaks` của `.github/workflows/code-analysis.yml` (kèm logic suy phạm vi quét gitleaks). Logic của hook pre-push vẫn được ghim trong YAML kèm comment giải thích từng ràng buộc đo được.
- **`bootstrap-superadmin`** — orchestration procedure first-administrator (ADR-0020 Quyết định 12): command không giữ credential, không mở kết nối, không ghi database; nó chạy preflight rồi CLI offline của `account` và `staff-access` như tiến trình con. Chuỗi kết nối đi qua env `ECOMA_ACCOUNT_DATABASE_URL` / `ECOMA_STAFF_ACCESS_DATABASE_URL` — không flag nào nhận connection string, vì argv nằm trong `ps` và shell history. `--operator-ref` bắt buộc có giá trị; `--correlation-id` dùng chung cho mọi stage và audit row; `--json` in một envelope JSON làm dòng cuối stdout. Nội dung từng stage thuộc `docs/applications/staff-access/03-operations.md`.
- **`local-status`** — read-only: adapter mỏng spawn `platform-status.ts` của `deploys/platform-deploy` qua tsx rồi nhận exit code — không import code deploy nào, vì chiều phụ thuộc hợp lệ chỉ đi từ deploy sang lib dùng chung. In namespace, resource names và outputs hiện có của platform. `--worktree-root` chỉ đổi state/namespace của worktree đích; Pulumi program vẫn chạy từ checkout đang gõ lệnh.
- **`local-cleanup`** — xoá Docker resource mồ côi của worktree không còn trên đĩa. Chỉ resource mang đủ label ownership của `@ecoma-io/deployment` mới đủ điều kiện; worktree còn sống và resource thiếu label được giữ nguyên; PostgreSQL volume của resource đủ điều kiện bị xoá như mọi resource mồ côi khác. `--dry-run` chỉ báo cáo. Exit 1 khi còn lỗi dọn. Quy tắc ownership và lifecycle nằm ở `docs/architecture/local-development/03-operations.md`.
- **`local-worker-up`** — quét marker opt-in `apps/<dir>/local-worker.jsonc`, boot `wrangler dev` cho từng app theo thứ tự topological; readiness khai trong marker (`http-health` poll `GET /health` 2xx, `log-banner` đợi banner của wrangler), không suy từ config wrangler. Process spawn DETACHED và sống tiếp sau khi lệnh exit — CLI là điểm điều khiển, không phải process manager; migration D1 local chạy trước khi spawn. Fail giữa chừng chỉ teardown entry vừa fail; lệnh dò lại và in cảnh báo kèm hướng dẫn `local-worker-down` cho các entry còn sống. `--entry a,b` chọn tập app, thứ tự boot vẫn topological trong tuyển chọn.
- **`local-worker-status`** — snapshot JSON của stateDir worktree (`.worker-local-state`): mỗi entry một row với state (`alive`/`stale`/`unspawned`/`invalid`), pid, `startedAt`, generated config còn trên đĩa. Read-only, an toàn chạy bất cứ lúc nào.
- **`local-worker-down`** — tắt runtime theo stateDir: kill process sống khi identity khớp, dọn metadata mồ côi, giữ file hỏng làm bằng chứng. Exit 0 chỉ khi mọi entry đã dứt; còn `kept-evidence` là exit 1 kèm cảnh báo — caller phân biệt được "down sạch" với "down từng phần, port còn bị chiếm".

## Boundaries

- Project tooling, không phải ứng dụng: không endpoint, không database, không được provision bởi deploy unit nào; nằm ngoài bản đồ deployment (`docs/architecture/05-code-architecture.md` §2) và không thuộc catalog bounded context ([`docs/domains/README.md`](../../docs/domains/README.md)) hay component ([`docs/applications/README.md`](../../docs/applications/README.md)).
- Chiều phụ thuộc một chiều: `tools/dx` import lib dùng chung `@ecoma-io/deployment` qua tên package; `deploys/*` không được import `tools/dx` và lib không import ngược lại — lệnh cần state của một deploy unit thì spawn entry colocated của owner (`local-status` → `platform-status.ts`) chứ không import (`docs/architecture/05-code-architecture.md` §3).
- Định nghĩa policy thuộc canonical doc; `arch-check` và `pr-check` chỉ thực thi rule mà `docs/architecture/05-code-architecture.md`, `commitlint.config.mjs` và root `AGENTS.md` nêu — không có bộ rule song song.
- Image scanner ghim theo digest ngay tại nơi gọi (`lefthook.yml`, `.github/workflows/code-analysis.yml`); CI và local phải chạy cùng image, và `security-tool-pins.spec.ts` assert chuỗi image khớp giữa hai bên cùng `matchStrings` của Renovate — nâng một bên quên bên kia, hay lệch khỏi regex của Renovate, là test đỏ.
- Các script trong `scripts/` là entrypoint Node thuần không phụ thuộc package nào, gọi bằng đường dẫn: `ocr-result-gate.mjs` và `ocr-selection-probe.mjs` do workflow `code-review.yml` gọi (spec của chúng ở `src/review-tooling/`), còn `mail-worker-runtime-e2e.mjs` là E2E in-repo của worker runtime transactional-mail theo quy trình ở `docs/architecture/local-development/evidence/worker-runtime-e2e.md`.

## Development

```bash
pnpm nx run @ecoma-io/dx:lint        # oxlint
pnpm nx run @ecoma-io/dx:typecheck   # tsc --build --emitDeclarationOnly
pnpm dx <command> --help             # usage của từng lệnh
```

Source tổ chức theo capability: `src/repository/` (repo-prepare, sync-agent-config, dò tool), `src/pull-request/`, `src/architecture/`, `src/security/`, `src/deployment/local-platform/`, `src/workers/`, `src/bootstrap/`, `src/local-runtime/` (arg `--worktree-root` + error boundary dùng chung). Thêm tool vào dò của `repo-prepare` là thêm một `ToolSpec` trong `tool-specs.ts`, không phải code mới.

## Testing

```bash
pnpm nx run @ecoma-io/dx:test        # vitest — unit test colocated với source
```

Spec ghim hợp đồng bằng hành vi thật: `index.spec.ts` chạy CLI trong tiến trình con qua `tsx`, `security-tool-pins.spec.ts` assert image ghim khớp giữa `lefthook.yml` và `code-analysis.yml` (kèm `matchStrings` của Renovate và regex phạm vi quét semgrep), `semgrep-rule-coverage.spec.ts` chạy `semgrep --test` bằng docker để ghim độ phủ thật của rule, `docker-context.spec.ts` kiểm `.dockerignore` của repo root, `local-entry-contract.spec.ts` ghim cấu trúc lane `deploys/*` (project `type:deployment` phải có `local.ts` và target `local-up`/`local-down`). Phân loại test và canonical target theo `docs/architecture/06-testing.md` §2–§4.

## Related Documentation

- [`AGENTS.md`](./AGENTS.md) — hợp đồng authored của project này: policy pr-check, luật sync-agent-config, ranh giới phụ thuộc.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — tag schema (§6), dependency direction (§3), deployment map (§2) và `pnpm dx arch-check` (§8).
- [`docs/architecture/06-testing.md`](../../docs/architecture/06-testing.md) — taxonomy và layout test-target mà lượt test-target của `arch-check` đối chiếu.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — lifecycle local platform, quy tắc `local-cleanup` và dọn dẹp sau khi xoá worktree.
- [`docs/architecture/local-development/evidence/worker-runtime-e2e.md`](../../docs/architecture/local-development/evidence/worker-runtime-e2e.md) — bằng chứng E2E của ba lệnh `local-worker-*`.
- [`docs/applications/staff-access/03-operations.md`](../../docs/applications/staff-access/03-operations.md) — procedure first-administrator mà `bootstrap-superadmin` orchestrate.
- [`docs/engineering/contribution-workflow.md`](../../docs/engineering/contribution-workflow.md) — validation theo loại thay đổi (§2.7, gồm dòng riêng cho `tools/dx/`).
- [`lefthook.yml`](../../lefthook.yml) — hook nào gọi lệnh nào của project này.
