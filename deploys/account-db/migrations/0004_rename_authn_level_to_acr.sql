-- 0004_rename_authn_level_to_acr.sql — `account_sessions.authn_level` → `acr`.
--
-- Bối cảnh: model assurance của `identity` chuyển từ thang bậc
-- `anonymous < password < totp < passkey` sang ACR URN
-- (`urn:ecoma:acr:email-otp`, `urn:ecoma:acr:mfa`, `urn:ecoma:acr:phishing-resistant`).
-- Ladder cũ chứa `password` — phương thức đã bị loại khỏi hệ thống, và bản thân
-- "thang bậc" không còn là mô hình đúng: email-OTP không "yếu hơn nhưng bao hàm
-- trong" MFA, nó chỉ KHÔNG mang ACR `mfa`.
--
-- Quyết định đổi tên (không chỉ đổi CHECK): `authn_level` là tên của mô hình
-- ladder; giữ tên cũ cho dữ liệu ACR là giữ một lời nói dối trong schema. Cột
-- này được đọc bởi flow `/internal/session/verified` (contract truyền `acr`)
-- và bởi mọi kiểm tra reauthentication (FR-004b, SR-005).
--
-- ⚠️ Forward-only: KHÔNG sửa `0001_identity_core.sql`. File này thay đổi schema
--    TIỀN ra SAU, trong MỘT transaction.
--
-- ⚠️ IDEMPOTENT BẮT BUỘC (README "Advisory lock và idempotent"): runner không có
--    bảng ledger — nó chạy lại MỌI file mỗi lần apply, nên mọi DDL phải là no-op
--    khi schema đã ở trạng thái đích. `RENAME COLUMN` và
--    `DROP CONSTRAINT ... ADD CONSTRAINT` không có dạng idempotent sẵn có, nên cả
--    hai được guard bằng kiểm tra catalog. Test `migrations.spec.ts` chạy apply
--    hai lần để giữ điều này thật — một file không guard sẽ đỏ ngay.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Bước 1 — Đổi tên cột `authn_level` → `acr` (khi cột cũ còn tồn tại).
--
-- Guard theo `information_schema.columns`: chạy lần hai, cột `acr` đã có và
-- `authn_level` đã mất, khối DO không làm gì — đúng nghĩa no-op.
--
-- `ALTER TABLE ... RENAME COLUMN` là metadata-only trong PostgreSQL: không ghi
-- lại bảng, không khoá kéo dài. An toàn ở mọi kích thước bảng.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'account'
       AND table_name = 'account_sessions'
       AND column_name = 'authn_level'
  ) THEN
    ALTER TABLE account.account_sessions RENAME COLUMN authn_level TO acr;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Bước 2 — Thay CHECK ladder bằng CHECK tập ACR (mỗi câu một guard riêng).
--
-- ⚠️ Hai guard RIÊNG BIỆT, không gộp: trạng thái giữa có thể tồn tại thật (cột đã
--    rename nhưng apply bị ngắt trước khi thay CHECK — transaction per-file thì
--    không, nhưng catalog check phải đứng vững độc lập với thứ tự đó để file này
--    không bao giờ phụ thuộc trạng thái của file khác).
--
-- Constraint cũ `account_sessions_authn_level_check` bám theo cột qua rename
-- (PostgreSQL giữ constraint khi cột đổi tên), nên DROP theo tên constraint.
--
-- Tập mới là ĐÚNG ba URN của `@ecoma-io/account-domain` (`ACR_VALUES`) — parity
-- được canh bằng test.
--
-- ⚠️ Không còn `anonymous` trong tập: session chưa xác thực để `acr` NULL (giữ
--    nguyên invariant cặp `(acr, authn_at)`), không dùng một giá trị giả
--    "anonymous" làm cánh cửa logic xuyên qua CHECK.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'account'
       AND table_name = 'account_sessions'
       AND constraint_name = 'account_sessions_authn_level_check'
  ) THEN
    ALTER TABLE account.account_sessions
        DROP CONSTRAINT account_sessions_authn_level_check;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'account'
       AND table_name = 'account_sessions'
       AND constraint_name = 'account_sessions_acr_check'
  ) THEN
    ALTER TABLE account.account_sessions
        ADD CONSTRAINT account_sessions_acr_check
            CHECK (acr IS NULL OR acr IN (
                'urn:ecoma:acr:email-otp',
                'urn:ecoma:acr:mfa',
                'urn:ecoma:acr:phishing-resistant'
            ));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Bước 3 — COMMENT cho cột mới (idempotent: COMMENT thay thế, không lỗi khi lặp).
-- ---------------------------------------------------------------------------------------------
COMMENT ON COLUMN account.account_sessions.acr IS
  'ACR URN - the highest assurance the session has passed. NULL when the session is unauthenticated; paired with authn_at by account_sessions_authn_pair_check.';

COMMIT;
