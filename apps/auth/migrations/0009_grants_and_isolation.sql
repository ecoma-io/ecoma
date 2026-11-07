-- 0009_grants_and_isolation.sql — quyền tối thiểu cho runtime, chặn chéo database.
--
-- Phạm vi: grant quyền trên `db-auth`, chặn `CONNECT` sang `db-account`.
-- Vận hành → docs/applications/auth/03-operations.md §3, §3.1
--          → docs/applications/auth/02-requirements.md NFR-002, NFR-002a, NFR-002b, AC-025..AC-028.
--
-- ⚠️ **CHẠY BẰNG ROLE `ecoma_auth_migrator` HOẶC CAO HƠN.** File này không tạo role — xem
--    `README.md` §"Vai trò của operator" để biết vì sao, và bước 0 của runbook.
--
-- ⚠️ File này **tên `db-account`**, nên nó **không** được áp dụng trong cùng transaction
--    với phần DDL. Runbook → `README.md` §"Vì sao phần chặn chạy ở psql session riêng".

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- Quyền trên schema.
--
-- ⚠️ Không cấp gì trên schema `public`: trên PostgreSQL 15+ `PUBLIC` đã **không** còn `CREATE`
--    ở đó, và `db-auth` không có bảng nào ngoài schema `auth`. Runtime không cần `USAGE` ở
--    `public` nên không được cấp — cấp thừa là thứ phải thu lại sau này.
--
-- ⚠️ `CREATE SCHEMA IF NOT EXISTS` giữ file này **re-runnable**: lần chạy đầu tiên là
--    no-op (schema đã do file 0001 tạo với `AUTHORIZATION ecoma_auth_migrator`), các lần
--    sau cũng là no-op.
--
-- ⚠️ Không cấp `CREATE` cho runtime trên schema nào: role chỉ có DML (NFR-002a).
-- ---------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA auth TO ecoma_auth_runtime;

-- ---------------------------------------------------------------------------------------------
-- Quyền DML trên các bảng của `db-auth`.
--
-- ⚠️ **Không có `GRANT ALL`.** Mỗi bảng được liệt kê tên và được cấp **đúng** các quyền nó
--    cần. `GRANT ALL ON ALL TABLES IN SCHEMA auth` sẽ cấp thêm `TRUNCATE`, `TRIGGER`,
--    `REFERENCES` — và `TRUNCATE` trên `authorization_audit_events` là xoá sạch audit trong
--    một câu không để lại dấu vết trên từng dòng.
--
-- ⚠️ Mọi `REVOKE` ở đây là **phòng thủ trước quyền mặc định**, không phải để gỡ quyền đã cấp.
--    PostgreSQL **không** cấp `UPDATE`/`DELETE` cho `PUBLIC` trên bảng mới, nên lệnh đầu
--    tiên trong nhóm này là `GRANT`, và các nhóm append-only bắt đầu bằng `GRANT SELECT,
--    INSERT`. `REVOKE` xuất hiện ở đâu đó là để một `GRANT` trong migration sau không vô
--    tình nới rộng bảng đã đóng.
-- ---------------------------------------------------------------------------------------------

-- Bảng đọc + ghi đầy đủ theo vòng đời nghiệp vụ.
--
-- ⚠️ **`token_revocations` và `authorization_audit_events` KHÔNG có trong danh sách này** —
--    hai bảng đó là append-only và được cấp riêng ngay bên dưới. Đây là chỗ dễ sai nhất của
--    file: chỉ cần thêm một tên bảng vào câu `GRANT` này là đã cấp `UPDATE`/`DELETE` cho một
--    bảng audit, và tính append-only mất hiệu lực **im lặng**.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    auth.oauth_clients,
    auth.client_redirect_uris,
    auth.authorization_transactions,
    auth.authorization_codes,
    auth.oauth_consent_decisions,
    auth.oauth_grants,
    auth.client_grant_scopes,
    auth.refresh_token_families,
    auth.refresh_tokens,
    auth.signing_keys
TO ecoma_auth_runtime;

-- ⚠️ `token_revocations` là **append-only**: nó là **bảng điều khiển duy nhất** cho cả ba mức
--    thu hồi (`01-architecture.md` §6.4). Ghi đè một bản ghi thu hồi cũ tức là xoá bằng chứng
--    rằng một subject đã bị thu hồi, và làm token đã thu hồi trở lại hợp lệ. Vì vậy nó được
--    cấp **đúng hai quyền**, và `REVOKE` đi kèm nhau như một chốt chặn phòng thủ.
GRANT SELECT, INSERT ON auth.token_revocations TO ecoma_auth_runtime;
REVOKE UPDATE, DELETE ON auth.token_revocations FROM ecoma_auth_runtime;

