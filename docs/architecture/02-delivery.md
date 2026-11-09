# 02 — Delivery

> **Phạm vi:** Code được validate, test, migrate, release, deploy và rollback như thế nào?
> Topology, data ownership, invariant → `01-architecture.md` · backup/DR, observability, runbook → `03-operations.md` ·
> platform fact → `04-platform-facts.md` · Nx taxonomy, DDD → `05-code-architecture.md` · kiến trúc test → `06-testing.md` · runbook của service → `applications/<name>/`.

> ### ⚠️ Trạng thái tài liệu này — đọc trước khi dùng làm mô tả hệ thống đang chạy
>
> Phần lớn nội dung dưới đây là **hợp đồng và thiết kế đã chốt**, phần lớn **chưa hiện thực** trong repo. Đo trên cây
> hiện tại:
>
> | Nhóm                                                                                       | Có thật trong repo?                                                                                                                                                                                                                                                                                                        |
> | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **Hai làn deploy** (`staging.yaml`, `production.yaml`, `release-prepare.yaml`)             | ❌ Không có. `.github/workflows/` chỉ có `ci.yaml`, `code-analysis.yml`, `code-review.yml`                                                                                                                                                                                                                                 |
> | **Delivery runner** (`tools/delivery/`, deploy gate, promotion gate, guard binding, audit) | ❌ Không có thư mục này. `tools/` chỉ có `dx/` và `account-bridge/`                                                                                                                                                                                                                                                        |
> | **Nhóm deployment** (`deploys/`)                                                           | ✅ Có — 13 Pulumi deployment project, `platform-deploy` là tầng prerequisite. `platform-deploy` + `home-deploy` hiện thực local platform (managed resource thật, lifecycle local điều phối qua Nx target `local-up`/`local-down` của từng deploy project); 11 project có lane local, 2 project job-deploy chỉ log (§7.4.1) |
> | **Release machinery** (`nx.json` `release.projects` + Nx Release config)                   | ✅ Có — khai trong `nx.json`, `projectsRelationship: independent`                                                                                                                                                                                                                                                          |
> | **Migration runner** (§3)                                                                  | ❌ Không có job nào; migration PostgreSQL là **CI job theo thiết kế**, chưa dựng                                                                                                                                                                                                                                           |
>
> Hệ quả cách đọc: các mục §7.2–§7.5 và §9.1 viết ở thì hiện tại ("đang chạy", "đã hiện thực", "repo không còn…") mô tả
> **mục tiêu đã chốt trong một thời điểm trước đó**, không phải trạng thái của cây code hôm nay. Đừng đọc chúng như bằng
> chứng một pipeline đang vận hành. Mọi claim trạng thái trong tài liệu này cần kiểm lại với cây code trước khi trích
> dẫn làm sự thật vận hành.

---

## 0. Bốn đường thay đổi, bốn chủ sở hữu

Bốn việc sau **không** phải một việc, và việc lẫn chúng là nguồn hiểu sai phổ biến nhất:

| Việc                    | Project / công cụ sở hữu                                                                                                                                     | Tạo ra                                                                        | **Không** làm                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| **Provisioning**        | Pulumi project trong `deploys/`                                                                                                                              | Tài nguyên hạ tầng: Worker identity, binding, D1/KV/R2/Queue, DNS, Hyperdrive | Không build, không version, không phát hành release |
| **Database migration**  | Migration runner (CI job)                                                                                                                                    | Schema của database, cộng catalog sealed (§3.2)                               | Không tạo resource, không deploy Worker             |
| **Bootstrap / seed**    | Bước provisioning của deploy unit sở hữu dữ liệu, hoặc CLI offline của app đó; một script vận hành nội bộ gọi các bước theo thứ tự và không ghi database nào | Dữ liệu khởi tạo do hệ thống sở hữu (§3.2)                                    | Không đổi schema, không chạy trên serving path      |
| **Application release** | `apps/` + Nx Release + Wrangler                                                                                                                              | Worker version đã build                                                       | Không tạo tài nguyên hạ tầng                        |

- Một application release **không** chạy `pulumi up`; đổi hạ tầng và phát hành ứng dụng là hai workflow tách biệt.
- Hợp đồng bootstrap/seed, bảng bước → database và danh tính khởi tạo canonical (tenant `ecoma`, Superadmin) → §3.2, chốt bởi [`domains/staff-access/adr/0020-bootstrap-seed-contract.md`](../domains/staff-access/adr/0020-bootstrap-seed-contract.md).
- Bảng sở hữu từng loại resource (canonical, trả lời "ai tạo/xoá cái gì") → §9.1. Layout project của nhóm deployment và
  ranh giới provisioning ↔ release ở tầng code → `05-code-architecture.md` §2.1.

---

## 1. Delivery Flow

```text
local (Lefthook)
  → Nx affected
  → validation (lint · typecheck · test · contract check · security scan)
  → build
  → migration gate (khi storage schema đổi)
  → bootstrap / seed + verify (khi dữ liệu khởi tạo thay đổi — §3.2)
  → deploy Worker
  → post-deploy verification
```

- **Gate bắt buộc trước deploy:** contract check (§3), migration gate (§3), bootstrap/verify khi có bước bootstrap thuộc unit đó (§3.2), promotion gate của làn production (§7.2). Gate fail → dừng pipeline.
- `nx affected` quyết định unit nào đi qua pipeline; release một unit không đụng unit khác.
- Mọi deploy unit là Worker (`01` §1): không image, không registry, không GitOps reconcile. Deploy là lệnh có trả về — bước kế tiếp chạy ngay khi lệnh thành công.

### 1.1 Hai làn deploy

Mỗi deploy unit đi qua hai làn với nhịp khác nhau (§4, §7.2):

- **Làn staging — tự động:** merge commit liên quan unit vào `main` → deploy revision đó lên staging → smoke test → ghi kết quả gắn với **exact commit SHA**.
- **Làn production — promotion gate:** chỉ chạy khi một **release** (§7.2) thỏa mọi điều kiện promotion **trước khi deploy**: release được định danh bằng version (resolve ra release commit trên `main`), staging verification pass **cho chính revision đó**, approval production. Production không bao giờ deploy "commit mới nhất của `main`". **Post-deploy verification** chạy **sau** khi production deploy xong; fail → failure handling với rollback controlled (§8) — nó không phải điều kiện để vào production, nhưng là điều kiện để publish release (§7.2).

Hai làn dùng hai Worker identity tách biệt (staging `stg-*`, production — §4); không có cơ chế promote version xuyên identity — production deploy lại từ source revision đã verify với cấu hình environment của nó.

---

## 2. Git and Nx

**Trunk-Based Development** trên `main`, **Conventional Commits** với Commitlint: scope là optional; khi có thì phải đúng **một** Nx project (không có whitelist `chore(deps)`/`chore(release)`); cấm `BREAKING CHANGE`/`!` ngoài `feat`/`fix`.

- **Lefthook** chia hai tầng: `pre-commit` chạy `oxfmt`, `oxlint`, kiểm cấu hình ký commit và fixture semgrep khi chạm `.github/semgrep/**`; `pre-push` chạy kiểm chữ ký commit, gitleaks, semgrep scan và `nx affected --target=lint --target=test`. Không hook nào chạy `build`.
- **Commit signing** có ba gate, mỗi gate ở thời điểm nó còn hành động được: `pre-commit` kiểm **cấu hình** ký (`commit.gpgsign`, `gpg.format`, `user.signingkey`) — vì lúc đó commit chưa tồn tại, `HEAD` vẫn là commit trước, nên không có object để kiểm; `post-commit` kiểm **commit vừa tạo**; `pre-push` kiểm **chữ ký thật** của các commit chưa có trên remote. Chỉ commit chưa đẩy mới bị xét, nên nhánh đã đồng bộ tốn gần như không đo gì và chi phí không tăng theo lịch sử.
- `pre-push` **không** đủ một mình: lefthook bỏ qua mọi command pre-push khi lần push không đổi file nào — đo được trên chính repo này, một commit `--allow-empty` làm cả `lint`/`test` sẵn có bị skip, và khai báo `files` với glob toàn phần cũng không cứu được. Đúng lúc đó một commit unsigned lọt thẳng lên remote, nên `post-commit` là lưới an toàn: nó luôn chạy sau mỗi `git commit`, kể cả dưới `--no-verify`.
- Ranh giới của `post-commit` phải nói thẳng trong chính message của nó: nó **không** chặn được. Commit đã tồn tại, exit 1 không xoá được nó và `git commit` vẫn trả 0. Hook này chỉ để báo ngay tại chỗ kèm lệnh sửa; `pre-push` mới là chốt chặn thật.
- "Đã ký" ở đây nghĩa là **commit object có header `gpgsig`**, không phải chữ ký đã được xác minh: GitHub ký bằng PGP key riêng không có trong local keyring, nên `%G?` trả `E` và `git verify-commit` fail trên chính các commit hợp lệ. Việc xác minh chữ ký thuộc về GitHub (`verification.verified`), và nó là thứ quyết định quyền đóng credit.
- **Nx affected** giảm số task phải chạy; **Nx project graph** xác định phụ thuộc; **Nx Remote Cache** reuse kết quả task (trusted CI được ghi, PR/fork không — §6); GitHub Actions cache cho dependency/tooling của CI.
- Quét: **Semgrep**, **Gitleaks**; **Renovate** cập nhật dependency; review hỗ trợ bằng **Open Code Review**.
- **Open Code Review** chỉ chọn file có đuôi nằm trong allowlist của CLI, và `.md` cũng như mọi file test (`**/*.spec.{js,jsx,ts,tsx}`, `**/*.test.{js,jsx,ts,tsx}`, `**/*_test.py`) đều không nằm trong allowlist đó: Markdown và file test chỉ được review khi `.github/ocr-rules.json` mở rộng phạm vi bằng `include`. Thiếu rule (hoặc rule mất hiệu lực) thì PR docs-only kết thúc `status: skipped`, `files_reviewed: 0` — và `ocr review` trả **exit 0** cho cả `skipped`, nên exit code của action không phân biệt được "đã review" với "không chọn được file nào". Bước **Verify the review result** trong `code-review.yml` đọc kết quả thật và fail-closed thay vì tin exit code: nó đỏ khi `manifest.terminal_state` không phải `complete` (kể cả `skipped`, trừ trường hợp cổng chứng minh được toàn bộ diff nằm ngoài phạm vi review theo rule — mọi file bị bỏ đều có dòng skip hợp lệ, `reviewing 0`, không file nào trong `include` của rule — khi đó nó pass kèm ghi chú "0 in-scope file(s)" thay vì đỏ vô hạn với một diff hợp lệ không có gì để review), khi `files_reviewed: 0` **mà không có** item `reused` nào, khi `coverage` không còn item `completed`/`reused` nào (cùng một nhánh đỏ cho cả "toàn bộ file bị waive" lẫn "toàn bộ file failed" — cổng không có check waive riêng), hoặc khi `summary.budget_exceeded` (token budget bị cắt). Nó đọc các nguồn: `ocr-result.json` (`manifest.terminal_state`, `manifest.coverage` — `selected`/`completed`/`reused`/`failed`, không đọc `waived` — cùng `summary.files_reviewed` và `summary.budget_exceeded`; trường `status` chỉ được in ra dưới dạng fact, không tham gia quyết định), `ocr-stderr.log` (nguồn duy nhất biết file bị loại vì `too_large`, vì `coverage` chỉ liệt kê item **đã chọn**), và rule của checkout base (để biết file bị bỏ qua có nằm trong phạm vi rule hay không). Hai ranh giới phải nói thẳng thay vì để người đọc suy đoán: **(a)** waive **một phần** (1 file đọc xong, 2 waive) vẫn ra exit 0, và chạy lại có checkpoint (`incremental` + `checkpoint_range`) cho `files_reviewed: 0` kèm mọi item `reused` cũng vậy — cả hai đã đo được trong chính PR này, phần đầu đã mở follow-up #292 thay vì nới gate ở đây; **(b)** nguồn rule của cổng là checkout base — đúng trên `pull_request_target`, nhưng khi `workflow_dispatch` thì lần review lấy rule của **ref được dispatch** còn cổng vẫn đối chiếu theo rule của base, nên hai lớp kiểm này có thể đọc hai rule khác nhau khi nhánh được dispatch có rule khác base.
- Xác minh selection **không cần LLM**: bước **Verify the selection contract on the pinned CLI** chạy `ocr-selection-probe.mjs` ngay **trước** bước review, nên rule mất hiệu lực làm CI đỏ trước khi tốn một lần review thật — không phải chỉ đỏ khi có người nhớ chạy tay. Lệnh cũng chạy được độc lập để kiểm cấu hình của một nhánh trước khi merge. Probe chạy `ocr review --preview` trên repo thí nghiệm, in `will_review`/`exclude_reason` cho từng đường dẫn, và fail khi `.md` hay một file test không được chọn (CLI mặc định loại file test với `exclude_reason: "default_path"` — chỉ `include` của rule mới đưa chúng vào), khi `include` vượt qua bộ lọc secret, hoặc khi `exclude` của rule mất hiệu lực. Nó đọc rule của **ref tin cậy** (base trên `pull_request_target`, ref được dispatch trên `workflow_dispatch`), không phải rule trong cây PR head: một PR tự làm hỏng `rule.json` không vì thế mà đỏ trước khi merge, phải chờ merge rồi các PR sau mới đỏ. Với range rỗng, probe chỉ **ghim hình dạng** mà CLI phải trả (`files: []`, `total_files: 0`, `reviewable_count: 0`); việc từ chối đọc hình dạng đó như một review sạch thuộc về cổng **Verify the review result** ở trên. Probe phân biệt ba exit code để không đổ lỗi sai chỗ: `0` contract đúng, `1` contract **sai** (một assertion trên `files[]` — `will_review`, `exclude_reason` — **hoặc trên con số tổng** (`total_files`, `reviewable_count`) không giữ), `2` **chưa đo được** (thiếu git, CLI không chạy được / bị kill / quá thời gian / stdout không phải JSON, setup repo thí nghiệm hỏng) — một lần chạy exit 2 không được đọc là "markdown không được chọn". Nó cũng từ chối chạy khi không đọc được pin, khi hai pin `OCR_VERSION_PIN` và `ocr_version` của action lệch nhau, hoặc khi phiên bản CLI thực tế khác pin — nên kết quả không thể đến từ một bản CLI khác bản mà lần review thật dùng. Để kết quả chạy tay cũng là bằng chứng, probe cô lập môi trường của mọi lệnh con: bỏ mọi biến `GIT_*` kế thừa, tắt git config global/system, và ghi đè toàn bộ nhóm biến home (`HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`) về thư mục rỗng của chính nó — vì CLI đọc thêm rule cấp người dùng ở `$HOME/.opencodereview/rule.json` (đo trên `1.12.12`), nếu không thì một máy đã cấu hình `ocr` toàn cục sẽ làm ca "không rule" báo contract sai và đổ lỗi cho rule của repo.
- Module-boundary lint enforce ranh giới project — không lặp chi tiết ở đây.

Taxonomy (`apps`/`libs`/`system-tests`) và cấu trúc Nx project → [`05-code-architecture.md`](./05-code-architecture.md).

---

## 3. Contracts và Database Migration

### Contracts

| Loại contract           | Công cụ                                                   | Gate                                       |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------ |
| API nội bộ              | Pact (consumer-driven)                                    | publish + verification                     |
| API công khai `llm-api` | OpenAPI + `oasdiff` + SDK conformance                     | protocol compatibility (`01` invariant 15) |
| Async events            | JSON Schema / AsyncAPI-compatible + contract test         | producer/consumer compatibility            |
| DB compatibility        | `drizzle-broker` (`schema.contract.json` theo DB project) | `can-i-deploy`                             |

- Lifecycle: **publish → verification → compatibility (`can-i-deploy`) → promotion.** Breaking change bị chặn trước khi deploy bởi Contracts Registry.
- `<bc>-contracts` là boundary artifact, không phải DDD layer → `05-code-architecture.md`. Contracts Registry chỉ là thành phần delivery gate, không phải specification ở đây.

**Track PostgreSQL** (`db-account`, `db-auth`, `db-payment`, `db-llm-gateway`, `db-llm-tenant`, `db-llm-marketplace`):

- Migration từ **CI runner**, pin `drizzle-kit`; normalize snapshot → `schema.contract.json`; mỗi app version khai báo `[minSchema, maxSchema]`; registry ghi version đang chạy và rollback window (toàn bộ là Worker version).
- Migration chạy **một lần trong CI runner**, kết nối thẳng database bằng PostgreSQL client, giữ **advisory lock**, dùng role _migrator_ của DB đó (role runtime của app chỉ có DML).
- **Mỗi database có migration history độc lập** — `db-account` và `db-auth` thuộc hai deploy unit khác nhau, rollout độc lập (`01` invariant 18). Dùng chung một bảng migration là cách buộc hai service vào một release, đúng thứ tách deploy unit sinh ra để tránh.
- Phân loại Safe/Unsafe. **Expand** chạy trước rollout; **contract** chỉ chạy sau rollback window và khi bản cũ nhất không còn live.
- Không down-migration → **forward-fix**. Backfill là job idempotent riêng, có checkpoint và resume.
- Trước migration production: on-demand base backup, ghi mốc thời gian/LSN vào release record (`03` §3.1).
- `can-i-deploy --force` chỉ qua GitHub Environment approval + audit log.

**Track D1** (`push`, `push-job`, `mail`, `mail-job` — mỗi service một D1):

- Migration là file `.sql` trong `migrations/` của service, áp dụng bằng `wrangler d1 migrations apply`; bảng `d1_migrations` của chính DB ghi tập đã chạy (`04` DB8).
- Tuân thủ expand → compatible rollout → contract (`01` invariant 10); không down-migrate.
- Chạy trong CI runner với Wrangler token scoped theo môi trường — **không** qua Hyperdrive, **không** qua PostgreSQL migration runner. Contract tooling riêng cho D1 chưa chốt (§12).

### 3.1 Migration runner phải độc lập topology

- **Chốt: migration PostgreSQL là CI job, dùng PostgreSQL client kết nối thẳng.** Cần đúng endpoint, credential, tên database — có sẵn ở mọi database hosting tier (`03` §6). Đổi tier chỉ đổi biến môi trường, lệnh migration không đổi.
- Loại trừ mọi đường chạy migration từ trong Worker: Hyperdrive **không hỗ trợ advisory lock** (`04` HD6) nên không giữ được lock chống chạy chồng; `cloudflare:sockets` chỉ plaintext TCP (`04` VP2) — không có TLS cho credential; Worker cron chạy migration nghĩa là migration phụ thuộc application plane.
- Dọc đường đó, một Worker cron **có thể** chạy DML có chọn lọc qua Hyperdrive — khác loại với migration: không cần advisory lock và không đổi schema. Job hiện tại là `auth-nonce-prune-job` (cron DELETE nonce hết hạn bằng role DML hẹp của từng database — `docs/applications/auth-nonce-prune-job/01-architecture.md`); đường sự vụ này KHÔNG mở cửa cho migration từ Worker, rule loại trừ ở bullet trên vẫn giữ nguyên.
- Đường vào database này là **admin path** riêng cho CI, không phải application access path (`01` §1.1). Credential `_migrator` chỉ tồn tại trong CI secret store, không bao giờ là Worker secret (§6).

### 3.2 Hợp đồng bootstrap / seed

Quyết định (đường chạy, danh tính khởi tạo canonical, nội dung migration được phép chứa) là một ADR — [ADR-0020](../domains/staff-access/adr/0020-bootstrap-seed-contract.md). Mục này là nội dung vận hành canonical: thứ tự bước, chủ sở hữu, database đích và kiểm tra sau bước.

**Định nghĩa.** Bootstrap/seed là dữ liệu khởi tạo **do hệ thống sở hữu**: bản ghi sản phẩm cần để hoạt động mà không người dùng nào tạo ra. Dữ liệu do người dùng tạo lúc chạy — tenant của khách hàng, project, API key của khách, membership của khách — **không** thuộc lớp này; nó đi qua route/control plane của sản phẩm như trước.

