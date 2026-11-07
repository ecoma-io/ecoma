# Vận hành — Transactional Mail (control plane)

> **Phạm vi:** triển khai, cấu hình/secrets, migration D1, monitoring/alerting, failure handling, recovery, runbook của `transactional-mail`.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · constraint toàn hệ thống → `docs/architecture/`.

Deploy unit là Cloudflare Worker `transactional-mail` (module worker): internal API qua Service Binding `TRANSACTIONAL_MAIL_SERVICE`, không public hostname — `workers_dev: false` ở mọi environment là **điều kiện readiness** chứ không phải trạng thái hiện tại (§2 checklist). Mỗi environment (`development`, `staging`, `production`) dùng D1 `mail`, Queue `ecoma-mail-delivery`, configuration và secrets độc lập. Secret của service là Worker Secret, không vào Git, PR build hay Preview runtime cho production.

## 1. Runtime

`transactional-mail` là Cloudflare Worker nội bộ (không hostname riêng); thiết kế → [`01-architecture.md`](./01-architecture.md).

```text
transactional-mail
├── Cloudflare Worker (HTTP private + publish loop, reconciler, nonce prune,
│                      retention chạy trong scheduled handler — wiring đã tồn tại: §1.1)
├── Cloudflare D1 `mail` (gồm kho nonce internal-auth — release-gated)
└── Cloudflare Queue producer `ecoma-mail-delivery`
```

- D1 `mail` là domain state duy nhất của service (owner: control plane). Không path nào từ service khác tới D1 `mail`; delivery worker truy cập qua private interface (Service Binding `TRANSACTIONAL_MAIL_SERVICE`).
- Migration D1 bằng `wrangler d1 migrations` (chạy theo track D1 trong `docs/architecture/02-delivery.md` §3). Control plane sở hữu migrations của D1 `mail`, và schema thay đổi theo expand → compatible rollout → contract. Migration comment là English, kể cả `COMMENT ON` text (per root `AGENTS.md`; migration comment chỉ đổi comment thì sửa tại chỗ, không cần forward-fix). D1 **không** thuộc Backup/DR scope — dữ liệu có thể mất, service recover ở mức service; chính sách → `docs/architecture/03-operations.md` §3.1.
- Control plane **không** sở hữu provider credential; credential và endpoint của relay là Worker Secret của `transactional-mailer-job`. Private interface chỉ trả runtime data, không credential.

### 1.1. Trạng thái của scheduled trigger — bốn tầng, phải phân biệt

Cơ chế trigger **đã được chốt ở thiết kế**; tầng (1)–(3) hiện đã hoàn thành ở repo, tầng (4) vẫn còn. Hai điều này không thay thế nhau, và tài liệu không được mô tả tầng (4) như thể đã xong. Bảng ở đây là **góc nhìn gate cặp service**; trạng thái chi tiết của cột worker là canonical ở `docs/applications/transactional-mailer-job/03-operations.md` §1.2.

| Tầng                                | Publish loop + reconciler (tài liệu này)                                                    | Report sweep + job reconciliation (worker)                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **(1) Quyết định thiết kế**         | ✔ Scheduled handler của chính Worker này (`01-architecture.md` §6.3, `architecture/03` §10) | ✔ Scheduled handler của chính Worker (`docs/applications/transactional-mailer-job/03-operations.md` §10) |
| **(2) Cấu hình (`wrangler.jsonc`)** | ✔ `triggers.crons` đã khai (`*/5 * * * *`) — đi cùng (3)                                    | ✔ `triggers.crons` đã khai — cùng nhịp                                                                   |
| **(3) Implement (`scheduled()`)**   | ✔ `src/main.ts` export `scheduled()` — publish → reconciler → nonce prune → retention       | ✔ `src/main.ts` export `scheduled()` — report sweep → stale lease → blocked backlog                      |
| **(4) Xác minh trên runtime**       | ✖ Chưa xác minh — app ngoài deploy matrix, không có deployment từ pipeline để kiểm          | ✖ Chưa xác minh — cùng lý do                                                                             |

- **Nhịp `*/5 * * * *` là giá trị khởi điểm lúc deploy, không phải con số đã load-test.** §3 liệt kê nó trong nhóm giá trị vận hành chốt ở deploy; khi đổi nhịp thì đổi ở `wrangler.jsonc` của environment tương ứng, không phải ở tài liệu này.
- **Queue là wake-up signal, không phải authority** (`architecture/03` §11.3): một scheduled run phục hồi từ durable state của chính D1 `mail` (`mail_messages` + `mail_outbox`), **không** từ Queue. Queue rỗng hay đã hết retention (QU5) không làm mất việc đã enqueue — đó chính là lý do reconciler phải chạy định kỳ.
- **`POST /internal/outbox/publish` vẫn không phải đường backup đã sẵn sàng** — nó chưa tồn tại: xem §5.1.
- Chưa có lane `env.staging`/`env.production` nào được khai → Worker chưa có identity cho hai làn deploy, và app nằm ngoài deploy matrix (`tools/delivery/config/deploy-eligibility.jsonc`). Điều kiện readiness trước khi vào matrix → §2.1.

---

## 2. Deployment

Deployment của Worker phải đi kèm (theo `wrangler.jsonc`):

- D1 binding `mail` (`database_name: mail`) — `database_id` do provisioning hạ tầng cung cấp (`docs/architecture/02-delivery.md` §9.1), **không** tự tạo D1 bằng `wrangler d1 create`.
- Queue producer `ecoma-mail-delivery` (binding `QUEUE`).
- Observability enabled.
- Scheduled handler + `triggers.crons` — **đã có ở repo** (§1.1 tầng (2)–(3)); tầng (4) xác minh trên runtime của từng environment vẫn còn và là điều kiện readiness (§2.1).

