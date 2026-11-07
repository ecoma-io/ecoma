-- 0013_oidc_provider_state.sql — state bền của oidc-provider (protocol engine của `auth`).
--
-- Phạm vi: một bảng `auth.oidc_state` giữ toàn bộ artifact giao thức mà
-- `oidc-provider@9.12.2` persist qua adapter của nó: Interaction, Session, Grant,
-- AuthorizationCode, AccessToken, RefreshToken, ReplayDetection.
--
-- ⚠️ TÁCH BIỆT VỚI `authorization_transactions` / `authorization_codes` (0002/0004).
-- Hai cấu trúc đó là source of truth NGHIỆP VỤ theo docs/applications/auth/01-architecture.md
-- §5.1 (browser_confirmed gate, CAS, idempotency event_id). Bảng này là state CƠ CHẾ
-- GIAO THỨC của provider: provider tự sinh jti, tự quản TTL, tự tiêu thụ. Một dòng
-- `oidc_state` không bao giờ được đọc để ra quyết định nghiệp vụ của `auth`; và ngược
-- lại, `completeAuthorization`/`insertAuthorizationCode` của application layer không
-- ghi vào đây. Trộn hai nguồn sự thật là đường ngắn cho một bên tin nhầm bên kia.
--
-- ⚠️ VÌ SAO MỘT BẢNG DUY NHẤT thay vì một bảng cho mỗi kind. Ba lý do độc lập:
--
--   1. **Payload là tài sản của oidc-provider, không phải của schema.** Mỗi model của
--      provider tự khai danh sách trường mà nó serialize (`IN_PAYLOAD` — ví dụ
--      `lib/models/refresh_token.js:13-33` thêm `consumed`, `gty`, `grantId`, `iiat`,
--      `rotations`…). Nâng version provider có thể thêm/bỏ trường; nếu mỗi kind là một
--      bảng relational thì mỗi lần đó là một migration schema. JSONB đẩy ranh giới đó
--      về phía thư viện — nơi nó thuộc về.
--   2. **Mọi truy vấn là point-lookup.** Hợp đồng adapter của provider
--      (`lib/adapters/memory_adapter.js`) chỉ có: `find(id)`, `findByUid(uid)`,
--      `findByUserCode(userCode)`, `consume(id)`, `destroy(id)`,
--      `revokeByGrantId(grantId)`. Không có truy vấn phân tích nào. Bảng hẹp với PK
--      `(kind, id)` + bốn đường truy cập phụ (dưới) phủ đúng hợp đồng, không thừa.
--   3. **TTL là thuộc tính của TỪNG hàng, không của kind.** `ttl` của provider là
--      hằng hoặc hàm theo request (`lib/helpers/defaults.js:3167-3179`), và
--      `ReplayDetection` còn lưu với TTL **âm hoặc bằng 0** khi `exp` đã quá khứ
--      (`lib/models/replay_detection.js:32` — `save(exp - epochTime())`). Cột
--      `expires_at` trên mỗi hàng xử lý tự nhiên cả trường hợp đó; bảng riêng phải
--      lặp lại cơ chế này cho từng bảng.
--
-- Đổi lại, cái giá phải ghi thẳng: **ràng buộc kiểu yếu đi** — JSONB không chặn một
-- payload Interaction thiếu `returnTo`. Đó là chấp nhận có chủ đích: hình dạng payload
-- được kiểm bởi test parity với thư viện (`src/oidc/adapter.spec.ts`), không bởi CHECK
-- SQL. Một CHECK JSONB chép lại `IN_PAYLOAD` của thư viện là một bản khai báo thứ hai
-- chắc chắn trôi lệch khi provider nâng version.
--
-- ⚠️ KHÔNG idempotent: `CREATE TABLE` không kèm `IF NOT EXISTS` (quy ước 0001) — file
-- chỉ được áp một lần, trùng lặp là lỗi chứ không phải no-op.

