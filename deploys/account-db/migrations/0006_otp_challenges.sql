-- 0006_otp_challenges.sql — kho challenge OTP của luồng đăng nhập email.
--
-- Phạm vi: bảng mà `server/api/auth/challenge` (tạo OTP) và
-- `server/api/auth/verify` (xác minh OTP) dùng. Mã OTP **không bao giờ** được lưu:
-- bảng chỉ giữ keyed HMAC (digest) của mã, key nằm ở Worker Secret
-- (`NUXT_OTP_HMAC_SECRET`) — cùng hình dạng "chỉ lưu dẫn xuất, không lưu credential"
-- với `account_sessions.id_hash` (invariant 3) và `login_handoffs.handle_hash`.
--
-- ⚠️ Forward-only, idempotent: cùng quy ước với `0005`.
--
-- ## Ràng buộc một challenge active cho mỗi (address, purpose)
--
-- Partial UNIQUE INDEX `(address_hash, purpose) WHERE consumed_at IS NULL`
-- biến "một địa chỉ chỉ có tối đa một challenge đang hiệu lực cho một mục đích"
-- thành thuộc tính của ràng buộc UNIQUE, không phải quy tắc app có thể quên.
-- `INSERT` mới khi còn challenge active phải đi qua việc `consume` challenge cũ
-- trong cùng transaction — hai request resend cạnh nhau chỉ một cái thắng, bất kể
-- tải (cùng tính chất first-binding-wins của `login_handoffs`).
--
-- ## Rate limit nằm ở đâu
--
-- Không có bảng rate-limit riêng (`0007` không tồn tại): giới hạn 3/15 phút và
-- 10/giờ per address **đếm từ chính bảng này** — `SELECT count(*)` các hàng
-- `created_at` trong cửa sổ, khoá theo `address_hash`. Con số đó reconstructible
-- từ durable state (mọi challenge từng cấp đều để lại một hàng), đúng bất biến
-- "quota reconstructible từ database state". Prune xoá hàng **hết hạn xa** thì
-- vẫn giữ đủ cửa sổ gần nhất vì TTL (10 phút) nhỏ hơn nhiều so với cửa sổ limit
-- lớn nhất (1 giờ) — hàng bị xoá là hàng đã ngoài mọi cửa sổ đếm.

BEGIN;

CREATE TABLE IF NOT EXISTS account.otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tra cứu theo **hash** của địa chỉ đã normalize — cùng quy ước với
  -- `email_addresses.address_hash`. Không FK sang `email_addresses`: challenge
  -- cũng cấp cho địa chỉ **chưa tồn tại trong DB** (anti-enumeration phải trả lời
  -- như nhau, và việc vẫn ghi challenge cho địa chỉ lạ là chính cơ chế rate-limit
  -- chống dò địa chỉ).
  address_hash text NOT NULL,
  -- Digest = HMAC-SHA256(key, purpose || ':' || code), hex 64. Key từ Worker
  -- Secret; so sánh ở tầng app bằng phép so thời gian hằng. Độ dài là ràng buộc
  -- hình dạng — giá trị thật do app ghi.
  code_digest text NOT NULL,
  -- `login` là purpose duy nhất của v1; cột tách ngay từ đầu để luồng
  -- reauthentication/verify-email sau này dùng chung bảng mà không đụng constraint
  -- active-unique của luồng đăng nhập.
  purpose text NOT NULL DEFAULT 'login',
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenges_purpose_check CHECK (purpose IN ('login')),
  -- Trần 5 lần thử nằm ở tầng app (`MAX_OTP_ATTEMPTS`), DB chỉ giữ hình dạng:
  -- số âm là dữ liệu hỏng và không bao giờ là trạng thái hợp lệ.
  CONSTRAINT otp_challenges_attempts_check CHECK (attempts >= 0),
  CONSTRAINT otp_challenges_digest_shape_check CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT otp_challenges_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT otp_challenges_address_shape_check CHECK (address_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE account.otp_challenges IS
  'OTP challenge store. Stores no plaintext code — only a keyed HMAC digest. Rate limiting derives from this table, no separate table.';
COMMENT ON COLUMN account.otp_challenges.address_hash IS
  'SHA-256 hex of the normalized address. No FK: a challenge is issued even for an address that does not exist yet (anti-enumeration).';
COMMENT ON COLUMN account.otp_challenges.code_digest IS
  'HMAC-SHA256(key, purpose || ":" || code) hex. Key lives in the Worker Secret NUXT_OTP_HMAC_SECRET; compared timing-safe at the app layer.';
COMMENT ON COLUMN account.otp_challenges.purpose IS
  'Challenge purpose. Login is the only one in v1; the column is split so later flows can share the table.';
COMMENT ON COLUMN account.otp_challenges.consumed_at IS
  'NULL = still valid. The partial UNIQUE index on (address_hash, purpose) counts only these rows.';

-- Đúng hai truy vấn đọc bảng này:
--   1. Tra cứu challenge active theo (address, purpose) — index UNIQUE bên dưới phục vụ.
--   2. Đếm challenge trong cửa sổ rate-limit theo (address, created_at) — index sau.
CREATE INDEX IF NOT EXISTS otp_challenges_address_created_idx
  ON account.otp_challenges (address_hash, created_at);

-- Ràng buộc một challenge active cho mỗi (address, purpose) — xem phần đầu file.
-- Index này ĐỒNG THỜI là index tra cứu của luồng challenge/verify (prefix
-- `address_hash`), nên không cần index riêng cho truy vấn active.
CREATE UNIQUE INDEX IF NOT EXISTS otp_challenges_active_unique_idx
  ON account.otp_challenges (address_hash, purpose)
  WHERE consumed_at IS NULL;

-- Grant nằm ở file tạo bảng — cùng luật với `0005`. `DELETE` là prune theo TTL
-- và là thao tác của bảng; không `UPDATE`-free vì **tăng `attempts` và consume**
-- là hai UPDATE hợp lệ của luồng verify.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.otp_challenges TO ecoma_account_runtime;

COMMIT;
