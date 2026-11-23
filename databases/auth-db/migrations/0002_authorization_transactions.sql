-- 0002_authorization_transactions.sql — bảng trung tâm của protocol.
--
-- Phạm vi: `authorization_transactions`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.3 (mô hình dữ liệu), §5.1.2 (máy trạng thái),
--            §5.5 (handle Y), §5.6 (derivation HMAC).
-- Yêu cầu   → FR-005..FR-009z.
--
-- Xem khối "QUY ƯỚC" ở đầu `0001_schema_and_oauth_clients.sql` cho các bất biến dùng chung.
--
-- ============================================================ VÌ SAO BẢNG NÀY PHẢI NHƯ VẬY ============================================================
-- Đây là bảng **single-use** lớn nhất của service. Mỗi authorization transaction đi qua một
-- chuỗi handle X → Y → Z; mỗi bước tiêu thụ bằng **một câu UPDATE duy nhất**. Ba điều kiện
-- dưới đây là toàn bộ cơ chế chống replay, và cả ba đều phải nằm **trong cùng một câu lệnh**:
--
--   1. `*_consumed_at IS NULL`  → chưa ai tiêu thụ (mỗi handle dùng đúng một lần).
--   2. `expires_at > now()`     → chưa hết hạn (đánh giá ở thời điểm `UPDATE`, không phải lúc đọc).
--   3. Các cột trạng thái đi kèm (ví dụ `browser_confirmed_at IS NOT NULL`) → trạng thái nền
--      đã đúng.
--
-- Tách thành `SELECT` rồi `UPDATE` là **sai về mặt bảo mật**: hai request song song cùng đọc
-- thấy "chưa tiêu thụ" rồi cùng `UPDATE`, và cả hai đều thành công — double-spend. Toàn bộ
-- lý do dùng `UPDATE … RETURNING` một lệnh là để điều kiện và hành động được đánh giá trong
-- cùng một snapshot, không có khe hở.
-- =======================================================================================================================

SET TIME ZONE 'UTC';

