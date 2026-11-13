# Account — Vận hành

> Phạm vi: vận hành ứng dụng `account` — deployment, binding, role & migration, dọn dữ liệu hết hạn, cô lập môi trường, Hyperdrive, observability, alerting, failure mode, backup/restore và runbook.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · nghiệp vụ → [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) · backup/DR system-level → [`../../architecture/03-operations.md`](../../architecture/03-operations.md) · delivery → [`../../architecture/02-delivery.md`](../../architecture/02-delivery.md).
> ⚠️ **`db-account` chưa provision** và Hyperdrive id trong `wrangler.jsonc` còn là placeholder — các phần deployment/provisioning/restore dưới đây là kế hoạch cho khi provision.

---

## 1. Runtime

```text
account.ecoma.io  (Cloudflare Worker · Nuxt 4 + Nitro preset cloudflare_module)
└── Hyperdrive binding → db-account   (query cache OFF)
```

Worker identity lâu dài — `ecoma-account`, không có suffix môi trường; staging là `stg-ecoma-account`. PR không tạo Worker mới ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §5.1).

## 2. Deployment

Deployment đi kèm (theo `wrangler.jsonc`):

- Hyperdrive binding trỏ `db-account` (**tên binding**, không host/port/user — [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 4).
- Worker Secrets của môi trường; **không** có provider credential — gửi mail qua `transactional-mail`, không tự gọi provider.
- Observability enabled.

⚠️ `nodejs_compat` là **bắt buộc** cho Nuxt app: Nitro đọc config này để bật `cloudflare.nodeCompat`, và `nodeCompat` quyết định build có polyfill Node cho runtime bundle hay không. Bỏ flag ⇒ runtime lỗi trong khi `wrangler deploy --dry-run` **vẫn báo pass**. Khác `auth`: `auth` mang `runtime:edge` và `.oxlintrc.json` cấm Node builtin, nên `auth` **không** bật flag này.

Kiểm sau deploy:

```text
GET /health → 200
GET /ready  → 200 { status: 'ready' }   # khi db-account sống, fail closed ⇒ 503 khi không
```

Rollback theo Worker version đã publish, **không** rollback database ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §8).

## 3. Database, role và migration

| Database     | Owner     | Runtime role            | Migrator role            |
| ------------ | --------- | ----------------------- | ------------------------ |
| `db-account` | `account` | `ecoma_account_runtime` | `ecoma_account_migrator` |

Ba tầng role, mỗi tầng một việc, cộng một role pruner riêng:

- **Owner/admin** — `ecoma_owner`, sở hữu database và object, **không** chạy trong Worker. Cầm ngoài VPS cho disaster recovery ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §3.5).
- **Migrator** — quyền DDL, chạy **chỉ** trong CI runner ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.1). **Không bao giờ** là Worker secret ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §6 rule 11).
- **Runtime** — chỉ `SELECT`/`INSERT`/`UPDATE`/`DELETE` trên schema ứng dụng. Không DDL, không `CREATE`.
- **Pruner** — `ecoma_account_nonce_pruner`, chỉ `SELECT, DELETE` trên `account.internal_nonces` (tạo ở `0007_nonce_pruner_role.sql`); là principal của cron Worker `apps/auth-nonce-prune-job`. Vì không phải role DDL, nó không cần — và không được — cầm credential migrator.

### 3.1 Chặn chéo — điều kiện bắt buộc

```sql
REVOKE CONNECT ON DATABASE db-auth FROM ecoma_account_runtime;
```

Câu lệnh này **không phụ thuộc table nào tồn tại**, nên từ chối được ngay từ khi database tạo ra chứ không phải "sau khi có bảng mới chặn được". Kiểm bằng:

```sql
SELECT has_database_privilege('ecoma_account_runtime', 'db-auth', 'CONNECT');  -- phải = false
```