Control plane **không** có Worker Secret nào tới mail relay — credential và endpoint của relay là Worker Secret của `transactional-mailer-job` (`MAIL_PROVIDER_TOKEN`, `MAIL_PROVIDER_ENDPOINT`). Control plane chỉ authorizes delivery và trả runtime data; nó không giữ credential. Secret của riêng control plane mà tài liệu này **đã định nghĩa** gồm **hai mục**, không phải một: (1) keyring HMAC cho `request_fingerprint` — không liên quan relay, không dùng chung với credential provider hay khoá auth của private interface (`02-requirements.md` FR-002); và (2) **credential registry internal-auth** — Worker Secret chứa credential của **từng** consumer (`svc.account`, `svc.auth`, `svc.payment`, `svc.transactional-mailer-job`), theo quyết định receiver ở `01-architecture.md` §7.4 — cùng một migration tạo **kho nonce bền vững** trong D1 `mail` mà contract đòi cho mỗi service nhận request. Vì HMAC là đối xứng, **mỗi entry trong registry cũng là một credential ký được** request tới interface production: chúng phải được liệt kê tường minh ở checklist cô lập bên dưới, **không** được ngầm coi là thuộc mục (1), và **không** được dùng chung giá trị giữa hai principal (xung đột → chặn lúc khởi động). Hai mục này chưa tồn tại ở runtime; checklist deploy ở dưới đây là gate, không phải mô tả trạng thái hiện tại.

Kiểm tra sau deploy:

```text
GET /health → { service: 'transactional-mail', status: 'ok', time }
```

Test smoke: tạo message với app thật → assert `201` → đợi outbox publish → assert message `queued`/`sent` theo delivery worker.

Rollback theo Worker version đã publish, không rollback D1 — `docs/architecture/02-delivery.md` §7–§8.

**Deployment readiness gate (Preview/Production isolation):** trước khi production phải kiểm và ngăn cross-environment truy cập theo bảng dưới đây. **Cô lập không phải thứ được đảm bảo bởi tài liệu này** — tài liệu ghi yêu cầu; runtime configuration và binding phải **enforce** chúng, và một mục chưa thoả là blocker release. Checklist theo resource của delivery worker → `docs/applications/transactional-mailer-job/03-operations.md` §1.1.

Cột **Trạng thái hôm nay** ghi đúng điều **đo được trong repo**, không phải điều checklist yêu cầu: `—` nghĩa là chưa đủ điều kiện để kiểm (chưa có deployment), `chưa thoả` nghĩa là cấu hình hiện tại vi phạm yêu cầu. Bảng này không phải bằng chứng đã qua gate.

| Resource / environment                                                         | Yêu cầu                                                                                                                                                                                                                     | Trạng thái hôm nay                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue `ecoma-mail-delivery` (Preview)                                          | Preview không được produce vào Queue/DLQ production, và không dùng D1 `mail`/`mail-job` production (rủi ro **PW5**: Preview produce → Queue production bị production consumer xử lý)                                        | **chưa thoả** — chưa khai `env.*`; binding Queue chỉ có ở top level, không có lane nào để kiểm cô lập                                                   |
| Service Binding (Preview)                                                      | Không được gọi deployment **production** của service nào đó để gây side-effect cross-environment (lớp **PW4** — platform fact **khác** PW5, phải kiểm riêng)                                                                | **chưa thoả** — chưa khai `env.*`                                                                                                                       |
| Scheduled trigger/Cron (mỗi environment)                                       | Schedule khai ở environment nào thì chỉ được chạy với bindings của environment đó; không đặt Cron trigger trên deployment Preview trỏ resource production (PW5); kiểm trên **runtime configuration**, không đọc repo config | **chưa thoả** — `triggers.crons` + `scheduled()` đã có ở repo (§1.1), nhưng chưa khai `env.*` nên chưa có deployment nào để kiểm trên runtime           |
| D1 `mail` + kho nonce (Preview vs production)                                  | **Không bao giờ** bind D1 production vào Preview (`docs/architecture/02-delivery.md` §5.2); kho nonce là resource phải cô lập, không chỉ là secret — **không** viện dẫn PW5 cho mục này                                     | **chưa thoả** — chưa khai `env.*`; `database_id` chưa được provisioning                                                                                 |
| Credential relay (`MAIL_PROVIDER_*`)                                           | Secret của `transactional-mailer-job`, **không** phải của control plane — xem checklist của worker. Preview không được giữ production value                                                                                 | **chưa thoả** — chưa khai `env.*`, nên không có làn nào khai secret của nó                                                                              |
| Hai secret của control plane (keyring HMAC, credential registry internal-auth) | Preview không được giữ production value của chúng; **mọi entry credential trong registry per-consumer** (`01-architecture.md` §7.4) cũng phải tách tương ứng                                                                | **chưa thoả** — chưa khai `env.*`; §3 chỉ xếp credential registry internal-auth + kho nonce vào release-gated, còn keyring HMAC là bắt buộc thường trực |
| Public ingress (cả hai Worker)                                                 | `workers.dev` và mọi Preview URL không phục vụ production phải được disable trước production                                                                                                                                | **chưa thoả** — chưa khai `workers_dev: false`, nên mặc định vẫn có hostname `*.workers.dev` công khai (`docs/architecture/01-architecture.md` §6)      |
| Service Binding (Preview → production)                                         | "Chỉ dựa trên một binding" là không đủ; phải đánh giá độc lập public ingress, bindings và secrets cho Preview                                                                                                               | **chưa thoả** — chưa khai `env.*`                                                                                                                       |

Ba điểm phải giữ khi đọc bảng trên, và hay bị gộp sai:

- **PW4 và PW5 là hai platform fact khác nhau.** PW5 là Queue/Cron không target Preview (Preview produce vào Queue production). PW4 là Service Binding từ Preview gọi deployment production. Cả hai phải được kiểm riêng.
- **Kho nonce là resource phải cô lập**, không phải chỉ secret — căn cứ là `docs/architecture/02-delivery.md` §5.2, **không** phải PW5.
- **Không rò secret qua đường khác:** production secret không vào Git, PR build, hay Preview runtime (`docs/architecture/02-delivery.md` §6) — áp dụng cho mọi secret ở trên, không chỉ credential của relay.

