-- 0001_pact_broker_app_bff_sessions.sql — store phiên BFF của `pact-broker-app`
-- (ADR-0031 §2), bảng trong database riêng `db-pact-broker-app` của app.
--
-- Cùng pattern `backoffice.bff_sessions` (ADR-0012 §3) và `account_sessions`:
-- hai giá trị, một hash — cookie `__Host-pact-broker-session` chỉ mang ID
-- phiên (256-bit base64url), DB chỉ thấy `id_hash = SHA-256(id)`. Token set
-- nằm CHỈ ở đây; cookie không bao giờ mang token, token không bao giờ vào log
-- (SR-007).
--
-- ⚠️ Ephemeral protocol state (invariant 26, `01-architecture.md` §9) nhưng
-- vẫn nằm ở PostgreSQL — không KV, không Worker memory. TTL do tầng app
-- enforce (idle 12h + absolute 7d, `server/auth/session.ts`); DB không xoá tự
-- động — prune là việc vận hành sau.
--
-- Khác `backoffice.bff_sessions` ở M1: KHÔNG có cột `auth_time`/`acr` —
-- ADR-0031 §2 quyết định ID token KHÔNG được verify trong M1, không có step-up
-- evidence nào để lưu. Expand-friendly: cột thêm sau bằng migration sau, hợp
-- rollout compatible; thay vì dựng cột chết ngay từ đầu.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tạo role (lưới an toàn) trước schema + schema `pact_broker_app`
-- ---------------------------------------------------------------------------
-- Giống `pact.tenants` (0001 của db-pact-broker): `CREATE SCHEMA` cần `CREATE`
-- trên database — quyền đó là provisioning step của deploy (`GRANT CONNECT,
-- CREATE, TEMPORARY ... TO migrator`), migration không tự cấp được (một role
-- không GRANT được thứ nó không có). Khối DO dưới đây chỉ để file chạy được
-- một mình trên cluster sạch của test.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_pact_broker_app_migrator') THEN
    CREATE ROLE ecoma_pact_broker_app_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_pact_broker_app_runtime') THEN
    CREATE ROLE ecoma_pact_broker_app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS pact_broker_app;

COMMENT ON SCHEMA pact_broker_app IS
  'Schema of db-pact-broker-app (the BFF session store of pact-broker-app). The runtime role has DML only here; grants are at the bottom of this file.';