⚠️ **Đây là lớp enforce thật của ranh giới database giữa `account` và `auth`, không phải tag Nx.** Dù hai app đang dùng chung một scope hay đã tách hai scope riêng, tag Nx đều **không** chặn được việc `apps/account` khai báo binding trỏ `db-auth` — tag chỉ mã hoá graph ([`../../architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md) §6.3). Ranh giới đó là credential không cho phép.

### 3.2 Migration

- **Greenfield provisioning, không phải data migration.** Không có schema chung nào tồn tại để kế thừa. Danh mục migration `0001`–`0010` và nội dung từng bước → [`01-architecture.md`](./01-architecture.md) §3.8. Mọi file idempotent (runner chạy lại toàn bộ mỗi lần apply) và forward-only; integration test áp mọi file hai lần (`apps/account/tests/databases/migrations.spec.ts`).
- Migration chạy từ **CI runner** bằng PostgreSQL client kết nối thẳng, dùng role `_migrator_`, giữ advisory lock ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.1). Hyperdrive không hỗ trợ advisory lock (`04` HD6) nên không thể chạy migration từ trong Worker. Runner đã có: `pnpm nx run @ecoma-io/account:db:migrate` với `DATABASE_URL` (bắt buộc) và `ECOMA_AUTH_DATABASE` (tuỳ chọn) — thiếu `DATABASE_URL` thì exit code khác 0 chứ không im lặng coi như đã apply.
- **Migration history độc lập** với `db-auth` — hai deploy unit rollout độc lập ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 18). Dùng chung bảng migration là cách buộc hai service vào một release, đúng thứ tách deploy unit sinh ra để tránh.
- Expand → compatible rollout → contract; không down-migration, **forward-fix** ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 10).

⚠️ **Bốn việc dưới đây phải do owner/admin chạy, không nằm trong `db/migrations/`.** Cả bốn bị chặn bởi cùng một nguyên nhân: `ecoma_account_migrator` sở hữu `db-account` chứ không sở hữu cluster, không có `CREATEROLE`, và không được có — `NOCREATEROLE` là điều kiện để nó không leo thang. Lệnh và lý do chi tiết ở [`apps/account/db/README.md`](../../../apps/account/db/README.md) §"Provisioning step 1".

| Việc                                                              | Vì sao migration không tự làm                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `CREATE ROLE … LOGIN` (migrator, runtime, pruner)                 | Cần `CREATEROLE`                                                |
| `GRANT CONNECT, CREATE, TEMPORARY` trên `db-account` cho migrator | `CREATE SCHEMA` cần `CREATE` ở tầng database, `PUBLIC` không có |
| `REVOKE CONNECT` trên `db-auth`                                   | Cần quyền sở hữu `db-auth`                                      |
| `COMMENT ON ROLE` / `COMMENT ON DATABASE`                         | Cần `CREATEROLE` / database owner                               |

⚠️ **`REVOKE CONNECT` trên `db-auth` phải rút khỏi `PUBLIC` _và_ khỏi role.** Chỉ rút khỏi `ecoma_account_runtime` là **no-op**: PostgreSQL cấp `CONNECT` cho `PUBLIC` theo mặc định, nên `has_database_privilege` vẫn trả `true` và một kết nối thật vẫn thành công. `apps/account/tests/integrations/roles.spec.ts` có ba test riêng cho điều đó: `has_database_privilege` trả `false`, connection thật bị từ chối, và item `PUBLIC` trong `datacl` không chứa `C`.

⚠️ **Hệ quả phối hợp:** rút `CONNECT` khỏi `PUBLIC` trên `db-auth` cũng chặn `ecoma_auth_runtime`, nên migration của chính `db-auth` phải `GRANT CONNECT` lại cho nó. Quên thì `auth` hỏng chứ không phải `account`.

Thứ tự provisioning, mỗi bước dừng an toàn:

1. **Infrastructure** — tạo database, bốn role (owner/admin, migrator, runtime, pruner), `REVOKE CONNECT` chéo (kể cả `PUBLIC`). Verifiable ngay bằng `has_database_privilege`.
2. **Expand** — schema vào, chưa Worker nào gọi tới.
3. **Binding** — Hyperdrive config theo môi trường.
4. **Compatible rollout** — deploy Worker mới đọc schema mới.
5. **Contract** — xoá object cũ **sau** rollback window.

### 3.3 Dọn nonce hết hạn

`account.internal_nonces` phình theo lưu lượng của đường nội bộ. Việc dọn nó **không** còn là job `prune-account` của GitHub Actions: workflow cron cũ (dùng chung cho hai bên) đã bị **xoá** khỏi `main` (issue #82, PR #89) và thay bằng cron Worker `apps/auth-nonce-prune-job` — nhịp `17 3 * * *`, một lần mỗi ngày, chạy **hai lane song song**; lane `DB_ACCOUNT` xoá `account.internal_nonces` (predicate `expires_at < now()`, xoá theo lô có giới hạn) bằng role riêng `ecoma_account_nonce_pruner` (tạo ở `0007_nonce_pruner_role.sql`), **không** phải `ecoma_account_migrator` — Worker không được cầm credential DDL ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §6 rule 11). Job **chưa chạy thật lần nào**: nó chưa có target `deploy`, chưa nằm trong release matrix, và binding Hyperdrive `DB_ACCOUNT` của nó còn là placeholder — nên kho nonce bên này chưa từng được prune.

Cố ý **không** dùng `ecoma_account_runtime` cho job định kỳ, dù runtime bên này có `DELETE` trên bảng đó (khối giải thích grant của `internal_nonces` ở cuối `0002_roles_and_grants.sql`, và grant thật ở `0003_internal_nonces.sql`): một job định kỳ không nên phụ thuộc vào một ngoại lệ chỉ tồn tại ở một bên — nên cron Worker cầm principal riêng của từng kho (`ecoma_account_nonce_pruner` / `ecoma_auth_nonce_pruner`), hai role **tách biệt**, không chia credential. Credential của `auth` không bao giờ được dùng ở đây và ngược lại.

Cơ chế, tần suất, hợp đồng log, hành vi khi hỏng và đường chạy tay nằm ở [`../auth/03-operations.md`](../auth/03-operations.md) §3.3; đó là chỗ duy nhất mô tả cơ chế dùng chung cho cả hai job, nên không chép lại ở đây.

⚠️ **Prune `otp_challenges` chưa hiện thực: grant `DELETE` đã có, nhưng chưa có job nào dùng nó.** Migration `0006_otp_challenges.sql` ghi rõ `DELETE` là "prune theo TTL, thao tác của bảng", song mọi hàng đã consume hoặc đã hết hạn của `otp_challenges` nằm lại database vô hạn — không job nào dọn nó (`internal_nonces` bên cạnh giờ đã có cron Worker dọn ở trên, nhưng `otp_challenges` vẫn "grant có, job chưa"; một job tương tự theo hình dạng §3.3 là follow-up riêng). Không khẩn cấp vì throttle resend 60 giây và rate limit 3/15 phút + 10/giờ chặn được phần lớn volume. Việc này **không cần cấp thêm quyền** — `ecoma_account_runtime` đã có `DELETE`; và cũng không chạy bằng role khác, vì hai lý do trong đoạn trên.

Điều kiện an toàn cho prune này đã có sẵn trong thiết kế: rate limit đếm các hàng `otp_challenges` trong cửa sổ 15 phút và 1 giờ, nên bất kỳ job dọn nào chỉ xoá hàng **quá TTL** (600 giây) thì không và không thể làm sai một phép đếm rate limit đang hiệu lực. Ràng buộc duy nhất cần giữ khi hiện thực: predicate prune phải dựa trên `consumed_at`/`expires_at` (vòng đời của bảng). Workflow cron cũ đã bị xoá khỏi `main` trong PR #89 (commit `bf920d3c`), khi nó được thay bằng cron Worker `apps/auth-nonce-prune-job`; trên `main` chỉ còn lại `ci.yaml`, `code-analysis.yml`, `code-review.yml`. Việc hiện thực lại prune cho hai bảng này (nonce và `otp_challenges`) do phần delivery đảm nhiệm và phải dựa trên đặc tả baseline ở [`../auth/03-operations.md`](../auth/03-operations.md) §3.3, không dừng ở trạng thái tài liệu đã drift.

### 3.4 Tạo Account đầu tiên (bootstrap)

Account đầu tiên đi qua **create-or-resolve** — thao tác offline của `account`, không có route HTTP và không nằm trong Worker (ADR-0021 Quyết định 2). Đây là đường **duy nhất** được phép ghi `account.users`; không có production code path nào khác làm việc đó.

Đường này chỉ phục vụ **bootstrap** — Account đầu tiên. Kênh tạo Account ngoài bootstrap đã có quyết định được chấp nhận: **lời mời do administrator phát**, Account ra đời tại thời điểm người được mời chứng minh kiểm soát email bằng luồng OTP đăng nhập ([ADR-0030](../../domains/account/adr/0030-account-creation-channel-invitation.md) — Accepted 2026-11-14, PR #214; chưa hiện thực — hiện thực thuộc #227). Cho tới khi Delivery đó hiện thực xong, trạng thái vận hành không đổi: procedure này vẫn là đường ghi `account.users` duy nhất và không có route nào tạo Account. Recovery không dùng đường này — recovery chỉ đọc `sub` đã có (ADR-0023 Quyết định 3). Địa chỉ canonical ở trạng thái `verified` ngay sau bước này, không phải `pending`: đó là **trusted provisioning assertion** của một thao tác offline được tin cậy, không phải bằng chứng OTP ([ADR-0024](../../domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md) Quyết định 1). Đăng nhập vẫn bắt buộc đi qua luồng passwordless OTP hiện có.

- **Bề mặt:** CLI offline trong `apps/account`, chạy bằng credential migrator/owner của `db-account` (ADR-0020 Quyết định 3(b)). Không route, không flag, không cron. Người vận hành không gọi thẳng CLI này: entry point duy nhất là `pnpm dx bootstrap-superadmin`, nó chạy CLI như tiến trình con với chuỗi kết nối lấy từ env `ECOMA_ACCOUNT_DATABASE_URL` (không qua argv) — chi tiết ở [`../staff-access/03-operations.md`](../staff-access/03-operations.md) §2.
- **Concurrency:** đọc và ghi trong **một** transaction dưới **advisory transaction lock toàn cục cố định** cho đường bootstrap (`pg_advisory_xact_lock` với một khoá hằng, không phải khoá theo `address_hash`: chỉ có một địa chỉ canonical nên một khoá toàn cục tuần tự hoá mọi lần chạy và không phụ thuộc dữ liệu đầu vào). Advisory lock tuần tự hoá bootstrap-vs-bootstrap; ngoài ra A1 lấy `LOCK TABLE account.users IN SHARE ROW EXCLUSIVE MODE` trong cùng transaction, **trước** phép kiểm và phép ghi, để tuần tự hoá A1 với **mọi** transaction khác INSERT vào `account.users` — không có nó, một writer ngoài bootstrap có thể commit giữa phép kiểm "database còn trống" và phép `INSERT` của A1 ở `READ COMMITTED`. Lock tự nhả khi commit/rollback; cùng hình dạng với advisory lock của migration runner. ⚠️ Vì Hyperdrive **không** hỗ trợ advisory lock (HD6, §5), create-or-resolve chỉ tồn tại được trên bề mặt CLI offline ở trên — không phải trong Worker.
- **Idempotency:** chuẩn hoá địa chỉ bằng đúng hàm của luồng OTP, tra `account.email_addresses` theo `address_hash` (SHA-256 hex, không theo địa chỉ trần). Không có hàng nào → sinh `sub` mới (entropy 32 ký tự base32 lấy từ CSPRNG; `createSubject` chỉ nhận entropy và throw khi sai; `sub` không bao giờ là email) rồi ghi `account.users` + `account.email_addresses` `verified` + bootstrap audit trong cùng transaction. Có đúng một hàng `verified` đã hội tụ **và chứng minh được nguồn gốc bootstrap** → trả lại chính `sub` đó; không tạo hàng mới, nhưng vẫn ghi một bootstrap audit event `status = 'converged'` trong transaction (điều kiện ở mục fail-closed ngay dưới, audit ở ADR-0024 Quyết định 6).
- **Fail-closed, không chọn một hàng:** nhiều hơn một `sub` sở hữu địa chỉ; `sub` đã `suspended`/`deleted`; Account đó còn địa chỉ `verified` **khác**; cùng `sub` có nhiều hơn một hàng còn sống cho `address_hash`; hoặc có hàng `verified` nhưng **không** chứng minh được nguồn gốc bootstrap (thiếu bootstrap audit event cùng transaction, hoặc địa chỉ không khớp hằng canonical) — tất cả dừng procedure. **Không bao giờ suy quyền từ địa chỉ một mình:** một hàng `verified` do đường khác tạo ra không phải bằng chứng Account đó do bootstrap tạo, kể cả khi địa chỉ trùng. Điều kiện là hàng `verified` khác, **không** phải `is_sign_in`: `is_sign_in` là cờ hiển thị, không có CHECK ràng buộc với `status` (`0005_email_addresses.sql`), và luồng đăng nhập chỉ lọc `status = 'verified'` cộng `users.status = 'active'` (`lookupVerifiedAddress`, `resolveOtpTarget`). Lý do chặn hàng `verified` lạ: nhận `sub` đó là cấp quyền administrator cho người đăng nhập bằng địa chỉ của họ (ADR-0021 Quyết định 2, ADR-0024 Quyết định 4).
- **Hàng `revoked`:** khoá tự nhiên và mọi kiểm hội tụ chỉ đọc `status IN ('pending','verified')`; hàng `revoked` không giữ địa chỉ và không chứng minh quyền sở hữu. Nhưng nó là dấu hiệu đã có người từng chạm địa chỉ — procedure **dừng và báo**, không tự xoá/revoke hàng nào.
- **Trạng thái email:** `verified`, `verified_at = database now()`, `is_sign_in = true`, ghi trong cùng transaction với `account.users`. Đây là assertion của procedure, không phải kết quả một lần OTP: không có endpoint sessionless nào đổi trạng thái này (ADR-0024 Quyết định 1, 2). Địa chỉ do người dùng tự thêm trong Account context vẫn `pending` và vẫn phải verify ở đó — procedure này không đụng tới chúng.
- **Đầu ra:** đúng một `sub`. Đây là giá trị duy nhất được truyền sang bước Staff Access; `staff-access` không đọc `db-account`.
- **Audit:** `account.security_events` ghi cùng transaction, `type = 'bootstrap_account_provisioned'` (`subject_sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode = 'bootstrap'`, `metadata.verification_source = 'trusted_bootstrap'`, và `metadata.operator_ref` do người vận hành khai báo — bảng này không có cột `correlation_id` và không có principal, ADR-0021 Quyết định 6, ADR-0024 Quyết định 6). Writer của đường này nhận **transaction client** và **ném** khi insert hỏng; không tái dùng `appendSecurityEvent` của serving path vì helper đó không nhận transaction và nuốt lỗi, nên một Account không audit được sẽ commit như thành công. Bước này **không** ghi `metadata.admins_before`/`metadata.admins_ever`: hai số đó chỉ được đo trong critical section ghi của `staff-access`, không phải ở `account`. ⚠️ `operator_ref` là **tự khai**, không được xác minh; nó không chứng minh danh tính người giữ credential (ADR-0021 Quyết định 6, ADR-0023 Quyết định 5). ⚠️ `operator_ref` **bắt buộc có giá trị**: nhận chuỗi rỗng sẽ tạo một Account mà audit không có attribution nào, và A1 đã commit nên không sửa lại được — CLI từ chối input rỗng trước khi mở transaction. Entry point `pnpm dx bootstrap-superadmin` kiểm cùng điều kiện trước cả preflight, để procedure không đi được tới A1 khi thiếu tham chiếu.
- **Bảo đảm nguồn gốc ở tầng database (không còn là giới hạn đã chấp nhận):** migration `0011_bootstrap_write_guards.sql` của `db-account` rút `INSERT` trên `account.users` khỏi `ecoma_account_runtime` (bootstrap là đường ghi `users` duy nhất), và một trigger trên `account.security_events` từ chối `type = 'bootstrap_account_provisioned'` khi principal thực thi là runtime — audit thường của serving path vẫn ghi được bình thường. Một credential runtime bị chiếm trước lần bootstrap đầu **không còn** dựng được Account + bằng chứng nguồn gốc để hướng nhánh hội tụ về `sub` tự chọn. Giả định tin cậy còn lại, ghi rõ ở [ADR-0024](../../domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md) Quyết định 1, 3, 6: người cầm **credential migrator/owner** là trusted principal của procedure — bảo vệ bằng custody credential, không phải bằng kiểm tra database.

Đọc lại để verify:

```sql
SELECT u.sub, u.status AS account_status, e.status, e.verified_at, e.is_sign_in
FROM account.users u JOIN account.email_addresses e ON e.user_sub = u.sub
WHERE e.address_hash = <sha256(address)>
  AND e.status IN ('pending', 'verified');
```

Đạt khi trả đúng một row với `sub` khớp `^sub_[a-z2-7]{32}$`, `account_status = 'active'`, `status = 'verified'`, `verified_at IS NOT NULL`, `is_sign_in = true`, **và** có đúng một `security_events` row `type = 'bootstrap_account_provisioned'` cùng `subject_sub` với `metadata.address_hash` khớp — đó là bằng chứng hàng email này do bootstrap tạo, không phải do đường khác. Cột `account_status` phải có trong câu đọc: "Account không ở trạng thái tombstone" là một điều kiện của pass criteria, nên câu truy vấn phải đọc được nó — kiểm một điều kiện mà truy vấn không trả về là kiểm bằng giả định. Runbook đầy đủ của procedure (thứ tự bước, retry, bổ nhiệm thường, recovery) → [`../staff-access/03-operations.md`](../staff-access/03-operations.md).

## 4. Environment isolation

| Môi trường | Database                      | Credential                         |
| ---------- | ----------------------------- | ---------------------------------- |
| Production | `db-account`                  | `ecoma_account_runtime` thật       |
| Staging    | Database riêng, cùng instance | Role staging riêng                 |
| PR Preview | DB preview riêng hoặc mock    | **Không** có production credential |

- **Không bao giờ** bind Hyperdrive production vào Preview ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9 invariant 2) — không có ngoại lệ.
- ⚠️ **Staging không phải bằng chứng HA.** `db-account` và `db-auth` cùng nằm trên **một PostgreSQL instance**, nên staging **không** kiểm chứng được failure domain độc lập — sập instance là sập cả hai service `account`/`auth` cùng lúc ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §3.2). Một run staging xanh chứng minh logic và contract chạy đúng, **không** chứng minh tách lỗi. Staging dùng chung host với production cũng vì vậy **không** phải HA test ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §4). Muốn kiểm chứng HA thì phải theo trigger và tier ở [`../../architecture/03-operations.md`](../../architecture/03-operations.md) §6.
- ⚠️ **Cả hai hướng binding đều là đường xác thực, không phải read-only.** `account` → `auth` (`POST /internal/session/verified`) là nơi `auth` nhận danh tính đã xác minh; `auth` → `account` (`GET /internal/account/status`) là control point fail-closed lúc phát hành ([`01-architecture.md`](./01-architecture.md) §5, §5.3). Worker đích giữ Hyperdrive production nên Preview gọi binding là **ghi vào dữ liệu production qua một Worker production**. Với `account`, cả hai vế đều áp dụng: binding của `account` tới `auth` **và** Hyperdrive config `db-account`. **Login/consent E2E và kiểm tra trạng thái account đều không chạy dependency mode A** — dùng Mode C (mock, mặc định cho smoke) hoặc Mode B với service token riêng theo môi trường ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §5.3). Mỗi môi trường khai báo binding tường minh; thiếu binding thì fail closed, không rơi về đường không xác thực.

## 5. Hyperdrive

Mỗi service **một config riêng**, không dùng chung:

- Query cache **OFF** (HD3/HD4: cache bật mặc định và **không** invalidate khi ghi — [`01-architecture.md`](./01-architecture.md) §10 invariant 13). Không có đường correctness nào được bỏ qua quy tắc này.
- Cấu hình tách biệt **không chỉ** là tách credential — nó là điều kiện để **repoint được độc lập** khi DR: sửa origin của `db-account` không được kéo `auth` đi theo.
- Ngân sách connection tính **theo từng config** (HD9 ~20 Free / ~100 Paid, HD13 tối thiểu 5). `db-account` và `db-auth` là hai config riêng — ngân sách tính cho cả hai, không gộp → [`../../architecture/03-operations.md`](../../architecture/03-operations.md) §2.1.
- Không dùng advisory lock / `LISTEN`/`NOTIFY` / SQL-level `PREPARE` (HD6 → [`01-architecture.md`](./01-architecture.md) §10 invariant 14).

## 6. Observability

- **Không log** password, session cookie, `account_session_ref`, `code_verifier`, token hay assertion. Log chỉ chứa whitelisted fields (event, route, method, status, `sub`, `session_id` đã hash, error code) ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §4).
- **Không** phải serving-path dependency ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §6).

Metrics (đề xuất):

| Metric                                        | Ý nghĩa                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `login_attempts_total{kind=success\|failure}` | Tỉ lệ thất bại là tín hiệu credential stuffing                                                                        |
| `login_failures_by_reason`                    | Phân biệt email không tồn tại / sai mật khẩu / MFA fail — **đếm cả hai nguyên nhân** để không rò thông tin qua metric |
| `sessions_revoked_total{reason}`              | Đổi mật khẩu, suspend, user tự thu hồi                                                                                |
| `rate_limited_total{bucket}`                  | Bucket nào đang bị chặn                                                                                               |
| `consent_context_requests_total`              | Tỉ lệ lỗi contract với `auth`                                                                                         |
| `outbox_backlog` / `outbox_unpublished_age`   | Event sang `auth` chưa gửi được                                                                                       |
| `db_query_duration` / pool size               | Đường DB ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §4)                            |
| `internal_auth_rejections_total{reason}`      | Lần từ chối envelope theo `reason` — không ghi giá trị header                                                         |
| `nonce_store_unavailable_total`               | Lần từ chối `503` vì không có kho nonce (Hyperdrive không gọi được)                                                   |

⚠️ `login_failures_by_reason` phải gộp hai nguyên nhân thất bại ở tầng metric. Tách riêng "email không tồn tại" khỏi "sai mật khẩu" biến metric thành **oracle enumeration** — chính cái mà anti-enumeration sinh ra để chặn.

## 7. Alerting

| Điều kiện                                              | Mức     | Ý nghĩa                                        |
| ------------------------------------------------------ | ------- | ---------------------------------------------- |
| Tỉ lệ login failure tăng vượt ngưỡng                   | Warning | Credential stuffing hoặc lỗi triển khai        |
| Burst login failure từ một IP/subnet                   | Page    | Đang bị tấn công dò mật khẩu                   |
| `db-account` không ghi được                            | Page    | Toàn bộ đăng nhập và account management lỗi    |
| Outbox backlog tăng liên tục                           | Warning | `auth` chưa nhận được trạng thái account       |
| Contract lỗi với `auth` tăng                           | Warning | Back-channel hoặc consent context đang hỏng    |
| Rate limit phát sinh trên nhóm người dùng thật         | Warning | Có thể là false positive của rule chưa chỉnh   |
| `internal_auth_rejections_total{reason}` tăng đột biến | Warning | Sai khoá, lệch clock hoặc dò endpoint internal |

Ngưỡng số cụ thể chưa chốt ([`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §10); **không** gắn con số chưa đo vào alert.

## 8. Failure modes

| Sự cố                                                                  | Hành vi                                                                                                                                                                                                                                                       | Đóng băng |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **`db-account` down**                                                  | `account` 503. `auth` vẫn validate token cũ nhưng **không** phát hành token mới — contract `auth → account` không trả lời được thì không phát hành (fail closed)                                                                                              | Không     |
| **`auth` down**                                                        | Đăng nhập vẫn được (session thuộc `account`), nhưng **không** có OAuth flow mới. Account management vẫn chạy                                                                                                                                                  | Không     |
| **Back-channel contract down**                                         | Fail closed, không cấp code. Không có degraded path                                                                                                                                                                                                           | Không     |
| **Kho nonce không gọi được** (Hyperdrive lỗi khi kiểm envelope)        | `401`/`503` theo taxonomy của envelope — không có nhánh cho qua khi không xác minh được replay. Xem [`01-architecture.md`](./01-architecture.md) §8.2                                                                                                         | Không     |
| **Toàn instance PostgreSQL/VPS down**                                  | `account` 503 — **một sự kiện duy nhất** ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §3.2)                                                                                                                                  | Có        |
| **Account bị suspend nhưng `auth` chưa nhận event**                    | Chặn ngay ở `db-account`. `auth` chặn tại thời điểm phát hành; độ trễ tối đa là quyết định chưa chốt                                                                                                                                                          | Không     |
| **Login handoff bị tranh chấp** (hai session trình X lần đầu cùng lúc) | Đúng một tạo binding trong `login_handoffs`; session còn lại bị từ chối + audit. Binding không bị ghi đè bởi session nào ([`01-architecture.md`](./01-architecture.md) §3.6.1)                                                                                |
| **Login handoff bị mất khi xoay session**                              | Binding được chuyển sang session mới **trong cùng transaction** xoay session; nếu xoay xong mà binding chưa chuyển thì đó là bug, không phải hành vi chấp nhận được ([`01-architecture.md`](./01-architecture.md) §3.6.2)                                     |
| **Attacker chiếm X trước nạn nhân** (pre-binding)                      | ⚠️ Lớp 1 của `account` **không** chặn được; `auth` chặn ở điều kiện `browser_confirmed`. Đừng dựa vào log `account` để phát hiện trường hợp này — hãy đọc metric push bị từ chối của `auth` ([`../auth/01-architecture.md`](../auth/01-architecture.md) §5.3) |
| **Outbox không publish**                                               | Event nằm trong outbox chưa published; reconciliation phát lại. `auth` vẫn chặn tại thời điểm phát hành                                                                                                                                                       | Không     |

