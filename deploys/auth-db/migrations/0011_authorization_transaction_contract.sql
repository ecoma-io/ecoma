-- 0011_authorization_transaction_contract.sql — thống nhất hợp đồng persistence
-- của `authorization_transactions` với domain/application (C1).
--
-- Phạm vi: kiểu `transaction_id`, CHECK state machine, nullability của
--          `client_state`; đồng bộ kiểu FK của `authorization_codes`,
--          `oauth_consent_decisions` và cột `authorization_audit_events`.
-- Thiết kế → docs/applications/auth/01-architecture.md §5.6 (entropy ≥ 256 bit),
--            §5.1.2 (sáu trạng thái canonical), §5.1.1 (already_processed là
--            OUTCOME của contract back-channel, không phải persisted state).
-- Issue     → #298 (C1), findings #1/#15/#16/#21 của #181.
--
-- ⚠️ Forward-only: file này KHÔNG sửa `0002`/`0004` — chúng đã có trong lịch sử
--    migration và được runner khoá bằng checksum. Mọi thay đổi đi qua đây.
--
-- ============================================================ VÌ SAO FILE NÀY PHẢI NHƯ VẬY ============================================================
-- Domain (`libs/auth-domain/src/transaction.ts`) và schema (`0002`) từng mô tả HAI
-- máy trạng thái khác nhau, và `createOpaqueId()` sinh transaction ID base64url 43 ký tự
-- trong khi cột `transaction_id` là `uuid`. Ba tầng không thể giao tiếp với nhau trên dữ
-- liệu thật: một `beginAuthorization` chạy thật sẽ ném `transaction_id qua ngan` trước cả
-- khi chạm database, và một `confirmBrowser` chạy thật sẽ vi phạm CHECK state. File này
-- đưa schema về đúng mô hình đích của `01-architecture.md` — nguồn sự thật khi các tầng
-- mâu thuẫn.
-- =======================================================================================================================================================

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- Toàn bộ chuyển đổi chạy trong MỘT transaction (BEGIN ... COMMIT cuối file). ⚠️ Bắt buộc:
-- các bước ở giữa (đổi kiểu cột, thay CHECK) mỗi câu là một statement riêng, và psql/những
-- runner không bọc transaction sẽ COMMIT từng câu — một guard vang ở giữa (BƯỚC 0 hoặc guard
-- cuối) sẽ để lại schema LỆCH NỬA ĐƯỜNG: FK đã gỡ chưa gắn lại, cột đã đổi kiểu chưa kịp
-- thay CHECK. Probe đã đo được đúng lỗi này: guard BƯỚC 0 vang nhưng `transaction_id` vẫn
-- kịp thành `text`. Bọc BEGIN/COMMIT biến mọi điểm hỏng thành rollback toàn phần.
--
-- (Lớp thứ hai: runner chuẩn của `db-auth` đã nạp cả file trong một transaction (`psql -1`,
-- xem README §thuật toán) — bọc trong file là defense-in-depth cho đường áp tay bằng psql
-- hoặc runner khác không bảo đảm thuộc tính đó.)
-- ---------------------------------------------------------------------------------------------
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- BƯỚC 0 — Guard fail-closed: từ chối chuyển đổi khi dữ liệu legacy không ánh xạ được.
--
-- Các trạng thái legacy của `0002` (`awaiting_login`, `consent_denied`,
-- `already_processed`) KHÔNG có ánh xạ ngữ nghĩa an toàn sang sáu trạng thái canonical:
--   - `awaiting_login` ≈ `pending_browser`, nhưng không bằng: hàng `awaiting_login` của
--     schema cũ chưa từng có khái niệm browser binding, nên "chưa xác nhận browser" của nó
--     không được chứng minh bằng dữ liệu nào.
--   - `consent_denied` ≈ `denied`, nhưng hàng đó có thể đang mang handle Y/Z theo schema cũ
--     — chuyển đổi mù thì các CHECK phụ thuộc handle Y/Z của state mới không đảm bảo đúng.
--   - `already_processed` theo đúng tài liệu KHÔNG PHẢI persisted state mà là outcome; lưu
--     nó là chính lỗi cần sửa.
-- Gán một terminal state tùy ý hay drop dữ liệu đều là mất dữ liệu âm thầm — vì vậy
-- migration DỪNG với thông báo rõ thay vì đoán. Khi guard này vang: database đã chứa dữ
-- liệu thật của schema cũ, và việc chuyển đổi phải là một quyết định vận hành có kế hoạch
-- cho từng hàng, không phải một chuyển đổi tự động.
--
-- ⚠️ Tập "được phép còn lại" là sáu trạng thái canonical — một database sạch (test, môi
-- trường mới) hoặc database đã từng chạy state mới sẽ đi qua không chạm gì.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    legacy_rows bigint;
BEGIN
    SELECT count(*) INTO legacy_rows
      FROM auth.authorization_transactions
     WHERE state NOT IN (
        'pending_browser',
        'browser_confirmed',
        'awaiting_consent',
        'ready_to_complete',
        'completed',
        'denied'
     );
    IF legacy_rows > 0 THEN
        RAISE EXCEPTION
            'authorization_transactions co % hang mang state legacy khong anh xa duoc an toan sang state machine canonical; can ke hoach chuyen doi tung hang truoc khi ap migration nay',
            legacy_rows
            USING ERRCODE = 'data_exception';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- BƯỚC 1 — Gỡ FK phụ thuộc kiểu `transaction_id` trước khi đổi cột.
