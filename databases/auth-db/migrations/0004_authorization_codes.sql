-- 0004_authorization_codes.sql — code đã phát hành, chỉ đổi lấy token **một lần**.
--
-- Phạm vi: `authorization_codes`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2, §3.3
--          → docs/applications/auth/02-requirements.md FR-006, FR-006a, T-01, T-02.
--
-- ⚠️ Đây là bảng single-use thứ hai, và là nơi rủi ro replay cao nhất: code chảy qua
--    `redirect_uri` nên có thể lọt vào access log, `Referer` và history của trình duyệt.
--    Ba lớp phòng ngừa chồng nhau:
--      1. chỉ lưu **hash** — không có plaintext nào để lấy lại (FR-006a);
--      2. TTL ngắn — cửa sổ replay nhỏ;
--      3. consume bằng compare-and-set **trong database** — không có cửa sổ double-spend.

SET TIME ZONE 'UTC';

CREATE TABLE auth.authorization_codes (
    id        uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- ⚠️ CHỈ hash của code được lưu. Giá trị code đưa tới `redirect_uri` là plaintext và
    --    **không** được ghi vào bất kỳ cột nào ở đây (FR-006a, FR-011a).
    --    UNIQUE: một hash ↔ đúng một code.
    code_hash text        NOT NULL,

    -- Transaction đã sinh ra code này. Code chỉ tồn tại nhờ một transaction, nên đây là
    -- khóa tra cứu tự nhiên khi cần đối chiếu code với transaction gốc.
    -- ⚠️ Kiểu `uuid` phải khớp `authorization_transactions.transaction_id`; PostgreSQL không
    -- implement được FK `text` → `uuid`.
    authorization_transaction_id uuid NOT NULL,

    -- `sub` của subject đã xác thực, opaque, không FK sang db-account.
    sub        text        NOT NULL,
    client_id   text        NOT NULL,
    redirect_uri text       NOT NULL,

    -- PKCE: challenge được **chép lại** từ transaction gốc (01-architecture.md §3.2).
    -- ⚠️ Đây là `code_challenge`, KHÔNG phải `code_verifier` — verifier chỉ tồn tại ở client
    -- và không bao giờ được gửi tới hay lưu ở đây (FR-010a).
    code_challenge        text        NOT NULL,
    code_challenge_method text        NOT NULL DEFAULT 'S256',

    -- Scope được cấp kèm code. Chỉ scope đã nằm trong grant hiệu hành tại thời điểm cấp.
    granted_scopes text[]   NOT NULL DEFAULT ARRAY[]::text[],
    -- `nonce` chép lại từ transaction, đưa vào `id_token` (SR-007).
    nonce text,

    issued_at timestamptz NOT NULL DEFAULT now(),
    -- TTL ngắn — đủ cho một lần đổi code lấy token. Hết hạn ⇒ `invalid_grant`/`invalid_request`,
    -- và người dùng luôn có đường tiếp tục: bắt đầu `/authorize` mới.
    expires_at timestamptz NOT NULL,

    -- ⚠️ **Điều kiện cạnh tranh của CAS consume** — xem câu SQL ở cuối file.
    --    NULL = chưa dùng. Một code chỉ chuyển NULL → giá trị này **đúng một lần**.
    consumed_at timestamptz,
    -- Đánh dấu phía consumer đã nhận row (ví dụ id request của `/token`), phục vụ điều tra
    -- khi phát hiện `codes_reused_total > 0`. KHÔNG phải credential.
    consumed_by text,

    CONSTRAINT authorization_codes_pkey PRIMARY KEY (id),

    -- Tra cứu nóng của `/token`: một lần tra cho mỗi lần đổi code. UNIQUE để một hash
    -- không bao giờ khớp hai code khác nhau.
    CONSTRAINT authorization_codes_code_hash_key UNIQUE (code_hash),

    CONSTRAINT authorization_codes_transaction_fk
        FOREIGN KEY (authorization_transaction_id)
        REFERENCES auth.authorization_transactions (transaction_id) ON DELETE RESTRICT,

    CONSTRAINT authorization_codes_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE RESTRICT,

    -- FR-010: chỉ `S256`; `plain` bị từ chối ở `/authorize` và không được lọt vào đây.
    CONSTRAINT authorization_codes_pkce_method_check
        CHECK (code_challenge_method = 'S256'),

    -- `consumed_at` và `consumed_by` phải đi cùng nhau: có `consumed_by` mà không có
    -- `consumed_at` sẽ là một row đã consume mà không có mốc thời gian — tức là một đường
    -- để né CAS mà không để lại dấu vết thời gian.
    CONSTRAINT authorization_codes_consumed_parity_check
        CHECK ((consumed_at IS NOT NULL) = (consumed_by IS NOT NULL))
);

