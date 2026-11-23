-- 0005_refresh_tokens.sql — refresh token rotation và reuse detection.
--
-- Phạm vi: `refresh_token_families`, `refresh_tokens`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2, §6.6
--          → docs/applications/auth/02-requirements.md FR-018, FR-018a, FR-019.
--
-- ⚠️ Mô hình: ROTATION + REUSE DETECTION.
--    Mỗi lần dùng refresh token sinh token mới và đánh dấu token cũ đã dùng.
--    Dùng lại một token **đã rotate** là dấu hiệu token bị lộ ⇒ thu hồi **toàn bộ family**
--    và buộc re-authenticate (FR-018a, invariant 10).
--
-- ⚠️ Vì refresh token LUÔN đi qua `auth`, nó thuộc **điểm kiểm soát (A)** (phát hành): refresh
--    luôn fail closed và luôn hỏi được trạng thái account. Nó là hàng duy nhất trong schema
--    này được phép hỏi `account` mỗi lần dùng (01-architecture.md §6.6).
--
-- ⚠️ Chỉ lưu **hash**. Không refresh token nào vào URL, log hay audit (FR-019).

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- refresh_token_families — một family cho một grant, dùng phát hiện reuse.
--
-- Family là **đơn vị thu hồi**: đánh dấu compromised ⇒ thu hồi toàn bộ token trong family đó,
-- buộc user re-authenticate. Đây là đường thu hồi ở mức grant/token của §6.4.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.refresh_token_families (
    id        uuid        NOT NULL DEFAULT gen_random_uuid(),
    -- Opaque, không FK sang db-account.
    sub       text        NOT NULL,
    client_id text        NOT NULL,
    -- Grant mà family này phục vụ. Family thuộc về grant, và grant bị thu hồi thì family chết
    -- theo — không có refresh token nào sống sót trên một grant đã thu hồi.
    grant_id  uuid        NOT NULL,

    status          text        NOT NULL DEFAULT 'active',
    -- Đánh dấu compromised là hành động **một chiều**: thu hồi family rồi phải auth lại, không
    -- có đường mở lại family cũ (FR-018a).
    compromised_at  timestamptz,
    compromised_reason text,

    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,

    CONSTRAINT refresh_token_families_pkey PRIMARY KEY (id),
    CONSTRAINT refresh_token_families_status_check
        CHECK (status IN ('active', 'revoked', 'compromised')),

    -- `compromised_at` chỉ tồn tại khi family thực sự compromised.
    CONSTRAINT refresh_token_families_compromised_parity_check
        CHECK ((status = 'compromised') = (compromised_at IS NOT NULL)),

    -- Đã thu hồi thì phải có mốc thời gian; còn sống thì không được có (tránh trạng thái
    -- "đã thu hồi nhưng không có thời điểm" làm điều tra không được).
    CONSTRAINT refresh_token_families_revoked_at_parity_check
        CHECK ((status IN ('revoked', 'compromised')) = (revoked_at IS NOT NULL)),

    CONSTRAINT refresh_token_families_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE RESTRICT,
    CONSTRAINT refresh_token_families_grant_fk
        FOREIGN KEY (grant_id) REFERENCES auth.oauth_grants (id) ON DELETE CASCADE
);

COMMENT ON TABLE auth.refresh_token_families IS
    'Family of refresh tokens for one grant. It is the unit of revocation: compromised means revoke the whole family and force re-authentication (FR-018a).';

-- Tra cứu lúc phát hành: "subject này có family active nào cho client này không" — và tra
-- khi cần thu hồi hàng loạt theo subject.
CREATE INDEX IF NOT EXISTS refresh_token_families_sub_client_idx
    ON auth.refresh_token_families (sub, client_id);
-- Một grant có bao nhiêu family — thu hồi theo grant.
CREATE INDEX IF NOT EXISTS refresh_token_families_grant_idx
    ON auth.refresh_token_families (grant_id);
-- Reconciliation: đếm family theo trạng thái, tìm family compromised còn sót.
CREATE INDEX IF NOT EXISTS refresh_token_families_status_idx
    ON auth.refresh_token_families (status);

