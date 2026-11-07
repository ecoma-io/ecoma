-- 0001_tenant_and_pact_domain.sql — schema lõi của `db-pact-broker`.
--
-- Bốn nhóm bảng, đúng thứ tự phụ thuộc:
--   (a) tenant + membership + machine token — lớp Ecoma, không có tương đương
--       upstream (`bison-digital/pact-broker-workers` là single-tenant);
--   (b) domain Pact (pacticipants → versions → tags/pacts → verifications,
--       environments → deployed_versions) — port từ upstream, thêm `tenant_id`
--       và composite UNIQUE/FK (xem `UPSTREAM_MAPPING.md` §5.2);
--   (c) audit append-only;
--   (d) internal nonces — chỉ dùng khi có contract nội bộ; tạo sẵn để không
--       phải expand sau (bảng không dùng không phải lỗi, bảng thiếu là).
--
-- Quy ước chung (giống `apps/account/db/migrations/`):
--   * Apply theo thứ tự tên file; KHÔNG có ledger — apply lại là no-op nên
--     mọi câu DDL idempotent (`CREATE ... IF NOT EXISTS`, grant lặp được).
--   * Mọi cột thời gian là `timestamptz` (NFR-001), UTC theo provision.
--   * Schema ứng dụng tên `pact`; runtime role chỉ có DML trên schema này.
--   * KHÔNG FK trỏ sang database khác, KHÔNG dblink/postgres_fdw
--     (NFR-002b của identity, áp dụng nguyên văn cho mọi service).
--   * `sub` là tham chiếu opaque sang identity — không FK, đúng quy ước
--     `sub` không tái sử dụng của `db-account`.
--
-- Điểm KHÁC upstream phải giữ tường minh ở đây:
--   * `UNIQUE` của `pacticipants.name`/`environments.name` là toàn cục ở
--     upstream (`schema.ts:9`, `:112`) → thành composite `(tenant_id, name)`.
--   * `pacts` unique `(consumer_version_id, provider_id)` → thêm `tenant_id`.
--     Composite FK về `versions (tenant_id, id)` là lớp enforce thật của ranh
--     giới tenant: một row tham chiếu version của tenant khác bị DB từ chối
--     ngay cả khi code có bug — không phụ thuộc WHERE clause.
--   * Tie-break `id DESC` của upstream (`datetime('now')` độ phân giải giây)
--     được giữ: `created_at` thành `timestamptz` microsecond nhưng hai row
--     trong cùng transaction vẫn tie — mọi truy vấn "latest" phải
--     `ORDER BY created_at DESC, id DESC` (`docs/architecture/…` không ghi điều
--     này; nó nằm trong test `latest-version-ordering` khi port).

BEGIN;

-- ---------------------------------------------------------------------------
-- Tạo role (lưới an toàn) trước schema
-- ---------------------------------------------------------------------------
-- Giống `0001_identity_core.sql`: `CREATE SCHEMA` cần `CREATE` trên database
-- — quyền đó là provisioning step 1, migration không tự cấp được (một role
-- không GRANT được thứ nó không có). Khối DO dưới đây chỉ để file chạy được
-- một mình trên cluster sạch của test.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_pact_broker_migrator') THEN
    CREATE ROLE ecoma_pact_broker_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_pact_broker_runtime') THEN
    CREATE ROLE ecoma_pact_broker_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS pact;

COMMENT ON SCHEMA pact IS
  'Schema ung dung cua db-pact-broker. Runtime role chi co DML o day; grant cap o cuoi file nay.';

-- ---------------------------------------------------------------------------
-- (a) tenants — ranh giới tenant
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_name_format_check CHECK (name ~ '^[a-zA-Z0-9._-]{1,255}$'),
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'deleted'))
);

-- UNIQUE(name) toàn cục như upstream sẽ cho một tenant chặn tên của tenant
-- khác; tên tenant là duy nhất trên toàn broker vì nó xuất hiện trong URL
-- dashboard. Composite index prefix tenant_id phục vụ mọi query theo tenant.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_name_key ON pact.tenants (name);
CREATE INDEX IF NOT EXISTS tenants_status_idx ON pact.tenants (status)
  WHERE status <> 'active';

