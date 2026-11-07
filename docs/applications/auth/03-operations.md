# Auth — Operations

> Phạm vi: vận hành `auth` — deployment, binding, role & migration, key rotation, monitoring, alerting, failure modes, restore và runbook.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · mô hình miền → [`docs/domains/auth/domain-model.md`](../../domains/auth/domain-model.md) · system-level backup/DR → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md) · delivery → [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md).
> **Hiện trạng:** endpoint protocol và glue internal đã có trong code (`apps/auth`), 14 migration của `db-auth` nằm ở `apps/auth/migrations/` (`0001`…`0014`); **không database nào được provision** và Worker chưa khai environment staging/production. Các phần deployment/restore/runbook dưới đây là kế hoạch cho khi provision.

---

## 1. Runtime

```text
auth.ecoma.io  (Cloudflare Worker · API-only · Hono)
├── Hyperdrive binding → db-auth   (query cache OFF)
└── Service Binding  → account     (auth là CONSUMER của contract auth → account,
                                      dùng để hỏi trạng thái account lúc phát hành — §6.0)
```

⚠️ Worker identity lâu dài — `ecoma-auth`, không có suffix môi trường; staging là `stg-ecoma-auth`. PR không tạo Worker mới ([`02` §5.1](../../architecture/02-delivery.md)).

## 2. Deployment

