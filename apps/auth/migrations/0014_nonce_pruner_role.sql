-- 0014_nonce_pruner_role.sql — role pruner riêng cho kho nonce của `db-auth`.
--
-- Bối cảnh: job prune định kỳ đổi cơ chế — GitHub Action
-- `.github/workflows/identity-nonce-prune.yaml` (job chạy bằng credential
-- `ecoma_auth_migrator`) được thay bằng cron Worker `apps/auth-nonce-prune-job`.
-- Worker KHÔNG ĐƯỢC cầm migrator: credential `_migrator_` (quyền DDL) không bao
-- giờ là Worker secret (docs/architecture/02-delivery.md §6; SR-008 bên account), nên
-- prune cần một principal trung gian — một role chỉ có DML tối thiểu trên đúng
-- một bảng, đủ để job chạy và KHÔNG đủ để làm gì khác nếu credential rò.
--
-- Hợp đồng mà `prune.ts` ghim qua identity preflight (`buildIdentitySQL`):
--   ecoma_auth_nonce_pruner|deletable
-- tức role này phải kết nối được db-auth, thấy `auth.internal_nonces` và có
-- `DELETE` trên nó. Sai một điều là job đỏ ở `outcome=identity_mismatch`
-- TRƯỚC khi xoá hàng nào — DSN dán nhầm service bị chặn, không âm thầm prune
-- nhầm database.
--
-- ⚠️ Xem nội dung file này như một **mở rộng của bảng quyền**, không phải một layer
-- mới: nó tạo role MỚI chứ không cấp thêm quyền nào cho
-- `ecoma_auth_runtime` hay `ecoma_auth_migrator` — serving path giữ nguyên
-- `SELECT, INSERT` trên bảng này, đúng Sweep ô (2c) của `README.md`.

-- Hyperdrive giữ TLS tới origin (04-platform-facts HD2) và connection string
-- sống trong Hyperdrive config của Cloudflare account, không vào Git; nên không
-- có phần "kiểm sslmode trên DSN" như script cũ — ranh giới đó chuyển thành
-- trách nhiệm của Hyperdrive binding, được mô tả ở
-- docs/applications/auth-nonce-prune-job/01-architecture.md §6.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
--
-- Cùng khuôn với `0002_roles_and_grants.sql` của db-account: ba cờ `NO*` giới
-- hạn role ở **định nghĩa**, không phụ thuộc grant bên dưới; `NOINHERIT` chủ
-- đích — quyền phải được cấp tường minh, không kế thừa bất ngờ từ một role cha
-- nào được gán thêm sau này.
--
-- ⚠️ Khối `DO $$` tạo role ở đây **chỉ là lưới an toàn**: role thật sự được
-- provisioning tạo sẵn (`README.md`, cùng mô hình `0002` của account — `CREATE
-- ROLE … LOGIN …`), vì migrator là `NOCREATEROLE` và không tự tạo được role.
-- File này vẫn phải chạy được **một mình** trên một cluster sạch, nên giữ guard
-- `pg_catalog.pg_roles`. Lưới an toàn phải tạo role **đúng khuôn với
-- provisioning** — có `LOGIN`: Hyperdrive kết nối db-auth bằng credential của
-- chính role này, và một role `NOLOGIN` không thể xác thực với credential nào —
-- job sẽ đo đỏ `db_unreachable` vĩnh viễn trong khi migrations trông xanh.
-- Chạy lại migration cũng không cứu được: guard bỏ qua role đã tồn tại.
--
-- ⚠️ **Cố ý KHÔNG có `COMMENT ON ROLE`** — cùng giới hạn của `0002`:
-- `COMMENT ON ROLE` yêu cầu `CREATEROLE`, mà migrator cần `NOCREATEROLE` để
-- không leo thang. Mô tả role sống ở docs + provisioning, không ở migration.
--
-- ⚠️ Không đặt `PASSWORD` ở đây: credential do provisioning path sinh và rotate,
-- không thuộc vòng đời migration. `LOGIN` chỉ khai báo rằng role này là
-- connectable — mật khẩu để provisioning gán; `GRANT CONNECT` trên database (và
-- thu `CONNECT` của `PUBLIC`) là việc của provisioning, nên lưới an toàn ở đây
-- không quyết định phần đó.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_auth_nonce_pruner') THEN
    CREATE ROLE ecoma_auth_nonce_pruner
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
-- Không đường nào cần `INSERT` hay `UPDATE`, và không đường nào chạm bảng khác,
-- nên grant dừng ở đó. `USAGE` ở tầng schema là bắt buộc để chạm tới object
-- trong schema; nó không cấp quyền đọc nội dung.
GRANT USAGE ON SCHEMA auth TO ecoma_auth_nonce_pruner;
GRANT SELECT, DELETE ON TABLE auth.internal_nonces TO ecoma_auth_nonce_pruner;

-- Phòng thủ trước quyền mặc định/tương lai, cùng khuôn với `REVOKE` của
-- `0010`: một grant quên khử là một quyền thừi người trực phải điều tra.
--
-- ⚠️ `REVOKE INSERT`/`UPDATE`/`TRUNCATE`/`TRIGGER`/`REFERENCES`/`REFERENCES`:
-- với role NOSUPERUSER NOINHERIT như trên, các quyền này không tự phát sinh từ
-- đâu cả — chúng là chỉ báo "không ai được nới quyền của pruner mà không qua
-- một migration mới có review". `TRUNCATE` còn quan trọng hơn DELETE: một lô
-- TRUNCATE xoá SẠCH kho, kể cả những nonce CÒN HIỆU LỰC — mở lại cửa sổ replay
-- cho mọi envelope còn trong skew, đúng thao tác bị cấm ở runbook `03-operations.md`.
-- `UPDATE`: đổi `expires_at` của nonce còn hiệu lực là nới cửa sổ replay — cùng
-- lý do `0010` REVOKE UPDATE cho runtime.
REVOKE INSERT, UPDATE, TRUNCATE, TRIGGER, REFERENCES ON TABLE auth.internal_nonces FROM ecoma_auth_nonce_pruner;

COMMIT;