COMMENT ON TABLE pact.tenants IS
  'Ran hoi tenant cua broker. Moi domain data gan tenant_id NOT NULL; composite FK la lop enforce that.';
COMMENT ON COLUMN pact.tenants.name IS
  'Ten tenant, regex giong nameSchema upstream ([a-zA-Z0-9._-], max 255). Duy nhat toan broker.';

-- ---------------------------------------------------------------------------
-- (a) tenant_members — membership + RBAC
-- ---------------------------------------------------------------------------
-- `sub` là tham chiếu opaque sang identity, không FK (quy ước chung).
-- Role là dữ liệu CỦA broker: không suy ra từ backoffice hay scope nào khác
-- (A21 của docs/architecture/01-architecture.md §2.2).

CREATE TABLE IF NOT EXISTS pact.tenant_members (
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  sub text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_members_role_check CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  CONSTRAINT tenant_members_pk PRIMARY KEY (tenant_id, sub)
);

COMMENT ON TABLE pact.tenant_members IS
  'Membership va role cua broker: owner|admin|member|viewer. sub la tham chieu opaque, KHONG FK.';
COMMENT ON COLUMN pact.tenant_members.sub IS
  'sub cua identity. Khong FK, khong tai su dung phat hanh la viec cua identity.';

CREATE INDEX IF NOT EXISTS tenant_members_sub_idx ON pact.tenant_members (sub);

-- ---------------------------------------------------------------------------
-- (a) machine_tokens — credential cho Pact CLI/CI
-- ---------------------------------------------------------------------------
-- Token chỉ lưu HASH (SHA-256 hex), plaintext hiện một lần trong response của
-- lệnh tạo rồi mất — không đường nào đọc lại (SR-002). Revoke = set
-- `revoked_at`, hiệu lực tức thời vì mọi request tra hash rồi check.
-- Pattern: `libs/auth-application/src/token-service.ts` (32B entropy
-- base64url, SHA-256) + `apps/auth/migrations/0005_refresh_tokens.sql`
-- (`token_hash` UNIQUE) + `0006_token_revocations.sql` (control plane tách
-- khỏi trạng thái thực thi).

CREATE TABLE IF NOT EXISTS pact.machine_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  name text NOT NULL,
  scopes text NOT NULL,
  created_by_sub text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- Không có `last_used_at`: ghi nó đòi UPDATE trên mọi request (serving-path
  -- dependency của observability, trái bất biến §Non-negotiable); muốn usage
  -- tracking thì dùng audit_events (append-only, off-path).
  -- Scope là tập cố định, phân tách dấu cách; token không scope nào = vô dụng.
  CONSTRAINT machine_tokens_scopes_check CHECK (
    scopes ~ '^(read|write|admin)( (read|write|admin))*$'
  ),
  CONSTRAINT machine_tokens_name_format_check CHECK (name ~ '^.{1,255}$'),
  -- Token đã revoke phải có thời điểm revoke.
  CONSTRAINT machine_tokens_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at > created_at)
);

-- Truy vấn của mọi request API: tra hash → tenant + scopes + revoked_at.
-- PK `token_hash` UNIQUE là index tra cứu; index theo tenant phục vụ list.
CREATE INDEX IF NOT EXISTS machine_tokens_tenant_idx
  ON pact.machine_tokens (tenant_id, created_at DESC);

COMMENT ON TABLE pact.machine_tokens IS
  'Machine token cho Pact CLI/CI. Chi luu hash SHA-256; plaintext hien mot lan khi tao (SR-002).';
COMMENT ON COLUMN pact.machine_tokens.token_hash IS
  'SHA-256 hex cua token. Tra cuu bang chinh PK nay; khong luu plaintext o bat ky dau.';
COMMENT ON COLUMN pact.machine_tokens.scopes IS
  'Tap scope phan tach dau cach: read (viewer+), write (member+), admin (admin+). Khong co scope = token vo dung.';