- Hyperdrive binding trỏ `db-auth` (**tên binding**, không host/port/user).
- Worker Secret cho signing key — `AUTH_SIGNING_KEY` (PKCS#8 PEM) cùng `AUTH_SIGNING_KEY_ID`; lịch xoay **chưa chốt** (§4).
- Worker Secret `AUTH_INTERNAL_SECRET` — bắt buộc, cùng giá trị với `account` (§3.3).
- Observability enabled.

⚠️ **Bật `nodejs_compat` là bắt buộc, khác gì các app Nuxt.** Provider `oidc-provider` là package Node: bridge `cloudflare:node` (`apps/auth/src/oidc/runtime.ts`) dựng một `http.Server` Node thật trong isolate rồi chuyển request vào bằng `handleAsNodeRequest`. `wrangler.jsonc` của `auth` đã khai `nodejs_compat` với `compatibility_date 2026-10-05`; `.oxlintrc.json` vẫn chặn Node builtin trực tiếp trong code application (`runtime:edge`) — đường Node hợp lệ duy nhất là qua bridge của provider.

⚠️ **KHÔNG khai báo binding storage nào cho tới khi `db-auth` được provision.** Binding trỏ database chưa tồn tại là config hỏng, không phải config "chưa dùng".

Kiểm sau deploy:

```text
GET /health → 200 { service: 'auth', status: 'ok' }
GET /ready  → 200 { service: 'auth', status: 'ready' }        # khi cả hai kiểm dưới đây đi qua
GET /ready  → 503 { error: 'service_unavailable' } + Retry-After   # khi một trong hai kiểm thất bại
```

⚠️ **`/ready` là readiness có kiểm phụ thuộc; `/health` là liveness không chạm DB.**
Cùng một hợp đồng với `account` ([../account/03-operations.md](../account/03-operations.md) §2,
nơi cài đặt bên kia là `apps/account/server/routes/ready.get.ts`, bên này là
`apps/auth/src/main.ts`). Route kiểm đúng **hai** điều, không hứa hơn:

- **Binding tồn tại** — `HYPERDRIVE` và `ACCOUNT_SERVICE` đều được gắn. Chỉ kiểm
  sự có mặt; ⚠️ **không probe service `account` qua binding**: binding có gắn
  mà bên kia chết thì `/ready` **không** phát hiện — mọi đường gọi thật của
  `auth` qua binding nằm trên route nội bộ/flow, không phải readiness. Sự cố
  `account` hiện qua trực tiếp các route thật; đừng đọc `/ready` 200 như một
  cam kết liveness hai chiều.
- **`db-auth` reachable** — một `SELECT` trên `auth.oauth_clients` qua
  `createPostgresClient` (`apps/auth/src/main.ts`), tức bảng gốc đầu tiên của
  schema (`0001`) với credential `ecoma_auth_runtime`: database nửa schema hay
  grant sai đều làm probe thất bại, không chỉ database chết.

Hành vi fail-closed: thiếu binding ⇒ `503` + `Retry-After` (mã ổn định
`binding_missing` trong log); DB không kết nối được ⇒ `503` + `Retry-After`
(`db_unreachable`). Response **không** nêu tên binding thiếu, **không** message
của driver (có thể rò connection string) — nguyên nhân nằm ở log cùng mã ổn định.
`/ready` trả `503` khi một dependency chết không phải là báo động giả: đây là
tín hiệu cho orchestrator ngừng traffic mới, đúng chỗ nó thuộc về.

Rollback theo Worker version đã publish, **không** rollback database ([`02` §8](../../architecture/02-delivery.md)).

## 3. Database, role và migration

| Database  | Owner  | Runtime role         | Migrator role         |
| --------- | ------ | -------------------- | --------------------- |
| `db-auth` | `auth` | `ecoma_auth_runtime` | `ecoma_auth_migrator` |

Role model giống [`../account/03-operations.md`](../account/03-operations.md) §3: owner (ngoài VPS cho DR) · migrator (chỉ CI runner) · runtime (chỉ DML).

### 3.1 Chặn chéo — điều kiện bắt buộc

```sql
REVOKE CONNECT ON DATABASE db-account FROM ecoma_auth_runtime;
```

```sql
SELECT has_database_privilege('ecoma_auth_runtime', 'db-account', 'CONNECT');  -- phải = false
```

Câu `REVOKE` không phụ thuộc table nào tồn tại → từ chối được ngay từ khi database tạo ra. Đây là lớp enforce thật, không phải tag Nx: `scope:account` và `scope:auth` là hai scope Nx khác nhau nhưng scope không chặn app chạm database của app khác — chỉ grant mức database chặn ([`05` §6.3](../../architecture/05-code-architecture.md)).

### 3.2 Migration

- **Greenfield provisioning, không phải data migration.** Không có schema chung nào tồn tại để kế thừa. Danh sách migration đã có trong repo tại `apps/auth/migrations/`: `0001` schema + `oauth_clients` tới `0013` (`oidc_state` — một bảng, bảy kind giao thức của provider), cộng `0014_nonce_pruner_role.sql`; `0010` tạo `auth.internal_nonces`, `0012` đổi tên cột `authn_level` → `acr` (đồng bộ với `0004` của `db-account`), `0013` là trạng thái OIDC cho provider, `0014` tạo role `ecoma_auth_nonce_pruner`. Danh sách này phục vụ provisioning lần đầu khi `db-auth` được tạo; các file đã được test phủ (integration suite của `apps/auth`).
- Migration chạy từ **CI runner** bằng PostgreSQL client kết nối thẳng, dùng role `_migrator_`, giữ advisory lock ([`02` §3.1](../../architecture/02-delivery.md)). Runner đã có: `pnpm nx run @ecoma-io/auth:db:migrate` với `DATABASE_URL` (bắt buộc) — thiếu `DATABASE_URL` thì exit code khác 0 chứ không im lặng coi như đã apply.
- **Migration history độc lập** với `db-account`.
- ⚠️ **Thứ tự mở rộng:** authorization transaction và authorization code **phải** nằm trong PostgreSQL — consume-once cần compare-and-set trong database. KV eventual consistency ≥ 60 s (KV1), 1 write/giây/key (KV2) và tài liệu chính thức khuyến cáo không dùng cho atomic operation (KV6); Queue là at-least-once (QU1). Không có lựa chọn nào cho consume-once đúng ([`01-architecture.md`](./01-architecture.md) §3.3).
- Expand → compatible rollout → contract; không down-migration, **forward-fix**.

Thứ tự provisioning: infrastructure (database + ba role + `REVOKE` chéo) → expand schema → binding Hyperdrive → compatible rollout → contract.

### 3.3 Envelope nội bộ — secret, kho nonce và mã lỗi

Vận hành của envelope HMAC dùng chung với `account`. Giao thức, canonical form và taxonomy lỗi có **một** nguồn sự thật: [`01-architecture.md`](./01-architecture.md) §5.1.8; cài đặt ở `libs/internal-auth-contracts` (`internal-auth.ts`). Mục này chỉ nói phần vận hành.

#### Secret

| Mục             | Giá trị                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`          | Worker Secret `AUTH_INTERNAL_SECRET` (**bắt buộc**)                                                                                                                                                                                                         |
| `account`       | Worker Secret `NUXT_INTERNAL_HMAC_SECRET` (Nuxt đổi tên sang convention `NUXT_*`; `nuxt.config.ts` map lại thành `internalHmacSecret`)                                                                                                                      |
| Skew (tuỳ chọn) | `AUTH_INTERNAL_SKEW_SECONDS` (và `NUXT_INTERNAL_AUTH_SKEW_SECONDS` phía `account`), **chuỗi chữ số thập phân** (số nguyên giây **dương**, `MIN_SKEW_SECONDS` = 1, tối đa `MAX_SKEW_SECONDS` = 3600); bỏ trống thì dùng `DEFAULT_SKEW_SECONDS` (300) của lib |

⚠️ **Skew phải thoả cả hai biên, và hai biên sống ở lib chứ không ở từng service.** `MIN_SKEW_SECONDS` = 1 vì cửa sổ `0` không phải "chặt nhất" mà là hỏng: `now` phía nhận và `timestamp` phía gọi là hai lần đọc đồng hồ khác nhau nên hiệu gần như luôn ≥ 1, tức cửa sổ `0` từ chối gần như mọi envelope hợp lệ. `MAX_SKEW_SECONDS` = 3600 vì skew kéo TTL của nonce theo (`timestamp + skew + buffer`), nên một giá trị gõ sai (`86400`) làm phình bảng `auth.internal_nonces` theo đúng cửa sổ đó. Cả hai service **từ chối giá trị ngoài biên lúc khởi động** (fail lúc boot, không im lặng chạy với mặc định), và cả hai đọc **cùng** hai hằng của `libs/internal-auth-contracts` — trần cục bộ ở một service là chỗ hai phía lệch nhau.

⚠️ **Hai Worker phải giữ CÙNG một giá trị.** Đây là secret đối xứng, không phải cặp khoá công khai/bí mật: `auth` ký bằng nó thì `account` verify được bằng đúng nó, và ngược lại. Lệch một bên là **mọi** request nội bộ `401` — hỏng đóng, không hỏng mở.

⚠️ **Không có giá trị mặc định và không có fallback.** `loadAuthConfig` gọi `requireSecret(env.AUTH_INTERNAL_SECRET, …)` và ném lúc khởi động nếu thiếu; middleware của `account` trả `401` khi secret rỗng. Không có nhánh nào coi "chưa cấu hình" là "cho phép". **Không bao giờ** đặt giá trị thật của secret vào Git, vào PR build hay vào Preview runtime (non-negotiable; [`02` §5.3](../../architecture/02-delivery.md)).

⚠️ **Rotate secret có giai đoạn overlap, nhờ header `x-ecoma-internal-kid`.** `v1=` trong header chữ ký là version của **scheme**, không phải `kid` của khoá — nhưng `kid` giờ đi ở **header riêng** (`x-ecoma-internal-kid`), **không** nằm trong canonical string. Hệ quả: chữ ký của envelope có `kid` và envelope không `kid` là **giống nhau từng byte** khi dùng cùng secret, nên thêm `kid` không phải một thay đổi giao thức và không phá các vector ký cũ. Receiver đọc `kid` như một **chỉ dẫn chọn khoá** trước khi tính HMAC: không có `kid` ⇒ dùng secret hiện hành; có `kid` ⇒ tra registry, không biết `kid` nào thì `401` (`bad_signature`).

| Biến (`auth`)                   | Biến (`account`)                     | Ý nghĩa                                |
| ------------------------------- | ------------------------------------ | -------------------------------------- |
| `AUTH_INTERNAL_KID`             | `NUXT_INTERNAL_HMAC_KID`             | `kid` của khoá **đang ký**             |
| `AUTH_INTERNAL_PREVIOUS_KID`    | `NUXT_INTERNAL_HMAC_PREVIOUS_KID`    | `kid` của khoá **chỉ dùng để verify**  |
| `AUTH_INTERNAL_PREVIOUS_SECRET` | `NUXT_INTERNAL_HMAC_PREVIOUS_SECRET` | Secret của khoá **chỉ dùng để verify** |

⚠️ **Slot "previous" là slot "không dùng để ký", không phải slot "khoá cũ".** Trong lúc nạp trước (bước 2 của runbook) nó chứa khoá **mới**; trong lúc overlap (bước 3) nó chứa khoá **cũ**. Không có slot riêng cho "khoá mới chỉ để verify" — một Worker chỉ có **hai** entry registry, và entry `current` **chính là** secret đang ký (`apps/auth/src/config.ts`, `apps/account/server/middleware/internal-auth.ts`).

⚠️ **`kid` là chuỗi 8–16 hex chữ thường** (`/^[0-9a-f]{8,16}$/u` — hằng giao thức ở `libs/internal-auth-contracts`, cả hai service đọc **cùng** một hằng đó). Cả hai Worker **từ chối lúc khởi động** khi `kid` sai hình dạng, khi cặp previous thiếu một nửa, khi `kid` hiện hành trùng `kid` cũ, và khi hai secret trùng **giá trị** (hai `kid` chia một secret làm mất ý nghĩa của selector). Thông báo lỗi **không bao giờ chứa giá trị** `kid` hay secret.

**Runbook — xoay secret không gián đoạn** (giả định `kid` đã bật ở cả hai Worker; xem bước 0):

| #   | Hành động                                                                                                                  | Vì sao an toàn                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Bật `kid` trước (nếu chưa): đặt `kid` hiện hành ở **cả hai** Worker, cùng secret hiện hành                                 | Envelope có `kid` vẫn verify được bằng chính secret đó — `kid` không đổi chữ ký                                                   |
| 1   | Sinh secret mới (`S2`) và `kid` mới (`K2`); **`S2` ≠ secret hiện hành**                                                    | Hai `kid` chia một secret là cấu hình mơ hồ, bị chặn lúc khởi động                                                                |
| 2   | **Nạp trước ở CẢ HAI Worker**: `previous kid` = `K2`, `previous secret` = `S2`; `current` vẫn là `K1`/`S1`                 | Cả hai Worker **verify** được cả `K1` và `K2`, nhưng **vẫn ký bằng `K1`** — không có Worker nào ký bằng khoá mà đối tác chưa biết |
| 3   | **Chuyển sang khoá mới ở CẢ HAI Worker**: `current` = `K2`/`S2`, `previous` = `K1`/`S1`                                    | Mỗi Worker ký bằng `K2`; đối tác đã có `K2` trong registry từ bước 2 ⇒ không envelope nào bị từ chối                              |
| 4   | Chờ ≥ `skew` + thời gian dài nhất một request nội bộ (thực tế: vài phút), tính từ lúc **Worker cuối cùng** hoàn tất bước 3 | Bảo đảm không còn envelope ký bằng `K1` trên đường                                                                                |
| 5   | Xoá cặp previous ở **cả hai** Worker                                                                                       | Thu hồi khoá cũ; `kid` cũ từ đây trở đi là `kid` lạ ⇒ `401`                                                                       |

⚠️ **Bước 2 phải áp dụng cho CẢ HAI Worker, không phải "phía nhận trước".** `auth` và `account` là **cặp song phương**: mỗi bên vừa gửi vừa nhận trên cùng một cơ chế, và mỗi bên có **một** entry `current` duy nhất — chính là secret đang ký. Nếu chỉ nạp trước ở một bên, bên đó **bắt đầu ký bằng khoá mới** ngay khi đổi `current`, trong khi đối tác chưa biết `K2` ⇒ chính hướng ngược lại bị `401`. Đây là lý do `kid` không đủ: nó chọn được khoá để **verify**, nhưng không tách được "khoá để ký" khỏi "khoá để verify".

⚠️ **Bước 2 và bước 3 có thể đổi thứ tự với nhau, miễn là mỗi Worker phải đi qua đủ hai bước.** Vì ở bước 2 mọi Worker vẫn ký bằng `K1`, nên Worker nào hoàn tất bước 3 trước vẫn **được** nhận envelope ký bằng `K1` từ Worker chưa chuyển. Điều kiện duy nhất là: **không Worker nào ký bằng `K2` trước khi cả hai đều có `K2` trong registry** — đúng nghĩa bước 2 phải xong ở cả hai.

⚠️ **Bước 4 đếm từ Worker cuối cùng hoàn tất bước 3**, không phải từ Worker đầu tiên: envelope ký bằng `K1` có thể còn trên đường từ Worker chưa chuyển.

⚠️ **Bỏ qua `kid` thì vẫn xoay đồng thời được** (giá trị secret hiện hành + secret mới đặt cùng lúc ở cả hai Worker), nhưng phải chấp nhận một cửa sổ `401` giữa hai lần deploy. Đó là đường lùi, không phải cách bình thường.

#### Kho nonce

| Service   | Bảng                      | Migration                                             |
| --------- | ------------------------- | ----------------------------------------------------- |
| `auth`    | `auth.internal_nonces`    | `apps/auth/migrations/0010_internal_nonces.sql`       |
| `account` | `account.internal_nonces` | `apps/account/db/migrations/0003_internal_nonces.sql` |

- Nonce là duy nhất **theo từng service nhận**, nên hai bảng là hai kho độc lập — nonce đã chiếm ở `db-account` không bảo vệ được request đến `auth`. Mỗi service chỉ chạm database của mình.
- Quyền của `ecoma_auth_runtime` trên bảng này là `SELECT, INSERT` — **không** `UPDATE`, **không** `DELETE`. Nới `expires_at` của một nonce đã ghi là nới cửa sổ replay; xoá một nonce **còn hiệu lực** còn nặng hơn: nó mở lại cửa sổ replay cho đúng envelope đó. Prune vì vậy là job của `ecoma_auth_migrator`, theo học thuyết retention đã viết trong `0009_grants_and_isolation.sql` ("Dọn dữ liệu hết TTL là job của migrator, không phải đường của serving path").
- `internal_nonces` đã nằm trong sweep quyền của `apps/auth/migrations/README.md` §"Sweep kiểm tra quyền" ô (2) và (2c) — chạy sweep đó sau khi áp `0010`.

**Prune (runbook)** — chạy trên database của chính service đó, bằng một role CÓ
quyền `DELETE` của kho:

`db-auth`: bằng role **`ecoma_auth_nonce_pruner`** (tạo từ `0014_nonce_pruner_role.sql`;
không phải runtime — runtime không có `DELETE` trên `auth.internal_nonces`, và không còn là
`ecoma_auth_migrator` nữa — job định kỳ hiện chạy bằng Worker, xem phần dưới, và Worker
không được cầm credential `_migrator_`):

```sql
WITH deleted AS (
  DELETE FROM auth.internal_nonces
   WHERE nonce = ANY (ARRAY(
           SELECT nonce FROM auth.internal_nonces
            WHERE expires_at < now() LIMIT 10000))
   RETURNING 1)
SELECT count(*) FROM deleted;
```

`db-account`: `account.internal_nonces` đã có `DELETE` cho runtime (ngoại lệ có giải thích tại `apps/account/db/migrations/0003_internal_nonces.sql`), nên runbook chạy tay được bằng cả `ecoma_account_runtime` lẫn `ecoma_account_nonce_pruner` (role tạo từ `apps/account/db/migrations/0007_nonce_pruner_role.sql`, có đúng `SELECT, DELETE`):

```sql
WITH deleted AS (
  DELETE FROM account.internal_nonces
   WHERE nonce = ANY (ARRAY(
           SELECT nonce FROM account.internal_nonces
            WHERE expires_at < now() LIMIT 10000))
   RETURNING 1)
SELECT count(*) FROM deleted;
```

⚠️ **Chạy lặp, không chạy một câu lớn.** Hai câu trên là **một lô**: lặp lại cho tới khi `count(*)` về `0` hoặc dưới `LIMIT`. Một câu `DELETE … WHERE expires_at < now()` trần giữ một transaction cho tới khi chạy hết — backlog lớn thì transaction lớn, giữ khóa lâu và có thể bị kill rồi rollback toàn bộ, không xóa được hàng nào. Predicate `expires_at < now()` giữ nguyên ở mọi lô, nên chạy lại sau khi đứt giữa chừng vẫn an toàn. `count(*)` thay cho `RETURNING nonce` để giá trị nonce không rơi vào terminal hay buffer của client.

**Prune định kỳ (lịch chạy)** — **Cloudflare Worker cron `apps/auth-nonce-prune-job`**. Workflow cron GitHub cũ đã bị **xoá** khỏi `main` (issue #82) và thay bằng cron-trigger Worker: nhịp `17 3 * * *` giữ nguyên (03:17 UTC = 10:17 ICT); toàn bộ thuật toán (identity preflight, batch, cap, probe, retry, log shape) được port sang application lib `@ecoma-io/auth-nonce-prune-job-application` của Worker, test phủ — đặc tả đầy đủ ở [`../auth-nonce-prune-job/01-architecture.md`](../auth-nonce-prune-job/01-architecture.md), runbook ở [`../auth-nonce-prune-job/03-operations.md`](../auth-nonce-prune-job/03-operations.md).

- **Cơ chế:** `scheduled()` handler của Worker chạy qua Hyperdrive bindings `DB_AUTH`/`DB_ACCOUNT`, kết nối bằng driver `pg` với role pruner của mỗi kho (`ecoma_auth_nonce_pruner` / `ecoma_account_nonce_pruner` — tạo từ `0014` / `0007`). KHÔNG dùng credential `_migrator_`: credential DDL không bao giờ là Worker secret ([`02`](../../architecture/02-delivery.md) §6), nên job cũ chạy CI-runner-bằng-migrator không thể port thẳng — thay vì đó, một role pruner DML cấp bảng được sinh để Worker cầm. Serving path không được nới quyền nào: grant của `ecoma_auth_runtime` trên bảng này giữ nguyên `SELECT, INSERT`.
- **Identity preflight giữ nguyên học thuyết:** script hỏi `current_user` + `has_table_privilege(..., 'DELETE')` từ chính server, rồi so với `ecoma_auth_nonce_pruner|deletable` / `ecoma_account_nonce_pruner|deletable`; sai role, sai bảng (một `to_regclass` NULL → `missing`) hay thiếu quyền thì dừng ở `outcome=identity_mismatch` TRƯỚC khi xoá hàng nào — DSN dán nhầm service bị chặn, không âm thầm prune nhầm database.
- **Xoá theo lô có giới hạn, giữ nguyên cap:** tối đa `MAX_BATCHES=50` lô, mỗi lô `BATCH_SIZE=20000` hàng (xoá qua `nonce = ANY (…)`, ghim plan Index Scan pkey), mỗi lô một transaction riêng với `SET LOCAL statement_timeout=60s` + `lock_timeout=30s`. Trần thời gian của vòng lô giảm từ `MAX_SECONDS=600` (workflow cũ) xuống `400`: trần `scheduled()` của Workers là 15 phút wall-clock xác thực, và bảng tính `MAX_SECONDS + 450 ≤ 850s < 900s` con số được ghim trong `prune-caps.ts` của application lib `@ecoma-io/auth-nonce-prune-job-application` cộng test.
  - **Chạm trần phải probe:** sau khi chạm trần (`batches`/`seconds`), chạy một phép `SELECT EXISTS(… WHERE expires_at < now())` rẻ (đi qua index `expires_at`): probe `true` (backlog còn) → `cap_hit` + **throw** → cron invocation đỏ ở Cron dashboard → Past events (fail closed — khác GitHub chỉ ở chỗ đơn vị đỏ là một cron invocation, không phải một job GitHub); probe `false` (xoá vừa đủ lúc chạm trần) → `ok` kèm `cap=`; không chạm trần → `ok` không tốn một vòng nào.
  - **Mỗi lô tự commit:** run đứt giữa đường chạy lại vẫn an toàn — predicate `expires_at < now()` giữ nguyên ở mọi lô, không có trạng thái tiến độ nào để hỏng. Không `TRUNCATE`, không `UPDATE` `expires_at`.
- **Hai kho song song, một kho hỏng không cản kho kia (nhưng run vẫn đỏ).** `runOnce` dùng `Promise.allSettled`: cả hai kho chạy, cả hai kết quả đều được log, sau đó **bất kỳ rejection nào** cũng rethrow — đúng hợp đồng "hai job GitHub đối xứng" cũ, một bên hỏng thì run đỏ ở đúng bên đó, không bên nào được báo thành công thay bên kia.
- **Tần suất:** một lần mỗi ngày (`cron` `17 3 * * *`). Đây là **chính sách vận hành, không phải một cam kết bảo mật**: nonce cũ nằm lại vẫn là nonce đã bị chiếm và vẫn chặn replay. Cloudflare có thể trì hoãn hoặc bỏ một cron tick khi tải cao, và không có SLA cho thời điểm chạy ([`04`](../../architecture/04-platform-facts.md) §2.17) — đừng đọc "03:17" như một bảo đảm.
- **Quan sát được:** mỗi kho in một dòng JSON `{"event":"nonce_prune","service":…,"outcome":…,"pruned":n,"batches":n,"duration_s":n,"retries":n}`; lỗi một kho in `{"event":"nonce_prune_error","message":"service=… outcome=… pruned=…"}` giữ nguyên shape dòng lỗi của workflow cũ (`outcome ∈ ok|cap_hit|db_unreachable|statement_failed|identity_mismatch|not_configured|unexpected_output`), và mỗi lần thử lại in thêm `{"event":"nonce_prune_retry","service":…,"what":…,"attempt":n}`. Trường `pruned=`/`batches=` trong **mọi** dòng lỗi là số đếm **thật** đã xoá tới thời điểm hỏng, không phải `0` cứng. **Không** nonce, không secret, không connection string, không thân request: projection của `DELETE` là `RETURNING 1` bọc trong CTE, chỉ `count(*)` ra tới client; connection string sống trong Hyperdrive binding của Cloudflare account, không qua env của Worker.
- **Khi hỏng:** fail closed. Chỉ lỗi transport mới được thử lại — connection-failure class SQLSTATE (`08000`, `08001`, `08003`, `08004`, `08006`, `08007`, `05P01`, `57P01`, `57P02`, `57P03`) **cộng** connect-failure tầng driver (`ENOTFOUND`, `ECONNREFUSED`, …), tối đa `MAX_ATTEMPTS=3` với backoff tuyến tính 5 s/10 s; `42501` (thiếu quyền), `57014` (`statement_timeout`) và mọi SQLSTATE khác dừng ngay ở `statement_failed` — thử lại chúng chỉ kéo dài giữ khoá, đúng học thuyết script cũ.
- **Chạy tay "có kiểm soát" hiện KHÔNG có đường.** Workflow cũ có `workflow_dispatch`; Worker cron không có HTTP surface nào (`fetch` export bị cố ý bỏ — `wrangler.jsonc` không route, `workers_dev: false`), nên không có cách nào kích prune từ bên ngoài. Lần chạy gần nhất là tick trước, tick kế cách nhau đúng một ngày; nếu cần drain gấp, dùng runbook chạy tay `ecoma_auth_nonce_pruner` ở phía trên. Việc nhắc một đường chạy tay production qua `cron trigger` Cloudflare là không có — đây là một đánh đổi tường minh: mất dispatch-on-demand để không phải thêm một ranh giới HTTP cần auth.

⚠️ **Trạng thái: đã cấu hình, CHƯA xác minh runtime.** Worker chưa được deploy + cron chưa có Hyperdrive thật: bindings `DB_AUTH`/`DB_ACCOUNT` trong `apps/auth-nonce-prune-job/wrangler.jsonc` mang id placeholder, hai database chưa được provision. Worker được tin chỉ sau khi ba điều kiện dưới được xác minh bằng một lần chạy thật:

1. **Hyperdrive config thật của mỗi database được provision và id thật được dán vào `wrangler.jsonc`** (staging riêng, production riêng — không dùng chung), và connection string của Hyperdrive cấu hình đúng role pruner của kho nó.
2. Migration `0014` (db-auth) / `0007` (db-account) được áp — role pruner tồn tại với đúng hai quyền `SELECT, DELETE`, và identity preflight trả đúng `ecoma_auth_nonce_pruner|deletable` / `ecoma_account_nonce_pruner|deletable`. Có sweep quyền trong `apps/auth/migrations/README.md` §"Sweep kiểm tra quyền" ô (2d) chạy sau khi áp.
3. Worker deploy đủ hai environment và "Past events" của Cron Triggers dashboard thấy tick đầu tiên: một run đỏ ở `outcome=not_configured`/`identity_mismatch` là đúng trạng thái fail-closed khi infra chưa đủ, KHÔNG phải một lần "job im lặng bỏ qua".

⚠️ Thiếu Hyperdrive binding ở `env` thì handler **đỏ** với `outcome=not_configured` (log một dòng JSON riêng nêu tên binding) chứ không im lặng bỏ qua: một job dọn dữ liệu không chạy được là một lỗi cần thấy.

⚠️ **Không deploy role pruner với quyền nhiều hơn hai quyền này, và không nới quyền runtime để cron "chạy được"**: học thuyết của `0010` — xoá nonce còn hiệu lực là mở cửa sổ replay — đúng nguyên văn ở đây; grant của pruner hẹp đúng một bảng, hai quyền.

⚠️ Chưa prune thì bảng phình ra theo lưu lượng request nội bộ — đó là vấn đề **vận hành, không phải bảo mật**: một nonce cũ nằm lại vẫn là một nonce đã bị chiếm, nên nó vẫn chặn replay. Không được vì thế mà "dọn" bằng `TRUNCATE`: xoá sạch kho bằng một câu lệnh **mở lại** cửa sổ replay cho mọi envelope còn trong skew, trong khi prune theo `expires_at` thì không. Cùng lý do, không xoá theo tuổi cố định và không hạ tần suất xuống mức "chạy khi nhớ".

#### Mã lỗi và trạng thái

| Nhóm                                                                                                     | HTTP  | Ghi chú                               |
| -------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------- |
| Thiếu header, timestamp sai định dạng/ngoài skew, nonce yếu/đã chiếm, chữ ký sai hoặc sai version scheme | `401` | Không nêu lý do cụ thể trong response |
| Thân vượt 64 KiB                                                                                         | `413` | Thân request — §5.1.8                 |
| Kho nonce hoặc DB không gọi được                                                                         | `503` | Fail closed, **không** cho qua        |

Log một lần từ chối chỉ ghi `reason` (`missing_header`, `bad_timestamp`, `weak_nonce`, `replayed_nonce`, `bad_signature`, `invalid_field`, `no_secret`, `no_binding`, `db_unreachable`) cùng `event`, `route`, `method`, `status`. **Không** ghi giá trị header: `x-ecoma-internal-signature` là chữ ký HMAC, và một chữ ký trong log là giá trị còn tái dùng được trong cửa sổ skew. Cũng **không** nối `error`/message của driver `pg` vào log — message của nó có thể chứa connection string.

⚠️ **Vì sao dòng log này là một phần của cơ chế chống replay, không phải trang trí.** Response `401` **cố tình** không phân biệt lý do (một response nói `bad_signature` là một oracle dò chữ ký), nên `reason` trong log là chỗ **duy nhất** phân biệt được `replayed_nonce` — dấu vết của một lần phát lại thật — với một chữ ký sai thông thường. Cùng vậy, `503` không mang thông tin nào để phân biệt "kho nonce không gọi được" với một sự cố hạ tầng khác: `reason: 'db_unreachable'` là dấu vết duy nhất.

⚠️ **Tập `reason` không giống nhau ở hai chiều**, vì mỗi bên có nhánh riêng **trước khi** chạm `verifyRequest`: `auth` (`apps/auth/src/main.ts`) chỉ sinh mã của lib cộng `db_unreachable`; `account` (`apps/account/server/middleware/internal-auth.ts`) ghi thêm `no_secret` và `no_binding`. Hai mã đó không tồn tại ở `auth` vì thiếu secret/binding là lỗi nạp config ở đó (`config.ts` ném), không phải một nhánh từ chối.

Cả hai chiều ghi ở cùng một mức (`log`, không phải `warn`) để một truy vấn theo mức không bỏ sót một nửa sự kiện. `account` đi qua `writeLog` (`key=value`), `auth` ghi một dòng JSON — định dạng khác nhau vì `auth` không có sink nào dùng chung với `apps/account`, nhưng **tập trường là cùng một hợp đồng**, và dòng của `auth` là tập đóng: `route`/`method`/`status` là hằng của route, `reason` là mã trong union.

## 4. Key custody và rotation

⚠️ **Lịch xoay chưa chốt** ([`01-architecture.md`](./01-architecture.md) §9). Những gì đã chốt và những gì còn mở:

**Đã chốt:**

- `db-auth` lưu **chỉ metadata**: `kid`, algorithm, status, `not_before`, `expires_at` (`auth.signing_keys`, migration 0007). **Private key không lưu trong `db-auth`** — đó là database có thể bị restore lên máy mới, bị đọc qua bản sao và lọt vào tay operator có quyền đọc.
- **Private key là Worker Secret `AUTH_SIGNING_KEY`** (PKCS#8 PEM) cùng `AUTH_SIGNING_KEY_ID` — cả hai bắt buộc, `apps/auth/src/config.ts` ném lúc khởi động nếu thiếu. Provider ký JWT ES256 (`id_token_signed_response_alg` pin `ES256` cho mọi client, TTL ID token 300 giây).
- JWKS phục vụ **public key** tại `/jwks.json`.
- Xoá `kid` khỏi JWKS **trước** khi phát hành bản thay thế.

**Chưa chốt (có trigger):**

| Mục                  | Vì sao cần quyết định trước                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Lịch xoay và overlap | Token ký bằng key cũ phải còn hợp lệ tới hết TTL                                              |
| TTL của key          | Phải ≥ TTL access token, nếu không token đang sống không verify được                          |
| Compromise response  | Xoá `kid` là một nước, nhưng token đã ký bằng key đó vẫn là chữ ký hợp lệ cho tới khi hết hạn |

⚠️ **Rủi ro khi key bị lộ: token đã cấp bằng key đó vẫn được chấp nhận tới hết hạn** dù đã xoá khỏi JWKS — và ở mô hình verify offline, resource server **không hỏi được** nên không có cách nào biết `kid` đã bị xoá. Xoá `kid` chặn **token mới**, không thu hồi **token cũ**. Muốn thu hồi cả token cũ thì phải dựa vào revocation control plane ([`01-architecture.md`](./01-architecture.md) §6.5), không dựa vào JWKS.

## 5. Environment isolation

| Môi trường | Database                      | Credential                         |
| ---------- | ----------------------------- | ---------------------------------- |
| Production | `db-auth`                     | `ecoma_auth_runtime` thật          |
| Staging    | Database riêng, cùng instance | Role staging riêng                 |
| PR Preview | DB preview riêng/mock         | **Không** có production credential |

- **Không bao giờ** bind Hyperdrive production vào Preview.
- ⚠️ **Cả hai hướng binding đều là đường xác thực, không phải read-only.** `account` → `auth` (`POST /internal/session/verified`) là nơi `auth` nhận danh tính đã xác minh; `auth` → `account` (`GET /internal/account/status`) là control point fail-closed lúc phát hành ([`01-architecture.md`](./01-architecture.md) §5.1, §6.0). Worker đích giữ Hyperdrive production nên Preview gọi binding là **ghi vào dữ liệu production**. **Login/consent E2E và kiểm tra trạng thái account đều không chạy dependency mode A** — dùng Mode C (mock, mặc định cho smoke) hoặc Mode B với service token riêng theo môi trường ([`02` §5.3](../../architecture/02-delivery.md)). Mỗi môi trường khai báo binding tường minh; thiếu binding thì fail closed, không rơi về đường không xác thực.
- ⚠️ **Staging không phải bằng chứng HA.** `db-auth` và `db-account` cùng nằm trên **một PostgreSQL instance**, nên staging **không** kiểm chứng được failure domain độc lập — sập instance là sập cả hai service cùng lúc ([`03` §3.2](../../architecture/03-operations.md), [`03` §3.2c](../../architecture/03-operations.md)). Một run staging xanh chứng minh logic và contract chạy đúng, **không** chứng minh tách lỗi. Muốn kiểm chứng HA thì phải theo trigger và tier ở [`03` §6](../../architecture/03-operations.md).

## 6. Hyperdrive

- Query cache **OFF** (HD3/HD4 → [`01` invariant 14](../../architecture/01-architecture.md)). Đặc biệt quan trọng ở `auth`: cache trả kết quả cũ cho _authorization transaction đã consume_ hoặc _token đã thu hồi_ là lỗi bảo mật, không phải lỗi hiệu năng.
- Config tách biệt để **repoint được độc lập** khi DR.
- Ngân sách connection tính theo từng config (HD9/HD13); hai database hai config riêng **nhân đôi** số config → [`03` §2.1](../../architecture/03-operations.md).
- Không advisory lock / `LISTEN`/`NOTIFY` / SQL-level `PREPARE` (HD6).

## 7. Observability

- **Không log** token, `code_verifier`, refresh token, `account_session_ref`, client secret hay assertion. Log chỉ chứa whitelisted fields (event, route, `client_id`, `sub`, `kid`, error code).
- **Không** phải serving-path dependency.

Metrics (đề xuất):

| Metric                                                 | Ý nghĩa                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `authorize_requests_total{outcome}`                    | `success`/`denied`/`invalid_request`/`error`                                                    |
| `token_requests_total{grant_type,outcome}`             | Phát hiện việc dùng grant type bị cấm (Implicit/ROPC) hoặc PKCE fail                            |
| `codes_issued_total` / `codes_reused_total`            | `codes_reused_total > 0` là tín hiệu nghi vấn — code single-use nên không bao giờ được dùng lại |
| `refresh_reuse_detected_total`                         | Dấu hiệu refresh token bị lộ                                                                    |
| `tokens_issued_total` / `tokens_revoked_total{reason}` | Theo dõi thu hồi                                                                                |
| `revocation_checks_total{outcome}`                     | `outcome=fail_closed` tăng → revocation control plane có vấn đề                                 |
| `contract_errors_total{target}`                        | Back-channel lỗi                                                                                |
| `reconciliation_lag_seconds`                           | Độ trễ giữa thay đổi ở `account` và projection ở `db-auth`                                      |
| `db_query_duration` / pool size                        | Đường DB                                                                                        |

⚠️ **`codes_reused_total` và `refresh_reuse_detected_total` không phải metric "bình thường".** Cả hai đều là dấu hiệu tấn công hoặc bug; giá trị khác 0 cần điều tra, không aggregate bỏ qua.

## 8. Alerting

| Điều kiện                                           | Mức     | Ý nghĩa                                                                                  |
| --------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `db-auth` không ghi được                            | Page    | Toàn bộ authorization và token issuance lỗi                                              |
| `refresh_reuse_detected_total > 0`                  | Page    | Refresh token có thể đã bị lấy; cần thu hồi family và điều tra                           |
| `codes_reused_total` tăng                           | Page    | Authorization code bị replay hoặc bug single-use                                         |
| `revocation_checks_total{outcome=fail_closed}` tăng | Page    | Revocation control plane không trả lời được — fail closed đang chặn user                 |
| Tỉ lệ `invalid_request` tăng vượt ngưỡng            | Warning | Sai redirect URI, thiếu PKCE, thiếu `state`, hoặc client bug                             |
| Grant type bị cấm xuất hiện                         | Warning | Client đang thử Implicit/ROPC — có thể là client cũ hoặc tấn công                        |
| `reconciliation_lag_seconds` vượt ngưỡng            | Warning | `auth` không học kịp trạng thái account                                                  |
| Tỉ lệ 5xx tăng khi `account` down                   | Warning | Back-channel đang fail closed như thiết kế; theo dõi **thời lượng**, không phải từng lần |
| JWKS không có key khả dụng                          | Page    | Token mới không ký được                                                                  |

## 9. Failure modes

| Sự cố                                                                                     | Hành vi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Đóng băng |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **`db-auth` down**                                                                        | `auth` 503. `account` vẫn phục vụ session và account management — mất token authority không được phép thành mất account                                                                                                                                                                                                                                                                                                                                                                                                            | Không     |
| **`account` down**                                                                        | Login/consent fail — `auth` **fail closed**, không cấp code. Token đã cấp cho client **vẫn hợp lệ theo mô hình token đã chốt** ([`01-architecture.md`](./01-architecture.md) §6.1); không có degraded path cho authorization mới                                                                                                                                                                                                                                                                                                   | Không     |
| **Back-channel contract down** (`account` → `auth`)                                       | **Fail closed** — không cấp code. Đây là đường xác thực, không có degraded path                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Không     |
| **Revocation control plane unavailable**                                                  | **Fail closed tại phát hành** (điểm kiểm soát A) — trạng thái thu hồi unknown ≠ active, nên không phát hành token. ⚠️ Fail closed **không** áp dụng cho resource server verify offline — ở đó không có lệnh gọi nào để hỏi ([`01-architecture.md`](./01-architecture.md) §6.1). Đây là hành vi đúng, không phải sự cố để "fix bằng cách cho qua"                                                                                                                                                                                   | Không     |
| **Toàn instance PostgreSQL/VPS down**                                                     | `auth` 503 — cùng một sự kiện với `account` ([`03` §3.2](../../architecture/03-operations.md))                                                                                                                                                                                                                                                                                                                                                                                                                                     | Có        |
| **Signing key bị lộ**                                                                     | Xoá `kid` khỏi JWKS **trước** (chặn token mới), phát hành bản thay thế **sau**, **và** ghi `token_revocations` mức toàn subject. ⚠️ Xoá `kid` một mình **không** vô hiệu token đã cấp ở verifier đã cache JWKS; và ở mô hình verify offline, ghi `token_revocations` **không** có tác dụng với resource server vì nó không hỏi nguồn thu hồi đó — nó chỉ giữ `auth` không cấp token mới. **Không** tuyên bố containment trước khi cả hai điều kiện ở §11.1 thỏa (runbook §11.1, [`01-architecture.md`](./01-architecture.md) §6.5) | Không     |
| **Token tự ký bằng key bị lộ**                                                            | Thu hồi theo subject **không** chặn được — attacker ký với `sub` tuỳ ý. Cách duy nhất là thay key, và hiệu lực phụ thuộc cache của verifier; hạ TTL **không** rút ngắn `exp` của token đã cấp (§11.1)                                                                                                                                                                                                                                                                                                                              | Không     |
| **Consent/authorization result bị delay, replay hoặc retry**                              | CAS consume → lần hai bị từ chối; không cấp code thứ hai                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Không     |
| **`__Host-auth-browser` cookie bị mất** (xoá cookie, đổi trình duyệt, sang thiết bị khác) | Bước push và `/authorize/complete` bị từ chối; browser bắt đầu `/authorize` mới. ⚠️ Đây **không** phải sự cố xác thực — cookie chỉ chứng minh quan hệ browser↔transaction, không chứng minh user đã đăng nhập ([`01-architecture.md`](./01-architecture.md) §5.3)                                                                                                                                                                                                                                                                  |
| **Push bị từ chối vì `browser_confirmed` chưa thoả**                                      | Transaction không bind danh tính; chính là hành vi chống pre-binding. Điều tra bằng cách hỏi user đã mở `/authorize/confirm` chưa, **không** bằng cách nới điều kiện                                                                                                                                                                                                                                                                                                                                                               |
| **Hết hạn rotation `K_auth`**                                                             | Xoá khóa cũ là tác vụ theo lịch, **có điều kiện** — chỉ khi mọi transaction dùng `key_version` đó đã hết TTL ([`01-architecture.md`](./01-architecture.md) §5.6)                                                                                                                                                                                                                                                                                                                                                                   |
| **`account` đã suspend nhưng event chưa tới**                                             | Chặn lần phát hành kế tiếp **nếu** nó đọc trạng thái sau commit — race in-flight vẫn tồn tại ([`01-architecture.md`](./01-architecture.md) §6.0). Độ trễ tối đa chấp nhận được chưa chốt                                                                                                                                                                                                                                                                                                                                           | Không     |

### 9.1 Isolation ≠ availability

Hai database trên một instance tách được **authorization blast radius** — hỏng logic `db-auth` không làm sập `account` — nhưng **không** tách được failure domain. `db-auth` down là `auth` down; instance PostgreSQL/VPS down là **cả hai** service down ([`03` §3.2](../../architecture/03-operations.md)).

## 10. Restore

⚠️ **`pg_dumpall` dump toàn cluster** (`04` PG1) và thường cần superuser (PG2) → hai database `db-auth`/`db-account` **luôn restore cùng nhau**. Cần **restore path độc lập theo database** cho lớp "chỉ một DB hỏng"; WAL/PITR là lớp crash-recovery chung.

| Tình huống                                    | Hành vi                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-auth` mất, `db-account` còn               | `auth` unavailable. Account người dùng vẫn đăng nhập được. **Mọi grant cũ coi như mất** — không có authority để kiểm chứng chúng còn sống hay không                                                     |
| `db-account` mất, `db-auth` còn               | `account` unavailable. Grant còn nguyên giá trị → **thu hồi hàng loạt** grant của các account mất **trước khi cho traffic trở lại** ([`../account/03-operations.md`](../account/03-operations.md) §9.2) |
| `db-auth` restore từ điểm cũ hơn `db-account` | `db-auth` có thể chứa token đã bị thu hồi ở phía kia, hoặc grant cho account không còn tồn tại. **Reconcile hai chiều trước khi mở traffic**                                                            |
| Cả hai mất                                    | Rebuild theo [`03` §3.3](../../architecture/03-operations.md)                                                                                                                                           |

⚠️ **Restore lệch thời điểm là trạng thái không an toàn theo mặt authorization.** Grant chỉ resolve được nếu `db-account` có account tương ứng tại cùng thời điểm. Restore hai database từ **cùng một restore point** là bắt buộc, và sau đó phải reconcile — không coi dữ liệu là hợp lệ chỉ vì nó từng tồn tại.

## 11. Runbook

| Tình huống                                    | Bước                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signing key bị lộ**                         | (1) Xoá `kid` khỏi JWKS **ngay** — chặn token **mới** trước. (2) Phát hành key thay thế. (3) **Ghi `token_revocations` mức toàn subject** — có tác dụng **tại `auth`** (không cấp token mới) và tại verifier **có** kiểm nguồn thu hồi; ⚠️ **không** có tác dụng với verifier JWT offline vì nó không hỏi ([`01-architecture.md`](./01-architecture.md) §6.5). (4) **Hạ TTL access token cho các token cấp sau này** — ⚠️ việc này **không** rút ngắn `exp` của token đã được cấp với TTL dài, nên nó **không** thu hẹp được cửa sổ chấp nhận token cũ. **Sau đó, hai việc theo dõi incident** (không thay thế 4 thao tác trên và **không** phải điều kiện containment — §11.1): **(5)** rà audit, xem token đã phát hành từ thời điểm nghi ngờ lộ, để ước lượng cửa sổ bị xâm nhập; **(6)** thu hồi grant/refresh family liên quan tại `auth` — tác dụng thuộc phía `auth`, không phải phía resource server verify offline |
| **Revocation system outage**                  | Fail closed theo [`01-architecture.md`](./01-architecture.md) §6. Không có degraded path "cho qua" — đó là việc biến sự cố khả năng sẵn có thành mất quyền kiểm soát. Báo incident; phục hồi rồi mới mở lại                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Phát hiện token theft**                     | Thu hồi refresh family (reuse detection hoặc chủ động), ghi `token_revocations` cho subject, kiểm audit phát hành token quanh thời điểm bất thường                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Client bị lộ `client_secret`**              | Rotate secret; cân nhắc thu hồi grant của client đó — tùy chính sách, chưa chốt ([`01-architecture.md`](./01-architecture.md) §9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **`db-auth` hỏng logic**                      | Đóng băng ghi → restore PITR sang instance mới → verify invariant qua Hyperdrive → repoint config `db-auth` → **reconcile với `db-account`** → mở lại                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Account bị suspend nhưng `auth` chưa biết** | Chặn tại thời điểm phát hành; chạy reconciliation để đồng bộ projection; kiểm outbox `account` có phát chưa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Restore lệch thời điểm**                    | Đóng băng cả hai service; restore từ cùng restore point; reconcile hai chiều trước khi mở traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 11.1 Signing key bị compromise — bốn thao tác khác nhau, và điều kiện tuyên bố containment

⚠️ **Bảng ở §11 là bản tóm tắt của §11.1, và nó phải có cùng ngữ nghĩa với §11.1.** Khi hai chỗ lệch nhau, §11.1 là canonical; sự lệch đó là bug tài liệu, không phải hai quy trình khác nhau.

| #   | Thao tác                                          | Chặn được cái gì                                                                        | **Không** chặn cái gì                                                          |
| --- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | **Ngừng ký bằng key bị lộ** (xoá `kid` khỏi JWKS) | Token **mới** ký bằng key đó, kể cả do attacker tự ký                                   | Token ký bằng key đó đã tồn tại; token ký bằng key khác                        |
| 2   | **Phát hành key thay thế**                        | Token mới ký bằng key mới                                                               | Không tự động làm token cũ hết hiệu lực                                        |
| 3   | **Ghi `token_revocations` mức toàn subject**      | Token đã cấp, **tại verifier có kiểm nguồn thu hồi**; và giữ `auth` không cấp token mới | Verifier verify offline — nó **không** hỏi nguồn thu hồi này                   |
| 4   | **Hạ TTL access token cho token cấp từ giờ**      | Rút ngắn cửa sổ của các token **được cấp sau thời điểm đó**                             | **Không** ảnh hưởng token đã được cấp với TTL dài — `exp` đã ký không đổi được |

**Sau khi làm 1–4** — hai việc theo dõi incident, không thay thế bốn thao tác trên và **không** phải điều kiện containment:

5. **Rà audit** — token đã phát hành từ thời điểm nghi ngờ lộ; dùng để ước lượng cửa sổ bị xâm nhập, không dùng để kết luận token nào còn dùng được.
6. **Thu hồi grant liên quan** — thu hồi refresh family và grant của subject bị ảnh hưởng tại `auth`; tác dụng thuộc phía `auth`, không phải phía resource server verify offline (cùng giới hạn với bước 3).

⚠️ **Bước 3 là bước dễ bị hiểu sai nhất, và hiểu sai là nguy hiểm.** Ghi `token_revocations` chỉ có tác dụng với verifier **có hỏi** nguồn thu hồi đó. Ở mô hình verify offline, resource server **không** hỏi — nó chỉ kiểm chữ ký. Ghi bản ghi thu hồi cho một mô hình không dùng nó là **hành động không có tác dụng**, dù nó trông như đã xử lý.

⚠️ **Không được tuyên bố "đã thu hồi token" nếu mô hình verify là offline.** Trong mô hình đó, hành động đúng là ghi `token_revocations` để _phía `auth`_ không cấp token mới và để reconciliation có đường truy vết — chứ không phải để "thu hồi" ở phía resource server.

**Kẻ tấn công dùng private key bị lộ để tự ký token** — đây là tình huống mà thu hồi theo subject **không** bao phủ:

- Attacker tự ký token với `sub` **tuỳ ý** — kể cả `sub` chưa từng tồn tại, hoặc thuộc tài khoản mà hắn không hề biết.
- Vì vậy "ghi `token_revocations` cho các subject đã biết" **không** chặn được token này. Danh sách subject của hệ thống không phải danh sách subject attacker có thể dùng.
- Cách duy nhất chặn được là **thay key** — và ở mô hình offline, hiệu lực của việc thay key phụ thuộc cache của verifier.

**Điều kiện để tuyên bố sự cố đã được containment** — phải thỏa **cả hai**, không được chỉ một:

| Điều kiện                                                                      | Cách xác minh                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Key bị lộ không còn ký được token nào** mà **bất kỳ** verifier nào chấp nhận | Mọi cache JWKS đã hết hạn **hoặc** đã purge chủ động. ⚠️ Ở mô hình offline đây là **cửa sổ theo cache**, không phải thời điểm bạn quyết định — không có cách nào đóng nó ngay lập tức |
| **Token đã cấp hợp lệ đã hết hiệu lực**                                        | TTL đã trôi qua, **hoặc** verifier có mạch kiểm thu hồi và thấy bản ghi ở bước 3                                                                                                      |

⚠️ **Nếu mô hình verify offline thì không thể tuyên bố containment ngay sau khi làm bước 1–6.** Phải chờ hết cửa sổ cache của mọi resource server. Trong thời gian đó, kết luận đúng là **"đã giới hạn khả năng cấp token mới, chưa chặn được token tự ký"** — ghi vậy vào hồ sơ incident, đừng ghi "đã thu hồi".

**Quyết định đã có trong code, phản chiếu vào runbook** (mô hình verify và TTL — [`01-architecture.md`](./01-architecture.md) §6.2, §9):

| Đã chốt                                | Giá trị                                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mô hình verify của resource server** | Offline JWT: access token là JWT ES256 TTL 300 giây; **không** có `/introspect`, có `/revocation` — bước 3 có tác dụng tại `auth` và tại verifier có kiểm nguồn thu hồi, không có tác dụng với verifier offline |
| **TTL access token**                   | 300 giây (`apps/auth/src/oidc/provider.ts`) — cửa sổ chấp nhận token cũ sau containment tối đa là 5 phút                                                                                                        |

| Cần chốt                    | Vì sao nó quyết định cả runbook này                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Cơ chế purge cache JWKS** | Có chủ động được không, hay phải chờ HTTP cache header hết hạn. Quyết định này quyết định "đã containment" sớm hay muộn |

⚠️ **Không được giả định `/introspect` hay denylist đã tồn tại.** Provider **không** mount `/introspect` (`features.introspection` tắt) và `/revocation` chỉ là endpoint thu hồi chủ động do client gọi (RFC 7009) — không phải denylist mà verifier offline tự hỏi. Giới hạn ở mô hình offline là giới hạn **thật** — không phải thiếu sót của tài liệu.

## 12. Operational invariants

1. Runtime role chỉ DML trên `db-auth`, không `CONNECT` sang `db-account` (§3.1).
2. Migrator role chỉ sống trong CI secret store; không bao giờ là Worker secret.
3. Query cache OFF trên Hyperdrive config `db-auth`.
4. Không Hyperdrive config nào của `auth` trỏ production origin từ Preview.
5. Migration history độc lập với `db-account`; rollback Worker **không** rollback database.
6. `db-auth` có restore path độc lập **và** được drill hằng tháng; restore hai database dùng cùng restore point rồi reconcile.
7. Mất `db-account` khiến grant mất ý nghĩa → thu hồi hàng loạt trước khi cho traffic trở lại.
8. Private signing key không nằm trong `db-auth`; chỉ metadata.
9. Revocation unavailable → fail closed; không có degraded path.
10. Không token, `code_verifier`, refresh token, `account_session_ref` hay secret nào xuất hiện trong log, audit, alert hay Queue message.
11. **Xoá `kid` không đồng nghĩa đã thu hồi.** Sự cố signing key chỉ được tuyên bố containment khi **cả** cache JWKS của mọi resource server đã hết hạn/purge **và** token đã cấp đã hết hiệu lực (§11.1).
12. Ghi `token_revocations` chỉ có tác dụng ở nơi **có** hỏi nguồn thu hồi. Không được mô tả nó là đã thu hồi token ở resource server verify offline.

Architectural invariants → [`01-architecture.md`](./01-architecture.md) §8 · [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §9.
