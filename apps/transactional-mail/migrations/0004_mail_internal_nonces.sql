-- 0004_mail_internal_nonces.sql — kho nonce bền cho replay guard của chính `transactional-mail`.
--
-- Nguồn: docs/applications/transactional-mail/01-architecture.md §7.4;
--        docs/applications/auth/01-architecture.md §5.1.8;
--        libs/internal-auth-contracts/src/internal-auth.ts (`claimNonce`, `assertNonceExpirySeconds`).
--
-- ⚠️ Đây là bản D1 của `auth.internal_nonces`
-- (`apps/auth/migrations/0010_internal_nonces.sql`) và `account.internal_nonces`
-- (`apps/account/db/migrations/0003_internal_nonces.sql`). Ba kho tồn tại vì **mỗi service
-- sở hữu database của mình**: một nonce đã chiếm ở `db-auth` KHÔNG bảo vệ được request đến
-- `transactional-mail`, và ngược lại. Nonce là duy nhất theo **từng service nhận**, và mỗi
-- kho do chủ của nó prune.
--
-- ⚠️ BẢN DỊCH SANG D1/SQLite. Hai bản PostgreSQL dùng `timestamptz`, `COMMENT ON`,
-- `GRANT`/`REVOKE` và schema có tên (`auth.`, `account.`) — D1 không có ba thứ đó, nên file
-- này viết lại toàn bộ theo phong cách của `apps/transactional-mailer-job/migrations/`
-- (epoch-ms INTEGER, constraint có tên). Quyết định giữ nguyên, chỉ đổi cách biểu diễn.
--
-- ⚠️ KHOÁ LÀ `(principal, nonce)`, KHÔNG PHẢI `nonce` (§7.4). `claimNonce` chỉ chạy sau khi
-- chữ ký đã hợp lệ, và vòng duyệt credential biết candidate nào vừa khớp, nên callback
-- truyền cho mỗi candidate bind theo principal của candidate đó. Nếu khoá chỉ là `nonce`,
-- một consumer giữ credential hợp lệ có thể ký envelope hợp lệ dưới key của mình với nonce
-- lấy từ log của consumer khác rồi "đốt" nonce đó — biến claim của principal A thành hiệu
-- lực chặn principal B (từ chối dịch vụ chéo-principal). Tách khoá là lớp phòng vệ duy nhất
-- cho đúng nhánh đó.
--
-- ⚠️ `expires_at` neo theo **timestamp của envelope** (`timestamp + skew +
-- NONCE_TTL_BUFFER_SECONDS`), không theo đồng hồ của receiver (§7.4). Neo `now` thì trôi:
-- `now` có thể chậm hơn timestamp tới trọn một skew, và khi đó nonce hết hạn TRƯỚC khi
-- envelope thôi phát lại được — mở cửa sổ replay thay vì đóng. Hằng số đó là hằng của giao
-- thức, không phải tuỳ chọn vận hành.
--
-- ⚠️ Hợp đồng của `claimNonce` là "kiểm tra VÀ ghi", không chỉ "kiểm tra": `INSERT … ON
-- CONFLICT DO NOTHING` rồi đếm số hàng trả về, một câu lệnh nên hai request mang cùng nonce
-- chỉ một cái thắng. Cài bằng `SELECT` rồi `INSERT` ở câu khác sẽ mất đúng tính chất này
-- dưới tải đồng thời.
--
-- ⚠️ Không có `DEFAULT` trên `expires_at`: thời điểm hết hạn là dữ liệu do **gọi bên tính ra
-- từ envelope**, để database tự điền sẽ biến nonce sống mãi và replay guard vô hiệu hoá.
--
-- Không có `UPDATE` trên bảng này. Nới `expires_at` của một nonce đã ghi là nới cửa sổ
-- replay — dữ liệu kiểm soát bảo mật, không được sửa ngang.
--
-- Mọi constraint đều đặt tên theo convention `CONSTRAINT <table>_<rule>_check`.

CREATE TABLE mail_internal_nonces (
  principal TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- `NOT NULL` ở cột là bắt buộc: trên rowid table, `PRIMARY KEY` không kèm `NOT NULL` vẫn
  -- cho NULL, và NULL trong khoá sẽ biến "claim" thành no-op im lặng.
  -- Composite chính là đơn vị claim: cùng nonce dưới hai principal là hai claim độc lập.
  CONSTRAINT mail_internal_nonces_pkey PRIMARY KEY (principal, nonce),

  -- `expires_at` là epoch miligiây UTC — cùng quy ước với mọi cột `*_at` của D1 `mail`
  -- (§4). Giao thức tính bằng epoch giây; repository đổi đơn vị tại một chỗ duy nhất.
  CONSTRAINT mail_internal_nonces_expires_at_check CHECK (expires_at > 0),

  -- Không cho khoá rỗng: principal rỗng nghĩa là claim không còn phạm vi, nonce rỗng nghĩa
  -- là mọi envelope đều đụng nhau.
  CONSTRAINT mail_internal_nonces_principal_non_empty_check CHECK (principal <> ''),
  CONSTRAINT mail_internal_nonces_nonce_non_empty_check CHECK (nonce <> '')
);

-- Đúng một truy vấn đọc bảng này ngoài claim: dọn nonce hết hạn theo lô (§7.4).
-- Không truy vấn nào khác lọc theo `expires_at`, nên index phục vụ riêng câu đó.
--
-- ⚠️ Chưa có prune job. Việc dọn bảng thuộc phạm vi runtime receiver (C2), không phải C1:
-- chưa dọn thì bảng phình theo lưu lượng — phiền về vận hành, KHÔNG làm yếu replay guard,
-- vì một nonce cũ nằm lại vẫn là một nonce đã bị chiếm. C1 chỉ dựng index để câu prune
-- không quét toàn bảng.
CREATE INDEX mail_internal_nonces_expires_at_idx ON mail_internal_nonces (expires_at);
