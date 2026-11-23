-- 0010_internal_nonces.sql — kho nonce bền cho replay guard của `auth`.
--
-- Phạm vi: bảng mà `verifyRequest` (`libs/internal-auth-contracts/src/internal-auth.ts`) **cần**
-- để chống replay ở chiều `account → auth`. Không phải tính năng: thiếu nó thì `claimNonce`
-- không có nơi ghi và đường nội bộ không có gì để fail closed vào.
--
-- ⚠️ Đây là bản song sinh của `account.internal_nonces`
-- (`apps/account/db/migrations/0003_internal_nonces.sql`). Hai bảng tồn tại vì **mỗi service
-- sở hữu database của mình** và không được với sang database của service kia: một nonce đã
-- chiếm ở `db-account` KHÔNG bảo vệ được request đến `auth`, và ngược lại. Nonce là duy nhất
-- theo **từng service nhận**, và mỗi kho do chủ của nó prune.
--
-- ⚠️ Cố ý **không** dùng `authorization_audit_events` (`0008`) làm kho nonce, dù nó cũng là
-- bảng của cùng service. Ba lý do độc lập:
--
--   1. **Retention khác nhau, và retention của audit là nghĩa vụ pháp lý.** Nonce chỉ còn giá
--      trị trong cửa sổ skew của envelope; giữ nó lâu hơn không thêm an toàn nào. Retention
--      của audit thì do quy định ấn định và `01-architecture.md` §10 còn để mở. Trộn hai vòng
--      đời vào một bảng nghĩa là một trong hai bị cắt cụt theo nhu cầu của cái kia.
--   2. **Append-only của audit chặn đúng thao tác mà kho nonce cần.** Dọn nonce hết hạn là
--      `DELETE` hàng loạt theo mốc thời gian; đưa nó vào `authorization_audit_events` sẽ đẩy
--      việc retention thành việc sửa bảng audit.
--   3. **`subject_ref` là nullable ở audit** (`0008`, dòng 34) vì chủ thể có thể không xác
--      định được; nonce thì luôn xác định và luôn phải tồn tại. Non-null là ràng buộc của kho
--      chống replay, không phải chi tiết tuỳ chọn.
--
-- ⚠️ Đừng lẫn sang service khác: `security_events` (cột `subject_sub`) là bảng của **`account`**
-- trong `db-account` (`apps/account/db/migrations/0001_identity_core.sql`), **không** tồn tại
-- trong `db-auth`. Nêu nó ở đây như một ứng viên của cùng database là đúng kiểu nhầm ranh giới
-- mà hợp đồng nội bộ này đang dọn.
--
-- ⚠️ **Hợp đồng của `claimNonce` là "kiểm tra VÀ ghi", không chỉ "kiểm tra".**
-- `verifyRequest` từ chối khi callback trả `true`; store hiện dụng vì vậy phải trả `true` **khi
-- nonce đã tồn tại** và ghi lại nonce ở mọi trường hợp còn lại. Đó là
-- `INSERT … ON CONFLICT DO NOTHING` rồi đếm số hàng trả về — một câu lệnh, nên hai request
-- mang cùng nonce chỉ một cái thắng bất kể tải. Cài `claimNonce` bằng `SELECT` rồi `INSERT` ở
-- câu khác sẽ mất đúng tính chất này dưới tải đồng thời — cùng cái lỗi mà FR-006c2 cấm ở
-- `login_handoffs`.

SET TIME ZONE 'UTC';