⚠️ **Tách database tạo blast radius, không tạo availability.** Hai database trên một instance tách được _authorization blast radius_ — hỏng logic `db-account` không làm sập `auth` — nhưng **không** tách được failure domain ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §3.2).

## 9. Backup và restore

Chính sách backup system-level → [`../../architecture/03-operations.md`](../../architecture/03-operations.md) §3.1. Điểm riêng của `db-account` (và song song với `db-auth`):

⚠️ **`pg_dumpall` dump toàn cluster** (`04` PG1) và thường cần superuser (PG2) → `db-account` và `db-auth` **luôn backup và restore cùng nhau**. Đúng thứ không mong muốn khi chỉ một database hỏng logic. Cần **restore path độc lập theo database**: dump riêng cho lớp "chỉ một DB hỏng", còn WAL/PITR là lớp crash-recovery chung của instance. Hai lớp khác nhau về mục đích, không thay thế nhau.

### 9.1 Drill

| Drill                                                 | Tần suất   | Đạt khi                                                                                                                                         |
| ----------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore **`db-account`** lên instance tạm             | Hằng tháng | Service chạy được trên bản restore và verify invariant của nó ([`01-architecture.md`](./01-architecture.md) §10) **qua chính đường Hyperdrive** |
| Restore **cả hai** database từ cùng một restore point | Hằng tháng | Hai service nhất quán chéo: `sub` trong `db-auth` resolve được trong `db-account`                                                               |