--
-- PostgreSQL không cho ALTER COLUMN TYPE trên cột đang bị FK của bảng khác tham chiếu.
-- Thứ tự an toàn: DROP constraint con → đổi kiểu cha → đổi kiểu con → ADD constraint lại.
-- Tên constraint giữ NGUYÊN tên của schema cũ (`authorization_codes_transaction_fk`,
-- `oauth_consent_decisions_transaction_fk`) — tên là một phần của hợp đồng mà sweep và
-- document đã ghi.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_codes
    DROP CONSTRAINT authorization_codes_transaction_fk;

ALTER TABLE auth.oauth_consent_decisions
    DROP CONSTRAINT oauth_consent_decisions_transaction_fk;

-- ---------------------------------------------------------------------------------------------
-- BƯỚC 2 — Đổi kiểu `transaction_id`: `uuid` → `text`.
--
-- §5.6: transaction ID là entropy ngẫu nhiên ≥ 256 bit, sinh MỘT lần khi tạo transaction.
-- `uuid` chỉ mang 122 bit ngẫu nhiên và `gen_random_uuid()` hạ cưỡng bức yêu cầu entropy
-- xuống để vừa schema — đúng thứ cần tránh. Canonical là chuỗi base64url 43 ký tự
-- (32 byte), đúng những gì `createOpaqueId()` sinh và `deriveHandle()` nhận.
--
-- `USING transaction_id::text`: hàng cũ chứa UUID thật (được INSERT bởi test/seed qua
-- DEFAULT `gen_random_uuid()`) được giữ nguyên giá trị dạng chuỗi UUID của nó. Không
-- re-key: `handle_hash_x` là HMAC KHOÁ TRÊN transaction_id cũ — đổi giá trị ID là làm mọi
-- handle đang sống không còn khớp. Giá trị UUID-chuỗi vẫn là text hợp lệ; các hàng đó
-- chết theo TTL của chúng như bình thường.
--
-- ⚠️ `key_version` của hàng cũ vẫn đúng: nó mô tả KHOÁ dùng cho handle, không phụ thuộc
-- việc biểu diễn ID đổi dạng văn bản.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_transactions
    ALTER COLUMN transaction_id SET DEFAULT NULL,
    ALTER COLUMN transaction_id TYPE text USING transaction_id::text,
    ALTER COLUMN transaction_id DROP DEFAULT;

-- Các bảng con: cùng phép đổi kiểu, cùng giữ nguyên giá trị.
ALTER TABLE auth.authorization_codes
    ALTER COLUMN authorization_transaction_id TYPE text USING authorization_transaction_id::text;

ALTER TABLE auth.oauth_consent_decisions
    ALTER COLUMN authorization_transaction_id TYPE text USING authorization_transaction_id::text;

-- `authorization_audit_events.authorization_transaction_id` KHÔNG có FK (audit chỉ tham
-- chiếu dữ kiện đã xảy ra) nhưng vẫn mang kiểu `uuid` từ `0008` — đổi theo để một INSERT
-- audit cho transaction ID dạng base64url không bị lỗi kiểu. `authorization_code_id`
-- GIỮ NGUYÊN `uuid`: `authorization_codes.id` (0004) vẫn là `uuid DEFAULT gen_random_uuid()`,
-- hai cột phải cùng kiểu mới đối chiếu được. Bảng append-only; đổi kiểu cột không sửa
-- nội dung hàng nào.
ALTER TABLE auth.authorization_audit_events
    ALTER COLUMN authorization_transaction_id TYPE text USING authorization_transaction_id::text;

