-- 0006_token_revocations.sql — revocation control plane.
--
-- Phạm vi: `token_revocations`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2, §6.4, §6.5
--          → docs/applications/auth/02-requirements.md FR-017..FR-022, FR-024b.
--
-- ⚠️ **Đây là control plane thu hồi DUY NHẤT** (FR-017a). Không có nguồn sự thật thứ hai cho
--    trạng thái thu hồi: `oauth_grants.status`, `refresh_token_families.status` và
--    `refresh_tokens.revoked_at` là trạng thái **thực thi**, không thay thế control plane này.
--
-- ⚠️ Bảng này là **append-only**. Không có đường UPDATE hay DELETE nào trên nó ở phía
--    runtime; xem file 0009 (grant quyền).
--
-- ⚠️ **Phân biệt bắt buộc — đọc trước khi dùng:**
--   Ghi một dòng ở đây **không** làm token đã cấp mất hiệu lực.
--   • Trong mô hình verify offline (chưa chốt — 01-architecture.md §6.2/§9): resource server
--     **không hỏi** nguồn thu hồi này, nên token đã cấp vẫn được chấp nhận tới hết TTL. Thứ
--     mà ghi ở đây đạt được là: `auth` **không cấp token mới**, và có đường truy vết cho
--     reconciliation.
--   • Chỉ ở verifier **thực sự hỏi** nguồn thu hồi (mức introspection) thì nó mới có tác
--     dụng với token đã cấp.
--   Nói "đã thu hồi token" cho mô hình offline là **sai** (SR-017c, FR-017c, §6.2).

SET TIME ZONE 'UTC';

CREATE TABLE auth.token_revocations (
    id        uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- ---------- Phạm vi thu hồi — ba mức của §6.4 ----------
    -- `subject`: mọi token của `sub`, mọi client (ví dụ: account bị suspend hoặc xoá).
    -- `client`: `sub` + `client_id` (ví dụ: user thu hồi một app trong Connected applications).
    -- `token`: một grant hoặc token cụ thể (ví dụ: phát hiện refresh token lộ).
    --
    -- ⚠️ Ba mức lồng nhau theo phạm vi, và **thu hồi mức nhỏ hơn không được xoá bản ghi mức
    --    lớn hơn** (§6.4). Vì bảng append-only nên điều đó là hệ quả tự nhiên của lịch sử, không
    --    phải một ràng buộc phải viết ra.
    level     text        NOT NULL,

    -- Opaque, không FK sang db-account. Ở mức `token`/`grant` có thể NULL vì phạm vi lúc đó
    -- là một grant cụ thể, không gắn với subject.
    subject_ref text,
    client_id   text,
    -- Grant bị thu hồi — chỉ có ở mức `token`/`grant`.
    grant_id    uuid,
    -- Token/refresh token cụ thể — chỉ có ở mức `token`.
    token_hash  text,

    -- Scope bị thu hồi ở mức này. NULL = thu hồi mọi scope của phạm vi.
    revoked_scopes text[],
    revoked_at  timestamptz NOT NULL DEFAULT now(),
    reason      text        NOT NULL,

    -- Nguồn phát hiện: `auth` tự quyết (ví dụ khi phát hiện reuse) hay do event từ `account`
    -- mang sang (01-architecture.md §7).
    source      text        NOT NULL DEFAULT 'auth',

    CONSTRAINT token_revocations_pkey PRIMARY KEY (id),
    CONSTRAINT token_revocations_level_check
        CHECK (level IN ('subject', 'client', 'token')),

    -- Ràng buộc theo mức: mỗi mức bắt buộc đủ trường để **xác định** phạm vi của nó. Nếu
    -- không có các ràng buộc này, một dòng mức `subject` thiếu `subject_ref` sẽ là một
    -- phạm vi rỗng — tức là một lệnh thu hồi không thu hồi gì mà vẫn ghi thành công.
    CONSTRAINT token_revocations_subject_level_shape CHECK (
        level <> 'subject' OR (subject_ref IS NOT NULL AND client_id IS NULL)
    ),
    CONSTRAINT token_revocations_client_level_shape CHECK (
        level <> 'client' OR (subject_ref IS NOT NULL AND client_id IS NOT NULL)
    ),
    CONSTRAINT token_revocations_token_level_shape CHECK (
        level <> 'token' OR (grant_id IS NOT NULL OR token_hash IS NOT NULL)
    ),

    CONSTRAINT token_revocations_source_check
        CHECK (source IN ('auth', 'account_event', 'operator'))
);

COMMENT ON TABLE auth.token_revocations IS
    'The ONLY revocation control plane (FR-017a), append-only. Writing here does NOT invalidate already issued tokens in the offline-verification model — it keeps auth from issuing new tokens and preserves an audit trail.';

-- ---------------------------------------------------------------------------------------------
-- Index — phục vụ **truy vấn kiểm thu hồi tại thời điểm phát hành** (điểm kiểm soát A).
--
-- ⚠️ Truy vấn này chạy ở **mỗi** lần phát hành token, kể cả refresh. Vì vậy nó phải là index
--    lookup, không phải quét bảng.
-- ---------------------------------------------------------------------------------------------

-- Tra cứu chính: "subject này có bản ghi thu hồi nào chạm tới không" — phủ cả ba mức.
CREATE INDEX IF NOT EXISTS token_revocations_subject_ref_idx
    ON auth.token_revocations (subject_ref) WHERE subject_ref IS NOT NULL;

-- "Subject này + client này" — mức thu hồi theo client, và cũng phục vụ Connected
-- applications (user thu hồi một app).
CREATE INDEX IF NOT EXISTS token_revocations_subject_client_idx
    ON auth.token_revocations (subject_ref, client_id)
    WHERE subject_ref IS NOT NULL AND client_id IS NOT NULL;

-- Tra theo grant và theo token hash ở mức `token`.
CREATE INDEX IF NOT EXISTS token_revocations_grant_idx
    ON auth.token_revocations (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS token_revocations_token_hash_idx
    ON auth.token_revocations (token_hash) WHERE token_hash IS NOT NULL;

-- Theo thời điểm: dọn bản ghi cũ theo retention và lập báo cáo thu hồi.
CREATE INDEX IF NOT EXISTS token_revocations_revoked_at_idx
    ON auth.token_revocations (revoked_at);