-- ---------------------------------------------------------------------------
-- (b) pacticipants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.pacticipants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  name text NOT NULL,
  -- mainBranch giữ semantics upstream (`schema.ts:10`, default 'main'):
  -- chỉ đọc ở getPactsForVerification, không endpoint nào ghi nó ở port đầu.
  main_branch text NOT NULL DEFAULT 'main',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Mục tiêu của composite FK `(tenant_id, id)` từ versions/pacts/webhooks:
  -- PostgreSQL đòi UNIQUE CONSTRAINT (không nhận CREATE UNIQUE INDEX) trên
  -- đúng cặp cột được tham chiếu, nên cặp này là CONSTRAINT chứ không index.
  CONSTRAINT pacticipants_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT pacticipants_name_format_check CHECK (name ~ '^[a-zA-Z0-9._-]{1,255}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS pacticipants_tenant_name_key
  ON pact.pacticipants (tenant_id, name);

COMMENT ON TABLE pact.pacticipants IS
  'Consumer/provider trong mot tenant. UNIQUE (tenant_id, name) thay cho UNIQUE name toan cuc cua upstream.';
COMMENT ON COLUMN pact.pacticipants.main_branch IS
  'Branch chinh cho selector mainBranch cua for-verification; default main, giup semantics upstream.';

-- ---------------------------------------------------------------------------
-- (b) versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  pacticipant_id uuid NOT NULL,
  number text NOT NULL,
  branch text,
  build_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- UNIQUE thay cho upstream `(pacticipant_id, number)` — thêm tenant.
  CONSTRAINT versions_tenant_pacticipant_number_key UNIQUE (tenant_id, pacticipant_id, number),
  -- Composite FK: version phải thuộc CÙNG tenant với pacticipant của nó.
  CONSTRAINT versions_pacticipant_fk
    FOREIGN KEY (tenant_id, pacticipant_id)
    REFERENCES pact.pacticipants (tenant_id, id) ON DELETE RESTRICT,
  -- Mục tiêu của composite FK từ tags/pacts/verifications/deployed_versions.
  CONSTRAINT versions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT versions_number_format_check CHECK (number ~ '^.{1,255}$'),
  CONSTRAINT versions_branch_format_check CHECK (branch IS NULL OR branch ~ '^.{1,255}$')
);

-- Mọi truy vấn "latest" của broker đều `ORDER BY created_at DESC, id DESC`
-- theo pacticipant; index gắn đúng câu đó.
CREATE INDEX IF NOT EXISTS versions_pacticipant_created_idx
  ON pact.versions (tenant_id, pacticipant_id, created_at DESC, id DESC);

COMMENT ON TABLE pact.versions IS
  'Version cua pacticipant. branch/build_url backfill-only khi publish; ghi de tường minh qua branch-version PUT (semantics upstream).';
COMMENT ON COLUMN pact.versions.branch IS
  'Branch tường minh. getOrCreateVersion CHI backfill khi trống; recordVersionBranch (PUT branch-version) mới ghi đè.';

-- ---------------------------------------------------------------------------
-- (b) tags
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_tenant_version_name_key UNIQUE (tenant_id, version_id, name),
  CONSTRAINT tags_version_fk
    FOREIGN KEY (tenant_id, version_id)
    REFERENCES pact.versions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tags_name_format_check CHECK (name ~ '^.{1,255}$')
);

-- "Latest version mang tag X" = join tags → versions rồi sort; index phục vụ.
CREATE INDEX IF NOT EXISTS tags_tenant_name_idx ON pact.tags (tenant_id, name, created_at DESC);

COMMENT ON TABLE pact.tags IS
  'Tag gan version. Composite FK versions giữ tag không lọt sang version cua tenant khac.';

