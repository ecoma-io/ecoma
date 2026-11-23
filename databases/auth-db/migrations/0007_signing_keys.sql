-- 0007_signing_keys.sql — metadata của signing key. KHÔNG private key.
--
-- Phạm vi: `signing_keys`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2, §3.5, §6.5
--          → docs/applications/auth/02-requirements.md FR-023..FR-025, T-13.
--
-- ⚠️⚠️ **BẢNG NÀY KHÔNG BAO GIỜ ĐƯỢC CHỨA PRIVATE KEY.** ⚠️⚠️
--
--    FR-023 nói rõ: `db-auth` lưu **chỉ metadata**; private key không nằm trong database.
--    Lý do cụ thể, không phải lý do chung: `db-auth` là database có thể bị **restore từ
--    backup lên máy mới**, bị đọc qua bản sao, và lọt vào tay một operator có quyền đọc — đó
--    không phải nơi giữ khóa ký (01-architecture.md §3.5).
--
--    Không có cột nào ở đây mang tên hay kiểu dữ liệu có thể chứa key material, và không
--    nên thêm. Đừng "tiện tay" thêm cột `private_key` rồi khoá bằng mật khẩu của bạn: một
--    cột tồn tại là một cột sẽ bị restore, backup và đọc.
--
--    Custody cụ thể (primitive nào trên Workers, lưu ở đâu, lịch xoay) là **quyết định chưa
--    chốt** — 01-architecture.md §9, auth 03-operations.md §4. Migration này chỉ tạo chỗ
--    ghi metadata, không chốt cách giữ private key.
--
-- ⚠️ **Lưu ý về `public_key_jwk`:** JWKS phục vụ **public key** cho client verify token, nên
--    public key được phép ở đây. Nó *không* phải bí mật. Cột này tồn tại để JWKS phục vụ được
--    mà không phải đọc private key.

SET TIME ZONE 'UTC';

CREATE TABLE auth.signing_keys (
    -- `kid` là khoá tra cứu trong JWKS và trong header của token đã ký.
    kid           text        NOT NULL,

    -- Thuật toán ký. Allowlist đóng để chặn `alg` confusion (SR-006, T-15): một hàng có
    -- `HS256` sẽ khiến verifier tưởng public key chính là khoá HMAC.
    algorithm     text        NOT NULL,

    -- ⚠️ PUBLIC key dạng JWK, dùng để dựng JWKS. KHÔNG BAO GIỜ private key.
    public_key_jwk jsonb,

    -- `active`: dùng để ký token mới. `retiring`: đã xoá khỏi JWKS, chỉ còn để verify token
    -- đã cấp. `retired`: hết cửa sổ.
    --
    -- ⚠️ FR-024 bắt buộc **xoá `kid` khỏi JWKS TRƯỚC** khi phát hành bản thay thế. Thứ tự
    --    đó là: `active` → `retiring` (xoá khỏi JWKS) → phát hành key mới (`active`) →
    --    `retiring` → `retired` sau khi mọi token ký bằng key cũ đã hết TTL.
    status        text        NOT NULL DEFAULT 'active',

    -- Khi key bắt đầu được dùng để ký.
    not_before    timestamptz NOT NULL,
    -- Hết hạn. Phải ≥ TTL access token, nếu không token đang sống không verify được
    -- (01-architecture.md §3.5, §6.5).
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),

    -- Mốc thời gian các chuyển trạng thái, để audit vòng đời key.
    retired_at    timestamptz,
    retired_reason text,

    CONSTRAINT signing_keys_pkey PRIMARY KEY (kid),
    CONSTRAINT signing_keys_algorithm_check
        CHECK (algorithm IN ('RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'EdDSA')),

    -- ⚠️ Allowlist **cố ý không có** `none` và không có thuật toán HMAC (`HS*`).
    --    `none` là token không chữ ký; `HS256` dùng public key làm khoá đối xứng. Cả hai đều
    --    là đường giả mạo token không cần private key (T-15).

    CONSTRAINT signing_keys_status_check
        CHECK (status IN ('active', 'retiring', 'retired')),

    -- `retired_at` chỉ tồn tại khi key đã rời `active` — điều kiện tiên quyết của FR-024 là
    -- xoá khỏi JWKS *trước* khi phát hành bản thay thế, và mốc thời gian đó phải kiểm
    -- chứng được.
    CONSTRAINT signing_keys_retired_at_parity_check
        CHECK ((status = 'active') = (retired_at IS NULL)),

    -- Key chưa dùng để ký thì không được sống trước thời điểm hiệu lực; key đã hết hạn thì
    -- không được sống quá hạn. Hai khoảng này không được chồng lấn trên cùng một key.
    CONSTRAINT signing_keys_not_before_check
        CHECK (not_before < expires_at)
);

COMMENT ON TABLE auth.signing_keys IS
    'Signing key metadata. Never contains a private key (FR-023) — db-auth can be restored, backed up and read by operators.';
COMMENT ON COLUMN auth.signing_keys.public_key_jwk IS
    'PUBLIC key in JWK form, used to build the JWKS. Not a secret. A private key must never be written here.';
COMMENT ON COLUMN auth.signing_keys.status IS
    'active = signs new tokens. retiring = removed from the JWKS, still verifies issued tokens. retired = window closed (FR-024).';

-- Tra JWKS: chỉ các key còn dùng để ký.
CREATE INDEX IF NOT EXISTS signing_keys_active_idx
    ON auth.signing_keys (not_before DESC) WHERE status = 'active';
-- Bảo trì vòng đời key: tìm key sắp hết hạn để xoay kịp.
CREATE INDEX IF NOT EXISTS signing_keys_expires_at_idx
    ON auth.signing_keys (expires_at);

-- ⚠️⚠️ **Xoá `kid` khỏi JWKS KHÔNG thu hồi token đã cấp.**
--
--   1. Resource server cache JWKS theo HTTP cache header của chính endpoint đó.
--   2. Sau khi `auth` xoá `kid`, resource server **vẫn verify được** token đã ký bằng key đó
--      cho tới khi cache của nó hết hạn.
--   3. Với token tự chứa (`kid` nằm trong header), có kiểm `kid` còn trong JWKS hay không
--      phụ thuộc còn mạch introspection hay không.
--
--   Vì vậy khi key bị compromise phải làm **cả hai**: (i) chuyển status sang `retiring` để
--   xoá `kid` khỏi JWKS — chặn token **mới**; (ii) ghi `token_revocations` mức toàn
--   subject. ⚠️ Ở mô hình verify offline thì (ii) **không có tác dụng** với resource server,
--   vì nó không hỏi nguồn thu hồi.
--
--   ⚠️ **Thu hồi theo subject KHÔNG phủ token tự ký.** Khi attacker giữ private key, hắn tự
--   ký token với `sub` **bất kỳ** — kể cả một `sub` chưa từng tồn tại. Cách chặn duy nhất là
--   **thay key**, và hiệu lực phụ thuộc cache của verifier (01-architecture.md §6.5,
--   T-14).
--
--   Điều kiện để **tuyên bố** sự cố đã containment — phải thỏa cả hai, không được thỏa một:
--   (i) mọi cache JWKS đã hết hạn hoặc bị purge chủ động, và (ii) token đã cấp hợp lệ đã
--   hết TTL hoặc bị chặn. Runbook → auth 03-operations.md §11.1.