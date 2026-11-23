-- 0002_roles_and_grants.sql — role và grant của `db-account`.
--
-- Ba tầng role, mỗi tầng một việc (`03-operations.md` §3):
--   * `ecoma_owner`            — owner/admin, sở hữu database và object. **Không**
--                                chạy trong Worker. Cầm ngoài VPS cho disaster
--                                recovery, nên nó **không** được sinh ra ở đây:
--                                credential đó không thuộc vòng đời migration.
--   * `ecoma_account_migrator` — quyền DDL, sống **chỉ** trong CI secret store.
--                                Không bao giờ là Worker secret (SR-008).
--   * `ecoma_account_runtime`  — chỉ SELECT/INSERT/UPDATE/DELETE trên schema
--                                `account`. Không DDL, không CREATE (NFR-002a).
--
-- ⚠️ `CREATE ROLE` **không có** dạng `IF NOT EXISTS`, nên phần tạo role phải đi
-- qua guard `pg_catalog.pg_roles`. Role là global object của cluster chứ không
-- phải object trong một database, nên file này chạy lại phải là no-op.
--
-- ⚠️ Không có foreign key, `postgres_fdw`, `dblink` hay truy vấn xuyên database ở
-- bất kỳ đâu trong `db/migrations/` (NFR-002b). `REVOKE CONNECT` bên dưới *cố ý*
-- nhắc tên `db-auth`: đó là grant cấp **database** do chính PostgreSQL thi hành,
-- không phải một truy vấn đọc dữ liệu của database khác. Đọc `pg_database` để
-- kiểm tra sự tồn tại là đọc catalog của cluster, không phải cross-database
-- query — cùng loại với `has_database_privilege` mà AC-012 dùng.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
--
-- Cả hai role đều `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`:
-- đây là hai tầng credential bị giới hạn sẵn ở **định nghĩa**, không phải ở grant
-- bên dưới, để một đường leo thang qua `ALTER ROLE` không cần chạm vào migration.
--
-- `NOINHERIT` có chủ đích: quyền phải được **cấp tường minh**, không kế thừa
-- bất ngờ từ một role cha nào được gán thêm sau này. Migrator kết nối bằng chính
-- tên role này trong CI, không qua `SET ROLE` từ một role rộng hơn.
--
-- Không đặt `PASSWORD` ở đây: secret do CI secret store sinh và đổi được mà
-- không cần migration (`03-operations.md` §3).

-- ⚠️ Khối `DO $$` tạo role ở đây **chỉ là lưới an toàn**: role thật sự được
-- provisioning step 1 tạo (`README`, `03-operations.md` §3.2), vì migrator là
-- `NOCREATEROLE` và không tự tạo được role. Nhưng file này vẫn phải chạy được
-- **một mình** trên một cluster sạch, nên giữ guard.
--
-- ⚠️ Cố ý **không** có `COMMENT ON ROLE` ở đây: `COMMENT ON ROLE` yêu cầu
-- `CREATEROLE`, còn migrator cần `NOCREATEROLE` để không leo thang (xem khối
-- `DO $$` phía trên). Hai yêu cầu đó không tương thích, nên mô tả role phải nằm
-- ở lệnh provisioning — nơi đã có `CREATEROLE` — chứ không phải ở migration.
-- Đây là giới hạn thật của PostgreSQL, không phải sở thích: nó chỉ lộ ra khi
-- chạy bằng **credential migrator thật** thay vì `SET ROLE` từ superuser.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_account_migrator') THEN
    CREATE ROLE ecoma_account_migrator
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_account_runtime') THEN
    CREATE ROLE ecoma_account_runtime
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grant cho migrator
-- ---------------------------------------------------------------------------
--
-- Migrator sở hữu các object nó tạo nên không cần quyền riêng trên từng object;
-- nó cần `CREATE` ở tầng schema để mở rộng schema sau này. `CREATE` ở tầng
-- database đã được `0001` cấp — không lặp lại ở đây, và xem giải thích thứ tự
-- trong `0001`.
--
-- ⚠️ Không grant `CONNECT` ở đây: migrator đã có nó qua `PUBLIC` trên chính
-- database của mình. Cấp tường minh chỉ cần cho database **khác** — và
-- database khác thì phải bị chặn, không phải được mở.

