-- 0008_append_only_events.sql — audit và outbox. Cả hai **append-only**.
--
-- Phạm vi: `authorization_audit_events`, `outbox_events`.
-- Thiết kế → docs/applications/auth/01-architecture.md §3.2, §7.1, §8 invariant 20
--          → docs/applications/auth/02-requirements.md SR-002, SR-010, AC-026.
--
-- ⚠️ **Không có `pgcrypto`, không extension.** `gen_random_uuid()` là builtin PostgreSQL 13+;
--    `pgcrypto` chỉ cần cho `digest()`/`hmac()` ở tầng ứng dụng, và cài extension vào
--    `db-auth` là mở rộng bề mặt không cần thiết (NFR-002a, NFR-002b).

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------------------------
-- authorization_audit_events — audit token issuance, consent, revocation, grant, client auth.
--
-- ⚠️ **Append-only, và điều đó được *cấp quyền* chứ không chỉ được *ghi trong comment*.**
--    File 0009 thu quyền `UPDATE`/`DELETE` khỏi `ecoma_auth_runtime` trên bảng này. Đó là
--    lớp enforce thật; một constraint không ngăn được một `UPDATE` của role khác.
--
-- ⚠️ **Không ghi token, `code_verifier`, assertion, secret, handle, `account_session_ref`
--    hay giá trị cookie** (SR-002, invariant 20, FR-012c). Cột ở đây là **allowlist** những
--    gì được phép ghi, nên thêm một cột là một thay đổi chính sách audit và phải được review
--    như vậy.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.authorization_audit_events (
    id        uuid        NOT NULL DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT now(),

    -- Loại sự kiện. Allowlist đóng — đây là danh sách những việc `auth` PHẢI audit
    -- (SR-010), không phải nơi ghi mọi thứ.
    event_type text       NOT NULL,

    -- `sub` opaque, có thể NULL (ví dụ client auth không gắn subject).
    subject_ref text,
    client_id   text,
    -- Transaction và authorization code liên quan, khi có. Kiểu `uuid` khớp với
    -- `authorization_transactions.transaction_id` / `authorization_codes.id`.
    authorization_transaction_id uuid,
    authorization_code_id        uuid,
    -- Grant bị thu hồi, khi có.
    grant_id    uuid,
    -- `kid` của signing key đã dùng, khi phát hành token. Chỉ là định danh công khai.
    kid         text,

    -- Kết quả: `success` | `failure` | `denied` … — đủ để đếm và cảnh báo, không phải để tái
    -- dựng lại payload request.
    outcome     text,
    -- Mã lỗi chuẩn hoá (`invalid_request`, `invalid_grant`, `access_denied`, …).
    error_code  text,

    -- Chi tiết bổ sung đã **lọc**. ⚠️ Đây là điểm dễ rò nhất: chỉ ghi vào đây trường đã được
    -- whitelist ở tầng ứng dụng. Không bao giờ ghi handle, code, token, ASR, cookie hay
    -- `code_verifier` — kể cả dạng đã hash, vì hash của handle trong audit biến audit thành
    -- nguồn đối chiếu cho kẻ đọc được log.
    details     jsonb,

    CONSTRAINT authorization_audit_events_pkey PRIMARY KEY (id),
    CONSTRAINT authorization_audit_events_event_type_check CHECK (event_type IN (
        -- Token
        'token_issued',            -- access token + refresh token phát hành
        'token_issue_denied',      -- không cấp được: grant/revocation/session không hợp lệ
        'refresh_token_reused',    -- phát hiện reuse ⇒ thu hồi family (FR-018a)
        'refresh_token_rotated',
        -- Authorization
        'authorization_started',   -- `/authorize` tạo transaction
        'authorization_completed', -- `/authorize/complete` cấp code
        'authorization_denied',    -- user deny, hoặc hàng 14 (grant mất hiệu lực)
        'consent_decided',         -- approve | deny
        'session_verified',        -- bước push nhận kết quả xác thực
        -- Grant & client
        'grant_created',
        'grant_revoked',
        'client_authenticated',
        'client_auth_failed',
        'client_registered',
        'client_disabled',
        -- Revocation
        'revoked_subject',
        'revoked_client_grant',
        'revoked_token'
    ))
);

COMMENT ON TABLE auth.authorization_audit_events IS
    'Auth audit log. APPEND-ONLY — UPDATE/DELETE privileges are revoked from ecoma_auth_runtime in file 0009. Contains no tokens, code_verifier, secrets, handles, account_session_ref or assertions (SR-002).';