SET TIME ZONE 'UTC';

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- auth.oidc_state — một hàng cho một artifact của provider.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth.oidc_state (
    -- Loại artifact. Tập giá trị là TÊN CLASS của provider
    -- (`BaseModel.this.kind = this.constructor.name` — `lib/models/base_model.js:59`),
    -- trùng với tham số `model` mà adapter nhận trong constructor
    -- (`memory_adapter.js:74`: `this.model = model`). CHECK là allowlist đóng: chỉ những
    -- kind mà cấu hình provider của `auth` có thể sinh ra. DeviceCode/
    -- BackchannelAuthenticationRequest/PreAuthorizedCode/PushedAuthorizationRequest
    -- KHÔNG có trong danh sách vì các feature tương ứng bị tắt — nếu sau này bật một
    -- feature, migration mở CHECK phải đi kèm, không phải nới lỏng im lặng.
    kind       text        NOT NULL,

    -- jti của artifact — định danh mà provider dùng cho MỌI lời gọi adapter
    -- (`base_model.js:87`: `this.adapter.upsert(this.jti, payload, ttl)`).
    id         text        NOT NULL,

    -- Payload đầy đủ đã serialize. Provider đọc lại ĐÚNG object này để tái tạo model
    -- (`base_model.js:120-133`: `find()` → `adapter.find` → `verify(stored)` → payload).
    -- Mọi trường mà provider ghi (`exp`, `iat`, `consumed`, `grantId`, `uid`…) nằm ở đây.
    payload    jsonb       NOT NULL,

    -- Hạn của hàng, tính từ TTL mà provider truyền vào `upsert`. Provider tự kiểm hạn
    -- khi đọc (`helpers/jwt.js` `assertPayload`: `timestamp - clockTolerance >= exp` ⇒
    -- hết hạn), nhưng lọc thêm ở SQL (`expires_at > now()`) để hàng chết không còn nhìn
    -- thấy ngay cả khi prune chưa chạy — và để prune có cột để quét.
    expires_at timestamptz NOT NULL,

    -- ⚠️ `consumed_at` (cột) và `payload->>'consumed'` (trong JSON) là HAI BẢN CHÉP của
    -- cùng một sự kiện, cố ý giữ cả hai: provider đọc `consumed` từ payload
    -- (`refresh_token.js:52-54`: `get isValid { return !this.consumed && !this.isExpired }`),
    -- còn prune/vận hành đọc cột. Adapter.consume() ghi CẢ HAI trong một câu UPDATE
    -- (xem `src/oidc/adapter.ts`), nên hai bản chép không thể lệch nhau quá một câu lệnh.
    consumed_at timestamptz,

    -- Secondary index cột cho `revokeByGrantId`. Chỉ các kind trong tập `grantable` của
    -- provider mới mang grantId (`memory_adapter.js:19-27`: AccessToken,
    -- AuthorizationCode, RefreshToken, DeviceCode, BackchannelAuthenticationRequest,
    -- PreAuthorizedCode) — cùng tập đó được lặp lại trong adapter.ts và được test canh.
    grant_id   text,

    -- Secondary index cột cho `Session.findByUid`. Provider map `sessionUid:${uid}` → id
    -- lúc upsert Session (`memory_adapter.js:126-128`); uid là trường `uid` trong payload
    -- (`models/session.js:23-34`).
    uid        text,

    -- Secondary index cột cho `findByUserCode` — device flow. Feature này KHÔNG bật, nên
    -- cột luôn NULL trong thực tế; giữ cột + index vì hợp đồng adapter bắt buộc có
    -- `findByUserCode` (`memory_adapter.js:107-109`) và để bật device flow sau này không
    -- phải sửa bảng.
    user_code  text,

    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT oidc_state_pkey PRIMARY KEY (kind, id),

    CONSTRAINT oidc_state_kind_check
        CHECK (kind IN (
            'Interaction',
            'Session',
            'Grant',
            'AuthorizationCode',
            'AccessToken',
            'RefreshToken',
            'ReplayDetection'
        )),

    -- `consumed` chỉ có nghĩa với kind có vòng đời consume-once. Với Interaction/Session/
    -- Grant/ReplayDetection, `consume()` của adapter không bao giờ được gọi; nếu cột có
    -- giá trị thì đó là bug adapter — chặn ở schema thay vì phát hiện qua log.
    CONSTRAINT oidc_state_consumed_kind_check
        CHECK (consumed_at IS NULL OR kind IN ('AuthorizationCode', 'RefreshToken', 'DeviceCode')),

    -- grantId chỉ tồn tại trên các kind grantable — cùng tập với `memory_adapter.js:19-27`.
    CONSTRAINT oidc_state_grant_kind_check
        CHECK (
            grant_id IS NULL
            OR kind IN ('AuthorizationCode', 'AccessToken', 'RefreshToken', 'DeviceCode')
        ),

    -- Session là kind duy nhất có uid (`memory_adapter.js:126`: chỉ `model === 'Session'`
    -- mới lập chỉ mục `sessionUid`).
    CONSTRAINT oidc_state_uid_kind_check
        CHECK (uid IS NULL OR kind = 'Session')
);

COMMENT ON TABLE auth.oidc_state IS
    'State of the oidc-provider protocol machinery (Interaction/Session/Grant/token). Not the business source of truth - authorization_transactions (0002) holds that role.';