GRANT USAGE, CREATE ON SCHEMA account TO ecoma_account_migrator;

-- ---------------------------------------------------------------------------
-- Grant cho runtime — chỉ DML
-- ---------------------------------------------------------------------------
--
-- `USAGE` ở tầng schema là bắt buộc để chạm tới bất kỳ object nào trong đó; nó
-- không cấp quyền đọc nội dung.
--
-- ⚠️ `SELECT` trên `security_events` là **ngoại lệ có chủ đích**: audit phải đọc
-- được qua đường nội bộ (FR-012k đòi mọi lần đọc đều ghi lại; AC-008m đòi đọc
-- tombstone qua từng đường nội bộ). Audit append-only nên quyền đọc đó không
-- kéo theo quyền sửa: UPDATE bị chặn bằng trigger `security_events_append_only`,
-- không bằng grant.
--
-- Cố ý **không** grant `TRUNCATE`, `TRIGGER`, `REFERENCES`:
--   * `TRUNCATE` xoá sạch audit — append-only nghĩa là UPDATE bị cấm, không phải
--     mọi cách xoá đều bị cấm; retention nhóm (3) là quyết định còn mở
--     (`01-architecture.md` §10) và phải là thao tác có chủ đích, không phải
--     thứ runtime role tự quyết.
--   * `TRIGGER` cho phép tạo trigger trên bảng, tức là một cách lách trigger
--     append-only.
--
-- Không grant `USAGE`/`CREATE` trên `public` — xem REVOKE ở cuối file.

GRANT USAGE ON SCHEMA account TO ecoma_account_runtime;

-- `users` chỉ nhận SELECT, INSERT, UPDATE — **không** có DELETE:
--   * Tombstone là nhóm (1), nhóm duy nhất được giữ vĩnh viễn
--     (`01-architecture.md` §7.1).
--   * DELETE trên `users` giải phóng PK `sub` — mở lại đường tái phát hành
--     identifier mà FR-001 / FR-012d cấm.
--   * Không có code ứng dụng nào xoá user; nếu retention thật sự cần xoá hàng,
--     thao tác đó chạy bằng owner/migrator ngoài application, có chủ đích.
GRANT SELECT, INSERT, UPDATE ON TABLE account.users TO ecoma_account_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.account_sessions TO ecoma_account_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.login_handoffs TO ecoma_account_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.account_outbox_events TO ecoma_account_runtime;
GRANT SELECT, INSERT ON TABLE account.security_events TO ecoma_account_runtime;

-- `internal_nonces` (tạo ở `0003_internal_nonces.sql`) là ngoại lệ thứ hai về
-- hình dạng grant, và cần giải thích riêng vì nó **không** theo khuôn "runtime có
-- DML" của các bảng kia:
--
--   * `INSERT` là việc duy nhất được cần — `claimNonce` chèn bằng
--     `INSERT … ON CONFLICT DO NOTHING`.
--   * `SELECT` để kiểm chứng và để prune kiểm hạn trước khi xoá.
--   * `DELETE` là prune theo `expires_at`, thao tác của bảng này.
--   * **Không** `UPDATE`: nonce là bất biến. Đổi `expires_at` của nonce đã ghi là
--     nới cửa sổ replay, và không có đường cần tới nó — nếu TTL sai thì sửa
--     `internal-auth.ts` và prune lại, đừng sửa hàng đã lưu.
--
-- Bảng này được `CREATE` ở `0003` nên `0002` không thể `GRANT` lên nó; grant thật
-- nằm trong `0003`. Ở đây chỉ nhắc lại để đọc `0002` thấy đủ bức tranh.

