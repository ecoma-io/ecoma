# Auth Nonce Prune Job — Vận hành (ứng dụng)

> Phạm vi: runtime, deployment và configuration của `auth-nonce-prune-job`. Kiến trúc → [`01-architecture.md`](./01-architecture.md). Mô hình miền → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md).

## 1. Runtime, deployment và configuration

Deploy unit gồm đúng các resource sau (thiếu binding nào thì job đỏ fail-closed mỗi tick — `01-architecture.md` §3, §4):

```text
Worker              — ecoma-auth-nonce-prune-job (module Worker, chỉ `scheduled()`,
                      KHÔNG `fetch`, KHÔNG hostname, KHÔNG HTTP API, KHÔNG route)
Cron Trigger        — `17 3 * * *` (03:17 UTC = 10:17 ICT), một lần mỗi ngày
Hyperdrive binding  — DB_AUTH    → Hyperdrive config của db-auth
Hyperdrive binding  — DB_ACCOUNT → Hyperdrive config của db-account
```

- Không D1, không Queue, không KV, không hostname: mọi HTTP surface của Worker này đều không tồn tại và đó là trạng thái cấu hình đúng — `workers_dev: false`, không route (`01-architecture.md` PN-1). Bảng cấu hình canonical (không có biến env, không có Worker Secret — xem dưới):

| Binding / cấu hình | Loại            | Bắt buộc | Mô tả                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DB_AUTH`          | Hyperdrive      | Có       | Hyperdrive config của `db-auth`; connection string runtime của binding phải là credential của role **`ecoma_auth_nonce_pruner`** (tạo từ `apps/auth/migrations/0014_nonce_pruner_role.sql`) — KHÔNG phải `_migrator` hay runtime role. Credential `_migrator` không bao giờ là Worker secret ([`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md) §6). KHÔNG dán secret vào `wrangler.jsonc` — credential sống trong Hyperdrive config của Cloudflare account (`01-architecture.md` §4). |
| `DB_ACCOUNT`       | Hyperdrive      | Có       | Hyperdrive config của `db-account`; connection string phải là credential của role **`ecoma_account_nonce_pruner`** (tạo từ `apps/account/db/migrations/0007_nonce_pruner_role.sql`). Cùng quy tắc với `DB_AUTH`.                                                                                                                                                                                                                                                                                             |
| `triggers.crons`   | Wrangler config | Có       | `["17 3 * * *"]` — giá trị khởi điểm lúc deploy; nhịp là chính sách vận hành, đổi bằng PR đổi `wrangler.jsonc`, không có override runtime (PN-13 cùng tinh thần).                                                                                                                                                                                                                                                                                                                                            |

- Worker **không giữ secret nào**: connection string lấy ở runtime qua `binding.connectionString` (pattern `apps/account/server/utils/db.ts`), caps là hằng số của application lib `libs/auth-nonce-prune-job-application` (module `prune-caps.ts`; PN-13 ghi rõ KHÔNG override qua env — một override chưa review là một ngân sách tự điền).
- **Mỗi lane phải khai lại binding tường minh trong `env.<lane>`** — Wrangler 4.151 **không inherit** top-level `hyperdrive` vào named environment (đo trên wrangler 4.151, cùng phát hiện ở `apps/account/wrangler.jsonc`, [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md) §4). Staging **không** được trỏ vào Hyperdrive production và ngược lại — mỗi lane một cặp `id` riêng.
- **Deploy matrix / release pipeline:** project này chưa có target `deploy` (`package.json` chỉ có `build` / `serve` / `prune-lockfile` / `copy-workspace-modules`), **chưa nằm** trong release matrix — `nx.json → release.projects` chỉ có `@ecoma-io/home`, và pipeline CD hiện chưa tồn tại (broker CD đã bị gỡ khỏi repo — [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md) §7). Deploy thật của Worker này là việc của provisioning hạ tầng khi hạ tầng Cloudflare cho repo đã sẵn sàng; trước đó, mọi nhát deploy phải qua checklist §1.1. KHÔNG deploy tay bằng `wrangler deploy` để "thử" — nó bypass cả hai lớp guard (audit binding + eligibility) được mô tả ở `docs/architecture/02-delivery.md` §9.1, vì guard chỉ chạy trên tập `releaseable` mà project này chưa vào tập đó.
- **Thứ tự provision (bắt buộc trước deploy):** (1) Hyperdrive config thật cho mỗi database mỗi lane được provision và `id` thật (staging riêng, production riêng) dán vào `wrangler.jsonc` — `id` hiện là placeholder toàn số 0; (2) migrations pruner-role được áp trên database thật (serving từ CI runner — `docs/architecture/02-delivery.md` §3.1 — KHÔNG áp từ Worker, PN-14) kèm sweep quyền (`apps/auth/migrations/README.md` §"Sweep kiểm tra quyền" ô 2d và `apps/account/db/README.md`); (3) connection string Hyperdrive mỗi lane dùng đúng role pruner của kho nó. Deploy với `id` placeholder chỉ cho ra một Worker đỏ runtime mỗi tick — `outcome=not_configured` — đúng trạng thái báo đỏ sớm, KHÔNG phải một run "im lặng bỏ qua".

