-- 0007_nonce_pruner_role.sql — role pruner riêng cho kho nonce của `db-account`.
--
-- Bản song sinh của `apps/auth/migrations/0014_nonce_pruner_role.sql`; hai file
-- là HAI role DỨT KHOÁI (mỗi database một principal), không chia credential.
--
-- Bối cảnh: job prune định kỳ đổi cơ chế — GitHub Action
-- `.github/workflows/identity-nonce-prune.yaml` (job chạy bằng credential
-- `ecoma_account_migrator`) được thay bằng cron Worker `apps/auth-nonce-prune-job`.
-- Worker KHÔNG ĐƯỢC cầm migrator: credential `_migrator_` (quyền DDL) không bao
-- giờ là Worker secret (docs/architecture/02-delivery.md §6; SR-008 của workstream
-- account), nên prune cần một principal trung gian — một role chỉ có DML tối
-- thiểu trên đúng một bảng, đủ để job chạy và KHÔNG đủ để làm gì khác nếu
-- credential rò.
--
-- ⚠️ Trước đây bên `account` không cần role riêng vì job cũ dùng migrator ở
-- CẢ HAI database — hai job giữ cùng một hình dạng quyền hạn, và bên `account`
-- không phụ thuộc vào ngoại lệ quyền của bên kia (`0002` đã giải thích). Job
-- Worker mới giữ nguyên học thuyết đó theo chiều khác: một role pruner RIÊNG
-- cho từng database, mỗi role chỉ đủ DML trên đúng một bảng của chính service.
--
-- Hợp đồng mà `prune.ts` ghim qua identity preflight (`buildIdentitySQL`):
--   ecoma_account_nonce_pruner|deletable
-- tức role này phải kết nối được db-account, thấy `account.internal_nonces` và
-- có `DELETE` trên nó. Sai một điều là job đỏ ở `outcome=identity_mismatch`
-- TRƯỚC khi xoá hàng nào — DSN dán nhầm service bị chặn, không âm thầm prune
-- nhầm database.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
--
-- Cùng khuôn với `0002_roles_and_grants.sql`: ba cờ `NO*` giới hạn role ở
-- **định nghĩa**; `NOINHERIT` chủ đích — quyền phải được cấp tường minh, không
-- kế thừa bất ngờ từ một role cha nào được gán thêm sau này.
--
-- ⚠️ Khối `DO $$` tạo role ở đây **chỉ là lưới an toàn**: role thật sự được
-- provisioning tạo sẵn (`README`, `03-operations.md` §3 — `CREATE ROLE …
-- LOGIN …`), vì migrator là `NOCREATEROLE` và không tự tạo được role. File này
-- vẫn phải chạy được **một mình** trên một cluster sạch, nên giữ guard
-- `pg_catalog.pg_roles`. Lưới an toàn phải tạo role **đúng khuôn với
-- provisioning** — có `LOGIN`: Hyperdrive kết nối db-account bằng credential
-- của chính role này, và một role `NOLOGIN` không thể xác thực với credential
-- nào — job sẽ đo đỏ `db_unreachable` vĩnh viễn trong khi migrations trông
-- xanh. Chạy lại migration cũng không cứu được: guard bỏ qua role đã tồn tại.
--
-- ⚠️ **Cố ý KHÔNG có `COMMENT ON ROLE`** — cùng giới hạn của `0002`:
-- `COMMENT ON ROLE` yêu cầu `CREATEROLE`, mà migrator cần `NOCREATEROLE` để
-- không leo thang. Mô tả role sống ở docs + provisioning, không ở migration.
--
-- ⚠️ Không đặt `PASSWORD` ở đây: credential do provisioning path sinh và rotate,
-- không thuộc vòng đời migration. `LOGIN` chỉ khai báo rằng role này là
-- connectable — mật khẩu để provisioning gán; `GRANT CONNECT` trên database là
-- việc của provisioning, nên lưới an toàn ở đây không quyết định phần đó.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_account_nonce_pruner') THEN
    CREATE ROLE ecoma_account_nonce_pruner
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants tối thiểu — chỉ đủ cho thuật toán prune của job
-- ---------------------------------------------------------------------------
--
-- Thuật toán (`src/prune.ts` của `apps/auth-nonce-prune-job`) chạy đúng ba
-- hình câu SQL trên bảng này:
--
--   identity  : SELECT current_user … has_table_privilege(…, 'DELETE') — chỉ
--               ĐỌC catalog của chính connection nó đang dùng.
--   batch     : WITH deleted AS (DELETE … WHERE expires_at < now() … RETURNING 1)
--               SELECT count(*) FROM deleted — cần SELECT + DELETE.
--   probe     : SELECT EXISTS(… WHERE expires_at < now()) — cần SELECT.
--
-- ⚠️ Grant này khớp đúng ngoại lệ mà `0003_internal_nonces.sql` đã cấp cho
-- `ecoma_account_runtime` (`SELECT, INSERT, DELETE`), nhưng cho principal khác
-- và HẸP hơn: pruner không cần `INSERT` (đó là việc của runtime — claim
-- chèn nonce), và không được có `UPDATE`. Runtime grant giữ nguyên như `0003`
-- đã ghi — file này KHÔNG thu lại quyền nào của runtime.
GRANT USAGE ON SCHEMA account TO ecoma_account_nonce_pruner;
GRANT SELECT, DELETE ON TABLE account.internal_nonces TO ecoma_account_nonce_pruner;

-- Phòng thủ trước quyền mặc định/tương lai, cùng khuôn với `0014` bên db-auth:
-- các quyền này không tự phát sinh từ đâu cả — chúng là chỉ báo "không ai được
-- nới quyền của pruner mà không qua một migration mới có review". `TRUNCATE`
-- còn quan trọng hơn DELETE: một lô TRUNCATE xoá SẠCH kho, kể cả những nonce
-- CÒN HIỆU LỰC — mở lại cửa sổ replay cho mọi envelope còn trong skew, đúng
-- thao tác bị cấm ở runbook `03-operations.md`. `UPDATE`: đổi `expires_at`
-- của nonce còn hiệu lực là nới cửa sổ replay — cùng lý do `0002` không cấp
-- UPDATE cho runtime trên bảng này.
REVOKE INSERT, UPDATE, TRUNCATE, TRIGGER, REFERENCES ON TABLE account.internal_nonces FROM ecoma_account_nonce_pruner;

COMMIT;