COMMENT ON TABLE auth.authorization_codes IS
    'Issued code. Stores the hash only (FR-006a); consumption is compare-and-set, so there is no double-spend window (FR-006).';
COMMENT ON COLUMN auth.authorization_codes.code_hash IS
    'Hash of the authorization code. The plaintext code value is NOT stored in any column.';
COMMENT ON COLUMN auth.authorization_codes.code_challenge IS
    'PKCE challenge copied from the originating transaction — NOT the code_verifier (the verifier never reaches db-auth).';

-- Tra theo transaction — dùng khi điều tra `codes_reused_total` và khi reconciliation.
CREATE INDEX IF NOT EXISTS authorization_codes_transaction_idx
    ON auth.authorization_codes (authorization_transaction_id);
-- Tra theo subject — dùng khi thu hồi hàng loạt và khi audit.
CREATE INDEX IF NOT EXISTS authorization_codes_sub_idx
    ON auth.authorization_codes (sub);

-- ---------------------------------------------------------------------------------------------
-- CAS consume code — **MỘT câu lệnh**, đây là SQL để adapter copy nguyên văn.
--
-- ⚠️ `UPDATE … WHERE consumed_at IS NULL` là điều kiện cạnh tranh **trong database**: hai
--    request đồng thời trình cùng một code thì **đúng một** nhận được row, request còn lại
--    nhận **0 row** → `invalid_grant` (FR-006, AC-001, AC-002). Không tồn tại read-then-write
--    nào, nên không có cửa sổ double-spend (01-architecture.md §3.3).
--
-- ⚠️ `expires_at > now()` nằm **trong** cùng câu UPDATE, không phải kiểm tra trước. Tách
--    ra nghĩa là code hết hạn vẫn bị đánh dấu consumed — tức là burn một code vốn đã chết.
--
-- ⚠️ `code_hash` có UNIQUE constraint nên câu này dùng index đó: một lần index lookup, một
--    lần kiểm tra `consumed_at`, một lần `expires_at` — không quét.
-- ---------------------------------------------------------------------------------------------
--
--   UPDATE authorization_codes
--      SET consumed_at = now(),
--          consumed_by = $2          -- định danh phía consumer của `/token`, để điều tra
--    WHERE code_hash    = $1
--      AND consumed_at IS NULL
--      AND expires_at  > now()
--    RETURNING id, authorization_transaction_id, sub, client_id, redirect_uri,
--              code_challenge, code_challenge_method, granted_scopes, nonce;
--
-- ⚠️ Bảy điều phải làm trong **cùng transaction `db-auth`** sau khi câu này trả về 1 row, theo
--    đúng thứ tự (01-architecture.md §3.3, §5.1.2 hàng 9):
--    1. Kiểm `code_verifier` khớp `code_challenge` — ⚠️ verifier **không** được ghi vào
--       database, chỉ so sánh trong bộ nhớ rồi bỏ đi (FR-010a).
--    2. Hỏi trạng thái account qua contract `auth → account`; `suspended`/`deleted`/
--       `not_found`/timeout/5xx đều ⇒ **không** cấp token (fail closed, FR-022d).
--    3. Kiểm grant còn hiệu lực và đủ scope (đọc `oauth_grants` + `client_grant_scopes`).
--    4. Kiểm `token_revocations` — unavailable/unknown **không** được coi là active (FR-017).
--    5. Phát hành access token + refresh token; ghi `refresh_token_families`,
--       `refresh_tokens`, `outbox_events`.
--    6. Ghi `authorization_audit_events`.
--    7. Xoá row của authorization transaction và code theo lô sau (TTL ngắn, xoá hẳn).
--
-- ⚠️ Nếu bất kỳ bước nào ở (2)–(6) lỗi ⇒ rollback ⇒ `consumed_at` được hoàn tác cùng code,
--    và người dùng dùng lại được code trong cửa sổ TTL. Đây là hệ quả **đúng**: code chỉ
--    chết khi token thực sự được cấp, nên không có trạng thái "code đã dùng nhưng không có
--    token nào được cấp".