-- ⚠️ Vì append-only, index theo thời gian là chiều truy vấn chính: "sự kiện của client này
--    trong khoảng này", "sự kiện của subject này", "sự kiện loại này".
CREATE INDEX IF NOT EXISTS authorization_audit_events_occurred_at_idx
    ON auth.authorization_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_events_event_type_idx
    ON auth.authorization_audit_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS authorization_audit_events_subject_ref_idx
    ON auth.authorization_audit_events (subject_ref, occurred_at DESC)
    WHERE subject_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS authorization_audit_events_client_id_idx
    ON auth.authorization_audit_events (client_id, occurred_at DESC)
    WHERE client_id IS NOT NULL;
-- Truy vết một transaction cụ thể khi điều tra `codes_reused_total > 0`.
CREATE INDEX IF NOT EXISTS authorization_audit_events_transaction_idx
    ON auth.authorization_audit_events (authorization_transaction_id)
    WHERE authorization_transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- outbox_events — event sang `account`, ghi **cùng transaction** với state đổi.
--
-- ⚠️ "Commit thành công là event tồn tại, không thể mất" — đó là điều mà **transactional outbox**
--    bảo đảm: event được ghi trong *cùng transaction* với thay đổi state, nên không có
--    trạng thái "state đổi xong mà event mất" (01-architecture.md §7.1, invariant A8).
--
-- ⚠️ Bảng này **không đảm bảo `account` nhận được event.** Giao thức là at-least-once, nên:
--      • item chưa publish được phát lại bởi relay + reconciliation định kỳ;
--      • consumer phải **idempotent** theo `event_id`; thu hồi là set-union nên giao lặp vô hại;
--      • không được đánh dấu `published_at` trước khi gửi thành công.
--    `auth` **không** tin "chưa nghe gì = vẫn active" — nó kiểm tra trạng thái account qua
--    contract đồng bộ `auth → account` lúc phát hành (01-architecture.md §6.0, FR-020).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.outbox_events (
    id        uuid        NOT NULL DEFAULT gen_random_uuid(),

    -- ⚠️ **Idempotency key UNIQUE** (01-architecture.md §3.2). Đây là điều kiện để consumer
    --    xử lý giao lặp an toàn: cùng `event_id` là cùng một sự kiện, không phải hai.
    event_id  text        NOT NULL,

    -- Loại event, và schema version của payload. Đổi cấu trúc payload ⇒ tăng version, không
    -- sửa tại chỗ (tương thích ngược bắt buộc cho message đã gửi).
    event_type text       NOT NULL,
    schema_version int      NOT NULL DEFAULT 1,

    -- Payload đã lọc. Không được mang token, assertion, `account_session_ref`, hay dữ liệu
    -- định danh nào ngoài `sub` mà contract cho phép.
    payload   jsonb       NOT NULL,

    -- `pending` = chờ phát. Đổi trạng thái sang `published` **chỉ** sau khi gửi thành công.
    status    text        NOT NULL DEFAULT 'pending',

    created_at timestamptz NOT NULL DEFAULT now(),
    -- Số lần phát lại. Đếm tăng là tín hiệu relay có vấn đề.
    attempts   int        NOT NULL DEFAULT 0,
    -- Thời điểm phát thành công. NULL = chưa phát — và đây là **điều kiện** của lệnh đánh dấu.
    published_at timestamptz,
    last_error text,

    CONSTRAINT outbox_events_pkey PRIMARY KEY (id),

    -- ⚠️ Idempotency key UNIQUE: một `event_id` không bao giờ sinh ra hai event. Insert lần hai
    --    trùng `event_id` phải **thất bại**, đó là cách phát hiện producer sinh event trùng.
    CONSTRAINT outbox_events_event_id_key UNIQUE (event_id),

    CONSTRAINT outbox_events_status_check
        CHECK (status IN ('pending', 'published', 'failed')),

    -- ⚠️ `published_at` chỉ tồn tại khi đã publish, và có mặt thì status phải là `published`.
    --    Ràng buộc này làm "đánh dấu đã phát" mà chưa gửi là một trạng thái không tạo được —
    --    đúng cái lỗi mà §7.1 của kiến trúc nêu là partial failure.
    CONSTRAINT outbox_events_published_at_parity_check
        CHECK ((status = 'published') = (published_at IS NOT NULL)),

    -- Số lần phát không được âm.
    CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0)
);

COMMENT ON TABLE auth.outbox_events IS
    'Transactional outbox to account. Written in the SAME transaction as the state change, so events cannot be lost. At-least-once protocol: consumers must be idempotent by event_id, and published_at is set only after successful delivery.';

-- ⚠️ Đường nóng của relay: lấy các item chưa phát, cũ nhất trước.
CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
    ON auth.outbox_events (created_at) WHERE status = 'pending';
-- Reconciliation: đếm item theo trạng thái và tìm item kẹt lâu.
CREATE INDEX IF NOT EXISTS outbox_events_status_idx
    ON auth.outbox_events (status);
-- Theo loại event, để đo độ trễ riêng từng loại.
CREATE INDEX IF NOT EXISTS outbox_events_event_type_idx
    ON auth.outbox_events (event_type, created_at);