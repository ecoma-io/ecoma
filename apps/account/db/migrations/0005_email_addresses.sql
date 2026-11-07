-- 0005_email_addresses.sql — địa chỉ email của user, phục vụ đăng nhập email-OTP.
--
-- Phạm vi: bảng mà luồng đăng nhập OTP (`server/api/auth/challenge`) cần để quyết
-- định "email này có thuộc một account còn hoạt động hay không" mà **không** tiết
-- lộ câu trả lời (anti-enumeration). Bảng cũng là chủ sở hữu dữ liệu email theo
-- logical model (`01-architecture.md` §3.2, entity `user_emails`; tên bảng ở đây
-- là `email_addresses` để khớp nhóm bảng thực tế đang tồn tại của `db-account`).
--
-- ⚠️ Forward-only: KHÔNG sửa `0001_identity_core.sql`. File này là expand — thêm
--    bảng mới, không đổi bảng cũ.
--
-- ⚠️ IDEMPOTENT BẮT BUỘC (README "Advisory lock và idempotent"): runner không có
--    bảng ledger — nó chạy lại MỌI file mỗi lần apply. `CREATE TABLE IF NOT EXISTS`,
--    `CREATE INDEX IF NOT EXISTS` và `GRANT` (bản chất lặp được) đều là no-op khi
--    schema đã ở trạng thái đích. Test `migrations.spec.ts` áp mọi file hai lần.
--
-- ## Vì sao email không là khoá và không là định danh
--
-- FR-002: email **không** bao giờ là OIDC `sub`. Bảng này giữ email như một
-- **credential liên lạc + đăng nhập**, trỏ về `users.sub` bằng FK. Hash của địa
-- chỉ (`address_hash`) là khoá tra cứu của luồng OTP — truy vấn theo hash thay vì
-- theo địa chỉ trần để index không lộ địa chỉ dưới dạng plaintext trong catalog,
-- và để phép so sánh tra cứu là so chuỗi hash cố định kích thước.

BEGIN;

CREATE TABLE IF NOT EXISTS account.email_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub text NOT NULL REFERENCES account.users (sub) ON DELETE RESTRICT,
  -- Địa chỉ đã normalize (lowercase, trim) — dạng chỉ dùng nội bộ, không phải
  -- dạng hiển thị. Database không tự normalize: cột nhận giá trị app ghi, và app
  -- là nơi duy nhất gọi `normalizeEmailAddress` (`server/lib/otp.ts`).
  address_normalized text NOT NULL,
  -- SHA-256 hex của `address_normalized`. Khoá tra cứu của luồng OTP; không đảo
  -- ngược được về địa chỉ trần trong log hay index.
  address_hash text NOT NULL,
  -- `pending` → `verified` | `revoked`. Chỉ email `verified` mới đăng nhập được
  -- (FR-002) và chỉ email `verified` nhận OTP đăng nhập.
  status text NOT NULL DEFAULT 'pending',
  is_sign_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Cặp trạng thái: `verified` phải có mốc xác minh, trạng thái khác thì không.
  verified_at timestamptz,
  CONSTRAINT email_addresses_status_check CHECK (status IN ('pending', 'verified', 'revoked')),
  CONSTRAINT email_addresses_verified_pair_check CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  -- Hash phải là ảnh của chính địa chỉ đã lưu: hai cột bị đổi lệch nhau (bất kỳ
  -- đường ghi nào tính hash từ chuỗi khác `address_normalized`) làm mọi truy vấn
  -- theo hash trả kết quả của một địa chỉ khác — sai thứ FR-002 cấm. Ràng buộc ở
  -- tầng app bằng parity của `normalizeEmailAddress` + `emailAddressHash`; đây là
  -- lớp thứ hai chặn giá trị hình thức sai (độ dài hash hex SHA-256).
  CONSTRAINT email_addresses_hash_shape_check CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_addresses_normalized_shape_check CHECK (length(address_normalized) > 0)
);

COMMENT ON TABLE account.email_addresses IS
  'Email addresses of a user. Only status = verified may log in (FR-002); lookups go through address_hash, never the plaintext address.';
COMMENT ON COLUMN account.email_addresses.address_normalized IS
  'Lowercased + trimmed address, internal form. Not a display form.';
COMMENT ON COLUMN account.email_addresses.address_hash IS
  'SHA-256 hex of address_normalized. Lookup key of the OTP flow; not reversible.';
COMMENT ON COLUMN account.email_addresses.status IS
  'pending -> verified | revoked. Only verified receives login OTP (FR-002).';

-- Truy vấn "mọi email của một sub" (trang quản lý email, và luồng OTP liệt kê
-- địa chỉ đăng nhập). Mỗi index gắn với đúng một truy vấn — không thêm index
-- "cho chắc" (`01-architecture.md` §3).
CREATE INDEX IF NOT EXISTS email_addresses_user_sub_idx
  ON account.email_addresses (user_sub);

-- FR-002 / T-04: một địa chỉ chỉ được **một** row `verified` — người verify sau
-- bị UNIQUE từ chối, người trước thắng. Đó là ràng buộc ownership của email đã
-- xác minh, enforced ở tầng database chứ không phải quy tắc app.
--
-- ⚠️ Partial (WHERE status = 'verified'), không phải UNIQUE toàn bảng: `revoked`
--     vẫn phải chặn `verified` mới nhưng KHÔNG chặn user claim lại địa chỉ đã
--     revoke; và hai row `pending` cùng địa chỉ tồn tại được cho tới khi một bên
--     verify. Toàn bảng UNIQUE sẽ biến revoke thành xoá cứng — trái logical model
--     (`01-architecture.md` §3.2: "UNIQUE trên email đã verify").
CREATE UNIQUE INDEX IF NOT EXISTS email_addresses_verified_hash_idx
  ON account.email_addresses (address_hash)
  WHERE status = 'verified';

-- Grant nằm ở file tạo bảng (`0002` không có default privilege cho bảng mới —
-- cùng luật với `internal_nonces` ở `0003`). DELETE có cấp: xoá email là thao tác
-- hợp lệ của nhóm (2) (xoá/anonymize theo account); bảng này KHÔNG phải tombstone.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account.email_addresses TO ecoma_account_runtime;

COMMIT;
