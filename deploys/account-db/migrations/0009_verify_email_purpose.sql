-- 0009_verify_email_purpose.sql — mở purpose `verify_email` cho `otp_challenges`.
--
-- Bối cảnh: PR2 của Issue #274 thêm đường quản lý email của chính chủ
-- (`POST /api/emails` + verify/resend). Mã xác minh email là OTP keyed-HMAC
-- với đúng các tính chất mà `otp_challenges` đã có (0006): chỉ lưu digest,
-- một challenge active cho mỗi (address, purpose), rate limit đếm từ chính
-- bảng, TTL + consume nguyên tử. Bảng được chia purpose từ đầu cho mục đích
-- này (COMMENT của cột `purpose` trong 0006); file này mở CHECK tương ứng.
--
-- ⚠️ Forward-only: KHÔNG sửa `0006_otp_challenges.sql`. File này thay đổi
--    constraint TIỀN ra SAU, trong MỘT transaction.
--
-- ⚠️ IDEMPOTENT BẮT BUỘC (README "Advisory lock và idempotent"): runner chạy
--    lại MỌI file mỗi lần apply, nên DROP + ADD được guard bằng kiểm tra
--    catalog — cùng hình thức với `0004_rename_authn_level_to_acr.sql`. Test
--    `migrations.spec.ts` apply hai lần để giữ điều này thật.
--
-- ## Vì sao nới CHECK chứ không tạo bảng verify riêng
--
-- Một khoá mã thứ hai phải tái hiện đúng bốn tính chất trên và tự bảo vệ riêng
-- (grant, rate limit, anti-enumeration). Purpose mới được domain-separation của
-- `otpDigest(key, purpose, code)` bảo đảm: một mã của `login` không verify được
-- email và ngược lại, kể cả khi trùng giá trị. Rate limit đếm lọc theo
-- `(address_hash, purpose)` nên hai luồng độc lập về allowance — dò verify-email
-- không tốn hạn mức đăng nhập của user.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Bước 1 — DROP CHECK cũ (guard theo tên constraint; chạy lần hai là no-op).
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = 'account'
       AND table_name = 'otp_challenges'
       AND constraint_name = 'otp_challenges_purpose_check'
  ) THEN
    ALTER TABLE account.otp_challenges
        DROP CONSTRAINT otp_challenges_purpose_check;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Bước 2 — ADD CHECK mới với hai purpose. Guard theo tên: file chỉ thêm giá trị
-- `verify_email`, không đổi ý nghĩa của `login` hay hình dạng bảng nào khác.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema = 'account'
       AND constraint_name = 'otp_challenges_purpose_check'
       AND check_clause LIKE '%verify_email%'
  ) THEN
    ALTER TABLE account.otp_challenges
        ADD CONSTRAINT otp_challenges_purpose_check
            CHECK (purpose IN ('login', 'verify_email'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Bước 3 — COMMENT phản ánh tập purpose mới (idempotent: COMMENT thay thế).
-- ---------------------------------------------------------------------------------------------
COMMENT ON COLUMN account.otp_challenges.purpose IS
  'Challenge purpose. login (email sign-in) and verify_email (address verification for self-service email management) share the table; digests are domain-separated by purpose.';

COMMIT;
