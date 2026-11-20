-- 0001_remote_cache_app_bff_sessions.sql — store phiên BFF của `remote-cache-app`
-- (ADR-0035), bảng trong database riêng `db-remote-cache-app` của portal.
--
-- Deliberate duplication của `pact_broker_app.bff_sessions` (ADR-0031 §2,
-- migration 0001 của pact-broker-app) và `backoffice.bff_sessions` — import chéo
-- deploy unit bị cấm (05-code-architecture.md §7). ADR-0035 chốt portal sở hữu
-- session store riêng theo đúng pattern đã ship hai lần.
--
-- Cùng pattern: hai giá trị, một hash — cookie `__Host-remote-cache-app-session`
-- chỉ mang ID phiên (256-bit base64url), DB chỉ thấy `id_hash = SHA-256(id)`.
-- Token set nằm CHỈ ở đây; cookie không bao giờ mang token, token không bao giờ
-- vào log (SR-007).
--
-- ⚠️ Ephemeral protocol state (invariant 26) nhưng vẫn nằm ở PostgreSQL — không
-- KV, không Worker memory. TTL do tầng app enforce (idle 12h + absolute 7d,
-- `server/auth/session.ts`); DB không xoá tự động — prune là việc vận hành sau.
--
-- Khác backoffice ở M1: KHÔNG có cột `auth_time`/`acr` — ADR-0031 §2 quyết định
-- ID token KHÔNG được verify trong M1, không có step-up evidence nào để lưu.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tạo role (lưới an toàn) trước schema + schema `remote_cache_app`
-- ---------------------------------------------------------------------------
-- `CREATE SCHEMA` cần `CREATE` trên database — quyền đó là provisioning step
-- của deploy (`GRANT CONNECT, CREATE, TEMPORARY ... TO migrator`). Khối DO
-- dưới đây chỉ để file chạy được một mình trên cluster sạch của test.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_remote_cache_app_migrator') THEN
    CREATE ROLE ecoma_remote_cache_app_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_remote_cache_app_runtime') THEN
    CREATE ROLE ecoma_remote_cache_app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS remote_cache_app;

COMMENT ON SCHEMA remote_cache_app IS
  'Schema of db-remote-cache-app (the BFF session store of remote-cache-app, ADR-0035). The runtime role has DML only here; grants are at the bottom of this file.';

CREATE TABLE IF NOT EXISTS remote_cache_app.bff_sessions (
  -- Hash SHA-256 hex của session ID (cookie value) — khoá tra cứu duy nhất.
  id_hash       text PRIMARY KEY,
  -- Subject của chủ phiên — đã qua verify access token trước khi ghi.
  account_sub   text NOT NULL,
  -- Access token hiện hành (JWT của `auth`) — BFF ký envelope HMAC với actor
  -- sub từ nó khi gọi control plane; KHÔNG forward cho browser.
  access_token  text NOT NULL,
  -- Refresh token opaque của `auth` (NULL khi phiên không có `offline_access`).
  refresh_token text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Mốc idle expiry — tầng app trượt nó ở mỗi request hợp lệ (sliding).
  expires_at    timestamptz NOT NULL,
  -- Logout đánh dấu revoke; hàng giữ lại để điều tra.
  revoked_at    timestamptz,
  CONSTRAINT bff_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT bff_sessions_id_hash_format_check CHECK (id_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE remote_cache_app.bff_sessions IS
  'Server-side BFF session of remote-cache-app (ADR-0035): the cookie carries only an ID, the access token lives here. Tokens are never logged (SR-007).';

CREATE INDEX IF NOT EXISTS bff_sessions_account_sub_idx
  ON remote_cache_app.bff_sessions (account_sub);

CREATE INDEX IF NOT EXISTS bff_sessions_expires_at_idx
  ON remote_cache_app.bff_sessions (expires_at);

-- Phiên append-then-revoke: UPDATE chỉ cho phép đổi `expires_at` (sliding),
-- `access_token` (refresh rotate sau này), `revoked_at` (logout) — không đường
-- nào đổi chủ phiên hay mốc tạo.
CREATE OR REPLACE FUNCTION remote_cache_app.bff_sessions_immutable_guard()
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

DROP TRIGGER IF EXISTS bff_sessions_immutable_guard ON remote_cache_app.bff_sessions;
CREATE TRIGGER bff_sessions_immutable_guard
  BEFORE UPDATE ON remote_cache_app.bff_sessions
  FOR EACH ROW EXECUTE FUNCTION remote_cache_app.bff_sessions_immutable_guard();

COMMENT ON FUNCTION remote_cache_app.bff_sessions_immutable_guard() IS
  'Blocks changing the session owner, id_hash or created_at after INSERT (the account_sessions guard pattern).';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE remote_cache_app.bff_sessions
  TO ecoma_remote_cache_app_runtime;

-- ---------------------------------------------------------------------------
-- `bff_login_flows` — hàng luồng login-in-progress (state + PKCE verifier)
-- ---------------------------------------------------------------------------
--
-- Invariant 26: state/PKCE challenge là ephemeral protocol state — database,
-- single-use, TTL. Hàng được consume bằng DELETE ở callback (`consumeLoginFlow`):
-- rowCount 0 nghĩa là replay/lặp/hết hạn. `code_verifier` là giá trị nhạy cảm
-- nhất của luồng — chỉ sống trong bảng này và biến cục bộ của handler, không
-- cookie, không log (SR-007).
CREATE TABLE IF NOT EXISTS remote_cache_app.bff_login_flows (
  id_hash       text PRIMARY KEY,
  state         text NOT NULL,
  code_verifier text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CONSTRAINT bff_login_flows_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT bff_login_flows_id_hash_format_check CHECK (id_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE remote_cache_app.bff_login_flows IS
  'The BFF login-in-progress flow: state + PKCE verifier, consumed by DELETE (single-use, 10-minute TTL). ADR-0035 follows the ADR-0031 2 pattern.';

CREATE INDEX IF NOT EXISTS bff_login_flows_expires_at_idx
  ON remote_cache_app.bff_login_flows (expires_at);

GRANT SELECT, INSERT, DELETE ON TABLE remote_cache_app.bff_login_flows
  TO ecoma_remote_cache_app_runtime;

GRANT USAGE ON SCHEMA remote_cache_app TO ecoma_remote_cache_app_runtime;

COMMIT;