-- ---------------------------------------------------------------------------
-- (b) pacts — nội dung hợp đồng + content SHA
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.pacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  consumer_version_id uuid NOT NULL,
  content jsonb NOT NULL,
  content_sha text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Thay cho UNIQUE (consumer_version_id, provider_id) của upstream.
  CONSTRAINT pacts_tenant_consumer_version_provider_key UNIQUE (tenant_id, consumer_version_id, provider_id),
  CONSTRAINT pacts_consumer_version_fk
    FOREIGN KEY (tenant_id, consumer_version_id)
    REFERENCES pact.versions (tenant_id, id) ON DELETE RESTRICT,
  -- consumer/provider/pacticipant phải cùng tenant với version phát hành.
  CONSTRAINT pacts_consumer_fk
    FOREIGN KEY (tenant_id, consumer_id)
    REFERENCES pact.pacticipants (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pacts_provider_fk
    FOREIGN KEY (tenant_id, provider_id)
    REFERENCES pact.pacticipants (tenant_id, id) ON DELETE RESTRICT,
  -- Mục tiêu của composite FK từ verifications.
  CONSTRAINT pacts_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT pacts_consumer_provider_distinct_check CHECK (consumer_id <> provider_id),
  CONSTRAINT pacts_content_sha_format_check CHECK (content_sha ~ '^[a-f0-9]{64}$')
);

-- Đường verification của verifier: tra pact theo (tenant, provider, consumer,
-- content_sha). ⚠️ ĐÂY là chỗ vá cross-tenant leak của upstream: DO tra pact
-- chỉ theo content SHA (`pact-broker.ts:478-480`) — hai tenant có pact giống
-- nhau byte-for-byte thì verification của tenant B ghi vào pact của tenant A.
-- Lookup ở đây luôn kèm tenant + provider + consumer.
CREATE UNIQUE INDEX IF NOT EXISTS pacts_tenant_sha_key
  ON pact.pacts (tenant_id, provider_id, consumer_id, content_sha);

CREATE INDEX IF NOT EXISTS pacts_tenant_provider_created_idx
  ON pact.pacts (tenant_id, provider_id, created_at DESC, id DESC);

COMMENT ON TABLE pact.pacts IS
  'Noi dung pact (jsonb) + SHA-256. Publish: doi SHA — update-in-place, 201 moi / 200 da co (semantics upstream).';
COMMENT ON COLUMN pact.pacts.content_sha IS
  'SHA-256 hex cua JSON.stringify(content). Tra pact cho verification PHAI kem tenant+provider+consumer (leak upstream: tra theo sha toan cuc).';

-- ---------------------------------------------------------------------------
-- (b) verifications — append-only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  pact_id uuid NOT NULL,
  provider_version_id uuid NOT NULL,
  success boolean NOT NULL,
  verified_by text,
  build_url text,
  verified_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifications_pact_fk
    FOREIGN KEY (tenant_id, pact_id)
    REFERENCES pact.pacts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT verifications_provider_version_fk
    FOREIGN KEY (tenant_id, provider_version_id)
    REFERENCES pact.versions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT verifications_build_url_format_check CHECK (build_url IS NULL OR length(build_url) <= 2048)
);

-- "Verification mới nhất của pact" — tie-break id DESC như upstream (`:551`).
CREATE INDEX IF NOT EXISTS verifications_pact_verified_idx
  ON pact.verifications (tenant_id, pact_id, verified_at DESC, id DESC);

COMMENT ON TABLE pact.verifications IS
  'Ket qua verify. Append-only: khong UPDATE trong code; khong UNIQUE nho them (upstream cung khong co).';
COMMENT ON COLUMN pact.verifications.provider_version_id IS
  'providerApplicationVersion bắt buộc khi publish (routes/verifications.ts:94 upstream) → luôn có version.';