-- ⚠️ `authorization_audit_events` là **append-only** (invariant 20). Chỉ `INSERT` và đọc.
--    Đây là **lớp enforce thật** của tính append-only, không phải một quy ước trong review.
--
-- ⚠️ Không dùng `TRUNCATE` làm "xoá theo lô" cho bảng này: `TRUNCATE` cần quyền riêng và
--    vẫn là một câu xoá không có mốc thời gian trên từng dòng. Retention phải là một job
--    chạy bằng `ecoma_auth_migrator` và **phải được ghi lại** (01-architecture.md §7.1).
GRANT SELECT, INSERT ON auth.authorization_audit_events TO ecoma_auth_runtime;

-- `outbox_events` cần `UPDATE` **giới hạn ở vài cột**: relay đánh dấu `published_at` và tăng
-- `attempts`, nhưng **không** được sửa `payload`, `event_id`, `created_at`.
--
-- ⚠️ Đây là lý do dùng `GRANT UPDATE (cột)`: cấp `UPDATE` cả bảng sẽ cho phép sửa `event_id`
--    của một event đã publish, tức là phá vỡ idempotency key mà consumer dựa vào.
GRANT SELECT, INSERT ON auth.outbox_events TO ecoma_auth_runtime;
GRANT UPDATE (status, attempts, published_at, last_error) ON auth.outbox_events TO ecoma_auth_runtime;

-- ⚠️ Runtime **không** có `DELETE` trên `authorization_audit_events` và `token_revocations`
--    (xem hai nhóm trên), và không có `TRUNCATE` trên bảng nào. Dọn dữ liệu hết TTL là job
--    của migrator, không phải đường của serving path: đường xoá do Worker gọi là đường mà
--    một request lỗi có thể gọi vào (`01-architecture.md` §3.2 — TTL ngắn, xoá hẳn theo lô).
--
-- Sequences: `gen_random_uuid()` là builtin nên không cần sequence. Nếu sau này thêm cột
-- `serial`, phải cấp `USAGE` trên sequence cho `ecoma_auth_runtime` ở đây.

-- ---------------------------------------------------------------------------------------------
-- Bảo đảm bất biến phía database: không ai gắn FK sang database khác.
--
-- ⚠️ Đây là **assertion**, không phải grant: NFR-002b cấm foreign key, `postgres_fdw`,
--    `dblink` và mọi query xuyên database. Migration không tạo ra thứ nào trong bốn loại đó,
--    và các ràng buộc dưới đây làm một lần viết sai trong tương lai **thất bại ngay lúc apply**
--    thay vì tồn tại âm thầm tới ngày review.
--
-- ⚠️ Các câu CAS của protocol **không** dựa vào `REPEATABLE READ` hay bất kỳ isolation
--    level nào: chúng dựa vào điều kiện `WHERE` của `UPDATE`, được đánh giá trong một
--    snapshot của câu đó (`authorization_transactions`, `authorization_codes`,
--    `refresh_tokens` — xem câu SQL CAS ở các file 0002, 0004, 0005).
-- ---------------------------------------------------------------------------------------------
DO $assert_no_cross_database_reference$
DECLARE
    offending text;
