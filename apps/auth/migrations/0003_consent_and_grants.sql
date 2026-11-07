-- 0003_consent_and_grants.sql — bằng chứng consent và quyền hiện hành.
--
-- Phạm vi: `oauth_consent_decisions`, `oauth_grants`, `client_grant_scopes`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2, §3.4
--          → docs/applications/auth/02-requirements.md FR-014..FR-014b, FR-022.
--
-- ⚠️ Cặp này là nơi dễ nhầm nhất của OAuth, và nhầm nó sinh bug ngay ở ngữ nghĩa thu hồi:
--
--   oauth_consent_decisions = user ĐÃ TỪNG đỒNG Ý, tại thời điểm T  → bằng chứng lịch sử
--   oauth_grants            = quyền ĐANG CÓ HIỆU LỰC                  → quyền hiện hành
--
--   • Thu hồi consent KHÔNG thu hồi grant.
--   • Thu hồi grant    KHÔNG xoá consent record.
--   • Grant KHÔNG tự tái sinh từ consent cũ còn nằm trong lịch sử.
--   • Reactivate KHÔNG hồi sinh grant — user phải consent lại (FR-022).
--
--   Chỉ `oauth_grants` được dùng để quyết định cấp token. Dùng bảng consent để ra quyết định
--   phát hành là lỗi, không phải lựa chọn.

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- oauth_consent_decisions — quyết định của user tại một thời điểm (01-architecture.md §3.4).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.oauth_consent_decisions (
    id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
    -- Opaque, KHÔNG foreign key sang db-account (NFR-002b; §3.6).
    sub                         text        NOT NULL,
    client_id                   text        NOT NULL,
    -- `auth` tự bind vào `redirect_uri` + scope của **chính transaction của nó**, lấy từ
    -- `/authorize` — không bao giờ lấy từ payload mà `account` gửi (FR-013a, invariant 4).
    redirect_uri                text        NOT NULL,
    -- Scope user đã đồng ý tại thời điểm này.
    granted_scopes              text[]      NOT NULL,
    decision                    text        NOT NULL,
    -- Gắn vào transaction đã sinh ra quyết định này.
    -- ⚠️ Kiểu `uuid` phải khớp `authorization_transactions.transaction_id`: PostgreSQL không
    --    implement được FK giữa `text` và `uuid`, và một FK `text` trên cột đó sẽ chỉ "chạy
    --    được" cho tới lúc có ai đó insert giá trị không phải UUID.
    authorization_transaction_id uuid    NOT NULL,
    decided_at                  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT oauth_consent_decisions_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_consent_decisions_decision_check
        CHECK (decision IN ('approve', 'deny')),

    CONSTRAINT oauth_consent_decisions_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE RESTRICT,

    -- `ON DELETE RESTRICT`: consent là **audit trail**. Xoá transaction cũ hết TTL sẽ bị
    -- chặn nếu decision vẫn trỏ tới — và đó là hành vi đúng: retention của consent phải được
    -- chốt riêng, không được suy ra từ việc dọn transaction.
    CONSTRAINT oauth_consent_decisions_transaction_fk
        FOREIGN KEY (authorization_transaction_id)
        REFERENCES auth.authorization_transactions (transaction_id) ON DELETE RESTRICT
);

COMMENT ON TABLE auth.oauth_consent_decisions IS
    'The user''s consent decision at one point in time — historical evidence, not the current entitlement (01-architecture.md §3.4). This table never decides token issuance.';

-- ---------------------------------------------------------------------------------------------
-- Index — chỉ những truy vấn protocol/UI thực sự cần.
-- ---------------------------------------------------------------------------------------------

-- Connected applications: lịch sử đồng ý của một ứng dụng cụ thể.
CREATE INDEX IF NOT EXISTS oauth_consent_decisions_sub_client_idx
    ON auth.oauth_consent_decisions (sub, client_id);
-- Rà soát toàn bộ consent của một client khi rotate `client_secret` hoặc khi client bị disable.
CREATE INDEX IF NOT EXISTS oauth_consent_decisions_client_idx
    ON auth.oauth_consent_decisions (client_id);
-- Truy ngược từ một transaction ra quyết định của nó.
CREATE INDEX IF NOT EXISTS oauth_consent_decisions_transaction_idx
    ON auth.oauth_consent_decisions (authorization_transaction_id);

