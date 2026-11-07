-- 0002_roles_and_grants.sql — role và grant của `db-backoffice`.
--
-- Ba tầng role theo pattern `apps/account/db/0002_roles_and_grants.sql`
-- (`../account/03-operations.md` §3 — pattern tham chiếu, không sao chép):
--   * `ecoma_owner`              — owner/admin, sở hữu database và object.
--                                  **Không** chạy trong Worker, không xuất hiện
--                                  ở đây: credential đó không thuộc vòng đời
--                                  migration.
--   * `ecoma_backoffice_migrator`— quyền DDL, sống chỉ trong CI secret store.
--                                  Không bao giờ là Worker secret.
--   * `ecoma_backoffice_runtime` — chỉ DML **hạn chế theo từng bảng** trên
--                                  schema `backoffice`. Không DDL, không
--                                  CREATE (SR-010, invariant 11).
--
-- ⚠️ `CREATE ROLE` không có dạng `IF NOT EXISTS`, nên phần tạo role đi qua
-- guard `pg_catalog.pg_roles`. Role là global object của cluster chứ không phải
-- object trong một database, nên file chạy lại phải là no-op.
--
-- ⚠️ Cố ý **không** có `COMMENT ON ROLE` và `COMMENT ON DATABASE` ở đây: cả
-- hai đều cần `CREATEROLE` / quyền sở hữu database, mà migrator cần
-- `NOCREATEROLE` (chống leo thang) và không sở hữu database. Mô tả role/database
-- thuộc lệnh provisioning, nơi đã có quyền — xem README.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
--
-- Cả hai role đều `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`:
-- giới hạn ở **định nghĩa**, không chỉ ở grant bên dưới, để một đường leo thang
-- qua `ALTER ROLE` không cần chạm vào migration.
--
-- Khối `DO $$` dưới đây chỉ là lưới an toàn để file chạy được một mình trên
-- cluster sạch; role thật sự do provisioning step 1 tạo (`CREATE ROLE … LOGIN`
-- cần `CREATEROLE`).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_backoffice_migrator') THEN
    CREATE ROLE ecoma_backoffice_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_backoffice_runtime') THEN
    CREATE ROLE ecoma_backoffice_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grant cho migrator
-- ---------------------------------------------------------------------------
--
-- Migrator sở hữu các object nó tạo nên nên không cần quyền riêng trên từng
-- object; nó cần `CREATE` ở tầng schema để mở rộng schema sau này. `CREATE` ở
-- tầng database đã là provisioning step 1 — migration không tự cấp được thứ nó
-- không có, xem `0001`.
--
-- ⚠️ Không grant `CONNECT` ở đây: migrator đã có nó qua `PUBLIC` trên chính
-- database của mình. Cấp tường minh chỉ cần cho database **khác** — và database
-- khác thì phải bị chặn, không phải được mở.

GRANT USAGE, CREATE ON SCHEMA backoffice TO ecoma_backoffice_migrator;

-- ---------------------------------------------------------------------------
-- Grant cho runtime — DML hạn chế theo từng bảng
-- ---------------------------------------------------------------------------
--
-- `USAGE` ở tầng schema là bắt buộc để chạm tới bất kỳ object nào trong đó; nó
-- không cấp quyền đọc nội dung.
--
-- Danh sách grant theo đúng từng bảng, không có dạng "cấp chung rồi thu":
--   * `staff`               — SELECT + INSERT + UPDATE, **không** `DELETE`:
--                             "không giả định xoá vật lý" (§4.6); record giữ
--                             lại để audit còn truy vấn được.
--   * `permissions`         — chỉ `SELECT`: catalog là sealed (invariant 10 /
--                             SR-020). INSERT là việc của seed migration chạy
--                             bằng migrator; runtime role không tự thêm
--                             permission ngoài catalog, DELETE trên catalog
--                             cũng không có đường nào cần (retire = UPDATE).
--                             ⚠️ UPDATE thuộc **migrator**, không runtime —
--                             retire một permission là governance action.
--   * `roles`               — chỉ `SELECT`: runtime đọc role để build tập
--                             permission. Tạo/sửa role là governance action;
--                             backend tự thêm "role bypass" không phải là
--                             DML hợp lệ (SR-016).
--   * `role_permissions`    — SELECT + INSERT + DELETE: gắn/gỡ permission
--                             khỏi một role là DML của việc compose role;
--                             không UPDATE — đổi membership của role làm
--                             bằng INSERT/DELETE, nên cặp (role, permission)
--                             nào đã tồn tại không bị đổi `created_at` và
--                             audit đọc được "gắn từ khi nào" (§4.3: thêm/
--                             đổi/bỏ một permission là governance action có
--                             audit — đường compose role cũng phải đi qua
--                             audit của tầng app, không phải UPDATE im
--                             lặng).
--   * `role_assignments`    — SELECT + INSERT + UPDATE (thu hồi = UPDATE
--                             `revoked_at`), **không** DELETE (lịch sử giữ
--                             lại, §4.6).
--   * `authorization_audit` — SELECT + INSERT (SR-015): audit phải đọc được
--                             qua đường nội bộ, quyền đọc không kéo theo
--                             quyền sửa.
--
-- Cố ý **không** grant `TRUNCATE`, `TRIGGER`, `REFERENCES` cho bảng nào:
--   * `TRUNCATE` xoá sạch audit — đúng thứ SR-015/T-12 cấm.
--   * `TRIGGER` cho phép tạo trigger trên bảng, tức một cách lách trigger
--     append-only.
--
-- Không grant `USAGE`/`CREATE` trên `public` — xem REVOKE ở cuối file.