CREATE TABLE auth.authorization_transactions (
    -- Khóa chính của transaction. Đây là giá trị mà cả ba handle X/Y/Z đều bắt nguồn từ
    -- (`01-architecture.md` §5.6): `HMAC-SHA-256(K_auth, domain ‖ transaction_id ‖ purpose)`.
    -- Nhờ vậy một handle không chứa được thông tin nào suy ra được từ giao dịch nó mở ra.
    transaction_id         uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- ───────────────────────────── HANDLE X (bàn giao login) ─────────────────────────────
    -- Hash của handle X. Chỉ hash được lưu; bản thân handle chỉ tồn tại trong URL và trong
    -- cookie `__Host-auth-browser` của trình duyệt (SR-006).
    handle_hash_x          bytea       NOT NULL,
    -- Khoánh khắc X bị tiêu thụ. Cột này tồn tại để CAS có điều kiện "chưa tiêu thụ" và để
    -- chẩn đoán replay; giá trị được viết bởi chính câu CAS ở cuối file này.
    handle_x_consumed_at   timestamptz,
    -- Phiên bản khóa HMAC dùng để tính `handle_hash_x`. Lưu lại để khi cần kiểm tra lại một
    -- handle cũ trong lúc rotation, biết phải dùng khóa nào — tránh việc "thử từng khóa"
    -- trở thành đường tấn công oracle (FR-006a).
    key_version            integer     NOT NULL,

    -- ───────────────────── LIÊN KẾT TRÌNH DUYỆT (không phải session của account) ─────────────────────
    -- Hash của giá trị cookie `__Host-auth-browser`. Đây KHÔNG phải session của `db-account`:
    -- nó chỉ ràng buộc "cùng một trình duyệt", không xác thực danh tính (NFR-002).
    browser_binding_hash   bytea       NOT NULL,
    -- Đặt bởi `account` trong `auth → account` status contract (`01-architecture.md` §6.0).
    -- NULL nghĩa là chưa xác nhận trình duyệt → handle X **không** được tiêu thụ.
    browser_confirmed_at   timestamptz,

    -- ───────────────────────────── YÊU CẦU CỦA CLIENT ─────────────────────────────
    client_id              text        NOT NULL,
    -- Đã chốt ở thời điểm `/authorize`: sau đó không đổi được, nên khi `/token` sinh code nó
    -- được đối chiếu với URI đã đăng ký mà không phải đọc lại điều chỉnh của client.
    redirect_uri           text        NOT NULL,
    requested_scopes       text[]      NOT NULL,
    -- ⚠️ `client_state` KHÔNG phải `state` của máy trạng thái ở cuối bảng.
    --
    --    Hai cột này trùng tên và **không** liên quan: `client_state` là token CSRF mà
    --    client tự sinh và phải nhận lại nguyên vẹn (FR-007); `state` dưới kia là trạng thái
    --    nội bộ của `auth`. Trùng tên sẽ khiến `RETURNING state` trong câu CAS âm thầm trả về
    --    cột không phải cái người gọi nghĩ — nên tách tên ngay từ schema.
    client_state           text        NOT NULL,
    nonce                  text,
    -- PKCE. `code_challenge_method` bị ràng buộc cứng `'S256'` — `plain` bị từ chối
    -- (FR-008a; SR-002). Ràng buộc ở tầng schema nghĩa là không có đường nào để lưu PKCE
    -- không phải S256, kể cả do một câu `INSERT` của service khác.
    code_challenge         text        NOT NULL,
    code_challenge_method  text        NOT NULL,

    -- ───────────────────────────── DANH TÍCH (opaque, không FK) ─────────────────────────────
    -- Giá trị danh tính do `account` cấp. **Không** có referential integrity sang
    -- `db-account` (NFR-002b): xoá user ở `db-account` không được làm hỏng hàng đây, và
    -- `db-auth` không được biết schema của `db-account`.
    sub                    text,
    -- Mức xác thực lúc `/authorize`, dùng để chọn bước tiếp theo của máy trạng thái.
    -- ⚠️ Tập giá trị phải khớp `AUTHN_LEVELS` ở `libs/account-domain` (nguồn sự thật dùng
    -- chung). `db-account` chưa được provision (issue #83), nên ràng buộc toàn vẹn giữa hai
    -- bên chưa có — xem README §"Ràng buộc liên service chưa có".
    authn_level            text,
    authn_at               timestamptz,
    -- Tham chiếu session của `account`, để `auth` không phải gọi lại `account` ở bước `/token`.
    -- Vẫn là tham chiếu opaque.
    account_session_ref    text,

    -- ────────────── KẾT QUẢ SỰ KIỆN LOGIN TỪ `account` (idempotent) ──────────────
    -- NFR-006: `auth` đăng ký mỗi event đúng một lần. Bốn cột này hoặc cùng NULL, hoặc cùng
    -- được điền — CHECK "all-or-none" bên dưới chặn trạng thái nửa vời.
    event_id               text,
    event_payload_hash     bytea,
    event_outcome          text,
    event_processed_at     timestamptz,

    -- ───────────────────────────── HANDLE Y (nối tiếp consent) ─────────────────────────────
    -- Sinh khi transaction đã biết danh tính và chỉ cần quyết định consent. Chỉ hash lưu.
    handle_hash_y          bytea,
    handle_y_consumed_at   timestamptz,

    -- ───────────────────────────── HANDLE Z (hoàn tất) ─────────────────────────────
    -- Sinh sau khi consent được ghi nhận, mang thông tin cần để `/token` sinh authorization
    -- code mà không đọc lại transaction qua đường khác.
    handle_hash_z          bytea,
    handle_z_consumed_at   timestamptz,
    -- Khóa HMAC đã dùng cho `handle_hash_z`, để `/token` xác minh bằng đúng khóa đó.
    handle_z_key_version   integer,

    -- ───────────────────────────── MÁY TRẠNG THÁI ─────────────────────────────
    -- Sáu trạng thái theo `01-architecture.md` §5.1.2. Giá trị chỉ có ý nghĩa cùng nhau với
    -- các cột trạng thái khác; các CHECK bên dưới ghim các kết hợp hợp lệ.
    --
    -- ⚠️ Cột này tên `state` — KHÔNG phải `client_state` ở trên. `RETURNING state` trong
    --    các câu CAS ở cuối file trả về **đúng cột này**; xem chú thích tại CAS 1 về việc
    --    `UPDATE … RETURNING` trả giá trị cũ cho cột không nằm trong `SET`.
    state                  text        NOT NULL,

    created_at             timestamptz NOT NULL DEFAULT now(),
    expires_at             timestamptz NOT NULL,

    CONSTRAINT authorization_transactions_pkey PRIMARY KEY (transaction_id),

    -- FR-008a / SR-002: chỉ S256.
    CONSTRAINT authorization_transactions_code_challenge_method_check
        CHECK (code_challenge_method = 'S256'),

    CONSTRAINT authorization_transactions_state_check
        CHECK (state IN (
            'awaiting_login',          -- /authorize xong, chờ account xác nhận danh tính
            'awaiting_consent',        -- đã biết danh tính, chờ quyết định consent
            'ready_to_complete',       -- đã có grant, sẵn sàng sinh code
            'completed',               -- code đã sinh
            'consent_denied',          -- client hoặc user từ chối consent
            'already_processed'        -- terminal idempotent: handle đã dùng hết (FR-008f)
        )),

    -- ⚠️ Danh sách này phải khớp `AUTHN_LEVELS` (`libs/account-domain/src/authn-level.ts`).
    CONSTRAINT authorization_transactions_authn_level_check
        CHECK (authn_level IS NULL OR authn_level IN ('anonymous', 'password', 'totp', 'passkey')),

    -- NFR-006 all-or-none: nếu event đã được xử lý thì cả bốn cột phải có giá trị; nếu chưa
    -- thì cả bốn phải NULL. CHECK này chặn hàng bị ghi dở (ví dụ có `event_id` nhưng chưa có
    -- `event_payload_hash`), tức là chặn idempotency dựa trên một dữ liệu chỉ nửa vời.
    CONSTRAINT authorization_transactions_event_all_or_none_check
        CHECK (
            (event_id IS NULL AND event_payload_hash IS NULL
                AND event_outcome IS NULL AND event_processed_at IS NULL)
            OR
            (event_id IS NOT NULL AND event_payload_hash IS NOT NULL
                AND event_outcome IS NOT NULL AND event_processed_at IS NOT NULL)
        ),

    CONSTRAINT authorization_transactions_event_outcome_check
        CHECK (event_outcome IS NULL OR event_outcome IN ('success', 'failure', 'error')),

    -- Danh tính phải **đủ bộ**: có `sub` thì phải có `authn_level` và `authn_at`.
    --
    -- ⚠️ Đây là invariant của *quy trình*, không phải của bảng: `sub` không được đặt trước
    --    khi `account` đã xác nhận trình duyệt. Không có cách nào buộc thứ tự ghi bằng
    --    CHECK (PostgreSQL không có assertion trigger sẵn có có sẵn), nên nó được ghim vào
    --    chính câu CAS 1 ở cuối file: câu đó **viết** `sub` và **đồng thời đòi**
    --    `browser_confirmed_at IS NOT NULL`, nên không có đường nào ghi danh tính mà chưa
    --    xác nhận trình duyệt.
    CONSTRAINT authorization_transactions_identity_is_complete_check
        CHECK (
            sub IS NULL
            OR (authn_level IS NOT NULL AND authn_at IS NOT NULL)
        ),

    CONSTRAINT authorization_transactions_key_version_check
        CHECK (key_version > 0),

    -- Trạng thái `awaiting_consent` **phải** có handle Y: đó là điều kiện để `/authorize`
    -- redirect về consent URL. Nếu không ràng buộc, một bug có thể tạo ra transaction mà
    -- không sinh được URL nào để trả về user.
    CONSTRAINT authorization_transactions_handle_y_state_check
        CHECK (
            state <> 'awaiting_consent'
            OR (handle_hash_y IS NOT NULL AND handle_y_consumed_at IS NULL)
        ),

    -- Trạng thái `ready_to_complete` **phải** có handle Z chưa tiêu thụ: `/authorize` trả
    -- `code_verifier` cho user, và Z là thứ mang nó về `/token`.
    CONSTRAINT authorization_transactions_handle_z_state_check
        CHECK (
            state <> 'ready_to_complete'
            OR (handle_hash_z IS NOT NULL AND handle_z_consumed_at IS NULL)
        ),

    CONSTRAINT authorization_transactions_expires_after_created_check
        CHECK (expires_at > created_at),

    CONSTRAINT authorization_transactions_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE RESTRICT
);

COMMENT ON TABLE auth.authorization_transactions IS
    'Transaction of one authorization_code flow. Each handle X/Y/Z is consumed exactly once via UPDATE ... WHERE handle IS NOT consumed ... RETURNING (01-architecture.md §5.1.2).';

COMMENT ON COLUMN auth.authorization_transactions.sub IS
    'Identity handle issued by account. Opaque: no foreign key into db-account (NFR-002b).';
COMMENT ON COLUMN auth.authorization_transactions.browser_binding_hash IS
    'Hash of the __Host-auth-browser cookie. Binds "same browser" only, NOT the account session (NFR-002).';
COMMENT ON COLUMN auth.authorization_transactions.event_id IS
    'event_id already processed, the idempotency key of account -> auth events (NFR-006).';
COMMENT ON COLUMN auth.authorization_transactions.code_challenge_method IS
    'Always "S256". plain is rejected at the schema layer (FR-008a, SR-002).';
COMMENT ON COLUMN auth.authorization_transactions.browser_confirmed_at IS
    'Set by account through the auth -> account status contract. NULL = browser not yet confirmed, so handle X has not been consumed.';

-- ==============================================================================================
-- INDEX — chỉ những index gắn với một truy vấn hoặc ràng buộc cụ thể.
--
-- Nguyên tắc của `docs/applications/account/01-architecture.md`: "every index must be tied to a
-- specific query or constraint — no 'just in case' indexes". Vì vậy mỗi index dưới đây đều
-- ghi rõ truy vấn nào dùng nó.
-- ==============================================================================================

-- CAS 1: `WHERE handle_hash_x = $1 AND handle_x_consumed_at IS NULL AND expires_at > now()`.
-- Partial unique index đóng hai việc: nằm trên đúng tập hàng mà CAS quét, và chặn hai
-- transaction sinh ra cùng một handle X (hash của một transaction_id+purpose là xác định,
-- nên trùng hash = sinh trùng transaction).
CREATE UNIQUE INDEX IF NOT EXISTS authorization_transactions_handle_x_uniq
    ON auth.authorization_transactions (handle_hash_x)
    WHERE handle_x_consumed_at IS NULL;

-- CAS 2: `WHERE handle_hash_y = $1 AND handle_y_consumed_at IS NULL AND expires_at > now()`.
CREATE UNIQUE INDEX IF NOT EXISTS authorization_transactions_handle_y_uniq
    ON auth.authorization_transactions (handle_hash_y)
    WHERE handle_y_consumed_at IS NULL;

-- CAS 3: `WHERE handle_hash_z = $1 AND handle_z_consumed_at IS NULL AND expires_at > now()`.
CREATE UNIQUE INDEX IF NOT EXISTS authorization_transactions_handle_z_uniq
    ON auth.authorization_transactions (handle_hash_z)
    WHERE handle_z_consumed_at IS NULL;

-- Idempotency event (NFR-006): `WHERE event_id = $1` khi account gửi event cho một
-- transaction đã xử lý. Unique partial (chỉ event đã xử lý) vừa là index tra cứu, vừa
-- chặn xử lý trùng.
CREATE UNIQUE INDEX IF NOT EXISTS authorization_transactions_event_id_uniq
    ON auth.authorization_transactions (event_id)
    WHERE event_id IS NOT NULL;

-- Liệt kê transaction theo danh tính: `WHERE sub = $1`.
CREATE INDEX IF NOT EXISTS authorization_transactions_sub_idx
    ON auth.authorization_transactions (sub)
    WHERE sub IS NOT NULL;

-- Dọn dẹp hàng hết hạn: `WHERE expires_at < now()` trong batch.
CREATE INDEX IF NOT EXISTS authorization_transactions_expires_at_idx
    ON auth.authorization_transactions (expires_at);

-- Liệt kê theo cả danh tính lẫn trạng thái: `WHERE sub = $1 AND state = $2`
-- (ví dụ "giao dịch đang chờ consent của tôi").
CREATE INDEX IF NOT EXISTS authorization_transactions_sub_state_idx
    ON auth.authorization_transactions (sub, state)
    WHERE sub IS NOT NULL;

-- Liệt kê transaction theo client: `WHERE client_id = $1 ORDER BY created_at DESC`.
CREATE INDEX IF NOT EXISTS authorization_transactions_client_idx
    ON auth.authorization_transactions (client_id, created_at DESC);

-- ==============================================================================================
-- CÁC CÂU CAS — SAO CHÉP NGUYÊN VĂN, KHÔNG SỬA.
--
-- Ba câu dưới đây là **hợp đồng** giữa schema và adapter. Chúng nằm ở đây dưới dạng comment
-- để adapter copy nguyên văn, nên chỉ được sửa khi có issue mở rộng chuỗi hạn chứa cả thay
-- đổi adapter.
-- ==============================================================================================

-- ---------------------------------------------------------------------------------------------
-- CAS 1 — Tiêu thụ handle X (bàn giao login), đồng thời ghi danh tính.
--
-- Câu này gộp "tiêu thụ" và "ghi danh tính" là cố ý: tách thành hai câu sẽ có khoảnh khắc
-- transaction đã tiêu thụ X nhưng chưa ghi `sub`, và không đường nào phục hồi được.
--
-- `browser_confirmed_at IS NOT NULL` là điều kiện **quan trọng nhất** trong câu này: nó biến
-- handle X từ "bằng chứng URL đúng" thành "bằng chứng `account` đã xác nhận đúng trình duyệt
-- này".
--
-- ⚠️ **Về `RETURNING state`:** PostgreSQL trả về **giá trị MỚI** cho cột nằm trong `SET`, và
--    **giá trị CŨ** cho cột không có trong `SET`. `state` không nằm trong `SET`, nên nó trả
--    về trạng thái **trước** khi chuyển. Đó chính là thứ cần cho hàng 13 của máy trạng thái
--    (`01-architecture.md` §5.1.2): giá trị cũ là `already_processed` thì đây là lần tiêu
--    thụ lặp, và `auth` trả lỗi idempotent thay vì xử lý lại.
-- ---------------------------------------------------------------------------------------------
--   UPDATE auth.authorization_transactions
--      SET handle_x_consumed_at = now(),
--          sub                   = $2,
--          authn_level           = $3,
--          authn_at              = $4,
--          account_session_ref   = $5
--    WHERE handle_hash_x        = $1
--      AND handle_x_consumed_at IS NULL
--      AND browser_confirmed_at IS NOT NULL
--      AND expires_at           > now()
--    RETURNING transaction_id, state, expires_at;
--
--  → 1 hàng : X hợp lệ, lần đầu. `state` là trạng thái trước khi chuyển.
--  → 0 hàng : X đã dùng, hết hạn, hoặc account chưa xác nhận trình duyệt. Cả ba đều là
--              "không tiếp tục"; câu này cố ý không phân biệt lý do.

-- ---------------------------------------------------------------------------------------------
-- CAS 2 — Tiêu thụ handle Y (nối tiếp consent), sinh handle Z.
--
-- `account_session_ref = $4 AND sub = $5` là ràng buộc phiên: handle Y nằm trong URL mà
-- `auth` tự redirect tới, nên nó có thể lọt sang người khác (referer leak, lịch sử trình
-- duyệt, link bị sao chép). Yêu cầu phiên phải khớp đảm bảo handle Y chỉ dùng được bởi phiên
-- đã sở hữu transaction đó.
--
-- ⚠️ `state` **có** nằm trong `SET`, nên `RETURNING state` trả **giá trị mới**
--    (`ready_to_complete`). Nếu adapter cần trạng thái trước đó thì phải đọc trước câu này —
--    trong transaction đang mở, lệnh đọc trước vẫn thấy trạng thái cũ.
-- ---------------------------------------------------------------------------------------------
--   UPDATE auth.authorization_transactions
--      SET handle_y_consumed_at = now(),
--          state                = 'ready_to_complete',
--          handle_hash_z        = $2,
--          handle_z_key_version = $3,
--          handle_z_consumed_at = NULL
--    WHERE handle_hash_y        = $1
--      AND handle_y_consumed_at IS NULL
--      AND expires_at           > now()
--      AND account_session_ref  = $4
--      AND sub                  = $5
--    RETURNING transaction_id, sub, client_id, redirect_uri, requested_scopes,
--              code_challenge, state;
--
--  → 1 hàng : Y hợp lệ trong đúng phiên này.
--  → 0 hàng : Y đã dùng, hết hạn, hoặc handle Y lọt sang phiên khác.

-- ---------------------------------------------------------------------------------------------
-- CAS 3 — Tiêu thụ handle Z (hoàn tất), sinh authorization code.
--
-- Trả về `code_challenge` **cùng** `code_challenge_method` để `/token` đối chiếu PKCE với
-- `code_verifier` mà user gửi lên. Trả cả `nonce` vì OIDC back-channel `id_token` sẽ nhúng
-- nó. `handle_z_key_version` để adapter biết dùng khóa HMAC nào khi băm lại `code_verifier`.
-- ---------------------------------------------------------------------------------------------
--   UPDATE auth.authorization_transactions
--      SET handle_z_consumed_at = now(),
--          state                = $2
--    WHERE handle_hash_z        = $1
--      AND handle_z_consumed_at IS NULL
--      AND expires_at           > now()
--    RETURNING transaction_id, sub, account_session_ref, client_id, redirect_uri,
--              requested_scopes, state, nonce, code_challenge, code_challenge_method,
--              handle_z_key_version;
--
--  → 1 hàng : Z hợp lệ, lần đầu. Giá trị `state` truyền vào là `completed` (FR-008g).
--  → 0 hàng : Z đã dùng hoặc hết hạn.
--
-- ⚠️ **Thứ tự bắt buộc sau CAS 3, trong CÙNG transaction:**
--   1. INSERT `auth.oauth_grants` — chỉ khi `requested_scopes` khác grant hiện hành. Grant
--      hiện hành thuộc về `oauth_grants` (file 0003), KHÔNG thuộc transaction.
--   2. INSERT `auth.authorization_codes` — sinh code, chỉ lưu `code_hash`. (CAS của bảng
--      này ở file 0004.)
--   3. INSERT `auth.authorization_audit_events` — file 0008.
--   4. COMMIT.
--    Gộp `2` vào trước `1` là sai về hình thức: hai hàng này độc lập, nhưng
--    `oauth_grants` là điều kiện để `authorization_codes` có ý nghĩa — code mà không có
--    grant sẽ đổi được access token rỗng.