### 2.1. Điều kiện readiness trước khi vào deploy matrix

Hai Worker hiện nằm trong `excluded` của `tools/delivery/config/deploy-eligibility.jsonc` và chưa khai `env.staging`/`env.production`. Việc đưa chúng vào matrix là một quyết định deploy, không thuộc phạm vi tài liệu này — nhưng các điều kiện sau phải hoàn thành trước đó, và **không** được coi là đã thoả chỉ vì checklist này tồn tại:

- Scheduled handler đã được implement (`scheduled()` + `triggers.crons` — §1.1); còn lại: chốt **giá trị** vận hành ở §3 trên từng environment — nhịp cron khai ở repo (`*/5 * * * *`) là khởi điểm, không phải con số đã load-test.
- Mỗi `env.<lane>` khai lại binding của chính nó (Wrangler **không** kế thừa binding top level vào named environment — `docs/architecture/02-delivery.md` §4.1) và không khai binding/resource của môi trường khác.
- `database_id` cho D1 `mail` do provisioning hạ tầng cung cấp (`docs/architecture/02-delivery.md` §9.1) — **không** tự tạo D1 bằng `wrangler d1 create`; Queue/DLQ theo `tools/delivery/config/queue-resources.jsonc`.
- Các mục release-gated ở §3 (credential registry internal-auth, kho nonce) chỉ qua gate **sau khi runtime implement xong** registry + kho nonce + middleware theo `01-architecture.md` §7.4 — merge contract canonical **không** tự động qua gate.
- Toàn bộ bảng ở mục 2 đã được kiểm trên **runtime configuration** từng environment.

---

## 3. Configuration

| Biến/Binding                      | Kiểu            | Bắt buộc                | Mô tả                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | --------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 `mail`                         | binding         | Có                      | Domain state của service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Queue producer `QUEUE`            | binding         | Có                      | Queue `ecoma-mail-delivery` — chỉ Outbox Publisher được send.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `TRANSACTIONAL_MAIL_SERVICE`      | Service Binding | Có                      | Binding mà `transactional-mailer-job` trỏ tới để gọi private delivery interface; không phải ingress public.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |     |
| `MAIL_FINGERPRINT_KEYRING`        | Worker Secret   | Có                      | Keyring HMAC cho `request_fingerprint` (có version) — JSON `{"current":"p1.k1","keys":{"p1.k1":"<64 hex chữ thường>"}}`; rotation = thêm key rồi đổi `current`, key cũ giữ lại để verify row đã persist (FR-002). Thiếu/sai → ném lỗi lúc boot, fail-closed (`02-requirements.md` FR-002).                                                                                                                                                                                                                                                                                                                           |
| `MAIL_INTERNAL_AUTH_SECRET_SVC_*` | Worker Secret   | Có (release-gated)      | **Credential registry theo từng consumer** — kho verify chữ ký cho **mọi** private/internal API của service (`01-architecture.md` §7.4). Mỗi principal một secret: `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT` / `SVC_AUTH` / `SVC_PAYMENT` / `SVC_TRANSACTIONAL_MAILER_JOB`; cửa sổ overlap khi xoay khoá khai thêm `..._PREVIOUS` (tuỳ chọn, duyệt sau `current` của cùng principal). Thiếu → `401` fail-closed, không có đường bypass; hai secret trùng giá trị (kể cả chéo `previous`) → chặn lúc khởi động vì envelope không mang principal. **Chưa provision ⇒ Worker không boot; không có giá trị để đặt "tạm".** |
| Kho nonce trong D1 `mail`         | table/migration | Có (release-gated)      | Bảng nonce bền vững mà contract PR #197 đòi cho **mỗi service nhận** request — dùng để claim nonce (`INSERT … ON CONFLICT DO NOTHING`) và fail-closed `503` khi kho không đọc được. **Migration đã tồn tại** (`apps/transactional-mail/migrations/0004_mail_internal_nonces.sql`) và **middleware receiver đã dùng nó** (`src/internal-auth.ts` — claim nonce trong chính verify); gate vẫn release-gated tới khi được xác minh trên runtime (§1.1 tầng (4)).                                                                                                                                                        |
| `MAIL_INTERNAL_AUTH_SKEW_SECONDS` | Worker Secret   | Không (khuyến nghị set) | Cửa sổ skew của envelope internal, **giây**, chuỗi chữ số, trong `[MIN, MAX]` của contract canonical. Vắng mặt → dùng default của contract; giá trị sai kiểu/sai kiểu số → ném lỗi lúc boot (không fallback ngầm giá trị nào khác).                                                                                                                                                                                                                                                                                                                                                                                  |
| `MAIL_TEMPLATE_URL_ALLOWED_HOSTS` | Var             | Có (có thể rỗng)        | Allowlist hostname cho URL template, phân tách bằng dấu phẩy. **Rỗng hoặc vắng mặt ⇒ không host nào được phép** — renderer fail-closed `503` khi gặp URL ngoài allowlist; không có default "cho phép tất cả".                                                                                                                                                                                                                                                                                                                                                                                                        |

Control plane **không** có Worker Secret nào tới mail relay: credential và endpoint của relay là cấu hình (Worker Secret) của `transactional-mailer-job` — canonical → `docs/applications/transactional-mailer-job/03-operations.md` §1. Nhờ vậy một rò rỉ ở control plane không lộ credential của provider, và control plane không cần rotation path cho relay. Control plane giữ **hai** secret riêng của nó — keyring `request_fingerprint` (fail-closed `503` khi thiếu — FR-002) và credential registry internal-auth (fail-closed `401` khi thiếu — `01-architecture.md` §7.4) — **không** dùng chung lẫn nhau, không dùng cho việc gì khác; ngoài ra còn cần kho nonce trong chính D1 `mail`. Mọi mục release-gated ở bảng trên phải được kiểm lại **sau khi runtime implement xong** registry + kho nonce + middleware theo `01-architecture.md` §7.4, trước khi coi gate này là qua — merge PR #197 **không** tự động qua gate.