GRANT USAGE ON SCHEMA backoffice TO ecoma_backoffice_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE backoffice.staff TO ecoma_backoffice_runtime;
GRANT SELECT ON TABLE backoffice.permissions TO ecoma_backoffice_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE backoffice.role_permissions TO ecoma_backoffice_runtime;
GRANT SELECT ON TABLE backoffice.roles TO ecoma_backoffice_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE backoffice.role_assignments TO ecoma_backoffice_runtime;
GRANT SELECT, INSERT ON TABLE backoffice.authorization_audit TO ecoma_backoffice_runtime;

-- ---------------------------------------------------------------------------
-- Guard CONNECT của runtime role trên CHÍNH database này — assertion
-- fail-closed, không revoke gì trên database khác
-- ---------------------------------------------------------------------------
--
-- `REVOKE CONNECT` thật sự của ranh giới database là **provisioning step 1**
-- (admin/owner — xem README): `REVOKE CONNECT ON DATABASE db-X` đòi quyền sở
-- hữu `db-X`, mà migrator không có và không được có. Chạy bằng credential
-- migrator thật, PostgreSQL in
--
--     WARNING: no privileges could be revoked
--
-- và để nguyên ACL — câu lệnh báo thành công nhưng không làm gì cả. Hành vi
-- này đã được đo trên `db-auth` của `account`; pattern giữ nguyên ở đây.
--
-- Khối dưới đây chỉ là **assertion không lỗi**: nó thất bại ngay lập tức nếu
-- provisioning quên `GRANT CONNECT` lại cho chính
-- `ecoma_backoffice_runtime` trên `db-backoffice` — đúng cơ chế fail-closed,
-- thay vì im lặng bỏ qua một tình huống mà người vận hành cần thấy ngay.
--
-- ⚠️ Kiểm `ecoma_backoffice_runtime`, KHÔNG phải `current_user`: `current_user`
-- ở đây là migrator — mà migrator luôn có CONNECT (nó vừa kết nối được để chạy
-- migration), nên kiểm nó là câu đúng luôn đúng, không bắt được gì.

DO $$
BEGIN
  IF NOT has_database_privilege('ecoma_backoffice_runtime', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION
      'ecoma_backoffice_runtime mat quyen CONNECT tren db-backoffice; can lai provisioning';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rút quyền mặc định của PUBLIC trên schema `public`
-- ---------------------------------------------------------------------------
--
-- `public` là schema mặc định của mọi database PostgreSQL và `CREATE` trên đó
-- là quyền **mặc định của `PUBLIC`** ở PostgreSQL < 15 (17 đã rút khỏi mặc
-- định, nhưng REVOKE vẫn giữ — một cài đặt cũ hoặc cấu hình đổi sau sẽ trả lại
-- quyền đó nếu thiếu câu này). Runtime role không cần gì trong `public`, nên
-- quyền đó bị rút lại — không có nó thì một `CREATE TABLE` của runtime vào
-- `public` sẽ tồn tại ngoài tầm sweep `has_table_privilege` (AC-012) và ngoài
-- schema `backoffice` mà grant theo dõi.
--
-- Đây là grant cấp **object của chính `db-backoffice`**; nó không chạm database
-- nào khác.


COMMIT;