### 1.1 Checklist isolation staging/production (gate trước deploy)

Bảng dưới là trạng thái đo được trong repo hôm nay, không phải điều checklist yêu cầu. `—` nghĩa là chưa đủ điều kiện kiểm (chưa deploy). Yêu cầu chi tiết → `docs/architecture/02-delivery.md` §4; hình thức bảng khớp `transactional-mailer-job/03-operations.md` §1.1.

| Resource                                      | Trạng thái hôm nay                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Hyperdrive per-lane (`DB_AUTH`, `DB_ACCOUNT`) | **chưa thoả** — `id` placeholder toàn số 0 cho cả hai lane; phải có config + id riêng của mỗi lane                                            |
| Role pruner per-database                      | **chưa thoả** — `0014` / `0007` chưa áp trên database nào, sweep quyền chưa chạy                                                              |
| Cron trên runtime                             | **chưa thoả** — handler + `triggers.crons` đã có, nhưng chưa có deployment nào để kiểm                                                        |
| Identity tách biệt lane                       | **thoả ở config** — `stg-ecoma-auth-nonce-prune-job` / `ecama-auth-nonce-prune-job` nằm trong khối `env` tường minh; chưa confirm bằng deploy |
| Public ingress                                | **thoả** — `workers_dev: false`, không route; trạng thái này chỉ giữ nguyên nếu không ai thêm lại route/fetch export                          |
| Secret                                        | **N/A có chủ đích** — Worker không giữ secret nào; connection string sống trong Hyperdrive config, không phải Worker Secret                   |

- **Cross-lane là blocker.** Một binding trỏ vào Hyperdrive của kho production làm staging cầm credential pruner thật của kho prod — tức có `DELETE` production ngay từ Preview — cùng loại vi phạm isolation mà `docs/architecture/02-delivery.md` §4 cấm với D1/Queue/secret. Rule: khai `env.<lane>` riêng từng lane, KHÔNG dùng chung bất kỳ `id` nào.
- **Không rò secret qua đường khác:** connection string sống trong Hyperdrive config của Cloudflare account — KHÔNG được export ra `.env`, log, hay khối `vars` của Worker (Worker này không có khối `vars` nào cả).

### 1.2 Trạng thái của trigger — bốn tầng, phải phân biệt

Cơ chế trigger **đã chốt ở thiết kế**: scheduled handler của chính Worker này, thay cron GitHub Action áp dụng ở `docs/architecture/02-delivery.md` §3.1; bốn tầng dưới đây không được gộp thành một chữ "đã xong":