**Giá trị vận hành (chốt ở deploy — canonical cho service này):** đây là cùng nhóm với bảng configuration ở trên, nhưng **không** phải secret/binding — tất cả là **biến bắt buộc, số nguyên dương, không có default ngầm**; thiếu mục nào thì Worker không boot (`src/config.ts` ném `TransactionalMailConfigError` lúc nạp) chứ không phải phần bound tương ứng chạy sai âm thầm. Tên biến đúng như loader đọc:

| Biến                                  | Bound ở `01-architecture.md` §6.5 / mục khác                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAIL_RATE_LIMIT_PRINCIPAL_LIMIT`     | Hạn mức tạo message theo principal (FR-004)                                                                                                   |
| `MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS` | Cửa sổ hạn mức principal                                                                                                                      |
| `MAIL_RATE_LIMIT_SYSTEM_LIMIT`        | Hạn mức toàn hệ thống                                                                                                                         |
| `MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS`    | Cửa sổ hạn mức hệ thống                                                                                                                       |
| `MAIL_RATE_LIMIT_KEY_LIMIT`           | Ngưỡng chặn probe `409` lặp trên cùng `(principal_id, idempotency_key)` — giới hạn theo **key** (FR-002)                                      |
| `MAIL_RATE_LIMIT_KEY_WINDOW_MS`       | Cửa sổ hạn mức theo key (FR-002)                                                                                                              |
| `MAIL_RENDER_MAX_BYTES`               | Ngưỡng byte UTF-8 của subject + body đã render — vượt → `413` trước khi ghi (§4)                                                              |
| `MAIL_PUBLISH_LEASE_MS`               | Lease claim của outbox publisher (§5.1)                                                                                                       |
| `MAIL_PUBLISH_BATCH_LIMIT`            | Biên lô publisher (cũng dùng cho retention — §5.1)                                                                                            |
| `MAIL_PUBLISH_MAX_ATTEMPTS`           | `maxPublishAttempts` — số lần thử publish trước khi outbox row thành `failed` (§5.2, §6.5 hàng 4; **không** tiêu ngân sách A)                 |
| `MAIL_PUBLISH_BACKOFF_BASE_MS`        | Backoff cơ sở giữa hai lần publish của cùng row (§5.3, §6.5 hàng 5)                                                                           |
| `MAIL_RECONCILER_MAX_AGE_MS`          | Ngưỡng tuổi delivery `accepted`/`queued` cho nhánh dispatch-incomplete (§5.3) — phải lớn hơn worst-case bounded của một execution bình thường |
| `MAIL_RECONCILER_BATCH_LIMIT`         | Biên lô quét reconciler (§5.3)                                                                                                                |
| `MAIL_RECOVERY_MAX_CYCLES`            | `maxRecoveryCycles` — ngân sách **A** (`mail_messages.recovery_cycle_count`; chặn reconciler, repair, redrive và DLQ replay — §6.5)           |
| `MAIL_NONCE_PRUNE_BATCH_LIMIT`        | Biên lô prune nonce (§5.3 pha 3 của scheduled)                                                                                                |
| `MAIL_RETENTION_CONTENT_MS`           | Tuổi giữ nội dung message terminal trước khi redact (§6)                                                                                      |
| `MAIL_RETENTION_STALE_ALERT_MS`       | Ngưỡng tuổi alert delivery dở (§7)                                                                                                            |

Cùng nhóm này nhưng **không** là số nguyên dương:

- Chu kỳ publish loop — `triggers.crons` trong `wrangler.jsonc` (hiện `*/5 * * * *`, giá trị khởi điểm lúc deploy — §1.1).
- **Ngưỡng cảnh báo sớm** — tỉ lệ của `maxRecoveryCycles` (ví dụ 70–80%) để operator vào trước khi ngân sách cạn (§5.3). Hiện là alerting config ở tầng observability, không phải biến của Worker.

Ý nghĩa bound của từng giá trị: `01-architecture.md` §6.5. Cơ chế đã chốt; **con số** cụ thể thuộc bước deploy và không được suy đoán từ tài liệu này.

Sensitive configuration không được lưu trong source.

---

## 4. Queue Configuration (producer side)

Control plane là producer; consumer cấu hình ở `docs/applications/transactional-mailer-job/03-operations.md`. Điều cần giữ ở phía này:

- Ngưỡng render payload dưới giới hạn Queue message (`docs/architecture/04-platform-facts.md` QU6) — vượt → `413` trước khi enqueue.
- At-least-once (`docs/architecture/04-platform-facts.md` QU1): duplicate publish là expected, consumer idempotent theo `delivery_id`.
- Command có `version` (hiện = 1).

Consumer/delivery worker báo outcome xuyên private interface; control plane **không** thực hiện retry delivery.

---

## 5. Outbox Operations

### 5.1. Publish

**Primary trigger: Cloudflare Cron Trigger / scheduled handler** — một scheduled Worker của `transactional-mail` chạy định kỳ và thực hiện toàn bộ publish loop. Cơ chế này **được chốt** và là yêu cầu bắt buộc trước production; handler đã được implement trong `src/main.ts` (`export scheduled`) và `triggers.crons` đã khai — nhưng chưa có deployment nào ở hai làn nên **chưa xác minh được trên runtime** (§1.1 tầng (4)). Chu kỳ hiện khai `*/5 * * * *` — giá trị khởi điểm lúc deploy, không phải con số đã load-test (§3).

**`POST /internal/outbox/publish` không phải đường backup đã sẵn sàng.** Nó được thiết kế là manual/internal trigger cho chính publish loop, nhưng hiện **chưa tồn tại**: contract request/response + status code của nó là **implementation gate** (`01-architecture.md` §10), và chưa có caller/permission mechanism nào được định nghĩa cho `outbox.publish` (`01-architecture.md` §7.5). Vì vậy nó **không** được mô tả hay dùng như một đường publish đã có thể gọi tay. Là internal API, khi tồn tại nó phải authenticate caller theo canonical contract **và** đòi permission `outbox.publish` — không public, và không nằm trong scope của `svc.transactional-mailer-job` (`01-architecture.md` §6.3/§7.4). Thuật ngữ "backup" ở đây là **thiết kế**, không phải trạng thái vận hành.

Mỗi lần chạy:

```text
claim ≤ limit (mặc định 10) item pending + reclaim item publishing quá lease
per item: buildMailCommand từ message → QUEUE.send
thành công → batch: outbox published + message queued
thất bại → publish_attempts++, available_at += backoff * 2^(publish_attempts-1); hết maxPublishAttempts → failed
```

Publish state (`pending`/`publishing`/`published`/`failed`) là việc đã publish Queue command hay chưa; message state (`accepted`/`queued`/`sent`/`failed`/`blocked`) là trạng thái delivery. Hai layer này **không bao giờ ghi lên nhau**:

- Publisher chỉ viết outbox + message `queued` bằng conditional write với nguồn **chỉ** `accepted`/`queued`, **và** `mail_outbox.dispatch_generation` khớp `mail_messages.dispatch_generation`; nó **không bao giờ** nhận `blocked` làm nguồn (một message `blocked` ở generation hiện tại là dữ liệu không nhất quán → publisher bỏ qua message row), **không bao giờ** viết `sent`/`failed`, và **không bao giờ** ghi `queued` đè lên message đã terminal hay đã sang generation mới.
- Outcome callback chỉ chuyển `accepted|queued → sent|failed|blocked` (guard `dispatch_generation`, xem `01-architecture.md` §6.2.2); callback idempotent, duplicate trả `result = duplicate`, stale/out-of-order trả `result = stale` và không lùi trạng thái. **`stale` không phải success.**
- Publisher crash giữa `QUEUE.send()` và batch update → outbox vẫn `pending`/`publishing`, message `queued`; reclaim theo lease và publish lại `delivery_id` — worker thấy message đã terminal, không gửi lại.

### 5.2. Duplicate publish safe

Cùng delivery_id được claim lại (crash) → gửi lại command với cùng delivery_id → consumer idempotent. Không cần dedupe phía publisher.

### 5.3. Outbox backlog / outbox không chạy

Nếu message `accepted` lâu nhưng không sang `queued`, kiểm tra:

```text
1. outbox có item pending chưa tới available_at không → publisher đang chạy?
2. Outbox có item published nhưng message chưa queued không (data lệch)
3. QUEUE.send lỗi liên tục → last_error → relay/Queue
4. item failed hết maxPublishAttempts → cần replay hoặc xử lý tay (5.4)
```

**Reconcile control plane** — hai trách nhiệm riêng biệt:

1. **Stale outbox items:** quét `mail_outbox` tìm item `pending`/`publishing` quá hạn (`available_at` quá xa hoặc `claimed_at` vượt lease). Claim bằng conditional update (`WHERE status = 'pending'`), reclaim lease của item `publishing` quá cũ, re-enqueue **cùng `delivery_id`** — không bao giờ tạo logical delivery mới. Re-enqueue là idempotent: worker thấy message đã terminal thì không gửi lại.
2. **Dispatch-incomplete deliveries:** hai điều kiện phát hiện, hai mức hành động khác nhau:
   - `queued` quá ngưỡng mà không chuyển `sent`/`failed`/`blocked` (worker mất message do Queue retention, hoặc worker không tiến triển) → re-enqueue **cùng `delivery_id`** với backoff + lease. **Đặc biệt**: bao gồm trường hợp `outbox.status = 'published'` và `message.status = 'queued'` nhưng **chưa có** job ở `mail-job` (không job record) — đây là nhánh dispatch-incomplete phát hiện bởi control-plane reconcile, guard có nguồn `outbox.status IN ('pending','publishing','published')`.
   - `blocked` quá ngưỡng → **alert Page trước**, không tự re-enqueue theo vòng. Re-enqueue cho delivery `blocked` chỉ chạy sau một **thao tác redrive có authorize** (credential/cấu hình provider ở delivery worker đã sửa, rồi caller đã authorized gọi `POST /internal/deliveries/:delivery_id/redrive` — `01-architecture.md` §6.4, caller/permission model ở `01-architecture.md` §7.5 **chưa chốt (implementation gate)**: hiện chưa có operator/backoffice authorization mechanism được định nghĩa). Redrive bump `dispatch_generation` và reset outbox row trong cùng batch; **không** dựa vào việc ai đó xoá một marker trong DB một cách ngầm hiểu. Mọi lần re-enqueue đều có guard lease + backoff + số chu kỳ bounded.

   **Guard chống recovery loop (bắt buộc):** mọi lần re-enqueue đều phải claim được quyền re-enqueue trước (conditional update + lease), có backoff tăng dần, và bị chặn theo **số chu kỳ bounded** cho mỗi `delivery_id`.

   **Giới hạn phải nói rõ — lease ở đây là lease của outbox row, không phải lease execution.** Control plane **không** đọc được D1 `mail-job` (invariant "một service sở hữu một database"), nên nó **không thể** phân biệt "worker đang chạy lành mạnh nhưng chậm" với "message đã mất". Một execution dài hơn ngưỡng tuổi sẽ bị nhánh này re-enqueue trong khi owner còn sống; command mới gặp lease còn hiệu lực ở worker nên **không** gọi provider lần hai (worker ack — `docs/applications/transactional-mailer-job/01-architecture.md` §9.2.2 hàng 15), tức **không** tạo duplicate mail, nhưng nó **vẫn tiêu một slot A không hoàn lại**. Vì vậy `ngưỡng tuổi` phải lớn hơn worst-case bounded của một execution bình thường (cùng tinh thần với `leaseMs` — `docs/applications/transactional-mailer-job/03-operations.md` §1), và trường hợp "owner sống, delivery vẫn chuyển biến" phải nằm trong **cảnh báo sớm** ở dưới. Bound thật của churn này là ngân sách A; guard ở đây là backoff + số chu kỳ, **không** phải một lease execution. Vượt ngưỡng `maxRecoveryCycles` mà delivery vẫn không tiến triển → **dừng re-enqueue tự động**, alert Page, giữ nguyên delivery intent + bằng chứng vận hành, và chỉ một hành động recovery **có authorize tường minh** (kèm cờ override) mới tiếp tục được — khi đó `recovery_cycle_count` **vẫn tăng** nên đường tự động không mở lại (`01-architecture.md` §6.5 hàng 10). Reconciler, repair, redrive (§5.4) và DLQ replay **tiêu cùng ngân sách A** (`recovery_cycle_count` / `maxRecoveryCycles`, §6.5 của [`01-architecture.md`](./01-architecture.md)) — không đường nào có bộ đếm riêng để tự nới bound. Publisher retry (kể cả sau lease reclaim) **không** tiêu ngân sách A: nó bị chặn bởi `maxPublishAttempts`, và một lần `QUEUE.send()` lỗi **không** phải một recovery cycle.

   **Hai điều kiện nguồn của guard (đừng trộn):** reconciler **tự động** claim outbox row `pending`/`publishing`/`published` — nó **không bao giờ** chạm row `failed`, vì `failed` (đã kiệt `maxPublishAttempts` trong chu kỳ đó) chỉ được reset bởi đường **repair có authorize** (§5.4). (`published` nằm trong nguồn **chỉ** cho nhánh dispatch-incomplete `queued`+không-job: một outbox row đã `published` mà delivery vẫn chưa tới worker là delivery intent còn nguyên — xem `01-architecture.md` §6.2.2.) Nếu reconciler tự re-enqueue `failed`, cổng authorize của repair bị lách qua và alert `outbox_failed > 0` thành vô nghĩa.

   **Hệ quả trực tiếp cho trạng thái `queued` + outbox `failed`:** đây là corner case mà hai layer ở trạng thái trái ngược — delivery vẫn non-terminal (`queued`) ở message layer, nhưng outbox layer đã kiệt `maxPublishAttempts`. Reconciler **không** claim được row này (nguồn guard của nó loại `failed`), nên **không** có đường tự động nào đẩy nó đi; việc đó đi qua **repair có authorize** ở §5.4 (reset đúng row `failed` + `recovery_cycle_count++` trong cùng batch). Reconciler chỉ **phát hiện và alert** (`outbox_failed > 0`) — nó không được "giải quyết" bằng cách tự reset. Chi tiết hành động theo từng trạng thái → bảng quyết định `docs/applications/transactional-mailer-job/03-operations.md` §11.

   **Cảnh báo sớm (giá trị vận hành):** churn tự động **có thể** tiêu hết ngân sách A mà delivery chưa từng bị provider từ chối — ví dụ reconciler re-enqueue liên tục một delivery còn `queued` trong khi worker ack không tiến triển (producer/consumer version lệch, hoặc job đã `blocked` cùng generation). Vì vậy phải có alert ở **một tỉ lệ** của `maxRecoveryCycles` (ví dụ 70–80%) để operator vào trước khi ngân sách cạn; đây là **giá trị chốt ở deploy**, không phải quyết định kiến trúc. Điều kiện này **không** làm mất delivery intent: hết A chỉ dừng **churn tự động**, không tuyên bố delivery đã chết.

   **Cơ chế re-enqueue (bắt buộc, vì `mail_outbox.delivery_id` là UNIQUE):** tái sử dụng chính outbox row cũ, đặt lại `status = 'pending'`, `publish_attempts = 0`, `available_at = now`; **không** chèn outbox row thứ hai cho cùng delivery. Khi publish thành công, `message.status` được đưa về `queued` bằng conditional write với nguồn **chỉ** `accepted`/`queued` — publisher **không bao giờ** nhận `blocked` làm nguồn và **không bao giờ** ghi đè message đã terminal. Chuyển `blocked → queued` **chỉ** xảy ra trong batch nguyên tử của redrive (§5.4), không do publisher.

   Không thể phát hiện message mất **trước** khi job record được tạo — trường hợp đó chỉ có thể tìm lại bằng control plane's durable delivery intent (`mail_messages` + `mail_outbox`), không phải bằng quét `mail-job`.

**Trigger của reconciler — đã wired trong scheduled handler:** reconciler chạy trong **scheduled handler của chính `transactional-mail`**, cùng cơ chế đã chốt cho publish loop (§5.1). Handler export `scheduled()` với thứ tự bốn pha publish → reconciler → nonce prune → retention, mỗi pha bắt lỗi riêng nên một pha chết không cản pha sau; `triggers.crons` đã khai (§1.1). Chưa xác minh trên runtime (tầng (4)) — các điều kiện quét dưới đây mô tả hành vi **sau khi deploy**, không phải điều đã đo được ở một environment nào. Mỗi Worker sở hữu reconciliation của mình: `transactional-mail` reconcile outbox + dispatch-incomplete trên D1 `mail`; `transactional-mailer-job` reconcile lease/outcome trên D1 `mail-job` (`docs/applications/transactional-mailer-job/03-operations.md` §10). Đây là hai đường enqueue **khác nhau** nhưng phải dùng **chung lease + backoff + ngân sách A** trong phạm vi control plane, nếu không sẽ có recovery loop giữa publisher trigger và reconciler. Phía worker dùng ngân sách **B** riêng (`mail_jobs.attempts` / `maxExecutionAttempts`) — composition của A và B → §6.5 của [`01-architecture.md`](./01-architecture.md).

Chu kỳ chạy cụ thể và các ngưỡng tuổi (`age threshold`, số chu kỳ tối đa, backoff) là **giá trị vận hành chốt ở deploy** — không phải quyết định kiến trúc còn mở. Phần còn mở duy nhất ở tầng hệ thống là **con số** cho từng service (`docs/architecture/03-operations.md` §10), không phải cơ chế trigger.

Reconciler claim work bằng conditional update + lease; không có recovery loop vô hạn nào trong đó hai reconciler có thể enqueue liên tục delivery không có state/lease guard.

**Properties bắt buộc (đối xứng với worker reconciler):**

- **Điều kiện quét:** outbox item `pending`/`publishing` quá `available_at`/lease; outbox `published` còn kẹt ở đây **chỉ** khi message vẫn `queued` mà không có job (nhánh dispatch-incomplete, cùng nguồn `outbox.status IN ('pending','publishing','published')` như trên); message `queued` quá ngưỡng không tiến triển; message `blocked` quá ngưỡng (alert trước, không tự re-enqueue theo vòng).
- **Claim/lease:** conditional update + lease; hai reconciler không cùng xử lý một đơn vị.
- **Không logical delivery mới:** mọi re-enqueue tái sử dụng outbox row hiện có, giữ nguyên `delivery_id` (và `dispatch_generation` trừ khi đó là redrive có authorize — §6.4).
- **Bounded cycles + terminal-quarantined:** vượt ngưỡng chu kỳ → dừng tự động, alert `Page`, xử lý tay. `terminal-quarantined` là **nhãn vận hành** cho tình huống này — **không** phải giá trị của `mail_messages.status` (enum vẫn `accepted|queued|sent|failed|blocked` — `01-architecture.md` §4.2) hay của `mail_jobs.status`.
- **Reconciler crash:** công việc được claim bằng lease trong D1 nên crash chỉ để lại lease hết hạn — lần chạy sau reclaim được; không giữ state trong memory.
- **Reconcile bị disable/chạy muộn/thất bại lặp lại:** có metric + alert (§7) — reconciler chết im lặng phải phát hiện được, không dựa vào việc "không thấy log lỗi".

### 5.4. Replay / Data Repair

- **Outbox item `failed`**: alert khi `failed > 0` (§7). Row `failed` **không bao giờ bị xoá tự động** — nó vẫn là delivery intent còn nguyên. Điều tra `last_error`; khi nguyên nhân đã hết, reset **chính row đó** (`status=pending, publish_attempts=0, available_at=now`, **cùng** `recovery_cycle_count++`) — repair thủ công, phải đi qua đường có authorize; **caller & permission của repair chưa chốt — implementation gate** ở `01-architecture.md` §10 (dòng "Repair caller & permission"), cùng trạng thái với redrive (`01-architecture.md` §7.5); operator tooling chưa có nên hôm nay chưa đường nào gọi được repair. `failed` là "đã hết retry tự động trong chu kỳ đó", **không** phải kết luận thư không gửi được. Repair cũng chịu ngân sách A: chạm ngưỡng → từ chối (`409`) + alert Page, và chỉ thao tác có authorize kèm override mới đi tiếp được (khi đó A **vẫn tăng**, `01-architecture.md` §6.5 hàng 10). Repair là đường **duy nhất** reset một row `failed` — reconciler tự động không bao giờ chạm nó (§5.3).
- **Redrive delivery `blocked`:** **tái sử dụng** row outbox hiện có của cùng `delivery_id` (UNIQUE — không chèn row thứ hai) trong **một** `db.batch()` cùng với: `dispatch_generation += 1`, `mail_messages.status = 'queued'`, `recovery_cycle_count += 1`, và outbox reset (`status=pending, publish_attempts=0, available_at=now, dispatch_generation=mới`). Redrive đặt `queued` **ngay trong batch**, không chờ publisher — nhờ vậy outcome hợp lệ của generation mới không bao giờ bị từ chối oan (§6.4 của [`01-architecture.md`](./01-architecture.md)).
- **Message đã `sent` rồi**: không tạo outbox mới và không reset outbox row — consumer idempotent theo `delivery_id`, không gửi lại. Một delivery đã `sent` **không bao giờ** được gửi lại, kể cả khi có entry DLQ ở phía consumer.
- **DLQ replay (phía consumer):** entry trong `ecoma-mail-delivery-dlq` nghĩa là **xử lý tự động đã dừng**, không phải thư đã chết — thư có thể chưa bao giờ được gửi. Operator **không** replay thô Queue command: replay đi qua **đúng đường control-plane có guard** cho state hiện tại (reconcile cùng generation §5.3, redrive có authorize, hoặc repair có authorize), để guard chu kỳ và generation được áp dụng như mọi đường khác. Chi tiết pre-replay validation → `docs/applications/transactional-mailer-job/03-operations.md` §11.

---

## 6. Observability

- Log chỉ chứa whitelisted fields (event, route, method, status, app, principal_id, message_id, delivery_id, trạng thái message/outbox, error_code...). **Recipient, subject/body render, credential không bao giờ được log.** Quy tắc chung (trace, privacy, retention) → `docs/architecture/03-operations.md` §4.
- Metrics (đề xuất): `messages_created` (theo app) · `messages_created_idempotent_replay` · `outbox_claimed` · `outbox_published` · `outbox_failed` · `outbox_stuck_over_lease` · `queue_send_errors` · `template_not_found`.
- Dashboards (đề xuất): outbox backlog (pending quá hạn `available_at`) · outbox stuck (publishing vượt lease) · tỉ lệ idle→queued chậm · lỗi template/render (4xx/413).

---

## 7. Alerting

| Điều kiện                                                                        | Mức     | Ý nghĩa                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox pending tăng liên tục / pending không giảm                                | Warning | Publisher không chạy hoặc `QUEUE.send` lỗi                                                                                                                    |
| Outbox `failed` > 0                                                              | Page    | Dữ liệu đang chết — item không bao giờ vào Queue (`docs/architecture/03-operations.md` §5)                                                                    |
| Delivery chạm tỉ lệ cảnh báo sớm của `maxRecoveryCycles` (giá trị chốt ở deploy) | Warning | Churn tự động đang tiêu ngân sách A (thường do worker ack không tiến triển) — vào trước khi cạn (§5.3)                                                        |
| Delivery chạm `maxRecoveryCycles`                                                | Page    | Đã dừng **re-dispatch tự động** — cần điều tra; đi tiếp chỉ bằng thao tác có authorize kèm override, và A vẫn tăng nên đường tự động không mở lại (§5.3/§5.4) |
| Outbox publishing vượt lease thường xuyên                                        | Warning | Publisher crash giữa chừng (reclaim hoạt động nhưng tần suất cao)                                                                                             |
| Delivery `blocked` (credential/provider/budget B)                                | Page    | Điều kiện system-level: 401/403, provider chưa cấu hình, hoặc `execution-budget-exhausted` — cần operator sửa rồi redrive                                     |
| 4xx rate tăng (template/render/validation)                                       | Warning | Contract gọi sai hoặc template thiếu                                                                                                                          |
| D1 không ghi được                                                                | Page    | Toàn bộ create message lỗi — xem log error                                                                                                                    |

Không alert theo một message failure đơn lẻ; aggregate theo `app`.

---

## 8. Common Failure Modes

### 8.1. Create message lỗi (5xx)

Kiểm tra: D1 up? Lỗi batch rollback? Statement vượt giới hạn (`docs/architecture/04-platform-facts.md` DB4)? migration schema chưa chạy?

### 8.2. Message `accepted` mãi, không `queued`

Đi theo mục 5.3 (outbox). Thường: scheduled handler không chạy hoặc fail (kiểm log `scheduled_publish*` của cron — §1.1), hoặc `QUEUE.send` fail liên tục.

### 8.3. Message `queued` mãi không `sent`

Delivery worker xử lý — `docs/applications/transactional-mailer-job/03-operations.md`. Control plane chỉ thấy qua private interface.

### 8.4. Idempotent replay trả khác nhau

Kiểm tra `Idempotency-Key` đúng key; chỉ request cùng `app` được dedupe. Các header định danh do caller tự khai phải ổn định giữa các request của cùng client, nhưng **không được coi là authentication** (§7.4/§7.5 của `01-architecture.md`).

---

## 9. Disaster Recovery

- D1 `mail` — authority duy nhất của service — **không** thuộc Backup/DR scope: chính sách → `docs/architecture/03-operations.md` §3.1; service recover ở mức service. Không backup/restore D1 của service khác.
- Worker runtime phải disposable: mất instance không mất domain state.
- ⚠️ Message mất do Queue retention (giới hạn → `docs/architecture/04-platform-facts.md` QU5) không nằm trong cửa sổ recover từ Queue: việc đã enqueue mất nhưng domain state còn; xử lý theo hai trách nhiệm reconcile ở §5.3 (re-enqueue cùng `delivery_id`). Trigger của reconcile — scheduled handler của chính `transactional-mail`, đã wired (§5.3); còn lại chỉ **giá trị vận hành** (chu kỳ, ngưỡng tuổi, số chu kỳ tối đa) là chốt ở deploy — `docs/architecture/03-operations.md` §10.

---

## 10. Capacity Management

Capacity điều chỉnh theo:

- Kích thước Queue message và tốc độ publisher claim (`docs/architecture/04-platform-facts.md` QU6).
- Tăng trưởng `mail_messages`/`mail_outbox` so với giới hạn D1 (`docs/architecture/04-platform-facts.md` DB4).
- Consumer throughput của `transactional-mailer-job` (provider rate limit).

Không dùng raw request rate của application làm sole scaling signal.

---

## 11. Local Worker runtime — E2E

Luồng smoke của control plane trên local Worker runtime (`wrangler dev`): `POST /v1/messages` (HMAC `ecoma-internal-v1`, allowlist template) → outbox publish qua cron trigger → Queue `ecoma-mail-delivery` → consumer báo outcome → `mail_messages` `sent`. Script in-repo, lặp lại được, không chạm Cloudflare hay email thật:

```
node tools/dx/scripts/mail-worker-runtime-e2e.mjs
```

Quy trình từng bước và giới hạn của wrangler dev → [`worker-runtime-e2e.md`](../../architecture/local-development/evidence/worker-runtime-e2e.md).

---

## 12. Operational Invariants

1. Rollback/restart an toàn nhờ idempotency — cùng `delivery_id` không tạo logical delivery mới.
2. Worker version mới phải consume được Queue command version hiện tại (contract `version`).
3. Mỗi outbox item publish chỉ sau claim; duplicate publish an toàn, không dedupe phía publisher.
4. Secret/recipient không xuất hiện trong Queue/log/DLQ — kiểm tra định kỳ bằng log sample.
5. Chỉ redrive có authorize làm tăng `dispatch_generation`; publish loop không bao giờ bump generation (§6.4 của [`01-architecture.md`](./01-architecture.md)).
6. `recovery_cycle_count` là ngân sách **A**: chỉ tăng, không bao giờ reset, dùng chung cho mọi đường **re-dispatch** (reconciler, repair, redrive, DLQ replay); `publish_attempts` là bộ đếm của chu kỳ publish hiện tại và không thay thế nó. Ngân sách **B** của worker (`mail_jobs.attempts` / `maxExecutionAttempts`) chặn số execution cho một generation và **không** tạo Queue command mới, nên không bypass được A (§6.5 của `01-architecture.md`).
7. Delivery đã `sent` không bao giờ được gửi lại, kể cả khi có entry DLQ; DLQ replay đi qua **đúng đường control-plane có guard** cho state hiện tại (reconcile cùng generation, redrive, hoặc repair — không bao giờ replay thô Queue command).

Architectural invariants (D1 authority, request path, isolation) → [`01-architecture.md`](./01-architecture.md) §8.