Drill dừng ở "PostgreSQL đã restore trên một máy" là **chưa đo** — phải gồm bước repoint Hyperdrive. Với cặp `account`/`auth`, repoint từng config và verify **cả hai** service, vì dữ liệu chéo database không được coi là hợp lệ chỉ vì nó từng tồn tại.

### 9.2 Partial restore

| Tình huống                                                 | Hành vi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-account` mất, `db-auth` còn                            | **`account` unavailable** — không đăng nhập được. Grant cũ **còn nguyên giá trị**, nên phải **thu hồi hàng loạt** grant của các account mất **trước khi cho traffic trở lại** — [`../auth/03-operations.md`](../auth/03-operations.md) §7                                                                                                                                                                                                                                                                                                                |
| `db-auth` mất, `db-account` còn                            | **`auth` unavailable**, không có authorization transaction, code, grant hay token. Account người dùng vẫn còn và **đăng nhập được** — đúng thiết kế: mất token authority không được mất account                                                                                                                                                                                                                                                                                                                                                          |
| Restore lệch thời điểm giữa hai DB                         | Hai database restore từ **cùng một restore point**; lệch điểm tạo grant không resolve được — phát hiện bằng reconciliation, không phải bằng lỗi runtime                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Restore làm dữ liệu đã xoá quay lại**                    | ⚠️ Backup chụp trước khi xoá vẫn chứa dữ liệu cá nhân, và restore đưa nó trở lại. ⚠️ **Dữ liệu quay lại không được coi là hợp lệ chỉ vì nó đã vào database.** Trước khi mở traffic: đối chiếu danh sách `sub` đã xoá với dữ liệu phục hồi; row khớp phải được xử lý như **tombstone đã quay lại cùng dữ liệu chức năng** — xoá hoặc anonymize lại, **không** mở lại account; **ghi lại kết quả đối chiếu**, kể cả khi không có dòng nào khớp. Chi tiết quy trình → [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §7.4 |
| **Restore đưa dữ liệu đã anonymize về tới `sub` còn sống** | Không có cơ chế nào tự phát hiện: `sub` vẫn hợp lệ nên dữ liệu trông bình thường, nhưng nó đã nối lại được với một chủ thể. Phải xem là **sự cố tái liên kết**, xử lý như data incident, và **không** coi là hợp lệ chỉ vì nó tồn tại                                                                                                                                                                                                                                                                                                                    |

## 10. Runbook

| Tình huống                                               | Bước                                                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Suspend tài khoản**                                    | Ghi `status=suspended` + thu hồi mọi session **trong `db-account`** trước; outbox event phát sang `auth`. Xác nhận `auth` đã nhận hoặc chấp nhận độ trễ đã chốt. **Không** chờ `auth` để ghi state  |
| **Xoá tài khoản**                                        | Soft delete → tombstone, `sub` không tái phát hành; thu hồi session; outbox event; xoá/anonymize dữ liệu chức năng theo retention                                                                   |
| **Lộ credential / nghi ngờ bị xâm nhập**                 | Đổi mật khẩu → thu hồi session khác; thu hồi luôn authenticator/passkey bị nghi ngờ; rà `security_events` theo `sub` và IP                                                                          |
| **`db-account` hỏng logic**                              | Đóng băng ghi → restore PITR sang instance mới → verify invariant qua Hyperdrive → **đối chiếu `sub` đã xoá** (§9.2) → repoint config `db-account` → **thu hồi hàng loạt grant** → mở lại           |
| **Privacy request failure**                              | [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §9.5 FR-015 — deadline theo luật là cứng; request hỏng **không** được kéo dài deadline                             |
| **Rate limit false positive**                            | Nới ngưỡng tạm, ghi nhận, hiệu chỉnh rule — không tắt hẳn rate limit trước khi có biện pháp thay thế                                                                                                |
| **Nghi sai khoá envelope** (401 hàng loạt từ một caller) | Kiểm `kid` + secret của hai Worker có cùng giá trị; kiểm clock skew; xoay theo quy trình overlap rồi bỏ khoá cũ sau khi cả hai phía đã deploy (`01-architecture.md` §8.1)                           |
| **Sự cố rò dữ liệu**                                     | Theo quy trình sáu bước ở [`../../domains/account/domain-model.md`](../../domains/account/domain-model.md) §8.5; bước quyết định nghĩa vụ thông báo phải ghi lại lý do, kể cả khi kết luận là không |

## 11. Operational invariants

1. Runtime role chỉ DML trên `db-account`, không `CONNECT` sang `db-auth` (§3.1).
2. Migrator role chỉ sống trong CI secret store; không bao giờ là Worker secret.
3. Query cache OFF trên Hyperdrive config `db-account`.
4. Không Hyperdrive config nào của `account` trỏ production origin từ Preview.
5. Migration history độc lập với `db-auth`; rollback Worker **không** rollback database.
6. `db-account` có restore path độc lập **và** được drill hằng tháng; drill chỉ tính là đạt khi có bước repoint Hyperdrive.
7. Mất `db-account` phải kèm thu hồi grant trước khi cho traffic trở lại; mất `db-auth` không được làm mất account.
8. Không password, session cookie, `account_session_ref` hay token nào xuất hiện trong log, audit, alert hay Queue message.
9. Observability không bao giờ là serving-path dependency.
10. Prune kho nonce chạy bằng role pruner riêng; không dùng credential migrator và không chia credential giữa hai kho.

Architectural invariants → [`01-architecture.md`](./01-architecture.md) §10 · [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §9.