-- ---------------------------------------------------------------------------------------------
-- BƯỚC 3 — Thay CHECK state machine bằng tập canonical.
--
-- Tập mới là ĐÚNG sáu trạng thái của `AuthorizationTransactionState` (domain) và bảng
-- §5.1.2. Khác biệt mấu chốt so với tập cũ:
--   - `pending_browser` + `browser_confirmed` xuất hiện (schema cũ không có).
--   - `awaiting_login` + `consent_denied` biến mất.
--   - `already_processed` biến mất VĨNH VIỄN: nó là OUTCOME của contract
--     `/internal/session/verified` (§5.1.1, §5.1.2 hàng 13), không phải một giá trị của
--     cột `state`. Comment của `0002` gọi nó là "terminal idempotent" — ghi chú đó mô tả
--     một nhánh HTTP, không phải một hàng database.
-- Bước 0 đã bảo đảm không còn hàng nào mang tên legacy, nên việc thay CHECK không kẹt
-- hàng nào.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_transactions
    DROP CONSTRAINT authorization_transactions_state_check;

ALTER TABLE auth.authorization_transactions
    ADD CONSTRAINT authorization_transactions_state_check
        CHECK (state IN (
            'pending_browser',     -- /authorize xong, chờ browser confirm (§5.1.2 hàng 1)
            'browser_confirmed',   -- cookie __Host-auth-browser khớp (hàng 2)
            'awaiting_consent',    -- đã biết danh tính, chờ quyết định consent (hàng 3)
            'ready_to_complete',   -- sẵn sàng sinh code (hàng 4/7)
            'completed',           -- code đã sinh; terminal (hàng 9)
            'denied'               -- từ chối; terminal (hàng 8/10)
        ));

-- ---------------------------------------------------------------------------------------------
-- BƯỚC 4 — `client_state` cho phép NULL: OAuth `state` là optional (RFC 6749 §4.1.1).
--
-- `0002` khai `client_state text NOT NULL` — mọi `/authorize` hợp lệ không gửi `state`
-- sẽ bị DB từ chối, đúng bug #1 của #181. NULL là cách biểu diễn "client không gửi";
-- tầng application ném lỗi `directInvalidRequest` cho giá trị vượt trần 512 byte
-- (FR giới hạn tham số optional), nên DB không cần CHECK độ dài riêng.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_transactions
    ALTER COLUMN client_state DROP NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- BƯỚC 5 — Khôi phục FK (đổi kiểu xong cả hai phía) và index của bảng con.
--
-- FK và index phụ thuộc cột bị ALTER đã được PostgreSQL tự drop khi đổi kiểu; phần index
-- do migration tạo riêng phải dựng lại bằng đúng tên cũ. Index `authorization_codes_*`
-- có `IF NOT EXISTS` đúng quy ước README; phần còn lại là constraint có tên, được ADD lại
-- nguyên tên.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE auth.authorization_codes
    ADD CONSTRAINT authorization_codes_transaction_fk
        FOREIGN KEY (authorization_transaction_id)
        REFERENCES auth.authorization_transactions (transaction_id) ON DELETE RESTRICT;

ALTER TABLE auth.oauth_consent_decisions
    ADD CONSTRAINT oauth_consent_decisions_transaction_fk
        FOREIGN KEY (authorization_transaction_id)
        REFERENCES auth.authorization_transactions (transaction_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS authorization_codes_transaction_idx
    ON auth.authorization_codes (authorization_transaction_id);

CREATE INDEX IF NOT EXISTS oauth_consent_decisions_transaction_idx
    ON auth.oauth_consent_decisions (authorization_transaction_id);

CREATE INDEX IF NOT EXISTS authorization_audit_events_transaction_idx
    ON auth.authorization_audit_events (authorization_transaction_id)
    WHERE authorization_transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Kiểm lại bất biến sau chuyển đổi — đề phòng ALTER âm thầm đổi một thứ khác.
-- Guard cuối: nếu bất kỳ assertion nào sai, migration DỪNG thay vì để lại schema lệch.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'auth'
           AND table_name = 'authorization_transactions'
           AND column_name = 'transaction_id'
           AND data_type = 'text'
    ) THEN
        RAISE EXCEPTION 'transaction_id phai la text sau migration'
            USING ERRCODE = 'data_exception';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'auth'
           AND table_name = 'authorization_transactions'
           AND column_name = 'client_state'
           AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION 'client_state phai cho phep NULL sau migration'
            USING ERRCODE = 'data_exception';
    END IF;
END
$$;

COMMENT ON COLUMN auth.authorization_transactions.transaction_id IS
    '43-character base64url string (32 bytes, entropy >= 256 bits per 01-architecture.md §5.6). Legacy rows from 0002 keep UUID-string values — not re-keyed because handles X/Y/Z are HMACs over the original ID.';
COMMENT ON COLUMN auth.authorization_transactions.state IS
    'The six canonical states of the §5.1.2 state machine. `already_processed` is NOT a state — it is an outcome of the /internal/session/verified contract (§5.1.1).';
COMMENT ON COLUMN auth.authorization_transactions.client_state IS
    'The client''s `state` (RFC 6749 §4.1.1) — optional, NULL when the client does not send it. Unrelated to the `state` column of the state machine.';

COMMIT;
