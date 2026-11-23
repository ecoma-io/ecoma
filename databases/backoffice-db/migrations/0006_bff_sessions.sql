-- 0006_bff_sessions.sql — store phiên BFF của `backoffice` (ADR-0012 §3).
--
-- Phiên server-side của BFF: cookie `__Host-backoffice-session` chỉ mang ID
-- phiên; nội dung (token set, `auth_time` đã verify, metadata) nằm ở đây.
-- Cùng pattern `account.account_sessions` — hai giá trị, một hash: cookie
-- nguyên vẹn, DB chỉ thấy `id_hash = SHA-256(id)`.
--
-- ⚠️ Bảng này là **ephemeral protocol state** (invariant 26 của
-- `docs/architecture/01-architecture.md` §9) nhưng vẫn nằm ở PostgreSQL — không
-- KV, không Worker memory. TTL do tầng app enforce (idle 12h + absolute 7d,
-- `server/auth/session-store.ts`); DB không xoá gì tự động — prune là việc
-- vận hành sau, không phải điều kiện correctness (một hàng hết hạn là hàng
-- `isSessionLive` trả `false`, không phải hàng nguy hiểm).
--
-- ⚠️ `access_token`/`refresh_token` là cột **bắt buộc có** ở đây — đây là chỗ
-- duy nhất của app lưu token, và SR-014 cấm token vào log/audit, không cấm
-- storage có ranh giới grant. Cột `access_token` NOT NULL: phiên không token
-- là phiên không hoạt động được; `refresh_token` NULL-able: phiên cấp mà
-- không có `offline_access` thì không có refresh.

BEGIN;

CREATE TABLE IF NOT EXISTS backoffice.bff_sessions (
  -- Hash SHA-256 hex của session ID (cookie value) — khoá tra cứu duy nhất.
  -- Định dạng ghim CHECK: tầng app luôn ghi hex 64 ký tự (`hashSessionIdentifier`).
  id_hash          text PRIMARY KEY,
  -- Account ID của chủ phiên — đã qua verify token trước khi ghi.
  account_sub      text NOT NULL,
  -- Access token hiện hành (JWT của `auth`). Được UPDATE khi refresh rotate.
  access_token     text NOT NULL,
  -- Refresh token opaque của `auth` (NULL khi phiên không xin `offline_access`).
  refresh_token    text,
  -- `auth_time` từ ID token đã verify lúc code exchange (ADR-0012 §3 step-up).
  auth_time        timestamptz,
  -- ACR của lần xác thực — audit-only, không là điều kiện allow.
  acr              text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Mốc idle expiry — tầng app trượt nó ở mỗi request hợp lệ (sliding).
  expires_at       timestamptz NOT NULL,
  -- Logout / refresh-reuse đánh dấu revoke; hàng giữ lại để điều tra.
  revoked_at       timestamptz,
  -- `expires_at` phải là mốc tương lai tại thời điểm ghi: một hàng sinh ra
  -- đã hết hạn là hàng bịa (bug tầng app) — DB chặn.
  CONSTRAINT bff_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT bff_sessions_account_id_format_check
    CHECK (account_sub ~ '^sub_[a-z2-7]{32}$'),
  CONSTRAINT bff_sessions_id_hash_format_check CHECK (id_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE backoffice.bff_sessions IS
  'Server-side BFF session of backoffice (ADR-0012): the cookie carries only an ID, the token set lives here. Tokens are never logged (SR-014).';

-- Phiên append-then-revoke: UPDATE chỉ cho phép đổi `expires_at` (sliding),
-- `access_token` (refresh rotate), `revoked_at` (logout/reuse) — không đường
-- nào đổi chủ phiên hay mốc tạo. Guard theo đúng pattern `account_sessions`
-- (trigger guard của `account` migration 0001).
CREATE OR REPLACE FUNCTION backoffice.bff_sessions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_sub <> OLD.account_sub
     OR NEW.created_at <> OLD.created_at
     OR NEW.id_hash <> OLD.id_hash THEN
    RAISE EXCEPTION
      'bff_sessions: chi expires_at, access_token, refresh_token, auth_time, acr, revoked_at duoc phep doi';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bff_sessions_immutable_guard ON backoffice.bff_sessions;
CREATE TRIGGER bff_sessions_immutable_guard
  BEFORE UPDATE ON backoffice.bff_sessions
  FOR EACH ROW EXECUTE FUNCTION backoffice.bff_sessions_immutable_guard();

COMMENT ON FUNCTION backoffice.bff_sessions_immutable_guard() IS
  'Blocks changing the session owner, id_hash or created_at after INSERT (the account_sessions guard pattern).';

-- ---------------------------------------------------------------------------
-- Grant cho runtime role
-- ---------------------------------------------------------------------------
--
-- Phiên là state ứng dụng sống động: SELECT (đọc mỗi request), INSERT (tạo
-- lúc callback), UPDATE (sliding idle, refresh rotate, revoke) và DELETE
-- (prune phiên hết hạn là dọn protocol state, không phải xoá lịch sử điều
-- tra — khác `authorization_audit`/`role_assignments`: nội dung phiên là
-- token đã sinh lại được bằng login, không có giá trị lịch sử sau khi hết
-- hạn). Mốc của account: `account_sessions` có đủ bốn quyền ở runtime role.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE backoffice.bff_sessions
  TO ecoma_backoffice_runtime;

-- ---------------------------------------------------------------------------
-- `bff_login_flows` — hàng luồng login-in-progress (state + PKCE verifier)
-- ---------------------------------------------------------------------------
--
-- Invariant 26: state/PKCE challenge là ephemeral protocol state — nằm ở
-- database, single-use, TTL. Hàng được **consume bằng DELETE** ở callback
-- (`consumeLoginFlow`): rowCount 0 nghĩa là replay/lặp/hết hạn — không có
-- đường "đọc rồi xoá sau". `code_verifier` là giá trị nhạy cảm nhất của luồng
-- (biết verifier + code là đổi được token) nên nó chỉ sống trong bảng này và
-- biến cục bộ của handler — không cookie, không log (SR-014).
CREATE TABLE IF NOT EXISTS backoffice.bff_login_flows (
  id_hash      text PRIMARY KEY,
  -- Giá trị `state` truyền qua authorize URL và callback so khớp.
  state        text NOT NULL,
  code_verifier text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  CONSTRAINT bff_login_flows_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT bff_login_flows_id_hash_format_check CHECK (id_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE backoffice.bff_login_flows IS
  'The BFF login-in-progress flow: state + PKCE verifier, consumed by DELETE (single-use, 10-minute TTL). ADR-0012 1.';

-- Luồng login là write-once-consume-once: runtime không cần UPDATE (không có
-- gì để trượt hay rotate) — DELETE là consume, và DELETE hàng hết hạn là dọn.
GRANT SELECT, INSERT, DELETE ON TABLE backoffice.bff_login_flows
  TO ecoma_backoffice_runtime;

COMMIT;
