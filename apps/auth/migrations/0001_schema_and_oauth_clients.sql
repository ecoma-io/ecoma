-- 0001_schema_and_oauth_clients.sql — schema của `db-auth`, và đăng ký client.
--
-- Phạm vi: schema `auth`, `oauth_clients`, `client_redirect_uris`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2
--          → docs/applications/auth/02-requirements.md FR-001..FR-004.
--
-- =============================================================== QUY ƯỚC ==================================
-- Quy ước bất biến cho mọi file trong thư mục này:
--
--   • **Mọi cột thời gian là `timestamptz`** (NFR-001). Kiểu này **lưu** theo UTC và hiển thị
--     theo `TimeZone` của session, nên `SET TIME ZONE 'UTC'` ở đầu mỗi file để mọi biểu
--     thức mặc định (`now()`, `CURRENT_TIMESTAMP`) được đọc trong UTC.
--
--   • **Mọi object được qualify bằng `auth.`**. Lý do không phải thẩm mỹ: Hyperdrive dùng
--     transaction mode pooling, nên `SET` chỉ sống trong transaction/query và bị `RESET`
--     khi connection quay về pool (`04` HD5). `search_path` ràng buộc trong một connection
--     không tồn tại suốt đời connection. Qualify tên là cách duy nhất không phụ thuộc
--     session state.
--
--   • **Mọi handle/token/code chỉ lưu dạng hash.** Không cột nào chứa plaintext
--     authorization code, `code_verifier`, `client_secret`, hay private key
--     (FR-006a, FR-016p, FR-023, SR-001).
--
--   • **`sub` là tham chiếu opaque, KHÔNG foreign key** sang `db-account`
--     (NFR-002b; 01-architecture.md §3.6).
--
--   • **Không `CREATE EXTENSION`.** `gen_random_uuid()` là builtin PostgreSQL 13+ và không
--     cần `pgcrypto`; cài extension vào `db-auth` là mở rộng bề mặt không cần thiết.
--
--   • **Không `IF NOT EXISTS` ăn cắt ý nghĩa.** `CREATE TABLE IF NOT EXISTS` im lặng bỏ qua
--     một bảng đã tồn tại **với schema khác**, nên một lần apply trùng sẽ thành công mà
--     database lại lệch. Vì vậy các câu `CREATE` ở đây **không** kèm `IF NOT EXISTS`; tính
--     re-runnable đến từ việc file chỉ được áp dụng **một lần**, có bảng ghi lịch sử bên
--     ngoài (README §"Vì sao các câu CREATE không kèm IF NOT EXISTS").
-- ============================================================== QUY ƯỚC ==================================

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- Schema `auth`.
--
-- ⚠️ **Vì sao không dùng schema `public`.** Trên PostgreSQL 15+ `PUBLIC` **không** còn quyền
--    `CREATE` trên schema `public`, và bản vá của Cloudflare là PostgreSQL 17+ (`04` HD1).
--    Hệ quả trực tiếp: một role không phải owner của database **không tạo được** bảng trong
--    `public` — đây không phải lựa chọn thiết kế mà là điều PostgreSQL bắt buộc. Schema riêng
--    `auth` vừa làm schema của service rõ ràng, vừa cho `REVOKE` chi tiết hơn: runtime chỉ
--    cần `USAGE` trên `auth`, không cần ở `public` được động tới.
--
-- ⚠️ `AUTHORIZATION ecoma_auth_migrator` — schema thuộc migrator, nên nó tạo được object bên
--    trong mà không cần `SUPERUSER` hay `CREATEDB`. Role **này không tồn tại** thì câu này
--    thất bại ngay, thay vì tạo schema rồi để role runtime không sửa được gì trong đó.
--    Việc tạo role là bước operator, xem README.
--
-- ⚠️ `CREATE SCHEMA IF NOT EXISTS` ở đây giữ file **re-runnable**: lần đầu tạo schema, các
--    lần sau là no-op. (Khác với `CREATE TABLE` — xem giải thích ở khối quy ước.)
-- ---------------------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ecoma_auth_migrator;

-- ---------------------------------------------------------------------------------------------
-- auth.oauth_clients — client đã đăng ký (01-architecture.md §3.2).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.oauth_clients (
    client_id          text        NOT NULL,
    client_name        text        NOT NULL,
    -- `public` không có secret; `confidential` bắt buộc có hash (FR-001).
    client_type        text        NOT NULL,
    -- Hash của client secret — KHÔNG phải secret. Giá trị gốc không được lưu ở bất kỳ đâu
    -- trong `db-auth`; nó chỉ được trả về đúng một lần lúc cấp (FR-004).
    client_secret_hash text,
    subject_type       text        NOT NULL DEFAULT 'public',
    -- Scope client được phép xin. Scope **thực sự của một grant** nằm ở
    -- `auth.client_grant_scopes` (file 0003), không nằm ở đây — tránh hai nơi cùng là nguồn
    -- sự thật.
    allowed_scopes     text[]      NOT NULL DEFAULT ARRAY[]::text[],
    -- `disabled` chặn cả `/authorize` lẫn `/token`, kể cả khi grant còn hiệu lực (FR-003).
    status             text        NOT NULL DEFAULT 'active',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id),
    CONSTRAINT oauth_clients_client_type_check
        CHECK (client_type IN ('public', 'confidential')),
    CONSTRAINT oauth_clients_subject_type_check
        CHECK (subject_type IN ('public', 'pairwise')),
    CONSTRAINT oauth_clients_status_check
        CHECK (status IN ('active', 'disabled')),
    -- FR-001: secret chỉ tồn tại với `confidential`, và `confidential` không được thiếu secret.
    -- Ràng buộc này chặn cả hai chiều của lỗi: public client mang secret, và confidential
    -- client không có secret để xác thực.
    CONSTRAINT oauth_clients_secret_parity_check
        CHECK (
            (client_type = 'public'        AND client_secret_hash IS NULL)
            OR (client_type = 'confidential' AND client_secret_hash IS NOT NULL)
        )
);

COMMENT ON TABLE  auth.oauth_clients IS
    'Registered client. client_secret_hash exists only for confidential clients (FR-001); client_secret is issued once and never again (FR-004).';
COMMENT ON COLUMN auth.oauth_clients.client_secret_hash IS
    'Hash of the client secret — not the secret itself. The raw value is never stored in db-auth.';
COMMENT ON COLUMN auth.oauth_clients.allowed_scopes IS
    'Ceiling on the scopes a client may request. The effective scope of each grant lives in auth.client_grant_scopes.';

-- ---------------------------------------------------------------------------------------------
-- auth.client_redirect_uris — redirect URI đã đăng ký (FR-002).
--
-- So khớp là **exact string**: cấm wildcard, cấm prefix match, cấm so khớp chỉ theo
-- scheme+host. `auth` chỉ so sánh chuỗi, không parse URI.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.client_redirect_uris (
    client_id    text        NOT NULL,
    redirect_uri text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    -- PK composite: `client_id` là cột dẫn nên tra theo client đã dùng được index primary key,
    -- đồng thời chặn đăng ký trùng cùng một URI cho một client.
    CONSTRAINT client_redirect_uris_pkey PRIMARY KEY (client_id, redirect_uri),
    CONSTRAINT client_redirect_uris_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE CASCADE
);

COMMENT ON TABLE auth.client_redirect_uris IS
    'Registered redirect URI. auth matches exact strings only — no wildcards, no prefix matching, no scheme+host-only matching (FR-002).';