BEGIN
    -- NFR-002b: không extension tào database khác được phép tồn tại trong `db-auth`.
    SELECT string_agg(extname, ', ' ORDER BY extname)
      INTO offending
      FROM pg_extension
     WHERE extname IN ('postgres_fdw', 'dblink', 'file_fdw');

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'NFR-002b: db-auth không được cài extension truy cập database khác. Tìm thấy: %',
            offending;
    END IF;

    -- NFR-002b: không foreign key nào được trỏ tới một bảng nằm ngoài schema của `db-auth`.
    -- Server khác (ví dụ `db-account`) đã bị chặn CONNECT ở phần dưới, nên đây là lớp thứ hai:
    -- nó bắt được lỗi khi người viết migration quên rằng mình đang ở trong `db-auth`.
    --
    -- ⚠️ Loại trừ schema nội bộ của TimescaleDB: platform image là `timescale/timescaledb`
    --    với `shared_preload_libraries=timescaledb`, nên extension tự cài vào `db-auth` và
    --    tạo các schema `_timescaledb_*` chứa FK chéo giữa chúng (`bgw_job_hypertable_id_fkey`
    --    -> `_timescaledb_catalog.bgw_job`, ...). Đây là state nội bộ của platform, không phải
    --    FK mà migration nào của auth viết ra, nên không thuộc phạm vi assertion này.
    --
    --    Giả định của lớp loại trừ này: **mọi** schema khớp tiền tố `_timescaledb_` là state
    --    của extension, kể cả khi một migration sau tự tạo schema trùng tiền tố (hành vi đó
    --    tự mâu thuẫn với NFR-002b và phải bị chặn ở review, không phải ở assertion này).
    --
    --    Dùng regex neo đầu chuỗi thay cho `LIKE '\_timescaledb\_%'`: `_` là ký tự thường
    --    trong regex nên không phụ thuộc escape của LIKE (và `standard_conforming_strings`),
    --    trong khi `_` là wildcard trong LIKE — quên escape là pattern nuốt cả schema người
    --    dùng bắt đầu bằng `timescaledb_`.
    SELECT string_agg(DISTINCT con.conname || ' -> ' || cl.oid::regclass::text, ', ')
      INTO offending
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE con.contype = 'f'
       AND n.nspname <> 'auth'
       AND n.nspname !~ '^_timescaledb_';

    IF offending IS NOT NULL THEN
        RAISE EXCEPTION
            'NFR-002b: db-auth chỉ được có foreign key bên trong schema auth. Tìm thấy: %',
            offending;
    END IF;
END
$assert_no_cross_database_reference$;

-- ---------------------------------------------------------------------------------------------
-- Kết thúc phần áp dụng trong transaction.
--
-- ⚠️ **Phần chặn chéo database KHÔNG nằm trong file này.** `REVOKE CONNECT ON DATABASE`
--    cần quyền trên database **đích** (`db-account`), mà một transaction đang mở trên
--    `db-auth` không có quyền đó. Nạp file này bằng `psql -1` (một transaction) sẽ dừng ở
--    câu đó với:
--        ERROR:  permission denied to change database "db-account"
--    Vì vậy runbook tách nó ra thành một `psql` session riêng:
--        README.md §"Vì sao phần chặn chạy ở psql session riêng"
--
-- ⚠️ Đây là **lớp enforce thật** của ranh giới database, không phải tag Nx: trước issue #324
--    cả `account` và `auth` cùng mang `scope:identity`, nên tag không phân biệt được chúng và không chặn được
--    `apps/account` khai báo binding trỏ `db-auth` (auth 03-operations.md §3.1).
-- ---------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------
-- Kiểm chứng — chạy sau khi apply, và nên chạy trong CI.
--
-- ⚠️ Các câu dưới đây là **assertion có thể máy đọc**. Đặc biệt câu (1) là NFR-002 và AC-025:
--    nó phải in ra `f`, và `t` là một sự cố bảo mật của môi trường đó.
-- ---------------------------------------------------------------------------------------------
-- (1) NFR-002 / AC-025 — runtime KHÔNG được CONNECT sang db-account.
--     SELECT has_database_privilege('ecoma_auth_runtime', 'db-account', 'CONNECT');  -- phải = f
--
-- (2) NFR-002a / AC-027 — sweep quyền, không còn quyền thừa ngoài tối thiểu.
--     Xem README.md §"Sweep kiểm tra quyền" cho câu đầy đủ.
--
-- (3) AC-026 — không FK chéo database, không `postgres_fdw`, không `dblink`.
--     SELECT extname FROM pg_extension WHERE extname IN ('postgres_fdw', 'dblink');  -- phải = 0 dòng
--     SELECT count(*) FROM pg_constraint con
--      JOIN pg_class c ON c.oid = con.conrelid
--      JOIN pg_namespace n ON n.oid = c.relnamespace
--     WHERE con.contype = 'f'
--       AND n.nspname <> 'auth'
--       AND n.nspname !~ '^_timescaledb_';  -- phải = 0
--
-- (4) AC-028 — `signing_keys` không có private key material.
--     SELECT count(*) FROM information_schema.columns
--      WHERE table_schema = 'auth' AND table_name = 'signing_keys'
--        AND (column_name ILIKE '%private%' OR column_name ILIKE '%secret%');  -- phải = 0
--
-- (5) Runtime không được `CREATE` trên schema nào.
--     SELECT has_schema_privilege('ecoma_auth_runtime', 'auth', 'CREATE');  -- phải = f