-- ---------------------------------------------------------------------------
-- (b) environments + deployed_versions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  name text NOT NULL,
  -- displayName trong HAL response upstream (routes/environments.ts:26,32);
  -- NULL = client không gửi, response lặp lại `name` (getOrCreateEnvironment
  -- upstream lưu displayName undefined thành null).
  display_name text,
  production boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Mục tiêu của composite FK từ deployed_versions.
  CONSTRAINT environments_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT environments_name_format_check CHECK (name ~ '^[a-zA-Z0-9_-]{1,100}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS environments_tenant_name_key
  ON pact.environments (tenant_id, name);

COMMENT ON TABLE pact.environments IS
  'Môi trường triển khai theo tenant. UNIQUE (tenant_id, name) thay UNIQUE name toan cuc cua upstream.';

CREATE TABLE IF NOT EXISTS pact.deployed_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  version_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  -- NULL = đang deploy; set = đã undeploy (soft-delete semantics upstream `:890`).
  undeployed_at timestamptz,
  -- ⚠️ KHÔNG có UNIQUE (tenant_id, version_id, environment_id) ở đây: recordDeployment
  -- semantics upstream cho phép re-record (hàng cũ undeployed + hàng mới đang chạy),
  -- ràng buộc "một hàng active" là partial unique index bên dưới.
  CONSTRAINT deployed_versions_version_fk
    FOREIGN KEY (tenant_id, version_id)
    REFERENCES pact.versions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT deployed_versions_environment_fk
    FOREIGN KEY (tenant_id, environment_id)
    REFERENCES pact.environments (tenant_id, id) ON DELETE RESTRICT
);

-- recordDeployment semantics upstream: re-record = set undeployed_at cho hàng
-- cũ rồi INSERT hàng mới. UNIQUE chỉ áp khi ĐANG deploy: partial unique.
CREATE UNIQUE INDEX IF NOT EXISTS deployed_versions_active_key
  ON pact.deployed_versions (tenant_id, version_id, environment_id)
  WHERE undeployed_at IS NULL;

CREATE INDEX IF NOT EXISTS deployed_versions_env_active_idx
  ON pact.deployed_versions (tenant_id, environment_id, deployed_at DESC)
  WHERE undeployed_at IS NULL;

COMMENT ON TABLE pact.deployed_versions IS
  'Version đang/đã deploy theo environment. undeployed_at NULL = đang deploy; re-record = đóng hàng cũ, INSERT hàng mới.';
COMMENT ON INDEX pact.deployed_versions_active_key IS
  'Một version chỉ ĐANG deploy ở một environment một lần; lịch sử undeploy được giữ vô hạn.';

-- ---------------------------------------------------------------------------
-- (b) webhooks + webhook_executions (schema tạo sẵn; outbound TẮT — SR-006)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  consumer_id uuid,
  provider_id uuid,
  events text NOT NULL,
  url text NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  username text,
  password text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhooks_events_format_check CHECK (events ~ '^[a-z_]+(,[a-z_]+)*$'),
  CONSTRAINT webhooks_url_https_check CHECK (url ~ '^https://'),
  CONSTRAINT webhooks_target_fk
    FOREIGN KEY (tenant_id, consumer_id) REFERENCES pact.pacticipants (tenant_id, id),
  CONSTRAINT webhooks_target_provider_fk
    FOREIGN KEY (tenant_id, provider_id) REFERENCES pact.pacticipants (tenant_id, id),
  -- Mục tiêu của composite FK từ webhook_executions.
  CONSTRAINT webhooks_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT webhooks_has_target_check CHECK (consumer_id IS NOT NULL OR provider_id IS NOT NULL)
);

COMMENT ON TABLE pact.webhooks IS
  'Cấu hình webhook. events CSV giữ format upstream (webhooks.events), headers jsonb thay JSON string.';
COMMENT ON COLUMN pact.webhooks.url IS
  'HTTPS-only chặn ở CHECK. Outbound execution TẮT ở production path cho tới khi có SSRF guard (SR-006).';

CREATE TABLE IF NOT EXISTS pact.webhook_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES pact.tenants (id) ON DELETE RESTRICT,
  webhook_id uuid NOT NULL,
  event text NOT NULL,
  trigger text NOT NULL,
  attempt integer NOT NULL DEFAULT 1,
  succeeded boolean NOT NULL,
  response_status integer,
  response_body text,
  executed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_executions_webhook_fk
    FOREIGN KEY (tenant_id, webhook_id) REFERENCES pact.webhooks (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT webhook_executions_attempt_check CHECK (attempt >= 1),
  -- Idempotency của delivery: một (webhook, event, trigger, attempt) chỉ ghi
  -- một lần — thiếu unique này thì retry tạo bản ghi trùng (gap §5.5 upstream).
  CONSTRAINT webhook_executions_delivery_key UNIQUE (tenant_id, webhook_id, event, trigger, attempt),
  CONSTRAINT webhook_executions_body_cap_check CHECK (response_body IS NULL OR length(response_body) <= 4096)
);

