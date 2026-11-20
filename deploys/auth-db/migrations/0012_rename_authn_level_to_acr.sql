-- 0012_rename_authn_level_to_acr.sql — `authorization_transactions.authn_level` → `acr`.
--
-- Bối cảnh: model assurance của `identity` chuyển từ thang bậc
-- `anonymous < password < totp < passkey` sang ACR URN
-- (`urn:ecoma:acr:email-otp`, `urn:ecoma:acr:mfa`, `urn:ecoma:acr:phishing-resistant`).
-- Ladder cũ chứa `password` — phương thức đã bị loại khỏi hệ thống (không còn
-- password ở bất kỳ đâu), nên cả TÊN cột lẫn CHECK của nó đều mô tả một thế giới
-- không còn tồn tại.
--
-- Quyết định đổi tên (không chỉ đổi CHECK): `authn_level` là tên của mô hình
-- ladder; giữ tên cũ cho dữ liệu ACR là giữ lại một lời nói dối trong schema —
-- nơi đọc schema sẽ suy ra có một "level" có thứ tự, đúng điều mô hình mới loại bỏ.
--
-- ⚠️ Forward-only: KHÔNG sửa `0002`. File này thay đổi schema TIỀN ra SAU.
--
-- ⚠️ Toàn bộ chạy trong MỘT transaction (BEGIN ... COMMIT cuối file): đổi cột và
--    thay CHECK phải cùng khớp hoặc cùng rollback — nửa đường là schema mô tả
--    một mô hình nửa vời.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Bước 1 — Đổi tên cột `authn_level` → `acr`.
--
-- `ALTER TABLE ... RENAME COLUMN` là metadata-only trong PostgreSQL: không ghi lại bảng,
-- không khoá kéo dài. An toàn ở mọi kích thước bảng.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_transactions
    RENAME COLUMN authn_level TO acr;

-- ---------------------------------------------------------------------------------------------
-- Bước 2 — Thay CHECK ladder bằng CHECK tập ACR.
--
-- Bước này chạy SAU rename: constraint cũ `authorization_transactions_authn_level_check`
-- bám theo cột qua rename (PostgreSQL giữ constraint khi cột đổi tên), nên DROP bằng tên
-- constraint, KHÔNG phụ thuộc tên cột.
--
-- Tập mới là ĐÚNG ba URN ACR của `@ecoma-io/account-domain` (`ACR_VALUES`) — parity với
-- contracts được canh bằng test, không phải bằng niềm tin:
--   - `urn:ecoma:acr:email-otp`          — đăng nhập OTP email (phương thức duy nhất).
--   - `urn:ecoma:acr:mfa`                — OTP + yếu tố thứ hai (TOTP hoặc Passkey).
--   - `urn:ecoma:acr:phishing-resistant` — yếu tố thứ hai là Passkey/WebAuthn.
-- Cột giữ ĐƠN GIÁ TRỊ (một URN, assurance cao nhất đã vượt qua), không phải mảng: contract
-- `/internal/session/verified` truyền đúng một `acr`, và invariant "có `sub` thì có bằng
-- chứng" (bước 3) chỉ có nghĩa trên một giá trị duy nhất.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_transactions
    DROP CONSTRAINT authorization_transactions_authn_level_check;

ALTER TABLE auth.authorization_transactions
    ADD CONSTRAINT authorization_transactions_acr_check
        CHECK (acr IS NULL OR acr IN (
            'urn:ecoma:acr:email-otp',
            'urn:ecoma:acr:mfa',
            'urn:ecoma:acr:phishing-resistant'
        ));

-- ---------------------------------------------------------------------------------------------
-- Bước 3 — COMMENT cho cột mới.
-- ---------------------------------------------------------------------------------------------
COMMENT ON COLUMN auth.authorization_transactions.acr IS
  'ACR URN (the highest assurance the session has passed) - replaces the authn_level ladder. NULL until account authenticates.';

COMMIT;