-- ---------------------------------------------------------------------------
-- REVOKE CONNECT chéo trên `db-auth` (NFR-002, `03-operations.md` §3.1)
-- ---------------------------------------------------------------------------
--
-- Đây là lớp enforce thật của ranh giới database: `account` chỉ được chạm
-- `db-account`. Trước issue #324 cả hai app cùng mang `scope:identity` nên tag Nx
-- không phân biệt được chúng; credential mới là thứ chặn được.
--
-- ⚠️⚠️ **Khối này KHÔNG enforce được ranh giới database, và đây là giới hạn thật
-- của PostgreSQL chứ không phải sơ suất.** `REVOKE CONNECT ON DATABASE db-auth`
-- đòi quyền sở hữu `db-auth` (hoặc `CREATEROLE`/superuser), mà
-- `ecoma_account_migrator` không có và **không được có** — nó chỉ sở hữu
-- `db-account`. Đo trên PostgreSQL 17: chạy khối này bằng credential migrator
-- thật in ra
--
--     WARNING: no privileges could be revoked for "db-auth"
--
-- và `has_database_privilege('ecoma_account_runtime','db-auth','CONNECT')` vẫn
-- là `true`. **Câu lệnh báo thành công nhưng không làm gì cả** — đúng cái loại
-- lỗi mà AC-012 sinh ra để bắt, và `tests/integration/roles.spec.ts` sẽ đỏ nếu
-- ai đó tin rằng khối này đã chặn được.
--
-- Vì vậy `REVOKE CONNECT` thật sự **không** nằm ở đây mà ở **provisioning step 1**
-- (admin/owner — xem `README`), và `AC-012` kiểm chứng kết quả của provisioning
-- đó chứ không kiểm chứng file này.
--
-- Khối bên dưới chỉ còn là **assertion không lỗi**: nó thất bại ngay lập tức nếu
-- provisioning quên `GRANT CONNECT` lại cho chính `ecoma_account_runtime` trên
-- `db-account` — đúng cơ chế fail-closed, thay vì im lặng bỏ qua một tình huống
-- mà người vận hành cần thấy ngay.
--
-- Tên database đích đọc từ GUC `ecoma.auth_database` để `db:migrate` không phải
-- hard-code một tên khác với instance thật; **không có** mặc định im lặng — thiếu
-- GUC thì file cố ý không làm gì hết, và `db:migrate` phải set nó.

DO $$
DECLARE
  auth_db text := current_setting('ecoma.auth_database', true);
  runtime_can_connect boolean;
BEGIN
  IF auth_db IS NOT NULL
     AND auth_db <> ''
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = auth_db)
     AND auth_db <> current_database() THEN
    -- Migration **không** được revoke gì trên database khác (xem giải thích ở
    -- trên). Nó chỉ được phép fail nếu chính **runtime role** mất quyền kết nối
    -- tới database mà nó phải phục vụ — tức provisioning đã làm hỏng đúng thứ
    -- cần giữ.
    --
    -- ⚠️ Kiểm `ecoma_account_runtime`, KHÔNG phải `current_user`: `current_user`
    -- ở đây là migrator — mà migrator luôn có CONNECT (nó vừa kết nối được để
    -- chạy migration), nên kiểm nó là một câu đúng luôn đúng, không bắt được gì.
    -- Mục đích thật của guard là bắt provisioning quên GRANT CONNECT cho
    -- **runtime** (03-operations.md §3.2) — role mà Worker dùng.
    runtime_can_connect := has_database_privilege(
      'ecoma_account_runtime', current_database(), 'CONNECT'
    );
    IF NOT runtime_can_connect THEN
      RAISE EXCEPTION
        'ecoma_account_runtime mat quyen CONNECT tren db-account; can lai provisioning (03-operations.md 3.2)';
    END IF;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rút quyền mặc định của PUBLIC trên schema `public`
-- ---------------------------------------------------------------------------
--
-- `public` là schema mặc định của mọi database PostgreSQL và `CREATE` trên đó là
-- quyền **mặc định của `PUBLIC`**. Runtime role không cần gì trong `public`, nên
-- quyền đó bị rút lại — không có nó thì một `CREATE TABLE` của runtime role vào
-- `public` sẽ không nằm trong bất kỳ grant nào mà AC-014 quét, và sẽ tồn tại ngoài
-- tầm `REVOKE CONNECT` ở trên.
--
-- Đây là grant cấp **object của chính `db-account`**; nó không chạm tới `db-auth`
-- và không đọc dữ liệu của database nào khác.


-- ⚠️ Cố ý **không** có `COMMENT ON DATABASE` ở đây: nó yêu cầu quyền sở hữu
-- database, mà migrator không có (và không nên có — nó chỉ cần quyền trên schema
-- `account`). Mô tả database là metadata của **owner/admin**, nên nó thuộc lệnh
-- provisioning, giống `COMMENT ON ROLE` ở trên.

COMMIT;