CREATE INDEX IF NOT EXISTS webhook_executions_webhook_executed_idx
  ON pact.webhook_executions (tenant_id, webhook_id, executed_at DESC);

COMMENT ON TABLE pact.webhook_executions IS
  'Delivery log. response_body cắt 4KB như upstream; UNIQUE delivery key là idempotency của retry.';

-- ---------------------------------------------------------------------------
-- (c) audit — append-only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pact.audit_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_sub text,
  actor_token_id uuid,
  action text NOT NULL,
  outcome text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_occurred_idx
  ON pact.audit_events (tenant_id, occurred_at DESC)
  WHERE tenant_id IS NOT NULL;

-- Append-only ở DB level, không phải quy ước ứng dụng — cùng luật với
-- `security_events_append_only` của db-account. DELETE không chặn ở đây:
-- retention là thao tác có chủ đích của owner (giống account 0001).
CREATE OR REPLACE FUNCTION pact.audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events la bang audit append-only: UPDATE bi tu choi (SR-008)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_append_only ON pact.audit_events;
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE ON pact.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION pact.audit_events_append_only();

COMMENT ON TABLE pact.audit_events IS
  'Audit append-only cho thay doi dac quyen (token, membership, environment). KHONG luu token plaintext (SR-007).';
COMMENT ON COLUMN pact.audit_events.actor_token_id IS
  'Token đã tạo sự kiện (nếu caller là machine token); NULL khi caller là người dùng dashboard.';

-- ---------------------------------------------------------------------------
-- (d) internal_nonces — chuẩn bị cho contract nội bộ sau này
-- ---------------------------------------------------------------------------
-- Cùng hình dạng với `account.internal_nonces` (0003): nonce bất biến,
-- INSERT ON CONFLICT DO NOTHING, prune theo expires_at.

CREATE TABLE IF NOT EXISTS pact.internal_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_nonces_expires_idx ON pact.internal_nonces (expires_at);

COMMENT ON TABLE pact.internal_nonces IS
  'Nonce replay-guard cho internal envelope HMAC (nếu bật). Bảng tạo sẵn để không expand sau.';

-- ---------------------------------------------------------------------------
-- Grants — runtime chỉ DML trên schema `pact`
-- ---------------------------------------------------------------------------
-- Giống `0002_roles_and_grants.sql` của account: USAGE trước, DML từng bảng,
-- KHÔNG TRUNCATE/TRIGGER/REFERENCES/CREATE. Audit chỉ SELECT+INSERT.

GRANT USAGE ON SCHEMA pact TO ecoma_pact_broker_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE pact.tenants TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pact.tenant_members TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pact.machine_tokens TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pact.pacticipants TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pact.versions TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pact.tags TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pact.pacts TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT ON TABLE pact.verifications TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE pact.environments TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pact.deployed_versions TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pact.webhooks TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT ON TABLE pact.webhook_executions TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT ON TABLE pact.audit_events TO ecoma_pact_broker_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE pact.internal_nonces TO ecoma_pact_broker_runtime;

-- Migrator sở hữu schema này.
GRANT USAGE, CREATE ON SCHEMA pact TO ecoma_pact_broker_migrator;

-- ---------------------------------------------------------------------------
-- Guard CONNECT của runtime role trên CHÍNH database này — assertion fail-closed,
-- không revoke gì trên database khác (đọc giải thích 0002_roles_and_grants.sql:
-- REVOKE CONNECT thật là provisioning step 1 do owner/admin làm).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT has_database_privilege('ecoma_pact_broker_runtime', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION
      'ecoma_pact_broker_runtime mat quyen CONNECT tren db-pact-broker; can lai provisioning';
  END IF;
END;
$$;

-- Rút quyền mặc định của PUBLIC trên `public` — cùng lý do với account 0002.

COMMIT;