COMMENT ON COLUMN auth.oidc_state.payload IS
    'jsonb payload the provider serializes/deserializes verbatim. Its shape belongs to oidc-provider (IN_PAYLOAD of each model); it must not be read to make business decisions.';

COMMENT ON COLUMN auth.oidc_state.consumed_at IS
    'Column copy of payload.consumed (the provider writes it into the payload on consume). Only consume-once kinds may hold a value.';

-- ---------------------------------------------------------------------------------------------
-- Indexes — đúng bốn đường truy cập của adapter + prune.
-- ---------------------------------------------------------------------------------------------

-- findByUid: Session tra theo uid. UNIQUE khớp ngữ nghĩa của provider: memory adapter map
-- `sessionUid:${uid}` → MỘT id (`memory_adapter.js:126-128`), hai Session sống cùng uid là
-- hỏng adapter. Session.resetIdentifier() (`models/session.js:113-117`) xoá hàng oldId trước
-- khi lưu hàng mới, nên uid không bị trùng trên hàng sống.
CREATE UNIQUE INDEX IF NOT EXISTS oidc_state_session_uid_key
    ON auth.oidc_state (uid)
    WHERE kind = 'Session' AND uid IS NOT NULL;

-- findByUserCode: device flow (không bật). Partial index vì cột luôn NULL — index trên cột
-- toàn NULL chỉ tốn chỗ.
CREATE INDEX IF NOT EXISTS oidc_state_user_code_idx
    ON auth.oidc_state (user_code)
    WHERE user_code IS NOT NULL;

-- revokeByGrantId: thu hồi toàn bộ token của một grant (RFC 7009 + reuse detection).
-- `helpers/revoke.js:32-40` gọi `revokeByGrantId` trên từng model grantable, và
-- `actions/grants/refresh_token.js:107-112` gọi lại khi phát hiện refresh token đã dùng.
CREATE INDEX IF NOT EXISTS oidc_state_grant_id_idx
    ON auth.oidc_state (grant_id)
    WHERE grant_id IS NOT NULL;

-- Prune: dọn hàng hết hạn là job của migrator (cùng học thuyết với `internal_nonces` ở
-- 0010 — runtime không được có đường xoá theo mốc thời gian). Đây là truy vấn duy nhất
-- quét theo `expires_at`.
CREATE INDEX IF NOT EXISTS oidc_state_expires_at_idx
    ON auth.oidc_state (expires_at);

-- Correlation glue: tìm Interaction theo tham số `ecoma_x` (handle X của ECOMA được
-- nhét vào authorize params của provider, khai trong `extraParams`). Lớp glue
-- (`src/oidc/interaction.ts`) cần nó ở POST /internal/session/verified và
-- /internal/consent/decide — các đường back-channel KHÔNG có cookie `_interaction`
-- nên không dùng được `provider.interactionDetails`; phải tra Interaction qua adapter.
-- Expression index tránh quét toàn bộ Interaction khi traffic lớn.
CREATE INDEX IF NOT EXISTS oidc_state_interaction_ecoma_x_idx
    ON auth.oidc_state ((payload->'params'->>'ecoma_x'))
    WHERE kind = 'Interaction';

-- ---------------------------------------------------------------------------------------------
-- Grants — runtime cần ĐỦ vòng đời của provider, không hơn.
--
-- SELECT/INSERT/UPDATE/DELETE: provider upsert mọi lần save (INSERT lẫn UPDATE khi
-- persist), consume là UPDATE, destroy/revokeByGrantId là DELETE (resume của
-- authorization xoá Interaction ngay khi áp result — `actions/authorization/resume.js:71`;
-- revocation xoá token theo grant). Đây là học thuyết nhóm 1 của `0009`, không phải nhóm
-- append-only.
--
-- ⚠️ KHÔNG có DELETE theo mốc thời gian cho runtime: prune (`expires_at`) là job của
-- `ecoma_auth_migrator` — cùng quy tắc mà 0010 dựng cho `internal_nonces`. DELETE của
-- runtime ở đây chỉ đi theo id/grant_id do provider chỉ định, không phải truy vấn dọn dẹp.
--
-- ⚠️ REVOKE TRUNCATE phòng thủ: xoá sạch state provider bằng một câu lệnh là đăng xuất
-- hàng loạt mọi session + thu hồi mọi grant đang sống, và giống 0010, nó không giống
-- prune theo `expires_at` về mặt ngữ nghĩa.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth.oidc_state TO ecoma_auth_runtime;
REVOKE TRUNCATE ON TABLE auth.oidc_state FROM ecoma_auth_runtime;

COMMIT;