**Danh tính canonical — giống nhau ở mọi environment.** Tenant nội bộ tên là `ecoma` và Account đầu tiên dùng email `superadmin@ecoma.io`. `local`/`staging`/`production` là nhãn environment, **không** phải tên tenant. Environment được đổi **input seed** (endpoint, credential, redirect URI, token plaintext, tên client), **không** được đổi danh tính canonical ([ADR-0020](../domains/staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 9 và 11).

**Thứ tự bắt buộc**, mỗi bước chỉ chạy sau khi bước trước đã commit:

```text
Provision databases
  → Migrate schemas (chỉ schema + catalog sealed)
  → Bootstrap Account (sub của superadmin, email ở trạng thái pending)
  → Seed staff + assignment của administrator (dùng sub ở bước trên)
  → Seed tenant ecoma + membership của từng sản phẩm (dùng sub ở bước trên)
  → Bootstrap provider / offer đầu tiên của LLM Seller
  → Verify (đọc lại đúng bản ghi kỳ vọng)
```

**Một entry point, nhiều cấu hình.** Thứ tự trên do **một** entry point vận hành chạy, nhận cấu hình chọn environment và input seed của environment đó. Entry point đó là **repo script** đặt trong `tools/` — không phải một Nx project sở hữu app nào, nên không phải deploy project (`05-code-architecture.md` §2.1) và không có entry trong `DEPLOYMENT_MAP`. Nó **không giữ credential database nào** và **không ghi trực tiếp database của service nào**: nó chỉ gọi thao tác bootstrap mà từng service tự sở hữu, theo đúng thứ tự, và dừng khi một bước fail. Không có cấu hình nào fallback sang environment khác (§4.1 điều 1).

| #   | Bước                                              | Chủ sở hữu (service ghi)             | Database ghi                   | Kiểm tra sau bước (đọc được, không dựa log)                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------- | ------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provision databases + role                        | Pulumi project trong `deploys/`      | — (không ghi dữ liệu ứng dụng) | Kết nối được bằng role migrator của từng database; role runtime tồn tại và **không** có quyền DDL                                                                                                                                                                                                                                                                                                                             |
| 2   | Migrate schemas                                   | Migration runner (§3, §3.1)          | Database của chính unit        | Migration history của database đó chứa đủ tập file; catalog sealed đọc lại đúng số bản ghi kỳ vọng                                                                                                                                                                                                                                                                                                                            |
| 3   | Bootstrap Account đầu tiên                        | `account`                            | `db-account`                   | `SELECT` theo `address_hash` của email khởi tạo: đúng một Account `active` + đúng một hàng `pending` (`verified_at IS NULL`); **không** có hàng `verified` cho địa chỉ đó và không có hàng `pending` của `sub` khác                                                                                                                                                                                                           |
| 4   | Seed staff + assignment của administrator         | `staff-access`                       | `db-staff-access`              | Đọc lại: đúng **một** assignment chưa `revoked_at` của `sub`, và đúng **một** role `kind = 'system'` theo định danh canonical — số hàng, không chỉ sự tồn tại (định danh canonical đó, `id` cố định trong seed hay UNIQUE `(kind, name)`, là yêu cầu schema của #17 — ADR-0021 Quyết định 4); audit trail của lần chạy ghi lại được theo [ADR-0003](../domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md) (#85) |
| 5a  | Seed tenant `ecoma` + membership owner            | `pact-broker`                        | `db-pact-broker`               | `SELECT id, status FROM pact.tenants WHERE name = 'ecoma'` trả đúng một row `active`; membership owner của `sub` đọc lại được                                                                                                                                                                                                                                                                                                 |
| 5b  | Seed tenant `ecoma` + membership owner            | `remote-cache`                       | `db-remote-cache`              | `SELECT id, status FROM remote_cache.tenants WHERE name = 'ecoma'` trả đúng một row `active`; membership owner của `sub` đọc lại được                                                                                                                                                                                                                                                                                         |
| 6   | Seed machine credential cho `pact-broker-app`     | `pact-broker`                        | `db-pact-broker`               | Đọc: đúng **một** token còn hiệu lực (`revoked_at IS NULL`) cho `(tenant ecoma, token name)`, không phải một hàng cho hash hiện tại. Gọi thật bằng token không thuộc verify bảng này — đó là smoke sau readiness                                                                                                                                                                                                              |
| 7   | Seed OAuth client cho backoffice                  | `auth`                               | `db-auth`                      | `SELECT 1 FROM auth.oauth_clients WHERE client_id = <id>` + đúng tập redirect URI kỳ vọng (URI cũ đã gỡ không còn)                                                                                                                                                                                                                                                                                                            |
| 8a  | Bootstrap Seller tenant đầu tiên + provider/offer | `llm-api` (BC `llm-seller-tenant`)   | `db-llm-gateway`               | Provider + offer đọc lại được qua probe của chính `llm-api`; owner membership của `sub` đọc lại được                                                                                                                                                                                                                                                                                                                          |
| 8b  | Bootstrap marketplace entry của offer đó          | `llm-api` (BC `llm-seller-tenant`)   | `db-llm-marketplace`           | Entry marketplace đọc lại được và trỏ đúng offer ở bước 8a                                                                                                                                                                                                                                                                                                                                                                    |
| 9   | Seed Consumer tenant `ecoma`                      | `llm-api` (BC `llm-consumer-tenant`) | `db-llm-tenant`                | Tenant + owner membership đọc lại được; nguồn lực ban đầu theo quyết định của #14 có bản ghi tương ứng                                                                                                                                                                                                                                                                                                                        |

Trong các dòng bootstrap/seed (3–9), mỗi dòng là **một service ghi và một database**. Bước 8 tách 8a/8b vì chạm hai database — dù cùng `llm-api` sở hữu — để không dòng nào cấp phép cho một bước ghi hai database. Bước 1 và 2 không phải seed: bước 1 không ghi dữ liệu ứng dụng, bước 2 chạy migration cho từng database bằng credential migrator của chính database đó.

Bước 5a/5b là hai sản phẩm, hai database, không chung transaction: mỗi bên seed tenant `ecoma` của riêng nó. Bước 6 thuộc cùng unit với bước 5a; bước 7 là unit `auth`. Bước 8a/8b chỉ có sau khi quyết định seller nội bộ của #15 được accept — **tên tenant seller và offer cụ thể do #15 chốt**, không phải nội dung của mục này. Bước 9 chỉ có sau #14.

Bước 3 và bước 4 ghi hai database khác nhau và **không** nằm trong một transaction: bước 3 sinh `sub`, bước 4 đọc `sub` đó làm input. Chạy lại bước 3 với cùng email khởi tạo phải trả **cùng** `sub`; cơ chế bảo đảm điều đó đã chốt ở [ADR-0021](../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) Quyết định 2 (create-or-resolve theo `address_hash`, fail-closed); phần còn lại là hiện thực ở #17. Điều kiện "đúng một hàng `pending`" ở bước 3 là ràng buộc của procedure, không phải của schema: UNIQUE trên `account.email_addresses` chỉ áp cho hàng `verified`. Kiểm tra ở bước 3 vì vậy chứng minh **hàng tồn tại đúng trạng thái**, không chứng minh Superadmin đăng nhập được — đường verify đầu tiên đã được chốt về yêu cầu ở [ADR-0021](../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) Quyết định 3 nhưng **chưa tồn tại** trong code; hình dạng route và việc hiện thực thuộc #17.

**Quy tắc thi hành:**

- **Bề mặt thực thi:** bước một-lần trong provisioning lifecycle của deploy unit sở hữu dữ liệu (chạy sau `migrate`, trước container serving — trim theo `dependsOn`) cho lane local; CLI offline trong chính app đó, dùng credential migrator của database đó cho environment thật — không bước nào ở đây cần `ecoma_owner`, và `db-staff-access` không provision role đó (ADR-0020 Quyết định 11). Cả hai bề mặt chạy trên **admin path** của §3.1, không phải trên máy trạm của operator cầm credential dùng chung. Không route, không flag, không code path nào trong Worker bundle của Worker serving.
- **"Đầu tiên" do entry point quyết định, không do service quyết định.** Bước 4 không có nhánh "nếu chưa có administrator thì tạo": entry point chạy một lần cho mỗi environment và chỉ chạy khi chưa có assignment nào của administrator role; chạy lại với input khác là ngoài hợp đồng, không phải một biến thể hợp lệ.
- **Verify, kiểm idempotency và smoke là ba thứ khác nhau.** Cột "Kiểm tra sau bước" chỉ là verify — đọc lại đúng tập bản ghi kỳ vọng. Kiểm idempotency là chạy lại bước rồi so số hàng; smoke sau readiness là gọi thật vào API đã lên. Ba việc không trộn vào cùng một bước và không thay thế nhau.
- **Đổi plaintext token là revoke hàng cũ, không tạo hàng thứ hai.** Machine token lưu hash; khi cấu hình environment đổi plaintext, bước 6 phải `revoked_at` hàng cũ trước khi ghi hàng mới (forward-fix, không xoá), để verify "đúng một token còn hiệu lực" giữ đúng.
- **Bootstrap Superadmin không cần phê duyệt hai-phím.** Bước 3 và 4 là bootstrap đầu tiên, chạy trên environment chưa có identity quản trị nào để làm phím thứ hai; trust anchor là chứng minh kiểm soát email `superadmin@ecoma.io` ở lần đăng nhập đầu, cộng audit trail và idempotency. **Emergency recovery vẫn giữ hai-phím rule của [ADR-0003](../domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md)**; ADR-0020 Quyết định 11 chỉ supersede hai-phím cho lần bootstrap đầu tiên.
- **Bootstrap không tự verify email.** Bước 3 để hàng email ở `pending`. Yêu cầu đặt lên đường hoàn tất lần xác minh đầu tiên đã chốt ở [ADR-0021](../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) Quyết định 3; hình dạng route và việc hiện thực thuộc #17.
- **Trạng thái hiện tại:** đường verify đầu tiên **chưa tồn tại**, nên bước 3 và 4 vẫn **bị chặn** trên thực tế cho tới khi #17 hiện thực nó — quyết định đã có, code chưa có.
- **Idempotency bằng natural key:** `sub`, `(schema, tenant name)`, `(tenant_id, sub)`, `client_id`, `sha256(plaintext token)`, permission `id`. Chạy lại là no-op trên bản ghi đã có; không file trạng thái, không bảng marker, không đọc log.
- **Partial failure — "bước K thất bại sau bước J đã commit":** vì mọi bước là insert-if-absent hoặc update trường không phải danh tính, trạng thái sau lỗi là một **tiền tố hợp lệ** của trạng thái cuối. Chạy lại toàn bộ hợp đồng từ đầu hội tụ về đúng trạng thái của một lần chạy sạch; **không có bước compensating nào** — không có transaction xuyên database và không có rollback dữ liệu (`01` §9 invariant 10: expand → contract, không down-migrate).
- **Fail-closed, không hồi sinh:** tenant đã `suspended`/`deleted` không được seed lại thành `active`; bước verify fail nghĩa là unit đó chưa xong.
- **Failure isolation:** bootstrap/verify của một unit thất bại chỉ làm unit đó không ready. Unit khác retry độc lập; `sub` từ bước 3 là giá trị đầu ra được truyền vào, không phải ràng buộc giao dịch.
- **Không đọc/ghi chéo database:** mỗi bước chỉ chạm database của service ghi; không FK xuyên database; `sub` là tham chiếu opaque duy nhất đi xuyên service.
- **Không credential nào chỉ sống trong một lần chạy:** plaintext của machine token / OAuth client phải tái tạo được từ nguồn cấu hình của environment (§6 — secrets thuộc cấu hình/Worker Secret, không thuộc migration; `03` §3.5 là yêu cầu liên quan nhưng khác: nó nói bản sao offline của credential phải nằm ngoài VPS); seed không sinh giá trị mới mỗi lần chạy, vì làm vậy là drift chứ không phải idempotency.
- **Permission catalog không do bootstrap định nghĩa.** Catalog canonical là `staff_access.permissions`; thay đổi đi qua seed migration mới, không sửa migration đã apply ([ADR-0010](../domains/staff-access/adr/0010-permission-naming-and-read-catalog.md)). Tập permission và nội dung system-defined administrator role đã chốt ở [ADR-0021](../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) Quyết định 4 và Quyết định 8; chênh lệch `audit.read` giữa hai bản seed **không** được chọn tại chỗ — nó vào catalog canonical bằng seed migration mới ở #17.

**Số phận của các seed đang có trong repo — chốt tại đây:**

| Seed hiện có                                                          | Lớp                           | Quyết định                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/backoffice/db/migrations/0003_permission_catalog_seed.sql`      | Catalog sealed                | **Giữ trong migration.** Permission catalog cố định lúc review, không biến thiên theo environment, idempotent (`WHERE NOT EXISTS` + `ON CONFLICT DO NOTHING`). `db-backoffice` là DB chuyển tiếp; catalog canonical là `staff_access`                                                                                                                                   |
| `apps/staff-access/db/migrations/0003_permission_catalog_seed.sql`    | Catalog sealed                | **Giữ trong migration**, cùng lý do. Chênh lệch 3-vs-4 permission so với bản `backoffice` không được sửa tại chỗ: `audit.read` đi qua seed migration mới ([ADR-0010](../domains/staff-access/adr/0010-permission-naming-and-read-catalog.md)) — đã chấp nhận ở [ADR-0021](../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) Quyết định 8, hiện thực ở #17 |
| `apps/transactional-mail/migrations/0009_mail_templates_seed.sql`     | Catalog sealed                | **Giữ trong migration.** Template không phải credential, không biến thiên theo environment, `ON CONFLICT (id) DO NOTHING`                                                                                                                                                                                                                                               |
| Tenant `local` + machine token trong `deploys/pact-broker-api-deploy` | Bootstrap/seed (system-owned) | **Chuyển sang tenant `ecoma`** trên bề mặt provisioning; token plaintext lấy từ cấu hình environment ổn định thay vì sinh mới (thực hiện ở #21)                                                                                                                                                                                                                         |
| OAuth client `ecoma-backoffice-local` trong `deploys/auth-deploy`     | Bootstrap/seed (system-owned) | **Giữ**, phân loại là bootstrap/seed trên bề mặt provisioning; redirect URI là output của stack nên không thể nằm trong migration (thực hiện/kiểm lại ở #25)                                                                                                                                                                                                            |
| `apps/pact-broker-api/db/bootstrap-internal-tenant.mts`               | Bootstrap/seed (system-owned) | **Nối vào bề mặt (b)** của `pact-broker` ở #21, hoặc thay bằng entry đã chốt — không để tiếp tục orphan                                                                                                                                                                                                                                                                 |

Không có seed nào khác được thêm vào migration ngoài ba catalog trên, cộng hai seed mới của `db-staff-access` mà [ADR-0021](../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) yêu cầu: permission thứ tư `audit.read` (Quyết định 8) và role system administrator cùng `role_permissions` của nó (Quyết định 4). Cả hai là catalog sealed cùng lớp, không phải credential, không biến thiên theo environment.

Việc đổi tenant `local` → `ecoma` không cần migration dữ liệu: bước seed hiện có chỉ chạy trên lane local (`docker exec` vào container PostgreSQL của worktree), và dữ liệu local là dữ liệu dùng một lần (`local-down` xoá volume PostgreSQL — `local-development/03-operations.md`). Sau khi #21 đổi hằng số, một worktree local đang chạy phải được dựng lại bằng `local-up`, không phải bằng cách chạy seed hai lần trên cùng database. Environment thật dựng tenant lần đầu bằng chính bước bootstrap này, nên chưa có hàng cũ nào phải đổi tên ở đó.

---

## 4. Môi trường

Baseline VPS database-only của ecoma — quyết định của ecoma, không phải platform minimum; validate bằng load test + restore drill → `03` §2.1.

| Môi trường       | Workers            | PostgreSQL                                                      | D1                                                          | Kích hoạt                         |
| ---------------- | ------------------ | --------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| **Local**        | Wrangler/Miniflare | qua Docker Compose hoặc mock                                    | D1 local hoặc mock                                          | Dev                               |
| **PR Preview**   | Worker Preview     | mock hoặc DB preview tách biệt; **không bao giờ** DB production | namespace/DB riêng theo PR; **không bao giờ** D1 production | Thủ công (§5.1), không theo PR    |
| **CI ephemeral** | —                  | Testcontainers PostgreSQL                                       | Miniflare D1                                                | PR (khi affected)                 |
| **Staging**      | Workers `stg-*`    | database staging riêng (cùng host, cost — §4.1)                 | D1 staging riêng                                            | Merge `main` (làn staging, §1.1)  |
| **Production**   | Workers production | database production                                             | D1 production                                               | Promotion release qua gate (§7.2) |

### 4.1 Hợp đồng môi trường — bảy điều bắt buộc

1. **Mỗi environment có identity, binding, credential riêng.** Staging không kế thừa production: Worker identity (`stg-*`), Hyperdrive config, D1/KV/R2/Queue ID, Worker Secrets, Environment approval — tất cả tách biệt. **Không có fallback sang production config**: một environment thiếu binding thì fail closed, không rơi về production.
2. **Staging dùng chung host PostgreSQL với production là quyết định chi phí, không phải HA.** Cả hai database trên một instance → staging **không** chứng minh failure domain độc lập; sập instance là sập cả hai service. Tách host staging là **operational trigger** (`03` §6), không phải roadmap phase. Load test chạy ngoài giờ cao điểm hoặc trên host riêng.
3. **Preview không bao giờ bind production D1/Hyperdrive.** D1/Hyperdrive production → Preview = ghi database production. KV/R2 preview phải có namespace/prefix riêng (cùng namespace = cùng data).
4. **Preview không dùng production Queue consumer hay Cron làm dependency.** Preview produce → queue production có thể bị production consumer xử lý (`04` QU7/PW5). Service Binding từ Preview gọi **production deployment** (`04` PW4) — đó là back-channel, không phải Preview-to-Preview isolation.
5. **Staging không bao giờ trỏ production DB hay storage ghi.** Staging Hyperdrive/D1/Queue/KV/R2 phải là staging-specific. Resource inheritance (kế thừa production config) là lối đi bị cấm.
6. **Một failed job không để resource im lặng coi là pass.** CI ephemeral: resource tạo cho test purpose phải được clean up; Testcontainers tự dọn; Miniflare D1 không persisted. Staging: infra stack không bị destroy/recreate bởi app deploy.
7. **Credential: một token shared, không cô lập theo environment.** `ECOMA_CLOUDFLARE_API_TOKEN` dùng chung cả hai lane — **không** có token theo environment. Environment separation (approval/audit) ≠ credential separation (token scope). Ranh giới staging/production nằm ở Worker identity + `--env` tường minh + Environment riêng, không phải credential (§6.12).

> **Hiện trạng điều 1 — đã đo (`wrangler` 4.151.0, `wrangler deploy --dry-run --env staging`):** `apps/account/wrangler.jsonc` khai `hyperdrive` ở **top level**, mà Wrangler **không** inherit binding vào `env.staging`/`env.production` (cảnh báo "is not inherited by environments"), và `id` hiện là placeholder toàn số 0. Nên cả hai lane deploy **không có** binding `DB_ACCOUNT` dù file trông như đã cấu hình — lệch về phía fail closed, nhưng vẫn là vi phạm điều 1. Sửa đúng cần `id` Hyperdrive theo **từng environment** do provisioning hạ tầng cung cấp (§9.1), nên Phase 1 không sửa được và **không** được bịa — ghi ở §12. Guard audit ở §9.1 **có** kiểm quy tắc này (`checkTopLevelReDeclaration`: binding top-level mà `env.<lane>` không khai lại là `problem`, và với `account` nó còn nêu thêm cả vế placeholder) — nhưng guard chỉ chạy trên tập `releaseable`, còn `account` hiện nằm trong `excluded` của `deploy-eligibility.jsonc` kèm đủ hai lý do. Nghĩa là app này không đi tới `wrangler deploy` bằng hai lớp: cổng eligibility loại nó khỏi matrix, và nếu ai đó đưa nó trở lại mà chưa sửa binding thì guard sở hữu chặn.

**Database staging là tối ưu chi phí, không phải chiến lược availability:**

- Staging dùng chung database host với production (`03` §6) → **không** phải HA test, không dùng để kiểm chứng failure domain độc lập.
- Load test (k6) chạy ngoài giờ cao điểm hoặc trên host staging riêng.
- Khi contention xảy ra production được ưu tiên; tách host staging là **operational trigger** (`03` §6), không phải phase roadmap.

---

## 5. Preview (Worker Preview)

### 5.1 Nguyên tắc

- **Mỗi unit chỉ có một Worker identity lâu dài; PR không tạo Worker mới.** Preview chạy dưới identity đó — `llm-api` không ngoại lệ. `account` (`ecoma-account`) và `auth` (`ecoma-auth`) là hai deploy unit của hai bounded context riêng, mỗi cái một Worker identity.
- **Preview là manual-only:** mở hay cập nhật PR chỉ chạy validation (§1); **không** tự động deploy Preview nào. Preview được tạo/refresh theo yêu cầu rõ (theo PR, branch hay revision — do phần implement chốt, §12).
- Preview có code, vars, secrets, bindings, URL, observability riêng; **không kế thừa cấu hình production**; cấu hình nằm trong `previews` block.
- Preview là **untrusted runtime** (`01` §6) và không ghi được storage production — enforced bằng binding, không bằng quy ước (`01` invariant 2).

### 5.2 Isolation theo tài nguyên

| Tài nguyên         | Hành vi Preview                               | Chính sách ecoma                                                                  |
| ------------------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Worker code/config | Isolated                                      | Mặc định                                                                          |
| KV, R2             | Cùng namespace/bucket = cùng data             | Preview cần isolation phải có namespace/prefix riêng                              |
| **D1**             | Binding trỏ DB nào thì ghi DB đó              | **Không bao giờ bind D1 production vào Preview**                                  |
| **Hyperdrive/PG**  | Binding trỏ origin nào thì ghi origin đó      | **Không bao giờ bind Hyperdrive production vào Preview**                          |
| Queue              | Produce được, **không** consume được          | Chỉ bind queue riêng/test; không thiết kế E2E dựa vào Preview consumer (`04` QU7) |
| Service Binding    | Gọi **production deployment** của Worker đích | Không coi là Preview-to-Preview isolation                                         |
| Workflow, Cron     | Target production                             | Không dùng làm Preview dependency                                                 |

- Chặn bằng binding: mọi environment phải khai báo `hyperdrive` / `d1_databases` / `kv_namespaces` / `queues` **tường minh**, không kế thừa mảng top-level; `previews` không được khai báo `id`/binding của production (`01` invariant 2). **Enforce một phần (hai lớp — chi tiết ở §9.1):** lớp audit `tools/delivery/src/resource-bindings.ts` đọc binding trong scope **từng lane** (`env.staging`, `env.production`) của mọi deploy unit `releaseable` và chặn khi định danh thiếu hoặc là placeholder — `d1_databases` (`database_id`), `kv_namespaces` (`id`), `r2_buckets` (`bucket_name`), `queues.producers` (`queue`) vì Wrangler tự tạo được bốn loại đó, và `hyperdrive` (`id`) vì thiếu id thì Worker không có DB bound; file hỏng/không đọc được/entry sai hình dạng đều fail closed. Lớp CLI thêm **cả hai** cờ `--experimental-provision=false` **và** `--experimental-auto-create=false` vào **mọi** `wrangler deploy` — đây mới là lớp **bảo đảm**, vì đo được rằng khai `bucket_name`/`queue` **không** đủ để Wrangler coi binding là fully specified. Quy tắc "binding phải nằm trong `env.<lane>`" **đã** có guard máy (`checkTopLevelReDeclaration`): binding khai ở top level mà lane không khai lại là `problem`, và test chạy hàm đó trên chính `apps/account/wrangler.jsonc` để chốt `DB_ACCOUNT` bị chặn ở cả hai lane. `account` vẫn không tới được `wrangler deploy` vì một lý do khác nữa: nó nằm trong `excluded` của `deploy-eligibility.jsonc`, nên cổng eligibility loại nó khỏi matrix trước — lý do ghi trong file đó → §4.1 · §9.1 · §12.
- ⚠️ **Service Binding + Hyperdrive cộng lại là một đường lách Preview.** Service Binding từ Preview gọi production (`04` PW4), và Worker production giữ Hyperdrive production → một Preview gọi binding là đang **ghi vào database production qua một Worker production**. Với cặp `account`/`auth`, cả hai vế đều áp dụng: service binding back-channel của `account` → `auth` (kiểm tra session) và Hyperdrive config của `account`. Luồng login E2E trong Preview vì vậy **không** chạy mode A (`applications/auth/03-operations.md` §5).

### 5.3 Dependency mode (khai báo cho từng app)

| Mode | Cách                                         | Dùng khi                                                                  |
| ---- | -------------------------------------------- | ------------------------------------------------------------------------- |
| A    | Preview → Service Binding → **production** B | Đã chứng minh tương thích, read-only/được bảo vệ — theo quy ước và review |
| B    | Preview A → HTTPS + preview auth → Preview B | Cần test cross-service thật; B có Access hoặc service token               |
| C    | Mock                                         | Mặc định cho smoke — không cần Preview                                    |

⚠️ **Mode A không dùng cho bất kỳ contract nào giữa `account` và `auth`.** Cả hai hướng binding đều là đường xác thực, không phải read-only: `account → auth` (`POST /internal/session/verified`, [`auth` §5.1](../applications/auth/01-architecture.md)) và `auth → account` (`GET /internal/account/status`, [`auth` §6.0](../applications/auth/01-architecture.md)). Worker đích lại giữ Hyperdrive production, nên Mode A trên hai contract này là một Preview ghi vào database production. Cụ thể:

| Việc cần kiểm chứng                       | Mode được phép                                      | Lý do                                                                                   |
| ----------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Login E2E, consent E2E                    | **Không A** — C (mock) hoặc B (service token riêng) | Cả hai đều đi qua back-channel xác thực; A để lọt là viết production                    |
| Kiểm tra trạng thái account lúc phát hành | **Không A**                                         | Cùng lý do; đây là control point fail-closed, không được chạy bằng đường không xác thực |
| Smoke test                                | **C** — mặc định                                    | Không cần Preview                                                                       |
| Test cross-service thật                   | **B** với service token riêng theo môi trường       | B phải là Preview B riêng, không phải production                                        |

Mỗi môi trường **khai báo binding tường minh**, không kế thừa: một môi trường thiếu binding thì service đó fail closed chứ không rơi về đường không xác thực. Không có mode nào ngoài A/B/C ở bảng trên.

⚠️ **Staging không phải bằng chứng HA.** `db-account` và `db-auth` cùng nằm trên một PostgreSQL instance, nên staging **không** kiểm chứng được failure domain độc lập — sập instance là sập cả hai service cùng lúc (`03` §3.2). Một run staging xanh chỉ chứng minh logic và contract chạy đúng, **không** chứng minh tách lỗi (`03` §3.2, [`account` §9](../applications/account/03-operations.md)).

Từ D2 trở đi mặc định Mode C (hoặc A); không E2E chéo giữa các Preview. **Preview routing** (router động cho preview trên cùng domain) chưa chốt — xem mục 12.

### 5.4 Hostname, cleanup, auth

- **Hostname:** ưu tiên `workers.dev`; custom domain chỉ khi UX cần origin ổn định, sau khi xác minh certificate/Access/routing (§12).
- **Cleanup:** không dựa vào `pull_request: closed`. **Worker Janitor** (cron ~6 giờ) quét tài nguyên theo tag/prefix, đối chiếu trạng thái PR (khi Preview gắn PR) qua GitHub API; PR đóng hoặc tuổi > 7 ngày → xoá Preview và dọn resource.
- **Auth:** `MockOidcAdapter` ký JWT cùng format production (trang chọn user/role từ seed data), bảo vệ 3 lớp. Org strict service token auth là mặc định (`04` AC1) — chỉ **Service Auth policy** cấp quyền.
- Giới hạn platform (số lượng Preview, retention, hành vi Queue preview) → `04-platform-facts.md`; Preview của service riêng → `applications/<name>/03-operations.md`.

---

## 6. Trust boundary, secrets

```text
PR source ──build──► Untrusted artifact ──► Trusted deploy workflow ──► Preview / Staging / Production
                      (no secrets)           (protected branch,          (Environment-scoped approval;
                                              reviewer-protected)        one shared Cloudflare token)
```

1. PR build không có secret; PR từ fork không có deploy credential.
2. Trusted workflow chỉ lấy artifact đã build; **approval** nằm ở GitHub Environment (`preview`, `staging`, `production`).
3. Environment production chỉ cho workflow promotion release (§7.2) + reviewer. Việc Environment **tồn tại và đủ bảo vệ** được preflight kiểm **trước** khi approval nào được xin (§6.13) — vì khai `environment: <tên>` khiến GitHub tự tạo Environment đó, tức là một approval không ai phải bấm.

> **Credential KHÔNG scoped theo environment.** Sơ đồ này trước đây ghi `(credential theo environment)`, và đó là tuyên bố sai: cả hai làn dùng **cùng một** org secret `ECOMA_CLOUDFLARE_API_TOKEN` (mục 12 dưới). Cái thuộc về Environment là **approval và audit log**, không phải credential.

4. Preview runtime chỉ có preview/test credentials; không bind production secret.
5. Cloudflare management token không vào Worker runtime.
6. **Không có control plane nào kéo workload từ Git** — deploy bằng Wrangler API token scoped, không orchestrator, không manifest.
   > **Ngoại lệ có chủ đích:** D1 migration (§3) chạy qua Wrangler API vì D1 không có đường kết nối trực tiếp. Đây là schema change cho database managed, không mở cửa cho pattern GitOps/manifest khác.
7. **Quản lý secret: native Worker Secrets.** Đặt bằng `wrangler secret put` (deploy) hoặc `wrangler versions secret put` (chỉ stage), theo môi trường deploy; không có service trung gian. Vì `wrangler secret put` **deploy ngay lập tức** (`04` WS1), xoay vòng secret phải đi qua `wrangler versions secret put` + `versions deploy` để không bypass delivery gate. Secrets **không kế thừa** giữa named environments (`04` WS3) — mỗi environment set riêng; `secrets.required` khai báo danh sách bắt buộc.
8. Worker **version** là đơn vị bất biến (`04` WV1); rollback chọn version đã publish, không rebuild; không image, không digest.
9. Access service token tách theo environment; Preview không giữ token production. Chi tiết rotate → `03` §8.
10. **Nx remote cache:** trusted CI được ghi shared cache; PR/fork **không** có write credential. Credential lấy từ local secret store / GitHub Environment, không commit vào Git → [`applications/remote-cache/03-operations.md`](../applications/remote-cache/03-operations.md).
11. **Credential của CI runner:** migration runner (§3.1) giữ credential `_migrator` trong CI secret store — không tồn tại trong bất kỳ Worker nào.
12. **Một Cloudflare API token duy nhất cho toàn bộ pipeline — `ECOMA_CLOUDFLARE_API_TOKEN`.** Đây là org secret (`visibility: all`), map vào `CLOUDFLARE_API_TOKEN` **chỉ trong step Wrangler của job deploy**. Pipeline **không** có token riêng theo environment, theo Worker, hay theo lane (`ECOMA_STAGING_CLOUDFLARE_API_TOKEN` / `ECOMA_PRODUCTION_CLOUDFLARE_API_TOKEN` và mọi bí danh tương tự đều bị cấm).

    **Hệ quả phải nói thẳng: token này không cung cấp cô lập theo environment.** Nó đủ quyền cho _mọi_ Worker mà pipeline chạm — kể cả Worker production — nên lane staging **không** bị chặn khỏi việc sửa Worker production chỉ bằng lý do credential. Ranh giới staging/production nằm ở chỗ khác, và chỗ khác đó mới là thứ phải giữ:

    - **Worker identity tách biệt** (`stg-ecoma-home` vs `ecoma-home`, `apps/*/wrangler.jsonc` khối `env`);
    - **`--env <target>` tường minh** ở Nx target `deploy` cho từng configuration — thiết kế hiện thực bằng cách mọi target `deploy` trỏ vào **cổng duy nhất** `tools/delivery/src/deploy-gate.mts` (§7.4.3), nơi lane là tham số bắt buộc và lệnh mặc định _từ chối chạy_ thay vì deploy ngầm (hiện tại repo chưa có target `deploy` nào — target đã bị xóa ở Phase 3 của #216);
    - **GitHub Environment riêng theo deploy unit** (`staging-<slug>` / `production-<slug>`) để approval và audit log không bị trộn.

    Quyền thật của token phải được kiểm tra tay trên Cloudflare; từ tên secret suy ra quyền là không đủ. Nếu sau này cần cô lập credential thật sự, đó là một thay đổi kiến trúc riêng (một token mỗi Worker, scope giới hạn theo Worker), không phải một thay đổi cấu hình secret.

**Pulumi state:** R2 bucket riêng theo environment, token giới hạn theo bucket, passphrase riêng (vị trí/credential → `03` §3.1). Contract bootstrap của Phase 2A (`tools/infra`) **đã bị gỡ khỏi repo** cùng toàn bộ CD; nhóm deployment thay thế nằm ở `deploys/` (§7.4.1). Bucket, credential và stack trên backend thật **chưa tồn tại** (bootstrap → §7.4.1).

---

### 6.13 Bảo vệ Environment production: cái pipeline kiểm được và cái nó không kiểm được

Khai `environment: production-<slug>` trong `production.yaml` **không** tạo ra một approval. Khi Environment đó chưa tồn tại, GitHub **tự tạo** nó — không required reviewer, không protection rule, không giới hạn branch. Workflow vẫn chạy, bước "approval" là một bước không ai phải bấm, và secret Environment vẫn được nạp. Coi một Environment ngầm định tạo như thể nó đã được bảo vệ là đúng cái §6 cấm.

**Cái pipeline kiểm (tự động, fail-closed).** Bước `Preflight production Environment protection` chạy ở job `gate-build` — tức **trước** khi approval nào được xin, và không giữ token Cloudflare. Vì approval có thể chờ lâu, niềm tin của người approve phải đúng _trước khi_ họ bấm chứ không phải sau. Preflight yêu cầu Environment:

- **tồn tại** (không phải do GitHub tạo ngầm);
- có `required_reviewers` khác 0 — không có ai phải duyệt thì không có approval;
- có **ít nhất một** reviewer gắn vào con số đó — `required_reviewers: 1` mà danh sách rỗng nghĩa là không ai nấp được;
- hình dạng `deployment_branch_policy` đọc được (object `{protected_branches, custom_branch_policies}` hoặc `null`). Giới hạn branch **không** bị chặn: dispatch-ref guard buộc mọi promotion chạy từ `main`, nên một policy chỉ cho phép protected/selected branches chứa `main` không chặn promotion nào — nó là lớp phòng thủ thêm và preflight chấp nhận, miễn hình dạng đọc được. (Trước khi có guard, preflight từng chặn mọi policy hạn chế vì promotion chạy từ ref không phải `main`; tiền đề đó không còn đúng.)

**Hình dạng payload preflight đọc, và vì sao nó dễ đọc sai.** `GET /environments/{name}` trả `protection_rules` là **mảng** các rule có trường phân biệt `type` (`required_reviewers`, `wait_timer`, `branch_policy`), và `deployment_branch_policy` là **object** `{protected_branches, custom_branch_policies}` — không phải chuỗi. Cả hai đều là chỗ dễ làm runner im lặng bỏ qua một lớp kiểm:

- đọc `protection_rules` như object thì `required_reviewers` ra `undefined` ⇒ coi như không ai approve ⇒ preflight đỏ **mọi lần**, kể cả Environment cấu hình đúng;
- đọc `deployment_branch_policy` như chuỗi thì không dòng nào khớp ⇒ **cổng giới hạn branch bị bỏ qua trong im lặng** và preflight vẫn báo `ok`.

Hai hình dạng lấy từ schema `environment` trong OpenAPI chính thức của GitHub, không phải từ suy đoán. Reviewer dạng **team** không có `login` mà có `slug`, nên đọc `login` một mình sẽ bỏ trống danh sách khi Environment được bảo vệ bằng một team — đường cấu hình rất phổ biến. Số approval không có sẵn trong payload: `required_reviewers` được **suy** từ số reviewer, vì "có ai phải duyệt hay không" mới là câu hỏi preflight cần trả lời.

Payload có `deployment_branch_policy` nhưng không đúng hình dạng object đã biết thì preflight **đỏ** chứ không coi là "mọi branch": đó là "không biết", và im lặng coi "không biết" là "không hạn chế" là fail-open.

Mọi vấn đề được báo **cùng lúc** và kèm tên Environment, nên một promotion nhiều project vẫn ra được danh sách việc cần làm.

**Cái pipeline KHÔNG kiểm — cấu hình bên ngoài repo, phải provision bằng tay.** Đây là khoảng trống thật, không phải thủ tục hình thức. `workflow_dispatch` chạy **bản `production.yaml` trên chính ref được dispatch** (không phải bản trên `main` — dropdown "Use workflow from" trên UI, tham số `ref` của API), và guard nằm trong chính file workflow đó. Vì vậy có **hai** cách xoá guard, và cách nguy hiểm hơn là cách chưa merge: một tài khoản có quyền ghi repo (không cần merge lên `main`) push một nhánh sửa `production.yaml` — xoá bước guard, và cả dòng `environment: production-...` — rồi dispatch từ chính nhánh đó. Guard không tồn tại để chạy, approval không còn ràng buộc, và `ECOMA_CLOUDFLARE_API_TOKEN` là org secret (không gắn Environment) nên vẫn được nạp. Bản sửa **đã merge** cũng xoá được guard, nhưng ít nhất phải qua được ruleset của `main`; bản sửa **chưa merge** thì không cần ai duyệt. Guard vì vậy chỉ là protection chống **dispatch lầm** (tag, SHA cũ, nhánh sai từ thao tác tay) — đúng mức mà comment của chính nó trong `production.yaml` nêu, và không phải là fail-closed trước mã chưa merge. Preflight và guard đều là điều kiện **cần**, không phải điều kiện **đủ**. Lớp bảo vệ thật sự nằm ở ba chỗ sau, và repo này **không tự kiểm được** chúng:

| Cấu hình                                   | Vì sao không thay bằng code trong repo                                                                                                                                                                                                                                                                                                                                                   | Cách kiểm chứng                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required reviewer trên `production-<slug>` | Lưu ở cấu hình Environment của GitHub, nằm ngoài mọi commit. Runner **đọc** được nó (đó là preflight) nhưng không thể **tạo** nó bằng một commit. Chỉ ràng buộc khi bản workflow được dispatch **còn** khai `environment:` — nhánh sửa file workflow có thể gỡ dòng đó, nên lớp này đi cùng nhau: reviewer chặn nhánh trung thực, còn nhánh cố ý gỡ cả hai phải chặn bằng quyền dispatch | `GET /repos/{owner}/{repo}/environments/production-<slug>` → phần tử `protection_rules` có `type: "required_reviewers"` với `reviewers` khác rỗng. Hoặc để chính preflight kiểm: nó đỏ ngay khi thiếu |
| Quyền dispatch `workflow_dispatch`         | Là quyền của tài khoản, không phải của repo. Chỉnh ở Settings → Actions                                                                                                                                                                                                                                                                                                                  | `GET /repos/{owner}/{repo}/actions/permissions/workflow` → `default_workflow_permissions`; và xem danh sách người có `write` trong team                                                               |
| Ruleset của default branch                 | Là cấu hình repository, nằm ngoài Git                                                                                                                                                                                                                                                                                                                                                    | `GET /repos/{owner}/{repo}/rulesets` → required checks + required pull request + required signatures                                                                                                  |

**Cấu hình phải provision (mỗi deploy unit một Environment):**

```text
Settings → Environments → New environment
  name: production-<slug>            # <slug> suy từ wrangler.jsonc, KHÔNG gõ tay
  Deployment protection rules
    Required reviewers:  ≥ 1 user hoặc team thật (không để trống)
  Deployment branches policy: Selected branches, CHỈ chứa main   # lớp phòng thủ thêm
```

Hai điểm dễ sai, cả hai đều làm approval là hình thức:

- **Để trống reviewer** → GitHub báo `required_reviewers: 1` với danh sách rỗng, và không ai nấp được. Preflight chặn trường hợp này riêng.
- **Deployment branches policy trỏ sai ref** → chính sách hạn chế được preflight **chấp nhận** (dispatch-ref guard buộc promotion chạy từ `main`, nên một policy chứa `main` là phòng thủ thêm chống các ref khác). Nhưng runner không đọc được danh sách pattern từ endpoint preflight dùng, nên việc policy **thực sự** có chứa `main` hay không phải được bảo đảm khi provision: thiếu `main` thì GitHub tự chặn job `promote` ở tầng approval — fail-closed, nhưng chặn promotion hợp lệ. Trong payload, `protected_branches: true` hoặc `custom_branch_policies: true`; cả hai cờ `false` là **All branches**, và `null` là chưa đặt — cả ba trạng thái đều qua preflight, chỉ hình dạng lạ (`unreadable`) mới đỏ.

**Trạng thái đo được trên repo này tại thời điểm viết:** `GET /environments/production-home`, `staging-home`, `production-account` và `production-backoffice` đều trả **404** — chưa Environment nào tồn tại. Preflight vì thế **đỏ đúng** và promotion đang bị chặn cho tới khi quản trị viên tạo. Ngoài ra, đặt required reviewer qua REST API trả `422 "Required reviewers must have at least one reviewer"` với mọi shape payload đã thử dưới token hiện có, nên phần đặt reviewer là **thao tác trên UI của quản trị viên**, không phải một lệnh API mà tài liệu này có thể hứa là chạy được.

## 7. Release và rollout

- Mỗi deployment có file cấu hình riêng để rollout độc lập. Không có bước bất đồng bộ nào — `wrangler deploy` trả về khi deploy xong. Lỗi **transport tạm thời** của Cloudflare API được thử lại trong chính lần chạy đó ([Retry quanh `wrangler deploy`](#retry-quanh-wrangler-deploy)).
- Thứ tự khi thêm unit mới: **Provisioning** (`deploys/<unit>-deploy` — tài nguyên hạ tầng của unit, sau `platform-deploy`) → storage expand → `llm-api` → Workers → Router → promotion gate. Sau đó mỗi release chỉ rollout unit bị ảnh hưởng. Đây là **thứ tự phụ thuộc**, không phải một bước tự động trong pipeline: nó được ràng buộc ở tầng project graph (`05-code-architecture.md` §2.1) và ở execution contract (§7.4.1), còn workflow nối hai vế thì chưa có.
- **Rollback tại release:** chọn Worker version đã publish, không rebuild, không revert Git (`04` WV1–WV3); chi tiết → §8.
- Chuỗi storage: **expand → deploy → migrate (nếu cần) → verify → enable → contract** — contract chỉ chạy sau rollback window (§3).

### 7.1 Làn Worker và promotion gate runtime

- **Atomic stateless:** version mới phục vụ 100% khi promote; không rolling giữa các version. Version skew giữa Service Binding là điều kiện bình thường — app bắt `ChunkLoadError` và reload tối đa một lần. Không drain; stream dài có thể bị cắt khi version bị thay → keepalive theo `01` invariant 19.
- **Promotion gate runtime** (khác promotion gate trước deploy ở §7.2) cho mọi Worker DB-backed (đọc Axiom): request count, error rate, latency, stream abort rate, quota failures, reservation failures. Thiếu metrics → dừng promotion, **không** tự rollback.
- Version Override để pin request test tương thích.
- Canary theo trọng số cho Worker → §12.

### 7.2 Environment, release, promotion

**Khái niệm (canonical cho mọi tài liệu delivery):**

| Khái niệm          | Định nghĩa                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Environment**    | Một deployment target (staging, production) — Worker identity + cấu hình + credential riêng (§4, §6)                                                                                                                                                  |
| **Release**        | Một phiên bản có định danh của **một** deploy unit: version + exact Git commit SHA; tag (`{projectName}@{version}`) + GitHub Release là identity, được **tạo ở Phase C2 (trước production deploy)** rồi **publish ở Phase D (sau smoke pass)** (§7.2) |
| **Promotion gate** | Tập điều kiện bắt buộc trước khi một release vào production (liệt kê bên dưới)                                                                                                                                                                        |

**Trạng thái hiện tại:** pipeline hai làn đã tồn tại trong repo và chạy cho **mọi** deploy unit, không riêng `home` — `.github/workflows/staging.yaml` (làn staging, matrix theo deploy unit) và `.github/workflows/production.yaml` (làn promotion, `workflow_dispatch` với input project + version), cùng toàn bộ helper và runner trong `tools/delivery/src/` — **câu trên mô tả thiết kế, không phải hiện trạng**: như warning block đầu tài liệu ghi, `staging.yaml`/`production.yaml` và `tools/delivery/` **chưa từng có trên `main`**; đây là hợp đồng mà các đoạn dưới mô tả ở thì hiện tại, không phải một pipeline đang vận hành. Danh sách deploy unit **không** ghi trong YAML: job `audit` suy ra nó từ `nx.json` (`release.projects`) ∩ Nx graph, và chạy trước cổng Environment để cấu hình hỏng bị chặn khi chưa dùng credential nào. Deploy unit tham gia pipeline hiện tại: `@ecoma-io/home` (đã có lịch sử release, `0.0.6`). `@ecoma-io/account` và `@ecoma-io/backoffice` — hai đơn vị của demo end-to-end Issue #166 — đã được **rút khỏi** `release.projects` vì cấu hình deploy chưa đủ điều kiện; lý do đầy đủ ở `deploy-eligibility.jsonc` và bảng dưới.

Nx Release được cấu hình **per-project** trong `nx.json` với `projectsRelationship: independent`: version ghi vào `package.json` của chính project (`fallbackCurrentVersionResolver: disk`), CHANGELOG ghi vào `CHANGELOG.md` của project đó, subject release commit là `chore(release): release {projectName} {version}` — scope `release` là **ngoại lệ duy nhất** được whitelist trong `commitlint.config.mjs`, vì scope của commit phải là một Nx project còn một batch release có thể chứa nhiều project. Nx Release KHÔNG tạo tag (`tag: false`) — tag là sản phẩm của làn production promotion (§7.4).

**`nx release` chỉ tính version và sửa file; nó không tạo commit.** `nx.json` đặt `release.git.commit: false` (Nx 23 không có cờ `--git-commit` ở dạng gốc `nx release`), nên runner tự tạo release commit qua git-database REST API — `POST /git/commits` **không** truyền author/committer để GitHub ký bằng web-flow key, và runner kiểm `verification.reason === "valid"` trước khi trỏ branch. Lý do là ruleset `main` có `required_signatures`: commit tạo bằng `git commit` trên runner là unsigned và PR kẹt `BLOCKED` dù mọi check xanh (đo ở Release PR #150). **Một batch, một commit.** `nx release` được gọi **một lần cho mỗi project** trong batch (`-p<project>`), vì `--first-release` là cờ **toàn cục**: dùng nó cho một project sẽ tính sai các project còn lại trong cùng lần chạy. Các thay đổi trên working tree được gộp thành **một** commit có chữ ký, và subject của commit mang danh sách version của cả batch (`buildReleaseSubject`). Một commit vì merge queue squash một PR thành một commit, còn evidence của promotion là **một** commit SHA — tách batch thành N PR thì "SHA nào đã verify" trở thành câu hỏi N lần.

**Mỗi Nx project trong workspace phải được phân loại, và không phân loại thì chặn.** `tools/delivery/config/deploy-eligibility.jsonc` là nơi duy nhất trả lời câu hỏi đó, với đúng ba trạng thái:

- `releaseable` — có **cả hai** target `staging` và `production` trong `wrangler.jsonc`, và được khai trong `nx.json → release.projects`;
- `excluded` — cố ý không đưa vào pipeline này, và **lý do là bắt buộc, mỗi project một lý do riêng**;
- **không khai ở đâu cả** — chưa phân loại → audit báo lỗi chặn, workflow đỏ **trước khi** bất kỳ credential nào được dùng.

Đây là thay đổi có chủ đích so với hành vi cũ: audit trước đây coi một deploy unit có `wrangler.jsonc` mà chưa khai trong `release.projects` là _advisory_ và không chặn, với lý do "chặn cứng sẽ khiến lane staging đỏ vĩnh viễn". Lý do đó có một nửa đúng — 5 app Cloudflare dưới đây đã từng không được khai — nhưng nó **sai về nguyên tắc**: một project nên release mà không ai khai thì bị pipeline bỏ sót **trong im lặng**, đúng loại hỏng âm thầm mà §7.5 đòi chặn. Cách chặn đúng là bắt buộc khai **một lý do cho từng project**, thay vì để "không ai nhớ" trở thành trạng thái mặc định. Mọi project `excluded` nay khai trong `deploy-eligibility.jsonc`, mỗi project một câu:

| Project (`excluded`)                                                                     | Vì sao                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ecoma-io/account`                                                                      | Có đủ hai lane với Worker identity, nhưng **chưa deploy được**: (1) binding `DB_ACCOUNT` (Hyperdrive) chỉ khai ở top level, `env.staging`/`env.production` không khai lại, mà Wrangler không inherit binding vào named environment → Worker deploy ra trả 503; (2) `devOrigin` cả hai lane là placeholder. Cần giá trị hạ tầng thật (§4.1 · §9.1 · §12) |
| `@ecoma-io/backoffice`                                                                   | Có đủ hai lane với Worker identity, nhưng `devOrigin` cả hai lane là placeholder nên cổng readiness chặn trước khi deploy                                                                                                                                                                                                                               |
| `@ecoma-io/auth`                                                                         | Worker API của bounded context `auth`; chưa khai `env.staging`/`env.production` nên chưa có Worker identity cho làn nào                                                                                                                                                                                                                                 |
| `@ecoma-io/push-notification`                                                            | Worker push, chưa tham gia hai làn deploy Worker này                                                                                                                                                                                                                                                                                                    |
| `@ecoma-io/transactional-mail`                                                           | Worker gửi mail, chưa tham gia hai làn deploy Worker này                                                                                                                                                                                                                                                                                                |
| `@ecoma-io/transactional-mailer-job`                                                     | Job cron của Worker mail, chưa tham gia hai làn deploy Worker này                                                                                                                                                                                                                                                                                       |
| `@ecoma-io/web-push-notification-job`                                                    | Job cron của Worker push, chưa tham gia hai làn deploy Worker này                                                                                                                                                                                                                                                                                       |
| Nhóm `account` (`account-contracts`, `account-domain`)                                   | Lib TypeScript nội bộ của bounded context `account` (contract/domain) — không có `wrangler.jsonc`, không deploy độc lập; chỉ được nạp vào Worker `@ecoma-io/account`                                                                                                                                                                                    |
| Nhóm `auth` (`auth-application`, `auth-contracts`, `auth-domain`, `auth-infrastructure`) | Lib TypeScript nội bộ của bounded context `auth` — không có `wrangler.jsonc`, không deploy độc lập; chỉ được nạp vào Worker `@ecoma-io/auth`                                                                                                                                                                                                            |
| `@ecoma-io/delivery`, `@ecoma-io/dx`                                                     | Project tooling (`tools/delivery`, `tools/dx`), không phải Worker — không có `wrangler.jsonc` và không bao giờ deploy được                                                                                                                                                                                                                              |

**Không suy eligibility từ "có `wrangler.jsonc` hay không".** Có config không phải tiêu chí đủ: phần lớn Worker trong repo không khai `env.staging`/`env.production`, nên đưa chúng vào matrix là deploy vào một Worker identity repo không khai. Ngược lại, một project có **cả hai** env mà quên khai ở đây sẽ bị bỏ sót trong im lặng.

`releaseable` ở `deploy-eligibility.jsonc` phải **bằng** `release.projects` của `nx.json`. Hai nơi khai cùng một danh sách là hai nơi trôi lệch, nên audit so chúng và báo lỗi chặn khi lệch; test `deploy-eligibility.spec.ts` khoá lại điều đó. Thêm một deploy unit = thêm nó vào **cả hai**; bỏ sót một thì audit đỏ, không phải deploy im lặng.

Ba lỗi **chặn** còn lại: project trong `release.projects` mà Nx graph không có; hai project suy ra cùng một slug (chúng dùng chung một GitHub Environment, nên approval của project A phủ cho deploy Worker của project B); và tên project không suy ra được slug an toàn.

**Chọn project vào Release PR — và điều xảy ra khi danh sách rỗng.** Input `projects` của `release-prepare.yaml` rỗng là **đường mặc định, và là đường hợp lệ**: nó nghĩa là "mọi project trong `nx.json` `release.projects`", không phải "không release gì".

Mọi project ứng viên được **dry-run trước**, rồi mới chọn. Đây là điểm mà hành vi cũ sai: nó **dừng ở project đầu tiên** không có gì để release, nên mặc định được tài liệu hóa là "để trống để plan mọi project" lại **không bao giờ** tạo được Release PR khi chỉ một project trong batch thật sự có thay đổi. Nay:

| Tình huống                                                                              | Kết quả                                                                                                                                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects` **rỗng**, một số project có thay đổi                                         | Batch gồm đúng những project đó; project không có gì để release bị **loại khỏi batch kèm lý do cụ thể**, không phải làm run đỏ                  |
| `projects` **rỗng**, **không** project nào có thay đổi                                  | **No-op thành công**: exit 0, có summary ghi rõ lý do từng project, **không** tạo branch, **không** tạo PR                                      |
| `projects` **rỗng** nhưng `audit` lỗi                                                   | Vẫn đỏ. Lỗi audit **không** được đọc thành "không có gì để release" — đó là false-green                                                         |
| `projects` chỉ định tường minh, và project đó **không** có gì để release                | **Fail closed**, kèm lý do. Ở chế độ auto, việc một project được chọn rồi không có gì release là một **mâu thuẫn**, không phải một no-op hợp lệ |
| `bump` tường minh (`patch`/`minor`/`major`)                                             | Được tôn trọng tuyệt đối; project được chỉ định phải ra version, nếu không thì dừng chứ không đoán                                              |
| `projects` có tên không khai trong `release.projects`, hoặc lặp, hoặc rỗng sau khi tách | Dừng, và nêu đúng tên không hợp lệ                                                                                                              |

Lý do một project không có gì để release là một câu cụ thể, không phải "không có thay đổi": ví dụ _"no conventional commit (feat:, fix:, BREAKING CHANGE:) reached this project since its last release tag"_. Một project bị chọn tường minh mà không có gì release có lý do khác — nó phân biệt "tôi không cần" với "bạn yêu cầu thứ không có".

PR body liệt kê **mọi** project trong batch với tên Nx chuẩn, version đích, và lý do bump; phần project bị loại nằm ở mục riêng. Sự cố planning của một project không được âm thầm tạo ra một batch thiếu.

**Vòng đời release của `home` (Phase A–D):**

```text
Phase A — Staging verification (tự động, merge `main`)
  CI pass → làn staging deploy `workflow_run.head_sha` → smoke → status `release/staging-verified/<slug>` theo SHA
  KHÔNG tạo tag, KHÔNG tạo GitHub Release (không có quyền `contents: write`, không mint App token)
Phase B — Release PR preparation (`workflow_dispatch`, nguồn duy nhất của version/CHANGELOG)
  `nx release` chỉ sửa `apps/home/package.json` + `apps/home/CHANGELOG.md`; runner commit có chữ ký
  qua API rồi mở PR. Review + squash merge tạo release commit trên `main`
  (subject `chore(release): release {projectName} {version} (#PR)`) — SHA MỚI, khác SHA đã staging-verify
  → commit đó tự chạy lại Phase A → **chính SHA release** có evidence staging riêng (§7.3)
Phase C — Promotion gate (job không secret: `statuses: read`, không `contents: write`)
  resolve release commit trên `main` theo version → promotion gate fail-closed
  → build artifact + `wrangler.jsonc` + `CHANGELOG.md` của ĐÚNG SHA đã gate, đóng gói kèm manifest
    (SHA + version + worker + hash config + hash changelog)
Phase C′ — [Environment `production` approval]
Phase C2 — Tag + draft release, TRƯỚC production deploy (job `promote`)
  revalidate toàn bộ precondition (version, candidate, 3 nguồn version, staging evidence, tag,
    release) — approval có thể chờ lâu nên pre-approval không phải bằng chứng bất biến
  → verify artifact: manifest + hash config + hash changelog
  → tag: chưa có thì `POST /git/refs` rồi **đọc lại ref** và verify trỏ đúng candidate; đã trỏ chỗ
    khác → fail closed trước cả Wrangler. Tag **không bao giờ** bị di chuyển.
  → draft release: tìm qua **danh sách** releases theo `tag_name` (`GET /releases/tags/{tag}` KHÔNG
    trả draft); chưa có thì POST một draft **bám vào tag đã tồn tại**, body lấy từ `CHANGELOG.md` đi
    cùng artifact (tức của chính candidate)
  → chỉ khi tag VÀ draft đã verify đúng mới sang deploy
Phase D — Deploy, smoke, publish, evidence
  → `wrangler deploy --env production` bằng config đi cùng artifact (không rebuild từ `main`)
  → post-deploy smoke trên `ecoma.io`
  → smoke FAIL: ghi `release/production-verified/<slug>` = failure, **giữ** tag + draft, KHÔNG publish,
    KHÔNG auto-rollback, exit 1
  → smoke PASS: publish đúng draft (PATCH `draft: false`) → verify remote tag **vẫn** trỏ candidate
    → verify release đã publish và gắn đúng tag → ghi `release/production-verified/<slug>` = success
```

**Hai status là bằng chứng (durable, gắn exact SHA):**

| Context                              | Nghĩa                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `release/staging-verified/<slug>`    | Kết quả staging verification của **đúng SHA** đó (deploy + smoke), không phải "workflow đã chạy"          |
| `release/production-verified/<slug>` | Kết quả **lần promotion production gần nhất** cho đúng SHA: deploy + smoke + verify tag + publish release |

Hai context được dựng từ **slug của project** (`naming.ts`), không phải tên `home` cứng — `release/staging-verified/home` chỉ là trường hợp riêng của `home`. Cùng bộ máy đó phục vụ `account` và `backoffice`, và bằng chứng của một project **không bao giờ** được đọc cho project khác.

Hai context này **không** được dùng như một status "workflow đã chạy" chung — chúng là bằng chứng có nghĩa, và promotion gate chỉ đọc đúng context của mình. `release/production-verified/<slug>` = success được ghi **sau khi cả bốn bước** (deploy → smoke → verify tag → publish) đã xong; publish fail thì workflow fail và **không** ghi success. Ngược lại, lỗi xảy ra **trước khi** production deploy bắt đầu (gate, revalidate, tag, draft, artifact) **không** ghi failure vào context này: ghi đè vậy sẽ phá một bằng chứng success còn hợp lệ của chính SHA đó từ lần promotion trước. Job URL của hai run được ghi trong mô tả status; workflow logs là bản ghi đầy đủ — chưa có store provenance riêng (→ §12).

**Promotion gate — điều kiện bắt buộc TRƯỚC khi production deploy, tất cả phải pass (`evaluatePromotionGate`):**

1. Version input resolve ra **đúng một** release commit trên lịch sử `main` (subject release commit; không có hoặc ambiguous → fail).
2. Ba nguồn version nhất quán: input ≡ subject release commit ≡ `apps/home/package.json` tại SHA.
3. SHA ∈ lịch sử `main`.
4. Tag release của version (nếu đã tồn tại) trỏ đúng SHA — trỏ chỗ khác → fail closed (tag không bao giờ di chuyển).
5. Status `release/staging-verified/<slug>` = success trên **chính SHA đó** (§7.3).
6. Approval production qua GitHub Environment `production` (§6) — approval nằm ở job deploy, gate fail thì không ai bị phiền approve.

Post-deploy verification **không** thuộc promotion gate: nó chạy sau khi production đã deploy và là đầu vào của failure handling (§8), không phải điều kiện để bắt đầu deploy — nhưng nó là điều kiện của Phase D (publish release).

**Failure / retry / rollback:**

- **Deploy hoặc smoke production fail** → ghi `release/production-verified/<slug>` = failure kèm run URL. Tag và draft **được giữ** (là đường đi tiếp cho lần rerun, và draft không làm gì với traffic); không publish; **không auto-rollback** — rollback là quyết định của con người, deploy lại version cũ là một promotion có chủ đích qua cùng workflow (§8).
- **Lỗi trước khi production deploy bắt đầu** → fail với lý do, không ghi status failure (xem bảng ở trên).
- **Timeout / job bị hủy** không bao giờ được báo là verification success: `timeout-minutes` của job phải lớn hơn ngân sách xấu nhất của retry + các bước bắt buộc, và khi đã deploy thì timeout phải là failure chứ không phải im lặng.

**Re-run cùng version là idempotent, và idempotent nghĩa là _trạng thái trên remote không đổi_, không phải _không làm gì_:**

| Trạng thái remote khi rerun                                                   | Hành động                                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tag trỏ đúng candidate, chưa có release                                       | Deploy → smoke → tạo draft → publish                                                                           |
| Tag trỏ đúng candidate, đã có draft (smoke fail lần trước, hoặc POST timeout) | Deploy → smoke → **tìm lại chính draft đó** qua danh sách releases → publish; không tạo bản thứ hai            |
| Tag trỏ đúng candidate, release đã publish                                    | Deploy → smoke lại → `already-published` ở bước publish (không tạo release thứ hai, không unpublish)           |
| Tag trỏ **SHA khác**                                                          | Fail **trước** Wrangler. Tag không bao giờ bị di chuyển để khớp, `target_commitish` không phải đường "sửa" tag |
| API timeout sau khi mutation có thể đã thành công                             | Reconcile: đọc lại ref / quét lại releases. **Không** retry mù — xem bảng dưới                                 |

Hai promotion chạy đồng thời cho cùng version: `concurrency.group` của workflow không cancel-in-progress nên chúng xếp hàng; nếu vẫn đua (dispatch ở hai nơi), run đọc tag sau sẽ thấy tag đúng candidate và reuse — trạng thái đích giống nhau.

Không đường fail nào xoá tag, xoá release, di chuyển tag, hay hạ một release đã public.

**Ranh giới release:** release độc lập theo deploy unit — release `home` không kéo release unit khác; `nx affected` quyết định unit nào đi qua pipeline. Publish của Nx Release không dùng cho app/service — deploy là job riêng chạy `wrangler deploy`, sinh Worker version bất biến (`04` WV1); GitHub Release publish của làn promotion là identity release, không phải cơ chế deploy.

### 7.3 Đồng bộ staging với release commit

Việc merge Release PR thêm commit version/changelog vào `main`, nên **SHA của release commit là SHA mới, chưa từng chạy staging trước khi merge**. Nếu bỏ qua điểm này, production có thể deploy một revision chưa từng chạy staging — vi phạm promotion gate.

Yêu cầu kiến trúc:

- Production workflow **không** chạy trên một SHA trừ khi **đúng SHA đó** có bằng chứng staging verification. Nguồn sự thật của bằng chứng phải là durable state (commit status gắn SHA), không phải suy luận "commit cha đã pass".
- Việc Release PR chỉ thêm metadata version/changelog (tree content của bản build không đổi) **không** tự thỏa yêu cầu trên — bằng chứng vẫn phải gắn với exact release SHA.

Cơ chế `home`: release commit nằm trong tập affected của unit (nó thay `package.json` + CHANGELOG), nên sau squash merge, làn staging tự deploy **chính SHA release commit**, chạy smoke và ghi `release/staging-verified/<slug>` trên SHA đó — việc merge Release PR tự nó được staging-verify, không cần thao tác tay. Làn staging không tạo tag; promotion gate kiểm evidence gắn exact SHA (không phải quy trình kỷ luật) trước khi cho phép Phase C–D. Gate **không** được bỏ qua bằng lập luận "Release PR chỉ đổi metadata" (§7.3 bullet 2).

**Hợp đồng của Release PR (Phase B):**

- **Allowlist file.** Release PR chỉ được đổi manifest + changelog của đúng những project trong batch — danh sách **suy ra từ plan** (`releasePrAllowedFiles` trong `release-allowlist.ts`, không còn hằng số cứng), có test khoá chính xác danh sách. Runner **fail closed** nếu `nx release` (hoặc môi trường của nó) sinh ra file ngoài danh sách đó. Đây không phải bộ lọc: file lạ làm dừng cả run, vì những file đó được đưa vào release commit bằng App token `contents: write` mà không có checkpoint nào soi tới. Mở rộng hợp đồng là một quyết định kiến trúc được review, không phải phụ lục. Đối xứng một nửa: thiếu **manifest** của project trong batch cũng dừng run (release không đổi version là không phải release); thiếu **changelog** chỉ là warning — `nx release` có lý do chính đáng bỏ qua nó ("No changes were detected for changelogs") và PR body có đường dự phòng.
- **Không có race nào ghi đè branch mù.** Branch release được trỏ bằng REST `PATCH /git/refs` với `force: true` (bắt buộc: commit luôn dựng lại từ `origin/main` nên luôn non-fast-forward), và **không** có compare-and-swap nào được bảo đảm cho endpoint đó — `previous_commit_sha` không thuộc `PATCH /git/refs` và không được mô tả là tương đương `--force-with-lease`. Chốt chặn thật là **đọc lại ref ngay trước `PATCH`** và so với SHA đã đọc; lệch thì throw, run fail, PR cũ giữ nguyên. Đánh đổi: một re-run thủ công chậm hơn một lần ghi đè mù quáng, và nó không bao giờ xoá mất commit release của run đã commit.
- **Chữ ký được kiểm trước khi trỏ branch.** Runner đọc `verification.reason` từ response `POST /git/commits` và dừng nếu không phải `valid`.
- **Idempotency và ambiguity.** Đã có tag release → fail (re-release là lỗi vận hành, không phải thao tác lặp vô hại). Nhiều PR mở cùng head branch → fail closed. 404 khi tra branch là "chưa tồn tại", còn lỗi API khác phải nổi lên — nuốt 403/500 thành "chưa có branch" biến một sự cố thành lần ghi đè không kiểm soát.

### 7.4 Yêu cầu triển khai hai làn

Workflow `staging.yaml` và `production.yaml` là hiện thực hoá của phần này cho **mọi** deploy unit; các bullet dưới đây mô tả hợp đồng mà cả hai workflow cùng tuân theo. Khác biệt cấu trúc duy nhất giữa hai làn: staging chạy **matrix** theo deploy unit (một push main deploy tất cả các đơn vị bị affected, và mỗi đơn vị có Environment riêng nên chạy song song), còn production là `workflow_dispatch` với **một** project + version — promotion là hành động có chủ đích của một người, và matrix ở đó nghĩa là một quyết định nhân lên N Worker mỗi cái một approval.

**Staging (tự động khi merge `main`, per-unit theo `nx affected`):**

- Trigger `workflow_run` sau CI (`workflows: [CI]`, `branches: [main]`, chỉ nhận `conclusion: success`); mọi quyết định SHA đọc `workflow_run.head_sha` qua env, không bao giờ `github.sha`.
- `workflow_run` là trigger **privileged**, nên `ref:` của `actions/checkout` không bao giờ lấy từ head của event — semgrep rule `workflow-privileged-trigger-untrusted-head-checkout` chặn đúng shape pwn-request đó và yêu cầu an toàn là thuộc tính của YAML chứ không phải của người đọc. Job `audit` vì thế checkout **base ref tường minh** (`github.event.repository.default_branch`); nó chỉ cần một `nx.json`/`wrangler.jsonc` hợp lệ để quyết định ma trận, và chạy trước cổng Environment với `contents: read`, không secret. `head_sha` chỉ là `ref:` ở `context` và `build`, sau khi `context` đã kiểm conclusion, event `push`, branch `main`, định dạng SHA và ancestry trên `origin/main` — tức **cây được deploy luôn là SHA đã qua kiểm**, kể cả khi main đã tiến thêm commit giữa lúc chờ queue.
- Build đúng revision merge trong job **không secret**, upload artifact kèm `build-manifest.json` (SHA + version + worker name); job deploy chỉ dùng artifact khớp manifest của run mình.
- Deploy lên Worker identity staging (`stg-ecoma-home`, cấu hình env `staging` của `apps/home/wrangler.jsonc`) với org secret `ECOMA_CLOUDFLARE_API_TOKEN` **dùng chung cho cả hai lane**, map vào `CLOUDFLARE_API_TOKEN` **chỉ ở job deploy**, dưới GitHub Environment `staging-home`. Token đó đủ quyền cho mọi Worker của pipeline nên **không** phải là ranh giới: ranh giới là Worker identity tách biệt + `--env staging` tường minh (§6.12).
- Smoke test HTTP thật sau deploy (`smoke-check.ts`: redirect `/`, SSR locale, noindex header, canonical, favicon); ghi commit status `release/staging-verified/<slug>` trên exact commit SHA.
- Làn staging **không tạo tag hay GitHub Release** — workflow chỉ cần `contents: read` và không mint GitHub App token, nên không có đường nào trong lane này ghi được ref hay release; release identity là trách nhiệm của làn production promotion (Phase C2).
- Concurrency guard: `concurrency.group` không-cancel xếp hàng, cộng stale-run guard (`runner-guard.ts`) chạy lại ở **hai** thời điểm — ngay trước `wrangler deploy` và ngay trước khi ghi status — và **mỗi lượt tra lại danh sách run** (không dùng lại ảnh chụp của lượt trước), vì cửa sổ giữa deploy và ghi status trải qua smoke retry. Run nhường (`skip`) là bình thường, exit 0, không ghi status; abort là fail-closed với exit **khác 0** — abort vì tra cứu lỗi thì dừng nhưng không đụng evidence, abort vì SHA phân kỳ thật thì ghi failure. Ghi success cho revision mà edge không còn phục vụ sẽ phá bằng chứng promotion, nên run không còn mới nhất dừng ở đó mà không ghi gì.

**Production (promotion, không tự động theo `main`):**

- Chỉ chạy qua `workflow_dispatch` với input **version**; candidate release được resolve từ lịch sử `main`, KHÔNG phụ thuộc tag tồn tại trước. Job gắn Environment `production` (required reviewer, credential riêng).
- **Ref của lần dispatch phải là `main`.** `workflow_dispatch` nhận ref bất kỳ (dropdown "Use workflow from" trên UI, tham số `ref` của API) và chạy **bản workflow trên chính ref đó**, nên job `promote` — job duy nhất cầm token Cloudflare production và token GitHub App có `contents: write` + `statuses: write` — chạy code lấy từ `github.sha` của ref đó. Bước `Guard the dispatch ref` ở `gate-build` chặn trước approval, không secret, theo hai điều kiện: tên ref phải là `refs/heads/main`, và `git merge-base --is-ancestor` chứng minh SHA được dispatch nằm trong lịch sử `main`. Output của bước này (không phải `github.sha` thô) là `workflow_sha` mà `promote` checkout. Guard này chống **dispatch lầm**, không chống nhánh chưa merge có chủ ý xoá nó — ranh giới đó và các lớp ngoài repo xem §6.13.
- Fail-closed trước Wrangler: gate `evaluatePromotionGate` kiểm đủ các điều kiện liệt kê ở §7.2 (version 3 nguồn, SHA ∈ `main`, tag không trỏ lệch, staging evidence của chính SHA).
- Production build từ chính release commit (checkout detached rồi build); `wrangler.jsonc` của **cùng revision** được đóng gói cùng artifact và verify bằng hash trong manifest — job deploy không bao giờ đọc config từ checkout `main` của nó (config và artifact phải cùng SHA).
- **Tag và draft được tạo TRƯỚC production deploy** (Phase C2), publish **SAU** smoke pass (Phase D) — xem khối vòng đời ở §7.2. Lý do: mọi mâu thuẫn về release identity (tag trỏ SHA khác, draft neo revision khác, hai release cùng tag) bị phát hiện trước khi Worker production bị đổi. **Tạo tag không có nghĩa là release đã công khai** — draft không phục vụ ai cho tới khi publish.
- Tag là **ref riêng**, tạo tường minh bằng `POST /git/refs` (không phải side effect của `POST /releases` — endpoint release sẽ tự sinh tag nếu tag chưa có, tức biến "tạo release" thành mutation tag không có bước verify riêng), rồi **đọc lại ref** để xác minh nó trỏ đúng candidate. Pipeline tạo **tag lightweight** (`POST /git/refs` với object type `commit`); khi đọc tag annotated, commit SHA phải peel qua `GET /git/tags/{sha}` mới so được — đừng gọi nó là annotated.
- Draft release tìm qua **danh sách** releases (`GET /releases`) khớp chính xác `tag_name`, không dựa vào `GET /releases/tags/{tag}` vì endpoint đó **không trả draft** — phân biệt bằng nó sẽ tạo draft thứ hai cho cùng một tag ở mỗi lần rerun. Nhiều hơn một release cùng tag là trạng thái **ambiguous** → fail closed, không đoán.
- Không `git push` tag từ runner: GITHUB_TOKEN không có quyền `workflows` nên push một tag có lịch sử chứa commit chạm `.github/workflows/` bị GitHub từ chối (run 38208354618).
- Mã orchestration của job `promote` checkout theo **workflow-run SHA**, không phải `main` di động: một merge vào `main` trong lúc job chờ approval sẽ thay script đang chạy dưới chân nó.
- Quyền ghi (`contents: write` cho tag + release, `statuses: write` cho evidence) chỉ nằm ở job sau approval, qua **GitHub App token scope đúng một repository** (`repositories: ${{ github.repository }}` — khai `owner` một mình làm action cấp token cho _toàn bộ_ repository trong installation, xem README của `actions/create-github-app-token`); job gate-build không ghi được gì. Cloudflare token (`ECOMA_CLOUDFLARE_API_TOKEN`, dùng chung cho cả hai lane — §6.12) cũng chỉ được inject ở job sau approval. Pipeline không push ref nào từ runner (tag do REST API tạo); nếu sau này có `git push` thủ tục khác, phải chạy với hooks vô hiệu (`core.hooksPath=/dev/null`) — runner có `pnpm install`, lefthook pre-push sẽ giết push thường.
- Post-deploy verification **sau khi deploy xong**; kết quả ghi commit status `release/production-verified/<slug>`. **Không auto-rollback** (§8).
- Staging và production là hai Worker identity tách biệt (`stg-ecoma-home` / `ecoma-home`) **và hai credential tách biệt**; production được deploy lại từ đúng source revision đã verify với env `production` của Wrangler — không có promote xuyên identity.

Hai làn deploy application tách biệt với provisioning infrastructure: infrastructure thay đổi qua Pulumi project trong `deploys/` (§7.4.1); một release application **không** chạy `pulumi up`. **Hiện trạng:** làn infrastructure có một đường apply tường minh cho local platform (Nx target `local-up`/`local-down` của từng deploy project, chỉ chạm hạ tầng local trên máy developer — không có workflow CI nào chạy `pulumi up`); còn staging/production chưa có đường provision nào, nên trên cây hiện tại hai làn cho environment thật **chưa tách biệt vì phía environment thật chưa có đường nào chạy**; §9.1 là hợp đồng đã chốt, phần hiện thực thuộc phase sau.

#### Retry quanh `wrangler deploy`

Cả hai làn đều bọc `wrangler deploy` trong một lớp retry backoff (`tools/delivery/src/wrangler-deploy.ts`): tối đa **3 lần thử**, backoff 15s rồi 30s, trần 4 phút mỗi lần thử. Retry **chỉ** khi phân loại được là lỗi tạm thời — HTTP 5xx/429, `Received a malformed response from the API`, và lớp lỗi transport của undici/socket (`fetch failed`, `SocketError: other side closed`, `socket hang up`, `ECONNRESET`, `ETIMEDOUT`…). Lỗi cấu hình hoặc quyền (`403`, `401`, thiếu biến môi trường, config sai) abort **ngay lần thử đầu**: thử lại chỉ che mất nguyên nhân thật và thêm phút chờ vô nghĩa.

Điều kiện để retry là đường lỗi nằm ngoài state mà lần thử lại có thể làm hỏng. Cloudflare API đã quan sát thật là trả `504` kèm body HTML hoặc đóng socket giữa chừng, trên **cả hai** Worker của cùng account (hai làn cùng định danh account qua org-level secret, §6). Wrangler chỉ trả exit 0 khi deployment đã được trỏ sang version vừa upload, nên một lần thử lại chỉ ghi đè bằng đúng version của cùng artifact — Worker đang phục vụ không bị để lại ở trạng thái dở dang.

Retry **không** nới lỏng đường fail-closed: hết lần thử (hoặc gặp lỗi không tạm thời) thì call-site đi đúng đường failure cũ — ghi `release/staging-verified/<slug>` / `release/production-verified/<slug>` = failure kèm run URL rồi exit 1, không đụng tag hay release. `timeout-minutes` của job phải lớn hơn ngân sách xấu nhất của retry, và quan hệ đó có test chốt lại: job chết giữa chừng không ghi status failure thì fail-closed **theo đường sai**. Ngân sách này loại trừ `github-run.ts` — GitHub API call giữ nguyên không retry, vì nguyên tắc fail-closed đứng trên việc nuốt lỗi thoảng qua (xem header của file đó).

#### 7.4.1 Pulumi stack & lifecycle strategy

**Hiện trạng — nhóm deployment ở `deploys/`:** 13 Pulumi project (`platform-deploy` + 12 project theo deploy unit), mỗi
project là `Pulumi.yaml` (`runtime: nodejs`) + một `index.ts`. 11 project có lane local: `platform-deploy` và `home-deploy`
hiện thực **local platform** (managed resource thật: network, Traefik, PostgreSQL, container home), các `<unit>-deploy` còn
lại mang lane riêng với resource container và/hoặc command migration thật; lifecycle local điều phối qua Nx target
`local-up`/`local-down` của từng deploy project trên máy developer — chi tiết ở `architecture/local-development/`. Hai
project job-deploy (`transactional-mailer-job-deploy`, `web-push-notification-job-deploy`) chỉ log, không có target local
và mang marker `ecoma.deployment.status: scaffold`. `platform-deploy` là tầng platform prerequisite mà mọi `<unit>-deploy`
khai là phụ thuộc; **chưa có workflow CI nào chạy Pulumi** — resource thật chỉ được tạo/sửa qua lệnh local tường minh,
không qua đường release.

> **Hai điều đã chốt trước đây, nay không còn hiện thực trong repo.** Contract bootstrap state backend của Phase 2A —
> Nx project `ecoma-infra` tại `tools/infra`, gồm contract module kiểm URL state backend + stack + provider + ownership,
> script `verify-local`, và test CLI pin trên stack `file://` — **đã bị gỡ khỏi repo** cùng toàn bộ CD. Các quyết định mà nó
> hiện thực (stack `local`/`staging`/`production`, contract từ chối tổ hợp stack↔backend sai, `PULUMI_CONFIG_PASSPHRASE` là
> secrets provider mặc định trên DIY backend) được giữ lại dưới đây làm **hợp đồng đã chốt**, không phải mô tả code đang
> tồn tại. Stack group đơn `ecoma-infra` **không** còn là hình hài hiện tại: nhóm `deploys/` chia theo deploy unit.
>
> Phạm vi hiện thực của resource thật: **chỉ local** — mỗi worktree một bộ (network, Traefik, PostgreSQL, container home),
> lifecycle local điều phối qua Nx target `local-up`/`local-down` của từng deploy project, không qua đường release nào. `deploys/platform-deploy` **đang** khai tài
> nguyên dùng chung trong phạm vi đó. Hình thái stack này **lệch có chủ đích** với hợp đồng stack `local` dùng một lần ở
> dưới — chi tiết và lý do ở `architecture/local-development/README.md`. Vì vậy hai claim "`hiện chưa có stack thật`" và "`local`
> _không chạm tài nguyên thật_" ở đoạn **Stack grouping** dưới đây chỉ còn đúng cho **staging/production** — chúng
> không mô tả local platform. Staging/production vẫn chưa có resource nào.

**Chọn stack theo ownership, không theo Nx project.** Tiêu chí grouping: (1) ownership/lifecycle của resource; (2) shared
dependencies; (3) required environment isolation; (4) blast radius; (5) stateful data risk; (6) need for independent
approval/reconciliation/recovery. Không một stack cho mỗi Nx project by default; không một giant stack couples unrelated
apps hay puts DBs at mercy of routine app release.

**Conceptual categories (tiêu chí phân loại; local platform hiện khai ba trong số này — Shared/platform resources, Stateful DB/platform infra và Environment-specific infra (image + container home của `home-deploy` chỉ thuộc local) — nhưng CHỈ trên môi trường local; staging/production chưa khai category nào):**

- **Bootstrap prerequisites** — state backend + credential/passphrase. Phải tồn tại _trước_ ordinary stacks; tạo bằng mechanism bên ngoài backend được tạo, hoặc bootstrap backend/stack riêng. Idempotent hoặc detect already-initialized.
- **Shared/platform resources** — resources có genuinely shared lifecycle (DNS zone, Access, org-level config).
- **Environment-specific infra** — resource chỉ thuộc một environment (staging D1/KV/Queue/Hyperdrive).
- **Stateful DB/platform infra** — PostgreSQL host + cluster + roles; cần independent protection, không được routine app promotion approve.
- **Optional Preview-specific resources** — chỉ khi true isolation warrants.

**Stack grouping — hợp đồng đã chốt, hiện chưa có stack thật.** Tên stack là **`local`/`staging`/`production`**; `local` chỉ
để xác minh cục bộ, không phải environment. `local` **không** phải môi trường: nó là stack dùng một lần trên backend `file://`
để chạy contract/end-to-end mà không chạm tài nguyên thật, và contract từ chối mọi tổ hợp stack↔backend khác (local chỉ đi
với `file://`, staging/production chỉ đi với `s3://`). Mỗi stack thật (`staging`, `production`) có một bucket R2 state, một
credential và một passphrase riêng. **Còn chưa quyết:** số stack và cách ánh xạ stack → project `deploys/`. Layout hiện tại
chia theo **deploy unit** (mỗi `<unit>-deploy` một project) với `platform-deploy` cho tài nguyên dùng chung, nên stack
split theo unit hay theo environment lại là một quyết định chưa chốt — state backend thật (bucket R2) và credential
**chưa tồn tại** vì chúng là bootstrap prerequisite, không phải thứ stack tự tạo (§9.1 nguyên tắc 4). Ngoài ba category
local platform đã khai (nêu trên), các conceptual category còn lại **chưa** có resource nào được khai báo.

**Bootstrap contract (không circular):**

- State backend + credentials/passphrase phải tồn tại _trước_ ordinary stacks run.
- First creation dùng bootstrap mechanism **ngoài** backend được tạo (vd: bootstrap backend/stack riêng, hoặc provisioning thủ công có document), không phải stack tự tạo backend của chính nó.
- Ordinary app infra stacks **không** được recursively create/destroy state backend của chúng.
- State access credentials + encryption/passphrase material **không** commit vào Git, **không** exposed đến untrusted PR jobs.
- Recovery/backup/access control là operational concerns, không phải stack responsibility.
- **Đã chốt — `PULUMI_CONFIG_PASSPHRASE`:** đây là **state access + encryption material**, không phải một cấu hình của stack, và trên DIY backend (`file://`, `s3://`) nó là secrets provider **mặc định** — không có service-managed encryption. Chi tiết platform (đã verify, kèm nguồn) ở `04` §2.16. Hệ quả bắt buộc cho delivery:
  - Hai biến `PULUMI_CONFIG_PASSPHRASE` / `PULUMI_CONFIG_PASSPHRASE_FILE` là **bắt buộc theo từng lệnh, không phải ở mọi lệnh**: bắt buộc ở `stack init` và ở mọi lệnh nạp stack config (`preview`, `up`), kể cả trên stack chưa có secret nào — thiếu thì CLI exit 1 (`04` PU4). **Không** bắt buộc ở `pulumi login` và ở `pulumi stack export` không `--show-secrets` (`04` PU5). Vì thế không có đường "chạy tạm mà không cần passphrase", nhưng có đường phục hồi không cần passphrase — và chính đường đó là lý do hai lệnh cuối không bị bắt buộc.
  - **Mất passphrase là mất vĩnh viễn plaintext của mọi secret**, nhưng **vẫn** `stack export` được inventory resource (`04` PU5). Credential này vì thế thuộc bản sao offline ngoài VPS (`03` §3.5), **không bao giờ** vào Git hay job PR không tin cậy.
  - ⚠️ **Cấm rotate passphrase bằng `stack change-secrets-provider` không tương tác:** ngoài TTY đường đó nhận chuỗi rỗng và **đặt passphrase thành rỗng với exit 0** (`04` PU6) — một đường fail-open. Rotate chỉ chạy từ TTY, và sau khi rotate phải chứng minh passphrase cũ không còn giải mã được và passphrase mới **khác rỗng**.
  - Vị trí lưu thật (GitHub Environment secret của đúng stack, hoặc file do job được bảo vệ ghi ra) chưa cấu hình — thuộc prerequisite ở §12.

**Bootstrap contract — đã chốt, hiện KHÔNG có code hiện thực (contract của Phase 2A đã bị gỡ cùng CD):**

- Backend state cho mỗi environment thật đến từ **biến môi trường ngoài repo** `ECOMA_PULUMI_STATE_URL_<ENVIRONMENT>` (đúng một biến cho một environment); URL phải là `s3://` trỏ Cloudflare R2, có `endpoint`, `region`, và **`s3ForcePathStyle=true`** — Pulumi mặc định địa chỉ hoá virtual-hosted, còn R2 chỉ công bố endpoint dạng account/path-style (`04` R22, PU9). Sai một trong các điều kiện đó thì contract **từ chối chạy**, không đoán.
- Vì backend phải tồn tại **trước**, việc tạo nó tách thành hai credential **khác loại**: token Cloudflare API quyền `Workers R2 Storage Write` (cấp account, chỉ dùng một lần để tạo bucket — `04` R24) và R2 token quyền **Object Read & Write** scope theo **đúng một bucket** để đọc/ghi state (`04` R23). Credential thứ nhất **không** được sống lâu dài như secret của workflow.
- Thứ tự bootstrap một lần: tạo bucket → phát hành R2 token bucket-scoped → `pulumi login s3://...` → `pulumi stack init` với passphrase set → huỷ token cấp account. `pulumi login` idempotent nên chạy lại an toàn (`04` PU11).
- State **không** được commit: `.gitignore` chặn `.pulumi/` và `Pulumi.*.yaml`; secret nằm trong `Pulumi.<stack>.yaml` dưới dạng ciphertext.
- Backup + access control + phục hồi (kể cả lock treo, passphrase mất, đổi credential) là **runbook vận hành**, và runbook đó **chưa tồn tại**: `tools/infra/README.md` đã bị gỡ khỏi repo cùng CD, và `deploys/` chưa có README tương ứng. Chính sách backup → `03` §3.1, credential bootstrap → `03` §3.5; viết runbook là việc còn lại, không phải trích dẫn được.

**Reconciliation execution contract — hợp đồng đã chốt, chưa hiện thực (không workflow nào chạy Pulumi):**

- Resolve exact env+stack cho affected deploy units.
- Mỗi required stack reconciled **at most once** per orchestration run, trừ khi dependency demands otherwise.
- Generate và inspect preview/plan **trước** apply; apply theo env policy.
- Block/require approval cho destructive changes đến stateful/shared production resources.
- Validate outputs, connectivity, access _sau_ apply.
- Run migrations **only sau** infra ready; deploy **only sau** infra + required migrations pass.
- Record evidence correlating stack changes với app deployment.
- **A resource ID is not proof of readiness** — PG prerequisite cần connectivity + correct DB/role permissions + environment isolation verified.

**Prerequisite trên project graph không tự ra thứ tự chạy.** Việc mỗi `deploys/<unit>-deploy` khai phụ thuộc `platform-deploy`
là một **constraint cấu trúc** trên Nx project graph: nó cho biết cái gì phụ thuộc cái gì và là điều kiện để kiểm được
trước khi apply. Nó **không** sắp thứ tự `pulumi up` giữa các stack — thứ tự thực thi, approval, và số stack được
reconcile trong một lần chạy là execution contract ở danh sách trên. Đừng đọc quan hệ project graph thành một cam kết
về thứ tự. Ranh giới ở tầng code → `05-code-architecture.md` §2.1.

#### 7.4.2 Tool boundary — điều gì không được làm

- **GHA** là **caller**, không phải owner: coordinates dependencies/credentials/approvals/gates/concurrency/evidence/order, calls the tools. GHA không phải source of truth cho resource IDs; **không** expose infra secrets đến untrusted build/test steps.
- **Nx** là project graph + affected + release/version/changelog; **không** provisioning infra. A build target ≠ deployable (§7.5 bullet 1).
- **Wrangler** là app deployment tool: Worker versions, named env, Worker Secrets, D1 migration execution via explicit step. Wrangler **không** compete cho infra lifecycle; không tự tạo/xoá D1/KV/R2/Queue/Hyperdrive/Access/DNS.
- **Pulumi** là infra lifecycle owner; **không** deploy Worker, **không** migrate app schema, **không** run as side effect của app release.
- **Migration runner** là CI job; **không** create role/cluster, **không** qua Hyperdrive.

#### 7.4.3 Cổng deploy duy nhất cho đường chạy trực tiếp

> ⚠️ **Toàn bộ mục này mô tả thiết kế của pipeline hai làn (§7.2) chưa hiện thực.** `tools/delivery/` và file
> `deploy-gate.mts` chưa từng tồn tại trên `main`. Trước Phase 3 của deployment graph normalization (#216), 7 app
> (`account`, `backoffice`, `home`, `push-notification`, `transactional-mail`, `transactional-mailer-job`,
> `web-push-notification-job`) mang nx target `deploy` trỏ vào cổng không tồn tại đó — dangling, không caller nào
> trong CI; các target đã bị **xóa** trong Phase 3, nên đường deploy trực tiếp hiện **không có** trong repo. Phần
> dưới giữ nguyên như thiết kế, để hiện thực tương lai có hợp đồng để bám.

Hai làn workflow ở §7.4 là đường deploy **được duyệt**. Cạnh chúng, mỗi app trước đây còn một đường thứ hai: target `deploy` của Nx tự gọi `npx wrangler deploy`. Đường đó đi vòng qua toàn bộ vòng đời release/promotion — không bằng chứng staging, không kiểm release identity, không cổng Environment — và cổng Environment của `production.yaml` **không** áp cho một process chạy trên máy người dùng, nơi `CLOUDFLARE_API_TOKEN` là token của chính người chạy. §3 xử lý đường đó bằng cách **tập trung** nó vào một cổng duy nhất thay vì để một bản sao yếu hơn tồn tại song song.

**Mọi** app có `wrangler.jsonc` và target `deploy` đều trỏ target đó vào `tools/delivery/src/deploy-gate.mts`; repo **không còn** một lời gọi `wrangler deploy` nào trong `apps/<slug>/package.json` (trước Phase 3 của #216: 7 app có target `deploy`). Cổng:

- **Không tự suy project hay lane.** `--project` và `--lane` là tham số **bắt buộc**; thiếu hoặc sai chính tả là `problem` chặn, không có giá trị mặc định. Lý do: `wrangler deploy` không kèm `--env` deploy **top-level Worker name**, mà top-level name của mọi app trong repo này là Worker production — một mặc định "tiện" ở đây chính là đường ghi đè production.
- **Từ chối project không `releaseable`**, kể cả khi người gọi truyền đúng tên project đó. Project phải được khai **đồng thời** trong `nx.json release.projects` và `tools/delivery/config/deploy-eligibility.jsonc`; khai một phía là `problem` (`compareReleaseDeclarations`), nên "thêm vào một danh sách rồi quên danh sách kia" không im lặng đi qua.
- **Từ chối `production` thẳng thắn**, kèm chỉ dẫn tới vòng đời promotion. Đây là lựa chọn "tắt đường cho tới khi có đủ điều kiện" của §2, **không** phải bản sao yếu hơn của cổng promotion: cổng promotion có bằng chứng staging, release identity và Environment approval — ba thứ một process trên máy người dùng không thể tự cấp.
- **Chạy lại đúng các lớp audit** trên **chính** unit được yêu cầu (readiness của lane, provenance định danh binding, sở hữu Queue/DLQ), nên đường trực tiếp không bỏ qua lớp nào.
- **Chỉ gọi Wrangler qua `runWranglerDeployWithRetry`** (`wrangler-deploy.ts`), nên hai cờ tắt auto-provisioning có mặt ở **mọi** lần thử, kể cả lần thử lại — không có nhánh nào nối cờ ở lần thử đầu rồi bỏ ở lần sau.
- **Không đệ quy**: cổng gọi thẳng `wrangler deploy`, không gọi lại một Nx target nào, nên không có vòng "runner gọi target gọi lại runner".
- **Fail closed khi không đọc nổi** `nx.json`/`deploy-eligibility.jsonc` — thông điệp nói rõ "no deploy may be allowed", không bao giờ im lặng cho qua.

`forwardAllArgs: false` trên target là **bắt buộc**, không phải trang trí: `nx:run-commands` nối argv của người gọi vào cuối `command`, nên để mặc định thì `nx deploy <project> -- --lane production` có thể chèn lane mà target không hề khai. Command mặc định cố ý **không** mang `--lane` (để gọi trần là bị từ chối), còn configuration `staging`/`production` mỗi cái pin **đúng một** lane.

Hợp đồng này được chốt bằng test **hành vi**, không phải bằng grep chuỗi: `deploy-metadata.spec.ts` khoá cổng + `forwardAllArgs: false` + luật "đúng một lane mỗi configuration" trên **mọi** app có `wrangler.jsonc`, và khẳng định repo **không** còn invocation `wrangler deploy` trần nào; `deploy-gate.spec.ts` chạy cổng thật với `CLOUDFLARE_API_TOKEN` rỗng và chốt thứ tự gọi — từ chối trước khi chạm credential, dừng đúng ở bước kiểm token khi mọi thứ khác hợp lệ. Các test và file mà câu trên nhắc tới đều thuộc `tools/delivery/` **chưa hiện thực** — câu đó mô tả hợp đồng mà hiện thực tương lai phải kèm theo, không phải bằng chứng đang có trong repo.

**Ma trận đường deploy — đường nào được phép, đường nào bị chặn.** Đây là bảng trạng thái **hiện tại** của repo, không phải mục tiêu; mỗi dòng từ chối là một đường **cố ý** tắt, không phải một đường hỏng chưa kịp sửa.

| Đường deploy                                                                                                                   | Trạng thái              | Điều kiện / lý do                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging.yaml` (matrix per-unit, tự động theo `main`)                                                                          | **Được phép**           | audit không secret → cổng Environment `staging-<slug>` → deploy qua helper                                                                                                                        |
| `production.yaml` (`workflow_dispatch` với **version**)                                                                        | **Được phép**           | đủ điều kiện §7.2 (version ba nguồn, SHA ∈ `main`, tag không trỏ lệch, staging evidence của chính SHA) + approval `production-<slug>`; ref dispatch phải là `main`                                |
| `nx deploy <project> --configuration=staging`                                                                                  | **Được phép, qua cổng** | project `releaseable`, `--lane` tường minh, `unitProblems` rỗng, `CLOUDFLARE_API_TOKEN` được đặt — và gọi helper nên có đủ hai cờ                                                                 |
| `nx deploy <project>` (lệnh trần, không `--lane`)                                                                              | **Bị từ chối**          | lane là tham số bắt buộc; không có lane mặc định vì `wrangler deploy` thiếu `--env` sẽ nhắm top-level Worker name                                                                                 |
| `nx deploy <project> --lane production`                                                                                        | **Bị từ chối**          | production chỉ qua vòng đời promotion — bằng chứng staging, release identity và Environment approval là ba thứ một process trên máy người dùng không tự cấp                                       |
| `nx deploy` cho 20 project `excluded`                                                                                          | **Bị từ chối**          | lý do **theo từng project** nằm trong `deploy-eligibility.jsonc` (5 Worker chưa khai `env.<lane>`; `account`/`backoffice` có lane nhưng `devOrigin` là placeholder; số còn lại không phải Worker) |
| Bốn Worker khai Queue/DLQ (`transactional-mail`, `transactional-mailer-job`, `push-notification`, `web-push-notification-job`) | **Bị chặn**             | nằm trong nhóm `excluded` ở trên (chưa khai lane) **và** không được đưa vào `releaseable` chừng nào chưa xác minh **tồn tại** của Queue/DLQ (§12) — cổng từ chối mọi project không `releaseable`  |

Hai dòng cuối là phần §2 yêu cầu "nếu đường an toàn duy nhất là tắt đi cho tới khi có điều kiện trước thì hãy cho nó **từ chối một cách tường minh**": không có dòng nào ở trên được sửa bằng cách gán cho một project trạng thái `releaseable` chỉ để ma trận xanh.

---

---

## 8. Rollback

| Đối tượng                 | Cách rollback                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker (mọi unit)         | Rollback về version đã build/verify, không rebuild (`04` WV2 — chỉ 100 version gần nhất). Rollback `cache` **không** purge cache artifacts |
| Dữ liệu                   | **Không rollback mặc định.** Expand → compatible rollout → quan sát rollback window → contract; forward-fix                                |
| Mất dữ liệu/sự cố hạ tầng | Restore PITR theo runbook có audit (`03`) — đây là DR, không phải application rollback                                                     |

Không có đường rollback nào đi qua migration: rollback Worker **không bao giờ** rollback database (`01` invariant 11).

**Khi post-deploy verification production fail (§7.2, §7.4), hành vi tối thiểu bắt buộc:**

1. Ghi release/deployment đó là **failed** trong provenance, kèm toàn bộ kết quả verification — không ghi đè, không xoá.
2. Trigger procedure incident/failure đã cấu hình (`03` §9) — không dựng hệ thống incident riêng cho delivery.
3. Rollback là **controlled, không tự động**: trả về Worker version trước đó chỉ theo quyết định có chủ đích của người vận hành, dựa trên provenance; policy rollback tự động (nếu có) phải được chốt tường minh, không mặc định.

**Application rollback** là quay về Worker version đã publish, đã verify — không build lại từ source tree có thể đã đổi (`04` WV1–WV3). Với release production, version cần rollback tới là version của revision trước đó trong provenance (§7.2). Cơ chế rollback giữa hai Worker identity staging/production **chưa xác minh** — cùng yêu cầu xác minh với cơ chế deploy (§7.4, §12).

**Infrastructure rollback** là bài toán khác: phụ thuộc resource type và Pulumi state, xử lý độc lập với application rollback — không có cơ chế chung; runbook riêng khi có (→ `03`).

### 7.5 Hành vi đã hiện thực khi có nhiều deploy unit

Phần này mô tả **hành vi đang chạy**, không phải thiết kế dự kiến. Nguồn: `tools/delivery/src/` và test tương ứng.

**1. Nx là nguồn của sự thật, và không có danh sách viết tay.** Danh sách deploy unit của lane staging do job `audit` sinh ra (`deploy-unit-audit.mts`): nó đọc `nx.json` `release.projects` bằng bộ đọc JSONC của chính repo, đọc Nx graph bằng `nx show projects`, rồi lấy **giao** của hai tập. `nx.json` là JSONC có comment giải thích chính sách, nên không đọc bằng `JSON.parse`; và không nhân bản bộ đọc JSONC ra chỗ thứ hai — bản sao thứ hai của parser là nơi chúng lệch nhau. Trước Issue #166 tên `@ecoma-io/home` xuất hiện ở sáu chỗ của workflow, và mỗi chỗ sót là một cách deploy sai.

**2. Audit chỉ còn lỗi chặn — không còn "cảnh báo" về project chưa phân loại.** Trước đây một deploy unit có `wrangler.jsonc` mà chưa khai trong `release.projects` chỉ được in ra log. Nay mỗi Nx project phải ở đúng một trong ba trạng thái trong `tools/delivery/config/deploy-eligibility.jsonc`: `releaseable`, `excluded` (bắt buộc có lý do riêng cho từng project), hoặc **chưa phân loại** → lỗi chặn. Lý do thay đổi: một project nên release mà không ai khai thì bị pipeline bỏ sót trong im lặng, và "không ai nhớ" là trạng thái mặc định duy nhất mà không ai phải trả lời. Chi tiết và bảng project `excluded` ở §7.2.

Các lỗi **chặn** còn lại (workflow đỏ trước cổng Environment, chưa dùng credential nào): project được khai trong `release.projects` mà Nx graph không có; hai project suy ra cùng slug — chúng dùng chung một Environment nên approval của project A sẽ phủ cho deploy Worker của project B; tên không suy ra được slug an toàn; `releaseable` lệch với `release.projects` của `nx.json`.

**3. Mỗi deploy unit giữ version, changelog, tag, Release, evidence và Environment riêng.** Quan hệ `independent` trong `nx.json`; tag theo `{projectName}@{version}` nên tag của hai project không bao giờ lẫn nhau (`@ecoma-io/home@0.0.6` là tag duy nhất hiện có). Commit status context là `release/staging-verified/<slug>` và `release/production-verified/<slug>`, và **gate tự tính** context từ project của candidate — nên evidence của project này không thể được đọc cho project khác, kể cả khi hai project từng có cùng SHA.

**4. Baseline `1.0.0` là hệ quả, không phải input.** Một project chưa từng release (không có tag nào khớp `{projectName}@{version}`) được `nx release` đặt đúng `1.0.0` bằng **version specifier tường minh**, không phải bằng `--first-release`: cờ đó toàn cục và sẽ **bump** version trên đĩa (`0.0.1` → `0.0.2`) thay vì đặt baseline. Workflow vì thế **không** có input "đặt version": một input như vậy mở ra đường đặt version tùy ý cho project đã có lịch sử — thứ mâu thuẫn với các tag đã publish. Version của một project đã release là hệ quả của lịch sử conventional commits của nó. Baseline này áp cho `@ecoma-io/account` và `@ecoma-io/backoffice` **khi** chúng đủ điều kiện deploy trở lại; hiện cả hai đã rút khỏi `release.projects` nên chưa được version/tag — tag là mốc của một artifact đã lên production, không phải của một manifest đã đổi.

**Lịch sử đọc từ tag Git, không từ manifest.** `package.json` là _kết quả_ của lần release trước, nên dùng nó làm nguồn sự thật về lịch sử là dùng kết quả để đoán nguyên nhân. Lịch sử là `git ls-remote --tags origin 'refs/tags/{projectName}@*'`. Khi manifest lệch với tag mới nhất (ai đó sửa tay, hoặc một lần chạy dở dang), runner **dừng** chứ không tin một trong hai.

**Migration hẹp cho `@ecoma-io/home` — và nó không phải một cơ chế reset.** `home` đã có release thật (`0.0.6`) và lịch sử đó **giữ nguyên**: tag `@ecoma-io/home@0.0.6` và GitHub Release tương ứng không bị xoá, không bị di chuyển, không bị ghi đè bằng tag bù cho version trước. Điều duy nhất cần là cho **lần release kế tiếp của nó** đi từ `0.0.6` lên `1.0.0`.

Vì sao phải hẹp thế, và vì sao không dùng `--first-release`: `nx release major` từ `0.0.6` cho ra `0.1.0` — major của 0.x **không** chạm tới `1.0.0` — và `--first-release` thì bump từ đĩa. Đường duy nhất ra `1.0.0` là **specifier tường minh** `1.0.0`. Bản migration vì thế không là "đặt lại version cho mọi thứ", mà là: khi một project đã có lịch sử nằm dưới baseline **và** có một release thật sắp diễn ra, lần release đó dùng specifier `1.0.0` thay vì bump thường. "Dưới baseline" nghĩa là **cả hai** nguồn — highest tag **và** manifest: bump tường minh đã có thể đẩy manifest vượt `1.0.0` trong khi tag còn dưới (migration bị hoãn ở lần dispatch trước), và migration khi đó sẽ ghi manifest **xuống** `1.0.0` — hạ đúng version người vận hành đã chọn; `planBaselineMigration` chỉ trả `migrate` khi max của hai nguồn vẫn dưới baseline.

Ràng buộc quan trọng nhất của migration, và là lý do nó không trở thành một nút reset: **nó chỉ đi kèm khi đã có một release thật**. Dưới `bump=auto`, nếu dry-run không ra version cho `home` (không có conventional commit nào chạm tới nó kể từ tag cuối), thì `home` **không** vào batch và migration **không** chạy. Nếu migration chạy cả khi không có gì để release, thì mỗi lần dispatch idle sẽ publish một `1.0.0` rỗng cho một ứng dụng production đang chạy — và đó là hành vi đã bị loại bỏ có chủ đích, không phải sự cố. Khi `bump` được chỉ định tường minh (`patch`/`minor`/`major`), bump tường minh **thắng** và migration bị trì hoãn: yêu cầu cụ thể của người vận hành không bị một quy tắc baseline ghi đè.

Mọi project khác giữ SemVer/Conventional Commits thông thường; không có project nào khác được migration này chạm tới.

**5. Batch nhiều project dùng MỘT Release PR, và đó là bắt buộc.** `nx release` được gọi một lần cho mỗi project (`-p<project>`), các thay đổi gộp thành một commit có chữ ký, subject mang danh sách version của cả batch. Lý do: merge queue squash một PR thành một commit, còn evidence của promotion là một SHA — N PR sẽ tạo N SHA và câu hỏi "SHA nào đã verify" thành N câu hỏi. `release-version` của một project được đọc từ subject phải kèm **tên project** (`releaseVersionOfProject(subject, projectName)`): subject batch chứa mọi project, nên đọc không kèm tên sẽ không phân biệt được `1.0.0` của `account` với `1.0.0` của `home`.

**6. Branch thuộc về batch, không thuộc về version.** Tên branch suy ra từ **danh sách version** của batch (`buildReleaseBranchName`), và quyết định tạo/refresh PR cũng mang tính batch: nếu branch đã có PR thì **refresh** PR đó, không tạo PR thứ hai.

**7. Một Cloudflare token cho cả hai lane.** `ECOMA_CLOUDFLARE_API_TOKEN` là credential duy nhất. Không có token theo environment (`ECOMA_STAGING_...`/`ECOMA_PRODUCTION_...`) và đặc tả §2.4 cấm những tên đó. Hệ quả phải nói thẳng: token đủ quyền cho mọi Worker mà pipeline chạm, kể cả Worker production. Ranh giới nằm ở **Worker identity tách biệt** (`stg-ecoma-home` vs `ecoma-home`) và `--env` tường minh, không nằm ở credential.

**8. Mọi thông số của một deploy unit đến từ `wrangler.jsonc` của nó.** Worker name, origin, commit status context, tên Environment, slug, đường dẫn `package.json`/`CHANGELOG.md`/`.output`, và **bề mặt smoke** đều được đọc từ file đó. Trước đây chúng là các hằng số trong runner; sửa **một** trong năm hằng số cũ là promote nhầm Worker, hoặc — tệ hơn — khiến deploy của project A đọc bằng chứng của project B. `wrangler deploy` không đọc `smokeSurface`, `devOrigin` hay `productionOrigin`; chúng là thuộc tính của repo mà Wrangler bỏ qua.

**9. Bề mặt smoke khai theo từng app, và kiểm tra không áp dụng thì bị BỎ QUA chứ không thành pass giả.** `smokeSurface` trong `wrangler.jsonc` khai `defaultLocale`, `publicLocales`, `productionOrigin`, `staticAssetProbePath`. App có chiều locale (`home`) được check redirect `/` → `/{defaultLocale}`, SSR từng locale, `ssr-lang`, canonical origin, và `content-noindex` **ở staging** trên route content thuộc bề mặt static-asset. App phẳng (`account`, `backoffice`) khai `smokeSurface: {}` — không locale, không `productionOrigin`, không `staticAssetProbePath`; check còn lại là `root-status`, `root-ssr-h1`, `favicon-status`, và noindex **theo lane** (`root-noindex` ở staging vì staging phải noindex, `root-indexable` ở production). Bị **skip** trên bề mặt phẳng: redirect `/` theo locale, `ssr-lang`, canonical (không có `productionOrigin` để đối chiếu) và `content-noindex` của bề mặt static-asset (không khai `staticAssetProbePath`). Bỏ assertion theo **khả năng của app**, không theo việc app có hỏng hay không: một app phẳng mà `/` trả 502, thiếu `<h1>`, hay thiếu noindex ở staging vẫn **đỏ**. Không assertion nào bị bỏ chỉ vì nó đang đỏ. `smokeSurface` mâu thuẫn — `defaultLocale` không có trong `publicLocales` — thì fail closed lúc nạp config, trước cả khi deploy.

**10. Stale-run guard lọc theo leg của matrix, và lệch về phía "giữ".** Ba leg có cùng `head_sha` và cùng branch, chỉ khác Worker đích. Endpoint `/runs` trả `name` của **workflow** chứ không phải của job, nên lọc ở tầng event không cứu được — phải vào `/runs/{id}/jobs`. Bộ lọc **fail-open về đúng-thứ**: không xác định được leg thì giữ run. Bỏ nhầm run cạnh tranh là mất lớp bảo vệ stale-run; giữ nhầm thì chỉ tốn một lượt re-check. Guard vẫn kiểm ở **hai** thời điểm với danh sách run tra lại tại từng thời điểm (trước deploy, và trước khi ghi status).

**11. Rerun sau khi Release đã publish là hành vi bình thường, và nó phải tự hoà giải.** Tag được đọc qua `GET /git/ref/tags/*` rồi **peel** (`GET /git/tags/{sha}` cho tag annotated); draft release tìm qua **danh sách** releases có phân trang theo Link header, vì `GET /releases/tags/{tag}` không trả draft. Rerun cùng version là idempotent: tag trỏ đúng → dùng lại; draft đúng tag → publish; đã publish đúng target → không tạo bản thứ hai. Tag trỏ **chỗ khác** thì fail closed và **không bao giờ** được di chuyển.

**12. Provenance đi cùng artifact.** `wrangler.jsonc` của **đúng revision đã gate** được copy vào artifact cùng SHA-256 của nó và của `CHANGELOG.md`; job promote kiểm hash đó trước khi deploy, nên config đi kèm artifact không thể bị thay sau khi gate. Evidence chỉ được ghi **sau** smoke pass.

**13. Tag và draft tồn tại TRƯỚC production deploy, publish SAU smoke.** Mọi mâu thuẫn về release identity bị phát hiện trước khi Worker production bị đổi; và rerun sau sự cố có sẵn draft để publish thay vì tạo bản thứ hai. Draft không công khai cho tới khi smoke pass.

**14. Ranh giới branch khi promotion chờ approval được nói thẳng là không có compare-and-swap.** `PATCH /git/refs` **không có** `previous_commit_sha` — field đó thuộc `POST /git/refs` (endpoint _tạo_ ref) — và **không** phải `--force-with-lease`. Bản đầu tiên của runner vẫn gửi nó "phòng xa"; điều đó là một loại **bảo đảm giả**: GitHub bỏ qua field lạ một cách âm thầm, nên nó không thêm bảo vệ nào, chỉ khiến người đọc tin rằng đã có lease. Nay body của `PATCH` chỉ có `sha` và `force`.

Chốt chặn thật, và là chốt chặn **duy nhất**, là **đọc lại ref ngay trước `PATCH`** rồi so với SHA đã đọc; lệch thì throw, run fail, PR cũ giữ nguyên. Cái này vẫn là **TOCTOU** — không có transaction nào bọc đọc–ghi — và vẫn được mô tả như một race vì nó là một race. Nó chỉ rút cửa sổ từ "cả quá trình tạo blob/tree/commit" xuống "một request", và đổi hậu quả phần còn lại từ _mất commit của run khác_ thành _một request GitHub từ chối_. `force: true` là bắt buộc ở đây: branch luôn được dựng lại từ `origin/main` nên commit mới luôn non-fast-forward với commit release của lần dispatch trước, và `force: false` trả 422 làm hỏng chính nhánh idempotent `refresh`.

**15. App token siết cho đúng một repository.** `owner` có mà `repositories` rỗng làm action mở rộng token cho **toàn bộ** installation (`resolveInstallationTarget` của action v3.2.0). Cả `owner` lẫn `repositories` đều không khai, token chỉ có scope đúng repository đang chạy. GITHUB_TOKEN không đủ cho endpoint tạo release (403 "Resource not accessible by integration" dù đã có `contents: write` — đo ở run 38212771703).

**16. Một leg đỏ không giết các leg khác, và chỉ MỘT job sinh ma trận.** `fail-fast: false` trên `build` và `deploy`: các đơn vị deploy Worker khác nhau với evidence độc lập. Ma trận **không** được dựng ở nhiều nơi — job `plan` (không matrix, không secret) tính tập project bị ảnh hưởng bằng Nx, giao với tập đã audit, rồi **phát ra đúng một** JSON matrix tất định; `build` và `deploy` cùng tiêu thụ chính ma trận đó, đọc nó qua `matrix.project` / `matrix.slug`. Hai nơi cùng tính ma trận là hai nơi trôi lệch, và lệch ở đây là deploy nhầm Worker chứ không phải lỗi hiển thị.

Danh sách trong `matrix` không phải các giá trị "tính riêng cho từng project": nó là **một** danh sách được phát ra từ **một** job, và mọi job downstream đọc đúng danh sách đó.

**17. Sự cố của một đơn vị làm lane của đơn vị đó đỏ, không phải toàn workspace.** `plan` bỏ qua đơn vị không bị `nx affected`; `deploy` fail ở đúng leg đó. `audit` và `plan` là hai job **không matrix** có thể đỏ cả lane, và chúng đỏ _trước khi_ bất kỳ leg nào deploy. Khi tập affected **rỗng**, đó là một no-op hợp lệ: không có matrix, không có artifact, không có deploy — và job `summary` vẫn chạy để nói rõ "không có gì để deploy" thay vì để workflow kết thúc im lặng. Lỗi của `audit` thì **không** được biến thành no-op xanh.

> **Giới hạn đã biết của cách tách job matrix hiện tại.** `deploy` khai `needs: [audit, plan, build]`, và `build` là job matrix — nên kết quả tổng của nó là all-or-nothing: một leg `build` đỏ làm job `deploy` bị skip cho **mọi** deploy unit, kể cả leg đã build xong và có artifact hợp lệ. `fail-fast: false` không cứu được trường hợp này; nó chỉ giữ leg build khác khỏi bị hủy giữa chừng. Một sự cố build của một project làm đỏ cả lane staging. Cách bỏ coupling là gộp `build` vào `deploy`, nhưng nó đưa mã install/build chạy trong job đang giữ secret Cloudflare, phá đúng ranh giới secret mà header của `staging.yaml` mô tả — nên coupling được **giữ có chủ ý và ghi lại ở đây**, không giấu. Bullet 16 nói đúng phạm vi mà `fail-fast: false` thực sự bảo đảm: nó bảo đảm leg này không giết leg kia **trong cùng một job**, không bảo đảm leg build sống sót tới deploy.

**18. Job `audit` đọc cấu hình ở base ref, không phải ở SHA sắp deploy — và điều đó không làm lệch cây được deploy.** `audit` chỉ quyết định _danh sách_ deploy unit, từ `nx.json` và Nx graph; nó không build và không deploy. Danh sách lấy từ revision `main` hiện hành là đúng: main chỉ nhận commit qua merge queue sau khi CI xanh. Revision `main` và SHA của run CI có thể lệch nhau khi main tiến thêm commit trong lúc run đang chờ queue — khi đó `audit` biết có thêm một deploy unit, còn `build`/`deploy` vẫn checkout và deploy đúng SHA đã qua kiểm của `context`. Hệ quả được chấp nhận: một deploy unit mới xuất hiện trên main sau run CI đó sẽ bị bỏ sót tới run kế tiếp, thay vì được deploy ở một revision chưa từng qua kiểm.

**Còn lại chưa làm, và cần nói thẳng:** `devOrigin` của `apps/account` và `apps/backoffice` ở **cả hai** env là placeholder `https://REPLACE-WITH-REAL-SUBDOMAIN.workers.dev`. Cả hai đã được rút khỏi `nx.json release.projects`: cổng readiness chặn placeholder **trước** khi deploy, nên chúng không còn đi qua pipeline này nữa — thay vì đỏ ở smoke check như trước, chúng giờ bị loại khỏi matrix với lý do ghi trong `deploy-eligibility.jsonc`. Khi quản trị viên điền origin thật (và với `account`, thêm `hyperdrive` theo từng env — §4.1), chúng được thêm lại ở **cả hai** nơi.

Về bề mặt UI, cả hai app **không còn là stub**: `apps/account` có presentation layer (Issue #178) và `apps/backoffice` có prototype surface với dữ liệu mẫu (Issue #235 → PR #240). Prototype đó **không** gỡ blocker nào ở trên: `smokeSurface` của cả hai vẫn khai `{}`, và cả hai vẫn **chưa có** cơ chế `noindex` phía Worker (`apps/home` dùng `server/middleware/no-index.ts` đọc `public.noIndex` theo lane), nên khi được đưa trở lại pipeline, smoke staging của chúng sẽ **fail** ở check `root-noindex` cho tới khi có cơ chế đó — một bề mặt staging không được `noindex` là khiếm khuyết thật, và báo đỏ là đúng. Trạng thái bề mặt của `backoffice` — gồm route, locale và adapter dữ liệu mẫu — có canonical ở [`domains/staff-access/README.md`](../domains/staff-access/README.md).

---

## 9. Ranh giới tooling

| Tool             | Responsibility                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Nx               | project graph / task orchestration / affected / release + versioning                                    |
| Wrangler         | Worker deploy + version, named environments, Worker Secrets, Preview, D1 **migration execution** (§9.1) |
| Pulumi           | infrastructure resource **lifecycle**: DNS, R2, KV, Queues + DLQ, D1, Hyperdrive, Access (§9.1)         |
| GitHub Actions   | orchestration CI/CD, workflow dependency, environment credential, approval gate, deploy verification    |
| Contract tooling | compatibility gate (Pact, oasdiff, `drizzle-broker`)                                                    |

§9.1 Bảng sở hữu chi tiết — xem bảng dưới. Bảng này là **canonical**; `03-operations.md` tham chiếu đến nó, không lặp lại. Không khai báo cùng một resource ở hai công cụ. Workers VPC Service + Cloudflare Tunnel quản lý bằng Wrangler (`04` VP4); bootstrap hạ tầng một lần → `03`. Nx Release là nguồn sinh version/tag/changelog (§7.2); Wrangler là nguồn thực thi deploy/version của Worker; Pulumi provisioning infrastructure — deploy application và provisioning infrastructure là hai workflow tách biệt, release application không chạy `pulumi up` (§7.4). Pulumi state ở R2 backend theo environment, credential + passphrase riêng (§6); resource bootstrap cần để tạo/truy cập state backend không được mô hình hoá như resource chỉ tạo được sau khi backend sẵn có.

⚠️ **Bảng dưới là hợp đồng ownership, không phải bảng trạng thái.** Cột "Tạo / cập nhật / xoá" trả lời **ai sở hữu**, chưa
trả lời **resource đó đã được tạo chưa**. Hiện trạng: chỉ local platform (network, Traefik, PostgreSQL, container home) được
provision — và chỉ trên máy developer qua Nx target `local-up`/`local-down` của các deploy project, không có workflow CI nào chạy `pulumi up`; các resource
của environment thật (staging/production) **chưa** được provision bởi nhóm `deploys/` (§7.4.1) — mọi ô "Pulumi" trong cột
này là **chủ sở hữu được giao**, chưa phải một hành động đã xảy ra.

### 9.1 Bảng sở hữu từng loại resource (canonical)

Bảng này trả lời bảy câu hỏi cho **mỗi** loại resource. `03-operations.md` tham chiếu đến bảng này, không lặp lại. Vế
**chủ sở hữu** (cột "Tạo / cập nhật / xoá") là hợp đồng đã chốt; vế **hiện thực** thì `deploys/` chưa provision resource
nào của **environment thật** (staging/production) thuộc các loại trong bảng (Worker/D1/KV/…) — resource thật duy nhất là
local platform (§7.4.1), và trong bảng này nó mới chạm tới các dòng PostgreSQL (host/cluster/roles, dưới dạng container +
volume local); các dòng còn lại nằm ngoài phạm vi hiện thực của local platform.

| Resource                                                             | Tạo / cập nhật / xoá                                                                                                                 | Cung cấp ID & config                                        | Áp dụng schema migration | Prerequisite trước deploy application  | Không được đồng thời sở hữu                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| **Worker**                                                           | Wrangler (deploy)                                                                                                                    | `wrangler.jsonc` của deploy unit                            | —                        | —                                      | Pulumi                                                                |
| **D1 database**                                                      | Pulumi (tạo/xoá DB)                                                                                                                  | `database_id` → Pulumi; `database_name` → `wrangler.jsonc`  | —                        | DB + binding phải tồn tại trước deploy | Wrangler không tạo/xoá DB; Pulumi không chạy migration                |
| **D1 app schema (migrations)**                                       | Migration runner — Wrangler `d1 migrations apply`                                                                                    | file migration → repo                                       | **migration runner**     | DB + `database_id` + binding           | Pulumi — không sở hữu việc áp schema                                  |
| **`d1_migrations` ledger**                                           | Migration runner (Wrangler tạo/đọc/ghi khi `migrations apply`)                                                                       | bảng ledger trong chính DB                                  | **migration runner**     | DB                                     | Pulumi — không tạo, không ghi ledger                                  |
| **KV namespace**                                                     | Pulumi                                                                                                                               | ID → Pulumi                                                 | —                        | namespace tồn tại                      | Wrangler                                                              |
| **R2 bucket**                                                        | Pulumi                                                                                                                               | ID → Pulumi                                                 | —                        | bucket tồn tại                         | Wrangler                                                              |
| **Queue**                                                            | Pulumi                                                                                                                               | ID → Pulumi                                                 | —                        | queue + DLQ tồn tại                    | Wrangler                                                              |
| **Queue DLQ (`dead_letter_queue`)**                                  | Pulumi — vòng đời **độc lập** với Queue chính                                                                                        | tên → Pulumi; khai trong `queue-resources.jsonc`            | —                        | DLQ tồn tại                            | Wrangler — API tự tạo Queue ngầm nếu tên chưa có, cờ CLI không chặn   |
| **Hyperdrive config**                                                | Pulumi                                                                                                                               | origin/credentials → Pulumi                                 | —                        | VPC Service + Tunnel + origin đã sẵn   | Wrangler không tạo config                                             |
| **DNS zone**                                                         | Pulumi                                                                                                                               | zone id → Pulumi                                            | —                        | —                                      | Wrangler                                                              |
| **DNS record độc lập**                                               | Pulumi                                                                                                                               | name/type/value → Pulumi                                    | —                        | zone tồn tại                           | Wrangler — không tạo record cùng tên                                  |
| **Record + certificate sinh ra như hệ quả của Worker Custom Domain** | Wrangler (tạo như side effect của việc gắn Custom Domain; **xoá lệch nhau** — xem "Teardown Custom Domain" ngay dưới bốn nguyên tắc) | không khai trong `wrangler.jsonc`; sinh khi attach          | —                        | zone tồn tại                           | Pulumi — **không** khai record/cert này, nếu không hai tool đánh nhau |
| **Worker Custom Domain attachment**                                  | Wrangler                                                                                                                             | `env.<lane>.routes[]` với `"custom_domain": true`           | —                        | Worker đã deploy + zone tồn tại        | Pulumi                                                                |
| **Worker route trên record đã tồn tại**                              | Wrangler                                                                                                                             | `env.<lane>.routes[]` với `pattern` (không `custom_domain`) | —                        | Worker đã deploy + record tồn tại      | Pulumi — không duplicate route                                        |
| **VPS / PostgreSQL host**                                            | Pulumi (infra layer)                                                                                                                 | host → Pulumi                                               | —                        | host + VPC Service + Tunnel            | —                                                                     |
| **PG cluster install & server config**                               | Pulumi                                                                                                                               | host → Pulumi                                               | —                        | host                                   | —                                                                     |
| **PG cluster config & logical DBs**                                  | Pulumi (provisioning)                                                                                                                | DB name → Pulumi                                            | —                        | cluster                                | —                                                                     |
| **PG roles / privileges**                                            | Pulumi (provisioning)                                                                                                                | role → Pulumi                                               | —                        | DB                                     | migration runner                                                      |
| **PG app schema / tables / indexes**                                 | Migration runner (CI)                                                                                                                | file → repo                                                 | **migration runner**     | DB + role + connectivity               | Pulumi — không áp dụng schema                                         |
| **PG migration history**                                             | Migration runner (CI)                                                                                                                | ledger table                                                | **migration runner**     | DB                                     | Pulumi                                                                |
| **Worker Secrets**                                                   | Wrangler `secret put`                                                                                                                | value → CI secret store                                     | —                        | Worker đã deploy                       | Pulumi                                                                |
| **Access application**                                               | Pulumi                                                                                                                               | ID → Pulumi                                                 | —                        | Worker đã deploy                       | Wrangler                                                              |
| **Pulumi state backend**                                             | Bootstrap (một lần)                                                                                                                  | endpoint → bootstrap script                                 | —                        | —                                      | mọi stack khác                                                        |
| **Workers VPC Service + Tunnel**                                     | Wrangler                                                                                                                             | `service_id` → `wrangler.jsonc`                             | —                        | Worker đã deploy                       | Pulumi                                                                |

**Bốn nguyên tắc bắt buộc:**

1. **Resource lifecycle ≠ application deployment.** Pulumi sở hữu _tạo/cập nhật/xoá_ infrastructure resource; Wrangler sở hữu _deploy Worker_ và _chạy migration_. Một resource không bao giờ có hai owner cùng lúc.
2. **D1: ba lớp, không phải hai.** (a) **D1 database** — Pulumi tạo/xoá, cung cấp `database_id`. (b) **áp schema** — delivery contract, thực thi bằng `wrangler d1 migrations apply` trên DB đúng environment. (c) **bảng ledger `d1_migrations`** — do **chính migration tooling** tạo/đọc/ghi như một phần của việc chạy migration; Pulumi **không** tạo và **không** ghi bảng này. Đây đúng cùng cách phân tách đã dùng cho PostgreSQL ở nguyên tắc 4: resource lifecycle, việc áp schema và ledger lịch sử là ba owner khác nhau, không phải một. `wrangler.jsonc` của bốn service push/mail khai `database_name` nhưng **không** khai `database_id` — đó là dấu hiệu chưa provisioning. Khi đã provisioning, `database_id` do Pulumi cung cấp và **không** được Wrangler tự tạo. Migration chạy trên DB đúng environment, **không** qua Hyperdrive hay PG runner.
3. **DNS: năm loại object, mỗi loại một owner — không có quy tắc either/or.** (a) **zone** → Pulumi. (b) **DNS record độc lập** (record tồn tại vì chính nó: mail, verification, A record của VPS) → Pulumi. (c) **record + certificate sinh ra như hệ quả của việc gắn Worker Custom Domain** → Wrangler, và **không** được khai trong Pulumi, nếu không hai tool cùng quản một object. (d) **Worker Custom Domain attachment** → Wrangler, qua `env.<lane>.routes[]` với `"custom_domain": true`; đây là **object attachment**, không phải object record. (e) **Worker route trên record đã tồn tại** → Wrangler, qua `env.<lane>.routes[]` với `pattern` (không `custom_domain`). Repo hiện khai Custom Domain ở `apps/home/wrangler.jsonc`: `env.staging.routes` = `ecoma.io.vn`, `env.production.routes` = `ecoma.io` (cả hai `"custom_domain": true`).
4. **PostgreSQL: phân tách 5 lớp.** (a) VPS/network/firewall/storage · (b) PostgreSQL install & server config · (c) cluster config & logical DBs · (d) roles/privileges/access — **(a)–(d) là Pulumi provisioning**. (e) application schema/tables/indexes + migration history — **migration runner (CI)**. Pulumi **không** áp dụng app schema như side effect; migration runner **không** tạo role hay cluster. Provider VPS/PG host chốt (`03` §10).

**Teardown Custom Domain — vòng đời lệch, và ai dọn phần còn sót.** Gỡ một Custom Domain (bỏ entry `routes[]` có `"custom_domain": true` rồi deploy, hoặc detach qua dashboard/API `DELETE /accounts/{account_id}/workers/domains/{domain_id}`) **chỉ** gỡ attachment: API mô tả đúng một việc — "Detaches a domain from a Worker. Both the Worker and all of its previews are no longer routable using this domain." — tức traffic ngừng được route tới Worker. **Certificate thì không đi theo.** Tài liệu Cloudflare nêu rõ một caution: "When you delete a Custom Domain, the associated Advanced Certificate is **not** automatically deleted. You must manually remove the certificate from the Cloudflare dashboard under **SSL/TLS** > **Edge Certificates**, or via the API" (endpoint `DELETE /zones/{zone_id}/ssl/certificate_packs/{certificate_pack_id}`); certificate để lại "does not affect functionality but may cause confusion when auditing your certificate inventory". Đo trên chính bản pin `4.151.0`: đường deploy của Wrangler gọi `/domains/changeset?replace_state=true` (domain bị bỏ khỏi config thì detach) và `GET /workers/domains/records/{id}` — **không** có call site nào chạm `certificate_packs`; client `certificatePacks` nằm trong SDK `cloudflare` mà Wrangler đóng gói, nhưng không được gọi từ đường này, nên "Wrangler tự xoá cert" là khẳng định sai.

Hệ quả ownership: **không tool nào trong repo tự dọn certificate residual này.** Wrangler không có call site xoá cert; Pulumi **cấm** khai record/cert sinh ra như hệ quả của Custom Domain (nguyên tắc 3c — nếu nó khai thì hai tool đánh nhau), nên Pulumi cũng không sở hữu việc gỡ nó. Vì vậy phần còn sót là **bước vận hành tường minh, có chủ đích** — xoá tay qua dashboard/API theo runbook, hoặc trong Phase 2 mô hình hoá certificate như một resource riêng có owner trước khi gắn Custom Domain. Không được giao việc đó cho "hiệu ứng phụ của việc gỡ domain" vì hiệu ứng phụ đó **không tồn tại**, và không được ghi vào đây một owner không thực sự sở hữu. Lịch sử của certificate còn lại phải **tra được** trước khi xoá: certificate gắn với hostname nào, sinh ra từ attach nào, và đã được thay bằng gì (nếu có) — nếu không thì xoá tay là xoá nhầm cert đang phục vụ hostname khác trên cùng zone.

Registry Queue ở dưới là công cụ sở hữu cho Queue/DLQ; **không có** bản tương đương cho certificate, và Phase 1 **không** dựng bản đó — ghi rõ để Phase 2 không phải suy đoán rằng đã có.

**Guard máy kiểm — hai lớp, và ranh giới giữa chúng.** Lớp thứ nhất là audit trong `tools/delivery/src/resource-bindings.ts`; lớp thứ hai là cờ CLI trong `tools/delivery/src/wrangler-deploy.ts`. Hai lớp này **không** thay thế nhau, và nói chúng tương đương là mô tả sai cơ chế bảo vệ.

**Lớp 1 — audit (đọc `wrangler.jsonc`, chưa dùng credential).** Với mỗi deploy unit `releaseable`, guard đọc binding **trong scope của từng lane** (chỉ `env.<lane>`) cho cả `staging` và `production`, rồi kiểm định danh:

| Khoá trong `wrangler.jsonc` | Định danh     | Wrangler 4.151.0 tự tạo được? | Thiếu định danh nghĩa là                               |
| --------------------------- | ------------- | ----------------------------- | ------------------------------------------------------ |
| `d1_databases`              | `database_id` | có                            | lỗi **sở hữu** — deploy sẽ tạo D1                      |
| `kv_namespaces`             | `id`          | có                            | lỗi **sở hữu** — deploy sẽ tạo namespace               |
| `r2_buckets`                | `bucket_name` | có                            | lỗi **sở hữu** — deploy sẽ tạo bucket                  |
| `queues.producers`          | `queue`       | có                            | lỗi **sở hữu** — deploy sẽ tạo Queue                   |
| `queues.consumers`          | `queue`       | **không** (chỉ đọc)           | lỗi **định danh** — consumer trỏ Queue không tồn tại   |
| `hyperdrive`                | `id`          | **không**                     | lỗi **định danh** — deploy ra Worker không có DB bound |

Định danh được kiểm **theo từng loại resource**, không bằng một regex chung (`identifier-format.ts`): `database_id` là UUID có gạch, `id` của KV/Hyperdrive là hex 32 ký tự, `bucket_name` và tên Queue là **tên resource** — chữ thường, số, `-`; chữ hoa bị từ chối ở bucket nhưng **được** chấp nhận ở Queue. Áp quy tắc UUID lên `bucket_name`/tên Queue sẽ chặn `ecoma-push-delivery` — một tên hợp lệ — nên guard tách luật theo loại và **không** dùng chung một pattern. Kiểm cú pháp **không** phải kiểm tồn tại: `database_id` đúng UUID vẫn có thể trỏ database không có trên account, và thông điệp lỗi nói rõ điều đó thay vì ngụ ý đã xác minh.

`hyperdrive` cố ý ở bảng riêng: trên bản pin 4.151.0 nó **không** có handler provision, nên thông điệp của nó **không** được nói "Wrangler sẽ tạo" — một guard nói sai về Wrangler thì log của nó hết đáng tin. Chỉ **producers** của `queues` mới provision được (`getRawConfigBindings()` cho `queue` trả `config.queues.producers`); consumer **đọc** Queue qua `getQueue()` chứ không tạo, nên thiếu tên là lỗi định danh chứ không phải lỗi sở hữu.

**Queue: producer, consumer và DLQ là ba thứ khác nhau, không được gộp.** Cấu hình Queue không phải mảng mà là `{ producers: [...], consumers: [...] }`, nên đọc `queues` như mảng là cách nhanh nhất để bỏ sót toàn bộ Queue. Guard đọc **cả ba** vị trí — `queues.producers[].queue`, `queues.consumers[].queue` và `queues.consumers[].dead_letter_queue` — mỗi vị trí một `problem` có định vị riêng, và **không** coi khai báo consumer tương đương khai báo DLQ: DLQ có vòng đời resource độc lập.

**Vòng đời DLQ — phần không thể vá bằng cờ CLI, và ai sở hữu.** `dead_letter_queue` là chỗ duy nhất mà việc đọc mã nguồn 4.151.0 **không** đủ để kết luận: CLI chỉ kiểm tồn tại cho `queue` (`ensureQueuesExistByConfig` ném `Queue "X" does not exist`), còn `updateQueueConsumers` chỉ gọi `getQueue(consumer.queue)` rồi PUT `consumers` — và chuyển tiếp nguyên `dead_letter_queue` xuống API. Tài liệu Cloudflare nói rõ API **tự tạo** Queue có tên trong `dead_letter_queue` khi nó chưa tồn tại. Đường tạo đó **không** nằm sau `RESOURCES_PROVISION`, nên `--experimental-provision=false` **không** chặn được nó: đây là lý do **không** cờ nào được mô tả là bảo đảm tuyệt đối cho Queue. Vì vậy DLQ được xử lý bằng **hợp đồng sở hữu** thay vì bằng giả định: `tools/delivery/config/queue-resources.jsonc` liệt kê mọi Queue/DLQ mà repo tham chiếu, mỗi tên kèm `owner` và `lifecycleRef` trỏ tới tài liệu; một tên **không** có trong registry là `problem` **chặn**. Registry là khai báo chủ sở hữu — **không** phải bằng chứng Queue tồn tại; nó chỉ chuyển câu hỏi "Queue này có thật không" thành một câu hỏi có người trả lời. Queue/DLQ lifecycle vì vậy thuộc **Pulumi**, không thuộc Wrangler.

Registry được audit trên **mọi** project có `wrangler.jsonc`, **không** chỉ tập `releaseable` — bốn Worker Queue của repo (push, mail, push-job, mailer-job) đều nằm **ngoài** matrix release, nhưng "ngoài matrix" **không** làm lệnh deploy của chúng an toàn; hai trong số đó (`web-push-notification-job`, `transactional-mailer-job`) là chỗ khai `dead_letter_queue`.

Guard fail closed ở **mọi** nhánh không đọc nổi: file `wrangler.jsonc` hỏng JSONC, root không phải object, `env`/`env.<lane>` sai kiểu, khoá binding sai kiểu, entry (hoặc producer) không phải object, file không đọc được — tất cả thành `problem` **có địa chỉ** (project · file · lane · vị trí khai · khoá thiếu), không bao giờ thành "không có gì để kiểm". Xử lý "khoá binding sai kiểu" như một `problem` là **đúng** theo chính Wrangler 4.151.0: `validateBindingArray` báo lỗi config khi khoá binding không phải mảng ("should be an array but got …"), nên shape đó không phải một cấu hình hợp lệ bị guard chặn oan. Định danh **placeholder** (toàn số 0, `<...>`, `REPLACE-WITH-…`, `TODO`/`EXAMPLE`/`xxx`) cũng là `problem`: nó không phải định danh thật, và với `r2_buckets`/`queues` nó còn tệ hơn vì Wrangler vẫn tạo được resource đúng bằng cái tên đó.

**Lớp 2 — cờ CLI, và vì sao nó là lớp bảo đảm.** Trong repo **không còn** một lời gọi `wrangler deploy` trần nào: `apps/<slug>/package.json` **không** khai lệnh Wrangler nữa mà trỏ `deploy` target vào **cổng duy nhất** `tools/delivery/src/deploy-gate.mts` (§7.4.3), còn hai làn release gọi `tools/delivery/src/wrangler-deploy.ts` qua `staging-deploy.mts` / `promote-production.mts`. Cả ba đường — cổng Nx, làn staging, làn production — đều kết thúc ở **cùng một** helper. Helper nối **cả hai** cờ, `WRANGLER_DEPLOY_SAFETY_FLAGS = ['--experimental-provision=false', '--experimental-auto-create=false']`, vào **mọi** lần thử, kể cả các lần retry. Đo trực tiếp trên 4.151.0: `--experimental-provision` (alias `--x-provision`) điều khiển `RESOURCES_PROVISION`, và toàn bộ `provisionBindings` nằm sau `else if (props.resourcesProvision)`, nên tắt nó thì `wrangler deploy` **không** tạo resource nào. Cần cờ này vì **khai định danh trong repo không đủ**. Trên 4.151.0 chỉ ba handler override `isFullySpecified()` thành khác `false`: `KVHandler` (`!!binding.id`), `D1Handler` (`!!binding.database_id`) và `FlagshipHandler` (`!!binding.app_id`); handler thứ ba phục vụ loại binding mà repo **không** khai. Trong bốn loại repo thật sự khai, chỉ `kv_namespaces` và `d1_databases` được coi là fully specified khi có định danh — `r2_bucket` và `queue` rơi về `false` của lớp cha, nên **kể cả khi đã khai `bucket_name`/`queue`**, Wrangler vẫn tạo resource khi nó chưa tồn tại trên account. Kiểm khai báo (lớp 1) vì vậy **không** chứng minh được `wrangler deploy` sẽ không tạo gì; chỉ cờ mới chặn được đường đó. Nguy hiểm hơn trong CI: với `auto-create` mặc định, Wrangler tạo resource **không tương tác** rồi **bỏ qua** writeback config (`isNonInteractiveOrCI()`), nên id của resource mồ côi không bao giờ được ghi lại ở đâu.

**Vì sao vẫn nối cả `--experimental-auto-create=false` dù trên 4.151.0 nó là dead code.** Đo trên chính bản pin: `--experimental-auto-create` (alias `--x-auto-create`) được parse và ghi vào `AUTOCREATE_RESOURCES`, nhưng biến đó **không** được đọc ở bất kỳ đâu trong `cli.js` 4.151.0 — nghĩa là hôm nay nó không chặn được gì thêm. Nó vẫn nằm trong bộ cờ vì (a) nó là cơ chế auto-provisioning **thứ hai** theo tài liệu Wrangler, và "tắt một cơ chế" **không** suy ra "tắt cơ chế kia" — một bản Wrangler sau này nối `AUTOCREATE_RESOURCES` vào đúng đường `provisionBindings` là thay đổi một dòng, và lúc đó bộ cờ đã đúng sẵn; (b) cả hai cờ có mặt trên **mọi** lần thử nên chúng không thể trôi lệch nhau. Đây **không** phải khẳng định rằng cờ thứ hai đang chặn một đường tồn tại — nó là lớp phòng thủ cho một cơ chế được tài liệu hoá, và được viết ra đúng như vậy.

**Giới hạn đã đo, không được mô tả quá mức:** bộ cờ CLI chỉ là bảo đảm cho các đường tạo resource **đi qua** `provisionBindings`. Nó **không** phủ đường tạo Queue ngầm của `dead_letter_queue` (mục Queue ở trên) — đường đó do API Cloudflare thực hiện và registry sở hữu chặn, không phải cờ. Không có bằng chứng ở mức mã nguồn cho một đường tạo resource **thứ ba**; nếu Phase 2 thêm một loại binding mới vào `GUARDED_KINDS` thì cần đọc lại bảng `HANDLERS` của bản Wrangler đang pin.

Guard chạy trong `deploy-unit-audit.mts` (job `audit` của làn staging, **trước** cổng Environment, không cầm secret) và trong `@ecoma-io/delivery:test`. Vì `production.yaml` **không** có bước audit riêng, audit đó quét **cả hai lane**.

**Chưa được machine-enforce — nói rõ để Phase 2 không phải suy đoán:**

- **Tồn tại của resource.** Cả ba lớp đều là kiểm **cấu hình**, không lớp nào nói resource có thật trên account. Registry Queue khẳng định _ai sở hữu_, không khẳng định _đã tạo_. Việc xác minh tồn tại cần inventory hạ tầng và là việc của Pulumi/`03` §10 — Phase 1 không bịa dữ liệu đó.
- `services` (Service Binding) **ngoài** guard: nó trỏ tới Worker đã tồn tại, không sinh resource mới, nên "thiếu id" không áp dụng.
- Bốn loại binding provision được mà **chưa** guard (`ai_search_namespaces`, `agent_memory`, `dispatch_namespaces`, `flagship`) — phân loại tường minh trong `UNGUARDED_PROVISIONABLE_KINDS` kèm lý do, và một test khoá đẳng thức `GUARDED_KINDS ∪ UNGUARDED_PROVISIONABLE_KINDS` = các `configField` của bảng `HANDLERS`, nên thêm loại mới mà quên phân loại là test đỏ. Repo không khai loại nào trong số này.

**Hai biên của lớp audit sở hữu:** (a) nó **chỉ** chạy trên tập `releaseable` — thêm một project vào `nx.json release.projects` mà quên `database_id` sẽ bị chặn, nhưng nó không phải bản kiểm kê toàn repo; (b) ngược lại, lớp **Queue/DLQ** và lớp **eligibility** phủ rộng hơn: Queue/DLQ audit chạy trên **mọi** project có `wrangler.jsonc`, còn eligibility audit chạy trên **mọi** Nx project và một project không được phân loại là `problem` chặn, không phải mặc định bỏ qua.

Mỗi khẳng định trên đều có test đối kháng: `resource-bindings.spec.ts` chốt sáu trường hợp lane/scope, các nhánh fail-closed, định danh placeholder và định dạng theo từng loại; `queue-resources.spec.ts` chốt ba vị trí Queue, DLQ thiếu trong registry, registry sai hình dạng và cấu hình Queue thật của repo; `deployment-target.spec.ts` + `deploy-eligibility.spec.ts` chốt hợp đồng origin, lane thiếu, và `account`/`backoffice` bị chặn; `wrangler-deploy.spec.ts` chốt **cả hai** cờ trên **mọi** lần thử. Các mutation (bỏ một trong hai cờ, bỏ nhánh `dead_letter_queue`, cho binding top-level thoả mãn lane, tắt kiểm định dạng theo loại, đánh dấu `account` releaseable trở lại, tắt kiểm placeholder origin, tắt kiểm scheme, thêm một deploy entry point không guard, cho một làn bỏ qua helper) đều được kiểm là **làm suite đỏ**.

---

## 10. Test execution

Bảng dưới đây là **chính sách thực thi theo kiến trúc đích** (`06-testing.md` là nguồn canonical về taxonomy và target
contract); trạng thái hiện thực của từng target trong cây code được xác minh tại thời điểm đọc bằng `pnpm nx show project
<name> --json`, không được suy ra từ bảng này.

| Tầng                          | Công cụ                                                                                                                                      | Chạy ở                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Unit/domain                   | Vitest                                                                                                                                       | PR                                                                                                 |
| Port conformance              | Miniflare + Testcontainers (PostgreSQL + TimescaleDB)                                                                                        | PR                                                                                                 |
| Worker integration            | Vitest + wrangler `getPlatformProxy` (D1) / testcontainers (PostgreSQL)                                                                      | PR                                                                                                 |
| `llm-api` integration/e2e     | CI runner + mock upstream                                                                                                                    | PR (khi affected)                                                                                  |
| API contract (nội bộ)         | Pact                                                                                                                                         | PR                                                                                                 |
| Public API                    | OpenAPI + `oasdiff` + SDK conformance                                                                                                        | PR                                                                                                 |
| Backoffice browser regression | Playwright — suite app-owned dưới `apps/backoffice/e2e/` (phạm vi UI của backoffice, không phải system E2E — phân loại theo `06-testing.md`) | PR, chạy qua target `e2e` và job CI `e2e` chuyên dụng                                              |
| Preview E2E                   | Playwright                                                                                                                                   | Preview                                                                                            |
| Serve-mode UI preview         | mock adapter qua data-mode seam (`nuxt dev` only) — chi tiết: `05-code-architecture.md` §5                                                   | Dev workstation — KHÔNG chạy ở CI gate                                                             |
| Staging E2E                   | OTP mailbox + OAuth nightly                                                                                                                  | Staging                                                                                            |
| `llm-api` load/soak           | k6 + mock upstream                                                                                                                           | Ngoài giờ cao điểm hoặc host riêng                                                                 |
| Restore test PostgreSQL       | Restore backup vào instance tạm trên host riêng                                                                                              | Định kỳ (`03` §3.4)                                                                                |
| Nx remote cache compatibility | GET/PUT cache artifact, auth, immutable entry / 409, local → CI cache hit                                                                    | PR ([`applications/remote-cache/03-operations.md`](../applications/remote-cache/03-operations.md)) |

Ba loại kiểm trên browser phải không bị lẫn: **browser regression** là UI của một app duy nhất — suite app-owned (không colocated) thuộc `apps/<app>/e2e/`, chạy qua target `e2e` do `@nx/playwright/plugin` suy ra trên project có `playwright.config.ts`, với một job CI chuyên dụng (phân loại theo `06-testing.md`); **system E2E** là kiểm liên dịch vụ qua runtime/service boundary, ở `system-tests/e2e/` với Nx target `system-test` (phân loại và taxonomy → `06-testing.md`); còn **manual UI preview** là serve-mode data policy khi chạy app bằng tay, không phải test — chính sách → `05-code-architecture.md` §5. Tên target `e2e` là tên target do plugin sinh ra, không phải tầng phân loại — quy tắc phân loại → `06-testing.md` §4.

Testing architecture (taxonomy test, vị trí unit/contract/E2E test, target contract của từng tầng) → `06-testing.md`.

Harness của tầng Worker integration tuân theo quy tắc tự-dựng-harness của `06-testing.md` §6, và là nơi minimum bar
worker reliability (lease, idempotency, retry, DLQ — `06-testing.md` §7) được kiểm với dependency thật; mô phỏng
Queue/DLQ (retry cạn vào `dead_letter_queue`) nằm ngoài phạm vi các harness này — nếu cần, đòi một quyết định riêng về
runner mô phỏng Queue. Thiết kế mail quarantine: drain/redrive là năng lực tương lai; bảng `quarantine` được consumer
ghi và test đọc, không có đường vận hành drain trong thiết kế hiện tại.

---

## 12. Chưa chốt

Chỉ chứa **delivery uncertainty**. Architectural decision → `01` §10 · operational uncertainty → `03` §10.

Đã chốt **về thiết kế** (xem §7.2/§7.3/§7.4; ⚠️ phần lớn **không** còn hiện thực trong cây hiện tại — xem hộp trạng thái ở đầu
tài liệu): cách Nx Release ghi version per-deploy-unit (`home` dùng `package.json`, config trong `nx.json`); vòng đời release
`home` Phase A–D (staging verify trước, tag + draft release sau gate + approval ở làn production, publish chỉ sau production
smoke); concurrency/stale-run guard staging (`runner-guard.ts`); cơ chế production deploy từ revision đã verify (rebuild từ
release commit với env `production` — không promote xuyên Worker identity); contract bootstrap state backend của Phase 2A
(§7.4.1 — **đã bị gỡ khỏi repo**).

Đã chốt **và còn hiện diện trong repo**: layout nhóm deployment `deploys/` với `platform-deploy` là tầng prerequisite; cấu
hình Nx Release per-project (`nx.json` `release.projects`, `projectsRelationship: independent`); ranh giới bốn đường
thay đổi ở §0 và hợp đồng bootstrap/seed ở §3.2.

**Chưa chốt và chưa có bằng chứng hiện thực (trên environment thật):** số stack Pulumi và ánh xạ stack → project
`deploys/` cho staging/production — đường **local** đã chốt và đã hiện thực: một stack `local-<namespace>` mỗi project,
`platform-deploy` giữ stack riêng (`architecture/local-development/README.md`); workflow chạy Pulumi
(`preview`/`up`) — trigger, Environment, approval, ranh giới credential; reconciliation execution contract (§7.4.1).

| Mục                                                                                                                                                                                                                                                                                                                                   | Kích hoạt                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Nơi lưu provenance release (§7.2) — artifact, job result hay store khác                                                                                                                                                                                                                                                               | Trước pipeline production đầu                  |
| Cơ chế trigger Preview manual (theo PR, branch hay revision; workflow hay CLI) (§5.1)                                                                                                                                                                                                                                                 | Trước Preview đầu                              |
| Preview database: 1 config chung + schema-per-PR hay chỉ mock                                                                                                                                                                                                                                                                         | Sau spike D2c                                  |
| Preview routing — router động (KV + header routing) cho preview trên cùng domain, phục vụ E2E liên dịch vụ                                                                                                                                                                                                                            | Sau D2                                         |
| Custom-domain scheme cho Preview                                                                                                                                                                                                                                                                                                      | Sau spike certificate/Access                   |
| Cơ chế dọn **certificate residual** sau teardown Custom Domain — bước vận hành tay có runbook, hay certificate mô hình hoá thành resource riêng (§9.1)                                                                                                                                                                                | Trước lần teardown Custom Domain đầu           |
| Canary theo trọng số cho Worker (Version Override + phân tách traffic)                                                                                                                                                                                                                                                                | Khi có đủ lưu lượng để chia                    |
| Dedicated Preview Workflow                                                                                                                                                                                                                                                                                                            | Khi dùng Workflow                              |
| Contract tooling cho D1 (tương đương `drizzle-broker`, §3)                                                                                                                                                                                                                                                                            | Trước khi schema D1 production                 |
| Cơ chế bảo vệ khi migration runner chết giữa chừng (mất advisory lock)                                                                                                                                                                                                                                                                | Trước migration production đầu                 |
| **Reconciliation execution contract** (§7.4.1)                                                                                                                                                                                                                                                                                        | Trước Phase 2 reconcile                        |
| **Bucket R2 state cho `staging`/`production`:** sự tồn tại thật, tên bucket, Cloudflare account id và jurisdiction của bucket (quyết định tiền tố endpoint — `04` R22) — **không** suy ra tên từ môi trường hay từ stack                                                                                                              | Trước bootstrap state backend                  |
| **Xác nhận R2 nhận `s3ForcePathStyle=true`** trên backend thật: contract đã bắt buộc path-style theo dạng endpoint duy nhất Cloudflare công bố (`04` PU9, R22), nhưng đường `s3://` **chưa** được chạy lần nào từ máy này                                                                                                             | Trước bootstrap state backend                  |
| **Credential state backend:** R2 token Object Read & Write scope đúng một bucket, và `PULUMI_CONFIG_PASSPHRASE` riêng từng stack, đặt trong GitHub Environment tương ứng (§6.13) — chưa cấu hình                                                                                                                                      | Trước lệnh Pulumi đầu trên backend thật        |
| **Workflow chạy Pulumi** (`preview`/`up`): trigger, Environment + approval, và ranh giới credential — chưa có workflow nào                                                                                                                                                                                                            | Trước lần reconcile đầu tiên                   |
| **Số stack Pulumi và ánh xạ stack → project `deploys/`** cho **environment thật** (unit-level hay environment-level; `platform-deploy` giữ stack riêng hay chung) (§7.4.1). Đường **local** đã chốt và đã hiện thực: một stack `local-<namespace>` mỗi project, `platform-deploy` giữ stack riêng — `architecture/local-development/` | Trước lần apply đầu tiên trên environment thật |
| **Hyperdrive binding của `account`** (§4.1 · §9.1)                                                                                                                                                                                                                                                                                    | Trước khi deploy `account`                     |
| Xác minh **tồn tại** của Queue/DLQ đã khai trong `queue-resources.jsonc` (registry chứng minh _chủ sở hữu_, không chứng minh _đã tạo_) — cần inventory hạ tầng                                                                                                                                                                        | Trước khi bật lane cho bốn Worker Queue        |