CREATE TABLE auth.internal_nonces (
  nonce text PRIMARY KEY,
  -- Hết hạn = timestamp của envelope + skew chấp nhận + biên cho độ trễ đồng hồ giữa hai máy.
  -- Số này là hằng của **giao thức**, không phải tuỳ chọn vận hành: nonce sống lâu hơn cửa sổ
  -- là nonce không còn tác dụng chống replay.
  --
  -- ⚠️ Phải lớn hơn `DEFAULT_SKEW_SECONDS` (300s, `internal-auth.ts`) vì sau khi skew hết hiệu
  -- lực thì request đó bị từ chối vì `bad_timestamp`, nên nonce của nó không còn cần giữ. TTL
  -- **nhỏ hơn** skew là hỏng: prune xoá nonce còn hiệu lực và replay thành công trong cửa sổ.
  expires_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE auth.internal_nonces IS
  'Nonce store backing the replay guard of account->auth internal routes. authorization_audit_events is deliberately not used as the store: its retention and append-only economics differ.';

COMMENT ON COLUMN auth.internal_nonces.nonce IS
  'Nonce value of an authenticated envelope. The PRIMARY KEY is the core of the claimNonce check-and-set.';

COMMENT ON COLUMN auth.internal_nonces.expires_at IS
  'Expiry past the accepted skew plus clock-drift margin. Pruning uses this column; it must exceed DEFAULT_SKEW_SECONDS.';

-- Đúng một truy vấn đọc bảng này: dọn nonce hết hạn theo lô. Không truy vấn nào khác lọc theo
-- `expires_at`, nên index phục vụ riêng câu đó.
--
-- Lịch chạy của câu prune: cron Worker `apps/auth-nonce-prune-job` (một lần mỗi ngày,
-- nhịp `17 3 * * *`) — chạy đúng câu lệnh dưới đây qua Hyperdrive binding `DB_AUTH`,
-- dùng credential `ecoma_auth_nonce_pruner` (role tạo ở `0014`). Trước đây job này là
-- GitHub Action `.github/workflows/identity-nonce-prune.yaml` chạy bằng credential
-- `ecoma_auth_migrator`; workflow đã bị thay và xoá (issue #82). Trước khi Worker có
-- Hyperdrive thật, bảng chỉ được dọn khi người vận hành chạy tay theo runbook
-- `03-operations.md` §3.3.
--
-- ⚠️ Trạng thái là **đã cấu hình, chưa xác minh runtime**: job cần Hyperdrive config của
-- `db-auth` (binding `DB_AUTH` trong `apps/auth-nonce-prune-job/wrangler.jsonc` vẫn mang id
-- placeholder) và credential `ecoma_auth_nonce_pruner` trên Hyperdrive đó — cả hai chưa tồn
-- tại (db-auth chưa được provision). Cho tới khi đó cron invocation đỏ mỗi lần chạy theo
-- lịch (Past events của Cron dashboard), và điều đó là cố ý: một job dọn dữ liệu không chạy
-- được là một lỗi, không phải một lần bỏ qua.
--
-- Chưa dọn thì bảng phình ra theo lưu lượng — phiền về vận hành, KHÔNG yếu đi về bảo mật: một
-- nonce cũ nằm lại vẫn là một nonce đã bị chiếm. Vì vậy câu prune này không được nới thành
-- `TRUNCATE` hay xoá theo tuổi cố định, dù nó chạy chậm đến đâu.
CREATE INDEX IF NOT EXISTS internal_nonces_expires_at_idx
  ON auth.internal_nonces (expires_at);

-- Không có `DEFAULT now()` trên `expires_at`: thời điểm hết hạn là
-- `timestamp của envelope + skew`, tức là dữ liệu mà **người gọi kiểm soát**. Để database tự
-- điền sẽ biến nonce sống mãi và replay guard vô hiệu hoá.

-- ⚠️ Grant nằm ở **đây** chứ không ở `0009`, và đây là ngoại lệ duy nhất của mô hình "một chỗ
-- khai quyền runtime" mà `0009_grants_and_isolation.sql` dựng nên. Lý do là **thứ tự áp dụng**:
-- `0009` chạy TRƯỚC file này, và `GRANT` lên một bảng chưa tồn tại là lỗi, không phải no-op —
-- `0009` cũng không có `ALTER DEFAULT PRIVILEGES` nào để hứng bảng mới. Cùng luật với
-- `apps/account/db/migrations/0003_internal_nonces.sql`; cái khác chỉ là bên đó không có file
-- grant tập trung nên đây không phải ngoại lệ.
--
-- Hệ quả cần nhớ: danh sách bảng ở ô (2) của `README.md` §"Sweep kiểm tra quyền" phải thêm
-- `internal_nonces` với đúng hai quyền này.
--
-- ⚠️ **Runtime KHÔNG có `DELETE` — prune là job của `ecoma_auth_migrator`.** Đây là học thuyết
-- đã viết trong `0009` ("Dọn dữ liệu hết TTL là job của migrator, không phải đường của serving
-- path: đường xoá do Worker gọi là đường mà một request lỗi có thể gọi vào"), và với bảng này
-- nguyên nhân đó **nặng hơn** chứ không nhẹ hơn: xoá một nonce **còn hiệu lực** là mở lại cửa sổ
-- replay cho đúng envelope đó — cùng kết luận mà `03-operations.md` dùng để cấm `TRUNCATE`.
-- Bản chép ở `account` (`0003`) cấp `DELETE` cho runtime và đã giải thích lý do riêng tại
-- `0002`; đây **không** chép lại quyết định đó, vì db-auth đã có học thuyết ngược lại và bản
-- prune trong `03-operations.md` §3.3 đã chạy bằng migrator.
--
-- Không `UPDATE` (xem giải thích đầy đủ ở khối grant trong `0009`): nới `expires_at` của một
-- nonce đã ghi là nới cửa sổ replay, tức là sửa dữ liệu kiểm soát bảo mật. Không `TRUNCATE`
-- vì cùng lý do với audit — xoá sạch kho nonce bằng một câu lệnh không giống prune theo
-- `expires_at`, và prune là truy vấn duy nhất bảng này phục vụ.
GRANT SELECT, INSERT ON TABLE auth.internal_nonces TO ecoma_auth_runtime;
-- Phòng thủ trước quyền mặc định/tương lai, cùng khuôn với `token_revocations` ở `0009`.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE auth.internal_nonces FROM ecoma_auth_runtime;