-- ---------------------------------------------------------------------------------------------
-- refresh_tokens — token refresh hiện tại.
--
-- ⚠️ `token_hash` là nơi CAS consume chạy: dùng token đã rotate phải trả **0 row** ⇒
--    phát hiện reuse. Xem câu SQL ở cuối file.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.refresh_tokens (
    id        uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- ⚠️ CHỈ hash của refresh token được lưu (FR-019). Giá trị token dạng rõ không tồn tại
    --    ở bất kỳ cột nào trong `db-auth`.
    token_hash text       NOT NULL,

    family_id  uuid        NOT NULL,
    client_id  text        NOT NULL,
    -- Opaque, không FK sang db-account.
    sub        text        NOT NULL,
    -- Scope đi kèm refresh token; không vượt quá scope của grant.
    granted_scopes text[]  NOT NULL DEFAULT ARRAY[]::text[],

    issued_at  timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_reason text,

    -- ⚠️ **Điều kiện cạnh tranh của CAS** — NULL = token còn dùng được, chưa từng rotate.
    --    Một token chỉ chuyển NULL → giá trị này **đúng một lần**.
    used_at    timestamptz,

    -- Token mới sinh ra khi token này được rotate — hình thành chuỗi để điều tra reuse.
    rotated_to uuid,
    -- Token cha, để truy ngược lại đầu chuỗi khi phát hiện reuse.
    rotated_from uuid,

    CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id),

    -- `/token` tra bằng hash; UNIQUE nên một hash không bao giờ khớp hai token.
    CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),

    CONSTRAINT refresh_tokens_family_fk
        FOREIGN KEY (family_id) REFERENCES auth.refresh_token_families (id) ON DELETE CASCADE,
    CONSTRAINT refresh_tokens_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE RESTRICT,

    -- ⚠️ `rotated_to`/`rotated_from` là **FK tự tham chiếu trong cùng database**, KHÔNG phải
    --    foreign key sang database khác — NFR-002b chỉ cấm liên-database, và chuỗi rotation
    --    là quan hệ bên trong `db-auth` nên toàn vẹn tham chiếu là việc của chính nó.
    CONSTRAINT refresh_tokens_rotated_to_fk
        FOREIGN KEY (rotated_to) REFERENCES auth.refresh_tokens (id) ON DELETE SET NULL,
    CONSTRAINT refresh_tokens_rotated_from_fk
        FOREIGN KEY (rotated_from) REFERENCES auth.refresh_tokens (id) ON DELETE SET NULL,

    -- Token không tự tham chiếu: chuỗi rotation là DAG, không phải vòng.
    CONSTRAINT refresh_tokens_not_self_rotated
        CHECK (rotated_to IS NULL OR rotated_to <> id),

    -- ⚠️ Một chiều: `rotated_to` có giá trị **kéo theo** `used_at` phải có giá trị.
    --    Chiều ngược lại **không** bắt buộc, và đây là chỗ dễ viết sai nhất của bảng này.
    --
    --    Câu CAS ở cuối file chỉ `SET used_at = now()` — nó **không** biết id của token mới,
    --    vì token mới chưa tồn tại. Đường rotation đúng là: (1) CAS đánh dấu token cũ đã
    --    dùng, `rotated_to` còn NULL; (2) `INSERT` token mới với `rotated_from` trỏ về token
    --    cũ; (3) `UPDATE` token cũ đặt `rotated_to` = id token mới. Vì vậy có một khoảnh khắc
    --    hợp lệ mà `used_at` đã có còn `rotated_to` vẫn NULL.
    --
    --    Nếu ràng buộc là đẳng thức hai chiều `(used_at IS NULL) = (rotated_to IS NULL)` thì
    --    chính câu CAS đầu tiên sẽ vi phạm nó, và adapter buộc phải biết id token mới trước
    --    khi tiêu thụ token cũ — đảo ngược thứ tự và mở lại cửa sổ double-use.
    CONSTRAINT refresh_tokens_rotation_parity_check
        CHECK (rotated_to IS NULL OR used_at IS NOT NULL),

    -- `revoked_at` và `revoked_reason` không bắt buộc đi cùng nhau: thu hồi theo lý do
    -- hệ thống (logout, suspend) không cần ghi reason.
    CONSTRAINT refresh_tokens_family_required CHECK (family_id IS NOT NULL)
);

COMMENT ON TABLE auth.refresh_tokens IS
    'Current refresh token. Stores the hash only; rotation uses CAS, so there is no double-use window (FR-018).';

-- Tra family của một token (đường đi của reuse detection): `family_id` là cột dẫn của
-- các index FK, nên index FK đã phục vụ truy vấn này — không cần index thứ hai.
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx
    ON auth.refresh_tokens (family_id);
-- Rà soát/thu hồi theo subject.
CREATE INDEX IF NOT EXISTS refresh_tokens_sub_idx ON auth.refresh_tokens (sub);
-- Rà soát/thu hồi theo client.
CREATE INDEX IF NOT EXISTS refresh_tokens_client_idx ON auth.refresh_tokens (client_id);
-- Cleanup theo lô: token đã hết TTL hoặc đã bị thu hồi.
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx
    ON auth.refresh_tokens (expires_at);

