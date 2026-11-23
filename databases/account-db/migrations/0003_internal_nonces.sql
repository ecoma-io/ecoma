-- 0003_internal_nonces.sql — kho nonce bền cho replay guard của đường nội bộ.
--
-- Phạm vi: bảng mà `verifyRequest` (`libs/internal-auth-contracts/src/internal-auth.ts`)
-- **cần** để chống replay. Không phải tính năng: thiếu nó thì `claimNonce` không
-- có nơi lưu và đường nội bộ không có gì để fail closed vào.
--
-- ⚠️ Cố ý **không** dùng `security_events` làm kho nonce, dù nó cũng là bảng
-- append-only của cùng service. Ba lý do độc lập:
--
--   1. **Retention khác nhau, và retention của `security_events` là nghĩa vụ
--      pháp lý.** Nonce chỉ còn giá trị trong cửa sổ skew của envelope; giữ nó lâu
--      hơn không thêm an toàn nào. Retention của audit thì do quy định ấn định và
--      `01-architecture.md` §10 còn để mở. Trộn hai vòng đời vào một bảng nghĩa là
--      một trong hai bị cắt cụt theo nhu cầu của cái kia.
--   2. **Append-only của audit chặn đúng thao tác mà kho nonce cần.** Dọn nonce
--      hết hạn là `DELETE` hàng loạt theo mốc thời gian; đưa nó vào
--      `security_events` sẽ đẩy việc retention thành việc sửa bảng audit.
--   3. **`subject_sub` là nullable ở audit** vì chủ thể có thể không xác định
--      được; nonce thì luôn xác định và luôn phải tồn tại. Non-null là ràng buộc
--      của kho chống replay, không phải chi tiết tuỳ chọn.
--
-- ⚠️ **Hợp đồng của `claimNonce` là "kiểm tra VÀ ghi", không chỉ "kiểm tra".**
-- `verifyRequest` gọi `seenNonce(nonce)` và từ chối khi nó trả `true`; store hiện
-- dụng vì vậy phải trả `true` **khi nonce đã tồn tại** và ghi lại nonce ở mọi
-- trường hợp còn lại. Đó là `INSERT … ON CONFLICT DO NOTHING` rồi đếm số hàng trả
-- về — một câu lệnh, nên hai request mang cùng nonce chỉ một cái thắng bất kể tải.
-- Cài `claimNonce` chỉ bằng `SELECT` (kiểm tra rồi `INSERT` ở câu khác) sẽ mất đúng
-- tính chất này dưới tải đồng thời — cùng cái lỗi mà FR-006c2 cấm ở
-- `login_handoffs`.

BEGIN;

CREATE TABLE IF NOT EXISTS account.internal_nonces (
  nonce text PRIMARY KEY,
  -- Hết hạn = timestamp của envelope + skew chấp nhận + biên cho độ trễ đồng hồ
  -- giữa hai máy. Số này là hằng của **giao thức**, không phải tuỳ chọn vận hành:
  -- nonce sống lâu hơn cửa sổ là nonce không còn tác dụng chống replay.
  --
  -- ⚠️ Phải lớn hơn `DEFAULT_SKEW_SECONDS` (300s, `internal-auth.ts`) vì sau khi
  -- skew hết hiệu lực thì request đó bị từ chối vì `bad_timestamp`, nên nonce của nó
  -- không còn cần giữ. TTL **nhỏ hơn** skew là hỏng: prune xoá nonce còn hiệu lực
  -- và replay thành công trong cửa sổ.
  expires_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE account.internal_nonces IS
  'Nonce store backing the replay guard of internal routes. security_events is deliberately not used as the store: its retention and append-only economics differ.';

COMMENT ON COLUMN account.internal_nonces.nonce IS
  'Nonce value of an authenticated envelope. The PRIMARY KEY is the core of the seenNonce check-and-set.';

COMMENT ON COLUMN account.internal_nonces.expires_at IS
  'Expiry past the accepted skew plus clock-drift margin. Pruning uses this column; it must exceed DEFAULT_SKEW_SECONDS.';

-- Đúng một truy vấn đọc bảng này: dọn nonce hết hạn theo lô. Không
-- truy vấn nào khác lọc theo `expires_at`, nên index phục vụ riêng câu đó.
--
-- ⚠️ Câu prune này **đã được cấu hình lên lịch**: cron Worker `apps/auth-nonce-prune-job`
-- chạy nó qua Hyperdrive binding `DB_ACCOUNT`, dùng credential `ecoma_account_nonce_pruner`
-- (role tạo ở `0007_nonce_pruner_role.sql`) — riêng cho từng DB. Trước đây job này là GitHub
-- Action `.github/workflows/identity-nonce-prune.yaml` chạy bằng credential
-- `ecoma_account_migrator`; workflow đã bị thay và xoá (issue #82). Trạng thái là **đã cấu
-- hình, chưa xác minh runtime**: cần Hyperdrive config của `db-account` (binding
-- `DB_ACCOUNT` trong `apps/auth-nonce-prune-job/wrangler.jsonc` vẫn mang id placeholder) —
-- chưa được provision. Runbook chính của prune nằm ở `docs/applications/auth-nonce-prune-job/`
-- (tài liệu của job là chỗ duy nhất mô tả cơ chế cron của cả hai kho). Hệ quả phình bảng là
-- vấn đề vận hành, KHÔNG làm yếu replay guard.
CREATE INDEX IF NOT EXISTS internal_nonces_expires_at_idx
  ON account.internal_nonces (expires_at);

-- Không có `DEFAULT now()` trên `expires_at`: thời điểm hết hạn là
-- `timestamp của envelope + skew`, tức là dữ liệu mà **người gọi kiểm soát**.
-- Để database tự điền sẽ biến nonce sống mãi và replay guard vô hiệu hoá.

-- Grant nằm ở **đây** chứ không ở `0002` vì bảng được `CREATE` ở file này, và
-- `GRANT` lên một bảng chưa tồn tại là lỗi. `0002` không có tầng default nào cho
-- bảng mới nên grant phải theo file tạo bảng — cùng luật với `0002` không grant
-- `COMMENT ON ROLE` cho vì không đủ quyền.
--
-- Không `UPDATE` (xem giải thích đầy đủ ở khối grant trong `0002`); không
-- `TRUNCATE` vì cùng lý do với audit — xoá sạch kho nonce bằng một câu lệnh
-- không giống prune theo `expires_at`.
GRANT SELECT, INSERT, DELETE ON TABLE account.internal_nonces TO ecoma_account_runtime;

COMMIT;