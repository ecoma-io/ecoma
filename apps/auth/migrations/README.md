# Migrations cho `db-auth`

Thư mục chứa migration của **`db-auth`** — database mà service `auth` sở hữu trọn vẹn. Mọi
object sống trong schema `auth` (không dùng `public`); xem §"Vì sao schema `auth`, không phải
`public`".

Đây là một work unit của nền tảng Auth. Runner TypeScript canonical của unit này giờ đã có:
`apps/auth/db/apply.mts`, chạy bằng `pnpm nx run @ecoma-io/auth:db:migrate` với biến môi
trường `DATABASE_URL` (credential `ecoma_auth_migrator`, database `db-auth`) — runner hiện thực
hoá đúng giao thức trong §"Cách áp dụng" dưới đây (advisory lock, history
`auth.schema_migrations`, checksum, thứ tự tên file). Các file SQL ở đây vẫn được viết để áp
dụng được bằng bất kỳ runner nào giữ đúng các quy ước dưới đây.

Mục lục:

- [Cách áp dụng](#cách-áp-dụng)
- [Quy ước cấu trúc file](#quy-ước-cấu-trúc-file)
- [Vai trò của operator](#vai-trò-của-operator)
- [Vì sao các câu CREATE không kèm IF NOT EXISTS](#vì-sao-các-câu-create-không-kèm-if-not-exists)
- [Vì sao lệnh REVOKE CONNECT không nằm chung transaction](#vì-sao-lệnh-revoke-connect-không-nằm-chung-transaction)
- [Vì sao phải thu CONNECT của cả PUBLIC lẫn role](#vì-sao-phải-thu-connect-của-cả-public-lẫn-role)
- [Sweep kiểm tra quyền](#sweep-kiểm-tra-quyền)
- [Ràng buộc liên service chưa có](#ràng-buộc-liên-service-chưa-có)

---

## Cách áp dụng

Migration chạy **từ CI runner**, bằng một PostgreSQL client kết nối thẳng database, dùng role
`ecoma_auth_migrator`, và **giữ advisory lock**. Hyperdrive không hỗ trợ advisory lock
(`docs/architecture/04-platform-facts.md` HD6), nên đường này **không thể** chạy từ trong Worker —
đó là lý do nó là một bước CI, không phải serving path.

Runbook (trình tự cụ thể, lặp lại được):

0. **Bước operator (một lần, ngoài CI)** — tạo hạ tầng; xem §"Vai trò của operator".
1. CI runner đăng nhập PostgreSQL với credential của `ecoma_auth_migrator`, vào database
   `db-auth`.
2. **Giữ advisory lock** trên một key hằng số riêng cho `db-auth`, và **nhả nó** kể cả khi
   có lỗi (lock của session bị giết tới hết connection timeout là một lý do CI khác bị chặn).
   Key cụ thể do runner chọn; chỉ cần ổn định và không trùng với key của `db-account`.
3. Đọc bảng migration history của **chính database này** (`auth.schema_migrations`), khác hẳn
   lịch sử của `db-account` — hai deploy unit rollout độc lập (`02-delivery.md` §3).
4. Với mỗi file `*.sql` chưa có trong lịch sử, theo thứ tự:
   - ghi checksum của file;
   - nạp **cả file trong một transaction** (`psql -1`); file nào dở giữa chừng sẽ hỏng đồng
     đều, không để lại trạng thái "bảng đã tạo xong, bảng chưa tạo";
   - sau khi nạp thành công, ghi dòng `(filename, checksum)` vào lịch sử.
5. File đã có trong lịch sử **không được nạp lại**. Nếu checksum lệch với lịch sử → **abort**:
   file đã thay đổi sau khi áp = drift, không được tự ý "sửa chữa" bằng DDL trùng.
6. Nhả advisory lock.

Đây là **forward-fix**: không có down-migration. Muốn sửa/đổi schema thì thêm file mới, không
viết `DROP`/`ALTER` ngược trong file cũ (bất biến 10; `02-delivery.md` §3).

Thứ tự áp dụng đúng là thứ tự số của tên file (`0001_*` trước, rồi `0002_*`, …). Phần
`0009_grants_and_isolation.sql` có một đặc thù riêng — xem §"Vì sao lệnh REVOKE CONNECT
không nằm chung transaction".

---

## Quy ước cấu trúc file

- Mỗi file ghi rõ framework nó thuộc giai đoạn nào (tên file bắt đầu bằng số → thứ tự).
- Mỗi file **bắt đầu bằng `SET TIME ZONE 'UTC';`** — mọi cột thời gian là `timestamptz`
  (NFR-001) và mọi biểu thức mặc định/so sánh thời gian được đọc trong UTC. Hyperdrive chạy
  transaction mode pooling nên `SET` chỉ sống trong transaction/query (`04` HD5) — vì vậy
  đừng cứ ỷ vào một session `SET` đã có từ trước.
- Mọi object được qualify bằng `auth.` (xem §"Vì sao schema `auth`").
- Lời giải thích viết tiếng Việt; tên cột, từ khóa SQL, tên framework giữ tiếng Anh.
- Quy tắc chung: **chỉ hậu tố là thứ tạo ra thứ tự, còn nội dung mỗi file là một đơn vị
  logic** (client → transaction → consent/grant → code → refresh → revocation → key → event).

---

## Vai trò của operator

Các file ở đây **không tạo role chủ**. Việc tạo database, ba role gốc (owner/migrator/runtime)
và thu cross-connect là **bước operator, ngoài CI** — đây là lựa chọn của workstream `account`,
và unit này **bám theo đúng lựa chọn đó** (auth 03-operations.md §3 mô tả cùng mô hình ba tầng;
đọc thêm `docs/applications/account/03-operations.md` §3). Lý do giữ ngoài migration: role/database
là hạ tầng, không phải schema; chúng phải tồn tại trước để migration **có người chạy và nơi chạy**.

⚠️ Ngoại lệ kiểu file: `0014_nonce_pruner_role.sql` **có** khối `DO $$` tạo role, nhưng đó chỉ
là **lưới an toàn idempotent** trên một cluster sạch — role vẫn phải được provisioning tạo sẵn
(bước 2 dưới đây), vì migrator là `NOCREATEROLE` không tự CREATE được. Pruner là role DML-cấp
bảng, không phải role chủ; nó không thay đổi mô hình "provisioning trước, schema sau".

Trình tự operator (provisioning, theo auth 03-operations.md §3.2):

1. Tạo database `db-auth`.
2. Tạo **bốn** role theo mô hình ba tầng cộng một role pruner: owner/admin
   (`ecoma_owner`, không chạy trong Worker, cầm ngoài VPS cho DR), migrator
   (`ecoma_auth_migrator`, quyền DDL, chỉ chạy trong CI), runtime
   (`ecoma_auth_runtime`, chỉ DML), và pruner (`ecoma_auth_nonce_pruner`,
   chỉ `SELECT, DELETE` trên `auth.internal_nonces` — principal của cron Worker
   `apps/auth-nonce-prune-job`, tạo trong migration `0014`).
3. Gán quyền hạ tầng:
   - `GRANT CREATE` trên `db-auth` cho `ecoma_auth_migrator` (role này tạo schema `auth` và
     các bảng; xem `0001` ở phần mở đầu);
   - **không** cấp `CREATE` cho `ecoma_auth_runtime` trên bất kỳ schema nào (NFR-002a).
4. Chạy `CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ecoma_auth_migrator;` — có thể do
   operator hoặc do file `0001` khi ứng dụng lần đầu; cả hai đều dùng đúng `AUTHORIZATION`
   nên không quan trọng ai thực hiện trước.
5. Chặn chéo: `REVOKE CONNECT ON DATABASE db-account FROM ecoma_auth_runtime;` **và**
   `REVOKE CONNECT ON DATABASE db-account FROM PUBLIC;` — xem §"Vì sao phải thu cả hai".

Role `ecoma_auth_migrator` không cần `SUPERUSER` sau khi schema `auth` thuộc về nó: bảng của
nó trong schema của nó, và `0009` cấp quyền DML cho runtime bằng `GRANT` từ chính chủ sở hữu.

---

## Vì sao schema `auth`, không phải `public`

Trên PostgreSQL 15+ (bản vá của Cloudflare là 17+, `04` HD1), `PUBLIC` **không** còn quyền
`CREATE` trên schema `public`. Hệ quả trực tiếp: một role không phải owner của database
**không tạo được** bảng trong `public` — đây không phải lựa chọn thiết kế mà là điều PostgreSQL
bắt buộc. Schema riêng `auth` vừa làm schema của service rõ ràng, vừa cho `REVOKE` chi tiết
hơn: runtime chỉ cần `USAGE` trên `auth`, không động tới `public`.

Vì các object nằm trong schema `auth`, **mọi câu lệnh phải qualify bằng `auth.`** — từ
`CREATE TABLE auth.x` cho tới `REFERENCES auth.y`. Lý do phải qualify (chứ không dựa vào
`search_path`): Hyperdrive dùng transaction mode pooling, nên `SET search_path` bị `RESET` khi
connection quay về pool (`04` HD5). Qualify tên là cách duy nhất không phụ thuộc session state.

Một ngoại lệ chủ ý: **tên index không được qualify bằng schema** — PostgreSQL báo
`syntax error at or near "."` cho `CREATE INDEX auth.idx ON auth.t (...)`. Tên index là duy nhất
trong database, nên chúng được liệt kê không tiền tố; phần đích của `ON` vẫn mang `auth.`.

---

## Vì sao các câu CREATE không kèm IF NOT EXISTS

`CREATE TABLE IF NOT EXISTS` **im lặng bỏ qua** một bảng đã tồn tại — kể cả khi bảng đó có
schema khác với những gì file định tạo. Một lần apply trùng sẽ "thành công" mà database lại
lệch với file, và không ai biết.

Vì vậy:

- **`CREATE TABLE` không có `IF NOT EXISTS`.** Áp trùng một file sẽ dừng với lỗi
  `relation "..." already exists` — rõ ràng, không im lặng.
- Các `CREATE INDEX IF NOT EXISTS` và `CREATE SCHEMA IF NOT EXISTS` **giữ** `IF NOT EXISTS`,
  vì chúng là no-op an toàn khi đã tồn tại.

Tính re-runnable **đến từ runner**, không đến từ kiểu `CREATE`: runner nhớ (qua lịch sử +
checksum) file nào đã chạy và không nạp lại. Xem §"Cách áp dụng", bước 4-5.

---

## Vì sao lệnh REVOKE CONNECT không nằm chung transaction

`REVOKE CONNECT ON DATABASE "db-account"` yêu cầu **quyền trên database đích** (`db-account`),
mà một transaction đang mở trên `db-auth` không có. Chạy câu này bên trong transaction sẽ
dừng với:

```text
ERROR:  permission denied to change database "db-account"
```

Vì vậy phần chặn chéo **không nằm trong file** `0009` (file đó dừng lại đúng trước điểm này
và ghi chú dưới dạng comment) — nó chạy ở **psql session riêng** trong bước operator (bước 5
của §"Vai trò của operator"), hoặc trong CI sau khi `db-account` đã được provisioning. Nếu
`db-account` chưa tồn tại, lệnh phải được điều kiện hóa bằng kiểm tra `pg_database` — xóa
`REVOKE CONNECT` trên database không tồn tại là lỗi, không phải no-op.

---

## Vì sao phải thu CONNECT của cả PUBLIC lẫn role

`CONNECT` là quyền mà `PUBLIC` giữ **mặc định** trên mọi database. Thu quyền của riêng một
role (như tài liệu ở auth 03-operations.md §3.1 và account 03-operations.md §3.1 chỉ mình nó)
**không xóa** được quyền role đó vẫn nhận qua `PUBLIC`:

```sql
-- CHỈ làm câu này (theo hai tài liệu nói trên):
REVOKE CONNECT ON DATABASE db-account FROM ecoma_auth_runtime;
-- Vẫn còn:
SELECT has_database_privilege('ecoma_auth_runtime', 'db-account', 'CONNECT');  -- = t  (SAI)
```

Hai câu phải đi cùng nhau, đúng thứ tự:

```sql
REVOKE CONNECT ON DATABASE db-account FROM PUBLIC;
REVOKE CONNECT ON DATABASE db-account FROM ecoma_auth_runtime;
```

Sau đó mới đạt trạng thái NFR-002 / AC-025 yêu cầu:

```sql
SELECT has_database_privilege('ecoma_auth_runtime', 'db-account', 'CONNECT');  -- = f
```

Đây là một **phát hiện trái với tài liệu**: tài liệu nói trên chỉ thu của role, mà thực
nghiệm trên PostgreSQL 17 cho thấy chưa đủ. Migration này và runbook áp dụng **cả hai câu**;
xem thêm issue/PR mở ở `docs/architecture` nếu muốn cập nhật tài liệu cho khớp.

---

## Sweep kiểm tra quyền

Chạy sau khi áp dụng `0009`, bằng `psql` với quyền đọc catalog (CI nên chạy):

```sql
-- (1) NFR-002 / AC-025 — runtime KHÔNG được CONNECT sang db-account.
SELECT has_database_privilege('ecoma_auth_runtime', 'db-account', 'CONNECT');  -- phải = f

-- (2) NFR-002a / AC-027 — sweep: không quyền nào ngoài tối thiểu.
--     Liệt kê đặc quyền runtime đang có trên từng bảng của schema auth:
SELECT grantee, table_name,
       string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants
 WHERE table_schema = 'auth' AND grantee = 'ecoma_auth_runtime'
 GROUP BY grantee, table_name
 ORDER BY table_name;
--     Kỳ vọng:
--       authorization_audit_events   → INSERT, SELECT
--       token_revocations            → INSERT, SELECT
--       internal_nonces              → INSERT, SELECT          (không UPDATE/DELETE: xem (2c))
--       outbox_events                → INSERT, SELECT        (UPDATE ở mức cột, xem (2b))
--       10 bảng còn lại              → DELETE, INSERT, SELECT, UPDATE
--     KHÔNG được có: TRUNCATE, TRIGGER, REFERENCES, CREATE trên schema nào.
--     Role riêng `ecoma_auth_nonce_pruner` (prune job) được sweep riêng ở ô (2d).

-- (2c) internal_nonces — quyền runtime phải là ĐÚNG hai, không UPDATE và không DELETE.
--     Nới `expires_at` của một nonce đã ghi là nới cửa sổ replay, tức là sửa dữ
--     liệu kiểm soát bảo mật. `DELETE` còn nặng hơn: xoá một nonce **còn hiệu lực**
--     là mở lại cửa sổ replay cho đúng envelope đó, nên prune là job của role
--     `ecoma_auth_nonce_pruner` (tạo ở `0014_nonce_pruner_role.sql`; trước đây job
--     GitHub Action dùng `ecoma_auth_migrator` — workflow đã bị thay bởi cron Worker
--     `apps/auth-nonce-prune-job`, và Worker không được cầm credential `_migrator_`).
--     Grant nằm ở `0010` chứ không ở `0009` vì `0009` chạy trước và
--     `GRANT` lên bảng chưa tồn tại là lỗi — xem chú thích cuối `0010`.
SELECT array_agg(privilege_type ORDER BY privilege_type)
  FROM information_schema.role_table_grants
 WHERE table_schema = 'auth' AND table_name = 'internal_nonces'
   AND grantee = 'ecoma_auth_runtime';                -- phải = {INSERT,SELECT}

-- (2d) internal_nonces — sweep của role PRUNER (tạo ở `0014_nonce_pruner_role.sql`).
--     Cron Worker `apps/auth-nonce-prune-job` kết nối bằng credential
--     `ecoma_auth_nonce_pruner` (Hyperdrive binding `DB_AUTH`), nên quyền của nó
--     đủ để job chạy và KHÔNG hơn gì cần thiết nếu credential rò.
SELECT array_agg(privilege_type ORDER BY privilege_type)
  FROM information_schema.role_table_grants
 WHERE table_schema = 'auth' AND table_name = 'internal_nonces'
   AND grantee = 'ecoma_auth_nonce_pruner';           -- phải = {DELETE,SELECT}
--     KHÔNG được có: INSERT, UPDATE, TRUNCATE, TRIGGER, REFERENCES (khối REVOKE
--     ở `0014`), và không được có quyền nào trên bảng khác của schema `auth`
--     (chỉ `USAGE` schema là đủ — thuật toán của job không chạm bảng khác).

-- (2b) outbox_events — UPDATE chỉ trên 4 cột, không trên payload/event_id.
SELECT table_name, column_name
  FROM information_schema.column_privileges
 WHERE table_schema = 'auth' AND grantee = 'ecoma_auth_runtime'
   AND privilege_type = 'UPDATE' AND table_name = 'outbox_events'
 ORDER BY column_name;
--     Kỳ vọng đúng 4 dòng: attempts, last_error, published_at, status

-- (3) AC-026 — không FK chéo database, không postgres_fdw, không dblink.
--     Loại trừ schema nội bộ `_timescaledb_*` của extension TimescaleDB: platform image
--     preload `timescaledb`, nên extension tự cài vào `db-auth` và FK nội bộ của nó nằm
--     ngoài schema `auth` một cách hợp lệ (cùng assertion ở `0009`).
SELECT count(*) FROM pg_extension
 WHERE extname IN ('postgres_fdw', 'dblink', 'file_fdw');                     -- phải = 0
SELECT count(*) FROM pg_constraint con
 JOIN pg_class c ON c.oid = con.conrelid
 JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE con.contype = 'f' AND n.nspname <> 'auth'
   AND n.nspname !~ '^_timescaledb_';                                         -- phải = 0

-- (4) AC-028 — signing_keys không có private key material.
SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'auth' AND table_name = 'signing_keys'
   AND column_name <> 'public_key_jwk'
   AND (column_name ILIKE '%key%' OR column_name ILIKE '%secret%'
        OR column_name ILIKE '%private%');                                    -- phải = 0

-- (5) Runtime không được CREATE trên schema nào.
SELECT has_schema_privilege('ecoma_auth_runtime', 'auth', 'CREATE');          -- phải = f

-- (6) Role pruner cũng KHÔNG được CREATE trên schema nào.
SELECT has_schema_privilege('ecoma_auth_nonce_pruner', 'auth', 'CREATE');     -- phải = f
```

---

## Ràng buộc liên service chưa có

- **`acr`**: tập giá trị trong CHECK phải khớp `ACR_VALUES` ở
  `libs/account-domain/src/acr.ts` (nguồn sự thật dùng chung). `db-account` chưa
  được provision (issue #83), nên chưa có ràng buộc toàn vẹn giữa hai bên; nếu `account`
  sau này đổi tập giá trị, CHECK ở file `0012` phải được cập nhật bằng một migration
  forward-fix.
- **`sub` là opaque**: mọi cột `sub`/`subject_ref` là giá trị chuỗi do `account` cấp, không có
  FK sang `db-account` (NFR-002b). Không thêm referential integrity vào đó.

---

File nền tảng: `docs/applications/auth/01-architecture.md` (mô hình dữ liệu §3, CAS §3,
consent≠grant §3.4, signing keys §3.5, no-FK §3.6, máy trạng thái §5.1.2), `02-requirements`
(FR/NFR/SR/AC), `03-operations` (role §3, chặn chéo §3.1, migration §3.2), và
`docs/architecture/02-delivery.md` §3 (migration từ CI runner).

---

## Chạy test trên PostgreSQL thật

Bảy spec PG **không** dùng fake: ba spec trong `libs/auth-infrastructure/src/`
(`authorization-code-cas.spec.ts` — tính đúng đắn của CAS nằm ở hành vi khoá hàng của
PostgreSQL dưới `READ COMMITTED`; `authorization-transaction-store.spec.ts` — hợp đồng
persistence của `authorization_transactions` — catalog schema sau `0011`, codec
`bytea`↔base64url, CAS transition; `internal-nonces.spec.ts` — tính đúng đắn của replay
guard nằm ở việc PostgreSQL quyết định thắng thua bằng ràng buộc UNIQUE) và bốn spec
PG của `apps/auth/src/`. Một fake `Map` cho đúng một winner và vẫn dạy ta tin rằng
`SELECT` rồi `UPDATE`/`INSERT` là atomic.

⚠️ **PostgreSQL đến từ testcontainers.** Mỗi spec file tự dựng **một container**
`postgres:17-alpine` riêng (`startAuthDatabase` trong `tests/integrations/harness.ts`
của `apps/auth` và bản copy có chủ đích `src/auth-test-harness.ts` của
`libs/auth-infrastructure`), provisioning hai role đúng trình tự operator ở
§"Vai trò của operator" (migrator có DDL, runtime chỉ DML), rồi apply **chính các file
trong thư mục này** bằng credential `ecoma_auth_migrator` thật — nên nó kiểm adapter
với đúng schema production. Một bảng do test tự chế là một schema thứ hai, và test
xanh trên schema thứ hai không nói được gì về production — đó là điều đã xảy ra: bản
test đầu dựng cột `code_id`/`scope` trong khi schema thật có
`id uuid`/`code_hash`/`granted_scopes text[]`.

⚠️ **Không có Docker thì test ĐỎ ngay lập tức — không có đường skip.** Harness
probe Docker một lần mỗi lần chạy qua vitest `globalSetup`
(`tests/integrations/docker-probe.global-setup.ts`), probe bằng chính container
PostgreSQL mà suite sắp dùng; probe thất bại là **ném lỗi** làm toàn bộ lần chạy
đỏ với exit khác 0 — vắng Docker là sự cố hạ tầng, không phải kết quả test, và
không có biến môi trường nào bật tắt hành vi này. Chạy tay chỉ cần Docker daemon đang chạy:

```bash
pnpm nx test @ecoma-io/auth-infrastructure --skip-nx-cache
pnpm nx test @ecoma-io/auth --skip-nx-cache
```

⚠️ **`--skip-nx-cache` là bắt buộc.** Nx cache theo input của task; một lần chạy
xanh được cache lại, và lần sau cùng input sẽ trả kết quả cũ mà không chạy gì —
kể cả khi database đã đổi.

⚠️ Vì mỗi spec file có **container riêng**, các suite không chia sẻ schema hay dữ
liệu — advisory lock giữa các spec của hình thức cũ (một database dùng chung qua biến
`AUTH_TEST_PG_*`) đã bị xoá cùng lý do nó từng tồn tại.