-- ---------------------------------------------------------------------------------------------
-- CAS consume refresh token — **MỘT câu lệnh**, đây là SQL để adapter copy nguyên văn.
--
-- ⚠️ Câu này vừa là **cơ chế rotation** vừa là **cơ chế phát hiện reuse**, và hai điều đó là
--    cùng một phép so sánh `used_at IS NULL`:
--      • nhận **1 row** ⇒ token còn dùng được ⇒ sinh token mới, đánh dấu token này đã rotate;
--      • nhận **0 row** ⇒ token đã hết hạn, đã bị thu hồi, **hoặc đã rotate trước đó** ⇒
--        dùng lại ⇒ phát hiện reuse.
--
-- ⚠️ `AND used_at IS NULL` nằm trong chính câu UPDATE: hai request refresh **đồng thời** với
--    cùng một token thì đúng một nhận row, request còn lại nhận 0 row và bị đi vào nhánh
--    reuse. Nếu tách thành SELECT rồi UPDATE thì cả hai đều thấy "còn dùng được" và cả hai
--    cùng cấp token — đúng cái lỗi mà CAS sinh ra để chặn (FR-018, AC-016).
-- ---------------------------------------------------------------------------------------------
--
--   UPDATE refresh_tokens
--      SET used_at = now()
--    WHERE token_hash = $1
--      AND used_at   IS NULL
--      AND revoked_at IS NULL
--      AND expires_at > now()
--    RETURNING id, family_id, client_id, sub, granted_scopes;
--
-- ⚠️ **Nhánh 0 row phải phân biệt ba nguyên nhân trước khi kết luận reuse** — nếu không thì
--    một token hết hạn bình thường sẽ bị báo thành reuse, và metric
--    `refresh_reuse_detected_total` sẽ bị nhiễu đến mức mất giá trị báo động. Truy vấn phân
--    biệt (chạy **sau** khi CAS đã trả 0 row, với chính hash đó):
--
--   SELECT id, used_at IS NOT NULL AS already_rotated,
--          revoked_at, expires_at <= now() AS expired
--     FROM refresh_tokens
--    WHERE token_hash = $1;
--
--   • `already_rotated = true`  → REUSE thật → thu hồi **toàn bộ family**.
--   • `revoked_at IS NOT NULL`   → token đã bị thu hồi có chủ đích (logout, suspend) ⇒
--                                   trả `invalid_grant`, **không** báo reuse, **không** thu hồi
--                                   family — thu hồi family ở đây là phản ứng quá tay và sẽ
--                                   logout hàng loạt user khỏi thiết bị khác.
--   • `expired = true`          → hết TTL ⇒ `invalid_grant`, không phải reuse.
--
-- ⚠️ Bốn việc này phải nằm trong **cùng transaction `db-auth`** sau khi CAS trả 1 row
--    (FR-018):
--    1. `INSERT` token mới với `rotated_to` trỏ token vừa consume, `rotated_from` ngược lại;
--    2. Hỏi trạng thái account qua `auth → account`; lỗi/timeout/5xx ⇒ **không** cấp token;
--    3. Kiểm grant còn hiệu lực, đủ scope, và `token_revocations`;
--    4. Ghi `authorization_audit_events`.
--
-- ⚠️ Thứ tự (2) trước (1) là cố ý: fail ở bước 2 thì rollback cả token cũ, nên người dùng
--    dùng lại được token cũ — đúng hành vi khi hệ thống đang trả lời sai.
--
-- ⚠️ CAS dùng index UNIQUE của `token_hash`, nên một lần index lookup rồi so `used_at`:
--    đường nóng của refresh không quét bảng, kể cả khi bảng có hàng triệu token đã chết.
--
-- ⚠️ Nhánh thu hồi **toàn bộ family** khi phát hiện reuse (FR-018a):
--
--   UPDATE refresh_token_families
--      SET status = 'compromised',
--          compromised_at = now(),
--          compromised_reason = $2,
--          revoked_at = now()
--    WHERE id = $1
--      AND status = 'active'
--    RETURNING id;
--
--   UPDATE refresh_tokens
--      SET revoked_at = now(),
--          revoked_reason = 'family_compromised'
--    WHERE family_id = $1
--      AND revoked_at IS NULL;
--
-- ⚠️ Ràng buộc `status = 'active'` ở câu trên làm nó **idempotent**: chạy lại không báo lỗi và
--    không ghi đè mốc thời gian thu hồi đã có. Nếu thiếu nó, một lần reuse thứ hai sẽ ghi đè
--    `compromised_at` và làm hỏng dấu vết thời điểm phát hiện.