CREATE TABLE IF NOT EXISTS pact_broker_app.bff_sessions (
  -- Hash SHA-256 hex của session ID (cookie value) — khoá tra cứu duy nhất.
  -- Định dạng ghim CHECK: tầng app luôn ghi hex 64 ký tự.
  id_hash       text PRIMARY KEY,
  -- Subject của chủ phiên — đã qua verify access token trước khi ghi.
  account_sub   text NOT NULL,
  -- Access token hiện hành (JWT của `auth`) — BFF forward token này tới API.
  -- Được UPDATE khi đường refresh hoạt động sau này; guard bên dưới ghim các
  -- cột còn lại bất biến.
  access_token  text NOT NULL,
  -- Refresh token opaque của `auth` (NULL khi phiên không có `offline_access`).
  refresh_token text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Mốc idle expiry — tầng app trượt nó ở mỗi request hợp lệ (sliding).
  expires_at    timestamptz NOT NULL,
  -- Logout đánh dấu revoke; hàng giữ lại để điều tra.
  revoked_at    timestamptz,
  -- Mốc hết hạn phải là tương lai tại thời điểm ghi: hàng sinh ra đã hết hạn
  -- là hàng bịa (bug tầng app) — DB chặn.
  CONSTRAINT bff_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT bff_sessions_id_hash_format_check CHECK (id_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE pact_broker_app.bff_sessions IS
  'Server-side BFF session of pact-broker-app (ADR-0031): the cookie carries only an ID, the access token lives here. Tokens are never logged (SR-007).';

-- Tra cứu theo chủ phiên (revocation hàng loạt khi account bị treo/đổi mật
-- khẩu) không được quét bảng — index btree trên account_sub.
CREATE INDEX IF NOT EXISTS bff_sessions_account_sub_idx
  ON pact_broker_app.bff_sessions (account_sub);

-- Dọn phiên hết hạn (prune) và tra cứu phiên sống theo mốc idle — index trên
-- expires_at. `revoked_at` đa số NULL, selectivity kém; truy vấn revoked luôn
-- kèm id_hash (khoá chính) nên không cần index riêng.
CREATE INDEX IF NOT EXISTS bff_sessions_expires_at_idx
  ON pact_broker_app.bff_sessions (expires_at);

-- Phiên append-then-revoke: UPDATE chỉ cho phép đổi `expires_at` (sliding),
-- `access_token` (refresh rotate sau này), `revoked_at` (logout) — không đường
-- nào đổi chủ phiên hay mốc tạo. Cùng guard pattern `account_sessions`/`bff_sessions`.
CREATE OR REPLACE FUNCTION pact_broker_app.bff_sessions_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_sub <> OLD.account_sub
     OR NEW.created_at <> OLD.created_at
     OR NEW.id_hash <> OLD.id_hash THEN
    RAISE EXCEPTION
      'bff_sessions: only expires_at, access_token, refresh_token and revoked_at may change';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bff_sessions_immutable_guard ON pact_broker_app.bff_sessions;
CREATE TRIGGER bff_sessions_immutable_guard
  BEFORE UPDATE ON pact_broker_app.bff_sessions
  FOR EACH ROW EXECUTE FUNCTION pact_broker_app.bff_sessions_immutable_guard();

COMMENT ON FUNCTION pact_broker_app.bff_sessions_immutable_guard() IS
  'Blocks changing the session owner, id_hash or created_at after INSERT (the account_sessions guard pattern).';

-- Phiên là state ứng dụng sống động: SELECT (mỗi request), INSERT (callback),
-- UPDATE (sliding/revoke) và DELETE (prune phiên hết hạn là dọn protocol
-- state — nội dung phiên là token sinh lại được bằng login, không có giá trị
-- lịch sử sau khi hết hạn).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pact_broker_app.bff_sessions
  TO ecoma_pact_broker_app_runtime;

-- ---------------------------------------------------------------------------
-- `bff_login_flows` — hàng luồng login-in-progress (state + PKCE verifier)
-- ---------------------------------------------------------------------------
--
-- Invariant 26: state/PKCE challenge là ephemeral protocol state — database,
-- single-use, TTL. Hàng được consume bằng DELETE ở callback (`consumeLoginFlow`):
-- rowCount 0 nghĩa là replay/lặp/hết hạn. `code_verifier` là giá trị nhạy cảm
-- nhất của luồng — chỉ sống trong bảng này và biến cục bộ của handler, không
-- cookie, không log (SR-007).
CREATE TABLE IF NOT EXISTS pact_broker_app.bff_login_flows (
  id_hash       text PRIMARY KEY,
  -- Giá trị `state` truyền qua authorize URL và callback so khớp.
  state         text NOT NULL,
  code_verifier text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CONSTRAINT bff_login_flows_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT bff_login_flows_id_hash_format_check CHECK (id_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE pact_broker_app.bff_login_flows IS
  'The BFF login-in-progress flow: state + PKCE verifier, consumed by DELETE (single-use, 10-minute TTL). ADR-0031 2.';

-- Prune hàng hết hạn không được quét bảng — cùng luật `expires_at` của
-- `bff_sessions`.
CREATE INDEX IF NOT EXISTS bff_login_flows_expires_at_idx
  ON pact_broker_app.bff_login_flows (expires_at);

-- Write-once-consume-once: runtime không cần UPDATE — DELETE là consume, và
-- DELETE hàng hết hạn là dọn.
GRANT SELECT, INSERT, DELETE ON TABLE pact_broker_app.bff_login_flows
  TO ecoma_pact_broker_app_runtime;

-- Runtime chỉ thấy schema `pact_broker_app` — USAGE trước khi DML nào có nghĩa.
GRANT USAGE ON SCHEMA pact_broker_app TO ecoma_pact_broker_app_runtime;

COMMIT;