| Tầng                                | Trạng thái hôm nay                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1) Quyết định thiết kế**         | ✔ Cron Trigger `17 3 * * *`, chỉ `scheduled()`, KHÔNG `fetch` export — thay workflow cron GitHub cũ (issue #82)                                       |
| **(2) Cấu hình (`wrangler.jsonc`)** | ✔ `triggers.crons` khai `["17 3 * * *"]`, `workers_dev: false`, không route — đi cùng (3)                                                             |
| **(3) Implement (`scheduled()`)**   | ✔ `src/main.ts` export `scheduled()`; hai kho qua `Promise.allSettled` rồi rethrow `PruneJobConfigError` → `not_configured` log riêng trước khi throw |
| **(4) Xác minh trên runtime**       | ✖ Chưa xác minh — ngoài deploy matrix, không có deployment nào để kiểm                                                                                |

- Nhịp `17 3 * * *` hiện khai là giá trị khởi điểm lúc deploy, không phải con số đã load-test** — đổi nhịp là đổi ở `wrangler.jsonc` (§2). Tầng (4) vẫn còn: khai cron ở environment nào thì schedule đó chỉ được chạy với bindings của environment đó (checklist §1.1).
- Đừng đọc "03:17" như một bảo đảm về giờ chạy. Cron tick có thể dời theo tải hoặc bị bỏ; fact này KHÔNG có dòng riêng của Cron Triggers trong `docs/architecture/04-platform-facts.md` (chỉ còn GH2 ở §2.17 — của GitHub Actions, không transfer nguyên văn tài liệu đó sang Cron Trigger Cloudflare) và QU6 chỉ đo được trần consumer duration. Đồng nghĩa: bạn đo thấy run khuya vài giờ ở Past events là hành vi platform có thể chấp nhận, không phải bug.

---

## 2. Cron configuration

```text
cron             17 3 * * *     (kế thừa phút :17 của workflow cũ — GH2 của 04-platform-facts §2.17 khuyến nghị lệch :00; nhịp giữ nguyên để hành vi “mỗi ngày lúc giờ lệch round” không đổi khi đổi executor)
worker           ecoma-auth-nonce-prune-job (staging: stg-ecoma-auth-nonce-prune-job)
trần mỗi tick    scheduled handler trần 15 phút wall-clock (Cloudflare Workers platform; KHÔNG phải con số `timeout-minutes: 25` của workflow cũ — bảng tính ở 01-architecture.md §6)
```

- Một lần mỗi ngày là chính sách vận hành khởi điểm, không phải cam kết bảo mật (`01-architecture.md` §1 và §10). Thấy `cap_hit` lặp lại nhiều ngày (§6.3) → đánh giá lại nhịp; đổi nhịp là thay `wrangler.jsonc` một PR, không đụng thuật toán.
- Không có đường bật/tắt cron từ repo: cron dashboard layer của Cloudflare là cấu hình ngoài repo, và repo không sinh thay đổi nào về trigger sau merge PR này. Nếu muốn tạm dừng job, DISABLE cron trong Cloudflare dashboard — KHÔNG phải cách "xóa binding" để tắt job im lặng: thiếu binding là `not_configured` đỏ **rõ ràng** (fail closed), không phải job dừng an toàn.

---

## 3. Error classification và retry policy

**Đây là error matrix canonical của Worker này** — design rules ở `01-architecture.md` §7; handler phải trả lời đúng bảng dưới:

| Loại outcome        | Nhận diện                                                                                                      | Retry?                                 | Cron invocation đỏ? | Runbook                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------- | -------------------------------------------- |
| `ok`                | hết sạch lô (batches < MAX và lô cuối < BATCH_SIZE), hoặc probe=false khi chạm trần                            | —                                      | không               | Không cần                                    |
| `cap_hit`           | chạm trần (batches/seconds) mà probe còn backlog                                                               | Có — tự phục hồi ở tick kế (một ngày)  | Có                  | §6.3                                         |
| `db_unreachable`    | SQLSTATE connect-class (08000–08007, 05P01, 57P01–57P03) hoặc connect-failure tầng driver hết `MAX_ATTEMPTS=3` | Có, bounded + backoff 5s/10s trong run | Có                  | §6.6                                         |
| `statement_failed`  | mọi SQLSTATE khác — gồm `42501` thiếu quyền, `57014` statement_timeout, ràng buộc                              | KHÔNG                                  | Có                  | §6.1 / §6.2                                  |
| `identity_mismatch` | preflight trả shape khác expected (`ecoma_auth_nonce_pruner\|deletable` v.v.)                                  | KHÔNG                                  | Có                  | §6.2 — đúng fail-closed, DSN dán sai bị chặn |
| `not_configured`    | thiếu Hyperdrive binding / caps cấu hình sai                                                                   | KHÔNG                                  | Có                  | §6.4 — đúng khi hạ infrastruct chưa đủ       |
| `unexpected_output` | output sai shape từ server (preflight/probe/batch)                                                             | KHÔNG — retry chỉ lặp lại shape sai    | Có                  | §6.5                                         |

- **Bắt buộc phân tách, không gộp:** `cap_hit` là trạng thái **chưa xong**, KHÔNG phải lỗi hệ thống; `identity_mismatch` và `not_configured` là fail-closed, KHÔNG phải "thử lại cho qua" — gộp về "có run nào OK" là che một kho đã hỏng (`01-architecture.md` §12 / PN-12).
- **Lỗi một kho KHÔNG cản kho kia chạy/log:** `Promise.allSettled` chạy cả hai kho, cả hai kết quả đều được log, sau đó rethrow — run đỏ theo đúng nguyên nhân của kho hỏng; kho còn lại đã chạy thành công nếu có đọc được từ log.

---

## 4. Observability

- **Log:** mỗi kho một dòng JSON một dòng qua `console.log`; một run có tối đa 8 dòng (`nonce_prune` ok × 2, `nonce_prune_error` × 2, `nonce_prune_retry` mỗi attempt). `pruned=`/`batches=` trong **mọi** dòng là số đếm **thật** đã xoá tới thời điểm log (một lô đã commit trước lúc hỏng phải được đếm), KHÔNG `0` cứng — chính sách này chặn một log nói "chưa xoá gì" trong khi hàng trăm nghìn row đã biến mất. Chi tiết shape + những gì bị cấm log → `01-architecture.md` §8.
- **Cron dashboard → Past events: tín hiệu đỏ của chuẩn "invocation thành công" duy nhất.** Throw của `scheduled()` được ghi tại đây — bao gồm cả `NotConfigured` — nghĩa là những run đỏ runtime hiện trên dashboard. KHÔNG `ctx.waitUntil` cho đường chính (PN-11), vì `waitUntil` che lỗi ra khỏi trạng thái đó.
- **Log bị bật: `observability.enabled: true`** trong `wrangler.jsonc` — visibility của dòng JSON trong dashboard/wrangler tail là nguồn đọc của runbook. KHÔNG log nonce, secret, connection string (PN-9).
- **`wrangler tail`:** dùng để đọc log từng telemetry tick khi cần; `pnpm nx serve @ecoma-io/auth-nonce-prune-job` (wrangler dev) chỉ chạy dev local, KHÔNG dùng để kiểm production.
- **Alert rule:** chưa được define (observability plane chung của repo chưa có dataset nào cho Cron Trigger / Worker — `docs/architecture/03-operations.md` §4 mô tả dataset chung; việc gắn alert là một thay đổi riêng của tài liệu alert, KHÔNG phải phần của PR này). Tối thiểu để thấy lỗi ngay hôm nay: Cron dashboard red dot. Workflow GitHub cũ từng có email failure notification cho một job đỏ — cơ chế đó hết hiệu lực khi file workflow bị xoá, nên sự mất đi alert email là thay đổi hành vi được ghi ở rollout §5.

---

## 5. Rollout

Rollout/rollback chung của Worker version → `docs/architecture/02-delivery.md` §7–8. Riêng cho job này:

- **Roll forward là chế độ duy nhất cho data:** job không giữ state nào; lỗi cấu hình/permission được sửa ở deploy kế tiếp, run đứt giữa chừng thì tick kế tiếp tiếp tục (mỗi lô tự commit, PN-10). KHÔNG có "checkpoint cần reset" trước re-run.
- **Rollback về GitHub Action KHÔNG đòi giữ file cũ:** workspace workflow file đã bị xoá khỏi repo trong PR này (cùng PR đổi cơ chế); nếu thật sự cần quay về cơ chế GitHub, recover từ git history bằng một PR `others` tách. KHÔNG giữ một bản copy của YAML để "ký gửi cho chắc" — file chết trong cây là một nguồn cấu hình sai lệch.
- **Deploy production thật phải sau khi**: (a) Hyperdrive id thật được điền cho lane production riêng, (b) migrations `0014`/`0007` được áp live prod + sweep quyền pass, (c) identity preflight một tick đầu tiên trả đúng `deletable`. Trước đủ ba điều kiện đó, deploy production là deploy vào một run chắc chắn đỏ — chỉ làm khi có chủ ý để chứng minh fail-closed.
- Thay đổi caps / nhịp / thuật toán → một PR chung đổi `src/config.ts` (loader) hoặc `libs/auth-nonce-prune-job-application/src/prune-caps.ts` + `prune.ts` của lib (nếu thuật toán), `config.spec.ts` tương ứng, bảng §6 của `01-architecture.md`, và bảng đó PHẢI khớp code (docs là spec).

---

## 6. Common failure modes

### 6.1. `statement_failed` với `42501`

Thiếu quyền — role pruner chưa đủ `SELECT, DELETE` trên đúng bảng, hoặc connection string của Hyperdrive đang là role khác. **Fail closed đúng thiết kế.** KHÔNG fix bằng cách nới quyền runtime hay pruner để "cron chạy được" — nới một quyền của pruner là mở cửa sổ replay (`0010` học thuyết). Đường đúng: migrations + sweep quyền (`apps/auth/migrations/README.md` §"Sweep kiểm tra quyền" ô 2d), rồi tick kế tiếp sẽ qua. KHÔNG xoá migration/role để tạm chạy.

### 6.2. `statement_failed` với `57014` (`statement_timeout`)

Một lô giữ khoá đủ 60 s chưa xong = dữ liệu quá lớn / plan xấu / index bị lạc; KHÔNG retry (thử lại chỉ kéo dài giữ khoá hơn). Diagnose: chạy `EXPLAIN` trong runbook tay thôi (bằng `ecoma_auth_nonce_pruner`) xem plan có giữ Index Scan pkey của pattern `nonce = ANY (ARRAY(SELECT …))` như script cũ không; plan đổi thành Seq Scan là dấu hiệu planner đổi — xem lại query shape (`01-architecture.md` §5). KHÔNG tăng `STATEMENT_TIMEOUT_SECONDS` để "chạy hết" — nó che triệu chứng, và trần 60 s là giới hạn Hyperdrive platform (HD10) nên vượt cũng vô nghĩa.

### 6.3. `cap_hit` lặp lại nhiều ngày liên tiếp

Xoá rate không theo kịp lưu lượng sinh nonce, hoặc index `expires_at` bị mất hiệu lực. Diagnose theo thứ tự: (1) `EXPLAIN` các lô — kế hoạch phải là Index Scan trên `expires_at`; (2) một tick đầu tiên sau khi deploy có chiếm `cap_hit` là **bình thường** (backlog tích từ trước), hai ba tick kế phải hết; còn lặp lại nghĩa là nhịp ngày không đủ — tăng nhịp (ví dụ 2 lần/ngày) là thay đổi chính sách vận hành trên `wrangler.jsonc` (§2), không phải đổi caps.

### 6.4. `not_configured`

Thiếu Hyperdrive binding (config chưa dán vào `env.<lane>`), hoặc binding có mà id là placeholder. Message lỗi nêu **tên binding** (`src/config.ts`), đủ để xác định chỗ sửa mà không lộ giá trị nào. KHÔNG đọc `not_configured` là "job im lặng bỏ qua" — nó là fail có log, đúng fail-closed ở trạng thái infra chưa đủ (§1 thứ tự provision).

### 6.5. `unexpected_output`

Output sai shape từ server — đúng loại: preflight trả thừa/thiếu cột, `count(*)` của batch không phải số nguyên, probe không phải boolean. Nguyên nhân có khả năng: server phiên bản khác format output, hoặc Hyperdrive/driver cần lại row shape. KHÔNG retry — một shape sai là shape sai lặp lại. Sửa phải ở code của app, hoặc driver/platform cần xác nhận lại (`01-architecture.md` §7).

### 6.6. `db_unreachable` nhiều tick liên tiếp

SQLSTATE connect-class hoặc errno tầng driver (`ENOTFOUND`, `ECONNREFUSED`) hết ngân sách retry. Kiểm: Hyperdrive config có trỏ đúng instance host không, host database còn sống không, connection string Hyperdrive còn hạn hay role đã bị rotate/drop; nếu Hyperdrive hay host thay đổi, cấu hình connection string trong Hyperdrive config là chỗ sửa, KHÔNG ở repo. Lỗi kéo dài nhiều ngày là câu hỏi vận hành hạ tầng, không phải bug code.

### 6.7. Log vắng hoặc Past events đỏ không có JSON liên quan

Throw ngoài các path được nhắc ở trên (driver version đổi, runtime platform thay đổi): đọc log từng dòng JSON theo thứ tự thời gian; nếu không thấy dòng JSON nào mà Past events đỏ nghĩa là Worker throw trước khi kịp log đầu — dò qua `wrangler tail` với phiên bản dev tương đương để tái hiện lỗi cục bộ.

---

## 7. Runbook chạy tay (drain gấp) và liên hệ với Worker

- **Worker không có đường chạy tay:** không `workflow_dispatch`, không HTTP endpoint — một HTTP surface hay một đường CLI bypass guard đều là một ranh giới mới không được tài liệu (`01-architecture.md` §3). Drain gấp dùng runbook chạy tay trong [`docs/applications/auth/03-operations.md`](../auth/03-operations.md) §3.3 đoạn "Prune (runbook)" cho `db-auth` (bằng role `ecoma_auth_nonce_pruner`) và [`docs/applications/account/03-operations.md`](../account/03-operations.md) §3.3 cho `db-account` (bằng role `ecoma_account_nonce_pruner`), KHÔNG dùng `_migrator`, KHÔNG thêm quyền runtime.
- **Phân biệt runbook tay với Worker:** runbook tay là một Kho (kho Auth) — một người với một credential đúng; Worker là hai kho, mỗi kho một preflight - một batch + một probe + log JSON. KHÔNG "mượn tay Worker" bằng cách import code Worker vào đâu khác hay ngược lại: code của Worker chỉ được nhập từ application lib `@ecoma-io/auth-nonce-prune-job-application` của nó.
- **Giới hạn thời gian tay:** operator chạy tay không bị trần 15 phút như Worker — nhưng runbook tay chỉ nên chạy vài lô rồi dừng, không thay thế Worker trong dài hạn.
