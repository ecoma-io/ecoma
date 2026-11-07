# Worker Local Runtime — E2E Evidence (PR5)

> Spike ban đầu: [`./worker-runtime-spike.md`](./worker-runtime-spike.md).
> Quy tắc chung: mọi thao tác với local stack đọc [`../03-operations.md`](./../03-operations.md).

## Bối cảnh

PR4 (#35) orchestration + ba lệnh CLI `local-worker-up/status/down` đã có unit test 641 test,
nhưng chưa có **bằng chứng E2E trên wrangler thật**: hai process `wrangler dev` thật boot,
service binding `[connected]`, migration D1 thật, readiness thật, và internal HMAC auth thật.
PR5 là bằng chứng E2E cộng thêm hai fix nhỏ (fix `.dev.vars` → `--env-file` ở mục 5, và
allowlist `gitleaks` cho log wrangler nhúng request headers
(`<stateDir>/.wrangler-home/.wrangler/logs/`) cùng `.dev.vars` của các app — chi tiết mục 5;
commit này cũng đính kèm).
Ngày đo: 2026-10-20 (UTC; phần sau ghi 2026-10-21 +07 — cùng phiên đo) · wrangler 4.151.2 ·
worktree `shovelnose` (namespace `wc75a6e628882`).

## Luồng E2E đã chạy, từng bước theo thứ tự

### 1. Bring up — `pnpm dx local-worker-up`

```
worker transactional-mail ready at http://127.0.0.1:22735/ (pid 469020)
worker transactional-mailer-job ready at http://127.0.0.1:43996/ (pid 469313)
worker runtime up (namespace wc75a6e628882, persist /.../.worker-local-state)
```

- Hai process `wrangler dev` thật trong `ps` (node → `wrangler-dist/cli.js` → `workerd serve`,
  mỗi entry một cặp workerd).
- CLI exit `0` ngay sau readiness, **process con sống tiếp** — detached spawn hoạt động:
  drain-release của orchestration giải phóng pipe read-end, event loop CLI không giữ handle.
- Control plane (`transactional-mail`) boot **trước** consumer để service binding của
  `transactional-mailer-job` tìm thấy peer (`[connected]`).
- Idempotency guard chạy đúng: `up` lần hai khi runtime đang sống → error kèm
  hướng dẫn `local-worker-down`.

### 2. Status — `pnpm dx local-worker-status`

- Đúng hai entry `alive`, `standard: true`, `generatedConfigExists: true`,
  pid khớp với `ps`, đúng file generated config theo tên Worker thật `ecoma-*`.

### 3. Control-plane health HTTP thật

`GET http://127.0.0.1:22735/health` → HTTP 200
`{"service":"transactional-mail","status":"ok","time":"…"}` — `/health` trả mà **không chạm D1**
(khớp 04-worker-runtime-spike.md §2). Readiness của orchestration dựa `/health`, không phải bản output
boot.

### 4. Cron manual trigger thật

```
POST 'http://127.0.0.1:43996/cdn-cgi/local/scheduled?format=json&cron=*/5%20*%20*%20*%20*'
  → {"outcome":"ok","noRetry":false}  HTTP 200
```

(Nguyên khởi đo trên terminal là query thô `cron=*/5 * * * *` — curl tự encode khoảng
trắng trước khi gửi; ghi ở đây dạng đã URL-encode để copy-paste một lần chạy được.)

- Endpoint này **cần luôn query `format=json&cron=…`** — POST trần trả HTTP 500 `exception`
  (đã đối chiếu nguồn wrangler 4.151.2: `scheduled()` nhận cron query).
- Cron local **không tự chạy** theo nhịp (spike §3 vẫn đúng); đây là đường trigger duy nhất
  khi dev; producer/consumer đều hoạt động qua CLI nếu muốn.

### 5. Cách ly env — `.dev.vars` qua `--env-file`

Lỗi thật được đo trong E2E: `wrangler dev` resolve `.dev.vars` theo **dirname của config
file**, không phải `cwd`. Config generated nằm ở `<stateDir>/generated/` chung cho hai entry,
copy `.dev.vars` sang đó sẽ khiến dev.vars của entry thứ hai đè của entry đầu. Fix
trong PR5: orchestration spawn `wrangler dev` với `--env-file <appDir>/.dev.vars` **duy nhất
khi file tồn tại**, mỗi entry đọc đúng env của chính mình.

File `.dev.vars` của app (đã `.gitignore` — `.env*`/`.dev.vars*`):

- consumer (`apps/transactional-mailer-job`):
  - `MAIL_PROVIDER_KIND=fake` (provider test; khỏi rò credential production)
  - `MAIL_PROVIDER_TIMEOUT_MS`, `MAIL_JOB_MAX_EXECUTION_ATTEMPTS=4` (≥ `max_retries + 1`),
    `MAIL_JOB_EXECUTION_LEASE_MS`, `MAIL_JOB_REPORT_LEASE_MS`,
    `MAIL_JOB_MAX_REPORT_ATTEMPTS`, `MAIL_JOB_SWEEP_BATCH_LIMIT`,
    `MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS` (bắt buộc, ≤ 24h — trần advisory cửa sổ
    `Idempotency-Key` mà provider tài liệu hoá; loader fail-closed không default)
  - `MAIL_QUARANTINE_HMAC_KEY` = chuỗi hex 64
  - `TRANSACTIONAL_MAIL_INTERNAL_AUTH_SECRET` giá trị **phải trùng**
    `MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB` bên control plane.
- control plane (`apps/transactional-mail`):
  - `MAIL_FINGERPRINT_KEYRING` (JSON `{"current","keys"}` — `current` là
    `<profileTag>.<keyTag>` ví dụ `p1.k1` và phải tồn tại trong `keys`; mỗi key hex 64)
  - bốn secret `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT|AUTH|PAYMENT|TRANSACTIONAL_MAILER_JOB`
  - toàn bộ `MAIL_RATE_LIMIT_*`, `MAIL_RENDER_MAX_BYTES`, `MAIL_PUBLISH_*`,
    `MAIL_RECONCILER_*`, `MAIL_RECOVERY_MAX_CYCLES`, `MAIL_NONCE_PRUNE_BATCH_LIMIT`,
    `MAIL_RETENTION_*`

Thiếu biến nào → boot vẫn thành công (config load lazy) — nhưng request/cron thật cho
500 + `TransactionalMailConfigError`/`MailerJobConfigError` trong log wrangler
(`<stateDir>/.wrangler-home/.wrangler/logs/`). `/health` vẫn 200 trong tình trạng này vì
route health không chạm config loader.

### 6. Migration D1 thật

Log wrangler consumer cho thấy `0001_mail_jobs.sql` áp thành công trên D1 `mail-job` ở
`<persist>/v3/d1`. Bỏ qua migration idempotency.

### 7. Internal HMAC auth thật (Flow message create)

Script node một lần (không vào repo — thủ tục lặp lại ghi ở mục "Cách lặp lại E2E này"):
dựng canonical envelope `ecoma-internal-v1` theo spec chuẩn hoá trong
`docs/applications/transactional-mail/01-architecture.md` §7.1 (`method` lowercase, length-prefix
byte UTF-8, delimiter `\n`) — không tái mô tả tắt tại đây; HMAC-SHA-256, kết quả gắn vào
`x-ecoma-internal-{timestamp,nonce,signature}` rồi gọi:

```
POST /v1/messages  → HTTP 403 (kí bằng mailer-job secret — đúng quy tắc: họ không có
                     quyền message.create)
POST /v1/messages  → HTTP 400 (thiếu Idempotency-Key — đúng transactional-mail/
                     02-requirements.md FR-001)
POST /v1/messages  → HTTP 404 (template chưa seed — đúng transactional-mail/
                     02-requirements.md FR-001, code `template_not_found`)
POST /v1/messages  → HTTP 201 sau khi seed template
  {"id":"msg_…","delivery_id":"dlv_…","app":"account","template":"welcome",
   "template_version":1,"status":"accepted","created":true,…}
```

Bốn lần gọi này chứng minh: signature envelope `ecoma-internal-v1` vẫn khớp giữa script
node và `verifyRequest` trong `transactional-mail`; parameter `principal` được suy đúng từ
credential (not from header); permission check `message.create` hoạt động; seed bên dưới
qua `wrangler d1 execute` trên cùng persist dir.

### 8. End-to-end message → outbox → queue → consumer → sent

Sau `POST /v1/messages` 201:

- trigger publish loop của control plane (`/cdn-cgi/local/scheduled?…`) → rồi trigger
  scheduled của consumer → sau đó đọc trực tiếp trong D1 local bằng
  `wrangler d1 execute … --local --persist-to`:
  - D1 `mail`: `mail_outbox.delivery_id = dlv_…`, `status = "published"`
  - D1 `mail-job`: `mail_jobs.delivery_id = dlv_…`, `status = "sent"`, `attempts = 1`
  - D1 `mail`: `mail_messages.status = "sent"` cho message vừa tạo.

Chuỗi này là **đường message thực tế trong môi trường local**, không mock: control plane
publish envelope đi qua Queue thật của wrangler dev, consumer grab message, đánh `sent`,
và `mail_messages.status` đồng bộ sau khi consumer báo cáo outcome.

### 9. Teardown — `pnpm dx local-worker-down`

```
worker transactional-mail: alive → terminated
worker transactional-mailer-job: alive → terminated
worker runtime down (2 entries)
```

- `pgrep -f wrangler` về 0 sau khi exit — hai process Worker thật kết thúc, **không orphan**.
- Metadata `.worker-local-state/*.json` sạch.

### 10. Lifecycle event ingest (PR3)

PR2 thêm consumer `ecoma-mail-lifecycle-events` với producer là Cloudflare
Event Subscriptions — cơ chế platform không thể có trong local dev. PR3 kiểm
đường ingest bằng một fixture producer worker do E2E script sinh tạm trong
`<stateDir>/e2e-fixture/` (config không vào repo): session `wrangler dev` thứ
ba này publish message vào queue qua producer binding, và vì nó không có
consumer nào, miniflare forward message qua dev-registry `ExternalQueueProxy`
sang session `transactional-mailer-job` đang consume cùng queue — cùng cơ chế
giao chéo process đã chứng minh ở mục 8 (dev registry là per-worktree vì cả
orchestration lẫn script cô lập `HOME`/`XDG_CONFIG_HOME` vào cùng
`<persistTo>/.wrangler-home`).

Ba message kiểm ba hành vi của ingest:

- `delivered` khớp `provider_message_id` của fake provider → 1 row
  `mail_lifecycle_events`, `delivery_id` correlate về đúng delivery.
- Cùng event giao hai lần (cùng `event_id`) → vẫn 1 row (dedupe theo PK).
- Payload JSON cắt cụt → row `quarantine` reason `lifecycle-event-invalid`.

Từ PR3, marker `local-worker.jsonc` của `transactional-mailer-job` khai
`external_queue_producers: ["ecoma-mail-lifecycle-events"]` — orphan-queue
guard của discovery miễn queue này (producer ngoài repo là tuyên bố topology,
không phải thiếu sót cấu hình); guard vẫn fail khi queue vừa khai external
vừa có producer trong repo.

## Cách lặp lại E2E này

Từ PR3 (#212), toàn bộ luồng trên là một script trong repo, lặp lại được:

```
node tools/dx/scripts/mail-worker-runtime-e2e.mjs
```

Script tự thực hiện: ghi `.dev.vars` hai app (mục 5), `local-worker-up --entry
transactional-mail,transactional-mailer-job` (Sub Directed Boot — chỉ boot hai
entry mail; list bắt buộc comma-separated vì citty/`node:util.parseArgs` collapse
flag lặp lại), kiểm readiness + `/health`, POST `/v1/messages` (403 sai principal,
201 đúng principal), trigger cron cả hai worker để chạy đủ đường message →
outbox → Queue → `mail_jobs` → report → `mail_messages` (mục 7–8), kiểm ingest
lifecycle event (mục 10), rồi teardown (`local-worker-down` + assert không còn
process orphan của worktree). Exit 0 chỉ khi mọi bước đạt; script tự teardown
trong mọi nhánh kể cả fail.

Yêu cầu trước khi chạy: hai app mail và `account-bridge` đã build (`dist/main.js`
tồn tại — generated config trỏ thẳng vào dist).

Thủ tục thủ công bên dưới giữ lại cho việc gỡ lỗi từng bước riêng lẻ:

1. Tạo `.dev.vars` cho hai app (mục 5) — mỗi app có tập key riêng; chỉ các key trùng nhau
   giữa hai app phải có giá trị khớp.
2. `pnpm dx local-worker-up`
3. Seed template (lần đầu) — INSERT vào `mail_templates` bằng
   `wrangler d1 execute mail --local --persist-to <stateDir> --config
   <stateDir>/generated/ecoma-transactional-mail.wrangler.jsonc --command "<SQL>"
   --json` (generated config của control plane — binding `mail`; file JSON sinh
   bởi orchestration, không phải `.toml`). Từ PR2, template seed
   `tpl-account-login-otp-en` tự áp qua migrations của control plane — bước này
   chỉ cần cho template khác.
4. Đọc `/health`, trigger `/cdn-cgi/local/scheduled`, hoặc script `POST /v1/messages` tuỳ ý.
5. Sau kịch bản, `pnpm dx local-worker-down` sạch.

## Giới hạn đã biết

- Cron không tự chạy theo nhịp trong `wrangler dev` (spike §3); mỗi lần kiểm thử cần
  trigger thủ công qua `/cdn-cgi/local/scheduled?format=json&cron=…`.
- Queue transport thật của Cloudflare không có trong local dev — producer ghi vào queue local
  trong persist dir, consumer polling của `wrangler dev` tiêu (spike §3).
- Mỗi app có tập `.dev.vars` riêng (mục 5); các key trùng nhau giữa hai app phải có giá trị khớp
  (ví dụ `TRANSACTIONAL_MAIL_INTERNAL_AUTH_SECRET` bên consumer =
  `MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB` bên control plane). Production dùng
  Worker Secrets đúng cách, không đọc `.dev.vars` (wrangler chỉ đọc nó khi `wrangler dev` local).
- Queue `ecoma-mail-lifecycle-events` có producer ngoài repo (mục 10) — trong local,
  đường này chỉ kiểm được bằng fixture producer do E2E script sinh tạm (config không vào
  repo); lifecycle event thật từ Event Subscriptions không thể có local.