-- ---------------------------------------------------------------------------------------------
-- oauth_grants — **quyền hiện hành**, được kiểm MỖI lần phát hành token.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.oauth_grants (
    id                  uuid        NOT NULL DEFAULT gen_random_uuid(),
    -- Opaque, KHÔNG foreign key sang db-account (NFR-002b; §3.6).
    sub                 text        NOT NULL,
    client_id           text        NOT NULL,
    status              text        NOT NULL DEFAULT 'active',
    -- Consent **đã sinh ra** grant này. Để NULL được: grant có thể được cấp lại bởi consent
    -- mà record quyết định đã bị retention xoá — và một grant vẫn sống được, đó là điều §3.4
    -- nói rõ. Ràng buộc KHÔNG được là `NOT NULL`.
    consent_decision_id uuid,
    granted_at          timestamptz NOT NULL DEFAULT now(),
    revoked_at          timestamptz,
    revoked_reason      text,
    -- Hạn dùng của grant. NULL = không hạn (grant chỉ chết khi bị thu hồi).
    expires_at          timestamptz,

    CONSTRAINT oauth_grants_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_grants_status_check CHECK (status IN ('active', 'revoked')),

    -- Trạng thái `revoked` là **vĩnh viễn**: `revoked_at` phải có mặt, và có mặt thì phải
    -- revoked. Không có đường "huỷ thu hồi" — thu hồi lại là consent mới.
    CONSTRAINT oauth_grants_revoked_at_parity_check
        CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),

    CONSTRAINT oauth_grants_client_fk
        FOREIGN KEY (client_id) REFERENCES auth.oauth_clients (client_id) ON DELETE RESTRICT,

    -- `ON DELETE RESTRICT`: xoá consent **không** được xoá grant (FR-014). Chiều này của ràng
    -- buộc là một nửa của §3.4; nửa còn lại — thu hồi grant không xoá consent — đến từ việc
    -- thu hồi chỉ `UPDATE` grant, không đụng tới decision.
    CONSTRAINT oauth_grants_consent_decision_fk
        FOREIGN KEY (consent_decision_id)
        REFERENCES auth.oauth_consent_decisions (id) ON DELETE RESTRICT
);

COMMENT ON TABLE auth.oauth_grants IS
    'Current entitlement of a (sub, client) pair. Checked on EVERY token issuance. It does not regenerate itself while an old consent still exists in history (FR-014b).';

-- ⚠️ Tại một thời điểm, mỗi `(sub, client)` chỉ có **một** grant `active`. Đây là ràng buộc
--    điều kiện nên các grant đã thu hồi không làm nghẽn index, và nó chặn trạng thái "hai
--    grant active cùng lúc cho một cặp" — trạng thái mà mọi câu hỏi "grant nào còn hiệu lực"
--    sẽ có hai đáp án.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_active_sub_client_idx
    ON auth.oauth_grants (sub, client_id) WHERE status = 'active';

-- Tra cứu nóng lúc phát hành và lúc reconciliation: "grant hiện hành của subject này".
CREATE INDEX IF NOT EXISTS oauth_grants_sub_idx ON auth.oauth_grants (sub);
-- Connected applications: grant của một (sub, client) cụ thể, gồm cả grant đã thu hồi.
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON auth.oauth_grants (client_id);
-- Rà soát khi rotate `client_secret` hoặc khi một client bị disable.
CREATE INDEX IF NOT EXISTS oauth_grants_client_status_idx
    ON auth.oauth_grants (client_id, status);
-- Cleanup theo lô: grant `active` có `expires_at` đã trôi qua.
CREATE INDEX IF NOT EXISTS oauth_grants_expiry_idx
    ON auth.oauth_grants (expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- client_grant_scopes — scope cụ thể của từng grant.
--
-- Được dùng để kiểm scope **tại thời điểm phát hành token** và tại introspection
-- (01-architecture.md §3.2). Một grant là một tập scope; thu hồi grant khiến **toàn bộ**
-- scope trong tập mất hiệu lực theo cùng một câu `UPDATE oauth_grants`.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.client_grant_scopes (
    grant_id   uuid        NOT NULL,
    scope      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    -- PK composite: chặn trùng scope trong một grant, và `grant_id` là cột dẫn nên đọc
    -- scope của một grant (truy vấn phát hành token) dùng được index primary key — không
    -- cần index thứ hai cho cùng một truy vấn.
    CONSTRAINT client_grant_scopes_pkey PRIMARY KEY (grant_id, scope),

    -- `ON DELETE CASCADE`: scope là **thuộc tính của grant**, không tồn tại độc lập với nó.
    -- Đây là chiều duy nhất trong schema này được cascade có chủ đích, vì scope không mang
    -- ý nghĩa gì khi grant không còn tồn tại — khác với consent/audit vốn phải sống lâu hơn.
    CONSTRAINT client_grant_scopes_grant_fk
        FOREIGN KEY (grant_id) REFERENCES auth.oauth_grants (id) ON DELETE CASCADE
);

COMMENT ON TABLE auth.client_grant_scopes IS
    'Concrete scope of each grant, used to check scope at token issuance and at introspection.';