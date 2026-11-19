-- 0001_identity_core.sql — schema lõi của `db-account`.
--
-- Phạm vi: những bảng mà invariant 2, 3, 4, 7, 8 của
-- `docs/applications/account/01-architecture.md` §9 đòi hỏi phải có **trước khi**
-- bất kỳ luồng đăng nhập nào chạy. Các bảng của nhóm password/MFA chưa được
-- tạo ở đây vì `01-architecture.md` §10 còn để mở "password auth có bật hay
-- không" — tạo sẵn sẽ đóng trước quyết định đó (AGENTS.md: không implement
-- planned state chỉ vì tài liệu mô tả).
--
-- Quy ước chung của mọi file trong `db/migrations/`:
--   * Áp theo thứ tự tên file; mỗi file phải chạy lại được (repeatable) qua
--     migration ledger, nên không dùng câu nào không có dạng idempotent.
--   * Mọi cột thời gian là `timestamptz`, tức đã lưu theo UTC (NFR-001).
--   * Schema ứng dụng tên `account`; runtime role chỉ có DML trên schema này
--     (`03-operations.md` §3).

BEGIN;

-- ⚠️ Không có `postgres_fdw`, không có `dblink`, không có foreign key trỏ sang
-- database khác ở bất kỳ đâu trong thư mục này (NFR-002b). Tham chiếu chéo với
-- `db-auth` là tham chiếu opaque không có ràng buộc toàn vẹn ở tầng database
-- (`01-architecture.md` §3.5).

-- ---------------------------------------------------------------------------
-- Tạo role migrator TRƯỚC schema
-- ---------------------------------------------------------------------------
--
-- ⚠️ Thứ tự này bắt buộc vì một lý do: `CREATE SCHEMA` cần `CREATE` **trên
-- database**, và PostgreSQL **không** cấp quyền đó cho `PUBLIC`. Nên `0001`
-- **không** tự cấp được: một role không thể `GRANT` thứ nó không có, và nó cũng
-- không sở hữu database. `CREATE` ở tầng database là **provisioning step 1**
-- (admin/owner), xem `03-operations.md` §3.2 và README. Thiếu nó thì runner dừng
-- ngay ở dòng `CREATE SCHEMA`.
--
-- Vì vậy file này **không** tự tạo được schema từ con số 0: nó giả định
-- provisioning đã cấp `CREATE` cho `ecoma_account_migrator` trên database này.
-- Tạo role thì vẫn ở đây, vì role là global object của cluster chứ không cần
-- quyền trên database nào — và `0002` cần nó tồn tại.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_account_migrator') THEN
    CREATE ROLE ecoma_account_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS account;

-- `security_events.event_id` mặc định bằng `gen_random_uuid()`.
--
-- Hàm đó là **core** từ PostgreSQL 13, và `pg_catalog` luôn đứng đầu
-- `search_path` một cách mặc định — nên mặc định của cột này tự giải quyết,
-- không cần extension nào. Repo pin ảnh `postgres:17-alpine`, càng không cần.
--
-- Cố ý **không** cài `pgcrypto` chỉ để "phòng xa": AC-013 quét `pg_extension`
-- và một extension cài sẵn nhưng không dùng là một lỗi trong tài liệu, không
-- phải một lớp phòng thủ. Tương tự, không khai báo `dblink` hay `postgres_fdw`.

COMMENT ON SCHEMA account IS
  'Application schema of db-account. Runtime role only has DML here; grants are issued in 0002_roles_and_grants.sql.';

-- ---------------------------------------------------------------------------
-- users — chủ thể và tombstone
-- ---------------------------------------------------------------------------
--
-- `sub` là PRIMARY KEY nên UNIQUE theo định nghĩa: identifier reuse bị UNIQUE
-- reject (FR-001, FR-012d). Tombstone là chính cơ chế đó — dòng `deleted` vẫn
-- giữ `sub`, nên `sub` cũ không bao giờ được cấp cho account khác
-- (`01-architecture.md` §7.1 nhóm (1)).
--
-- FR-012e: tombstone giữ **tối thiểu** `sub`, trạng thái đã xoá và thời điểm
-- xoá. Bảng này vì vậy không có cột nào định danh (tên, email, profile);
-- toàn bộ dữ liệu định danh nằm ở các bảng khác của nhóm (2), bị xoá hoặc
-- anonymize khi account bị xoá.

CREATE TABLE IF NOT EXISTS account.users (
  sub text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'deleted')),
  -- Tombstone phải có thời điểm xoá; tài khoản còn sống thì không có.
  CONSTRAINT users_deleted_at_check CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL)
    OR (status <> 'deleted' AND deleted_at IS NULL)
  )
);

COMMENT ON TABLE account.users IS
  'Subject and minimal tombstone. sub is never reused, never reissued (FR-001, FR-012d, FR-012e).';
COMMENT ON COLUMN account.users.sub IS
  'Opaque, never reused and never reissued. The only re-linking target (FR-012l).';
COMMENT ON COLUMN account.users.deleted_at IS
  'Set only when status = deleted; the tombstone keeps exactly this column and status.';

-- ---------------------------------------------------------------------------
-- Tombstone là bất biến: chặn mọi UPDATE trên hàng đã deleted (FR-012d, FR-001)
-- ---------------------------------------------------------------------------
--
-- CHECK `users_deleted_at_check` chỉ giữ **tuyến** status/deleted_at: hàng
-- `deleted` + deleted_at NULL là vi phạm, nhưng `deleted → active` (xoá deleted_at
-- đi kèm) là một cặp value hợp lệ theo DB — tức "hồi sinh" tombstone không bị
-- ràng buộc nào chặn. Runtime role có UPDATE trên `users` (FR-012 suspend cần
-- nó), nên chỉ hy vọng tầng ứng dụng không làm là không đủ — đúng kiểu bảo vệ
-- mà trigger `security_events_append_only` làm cho audit.
--
-- Chặn **mọi** UPDATE trên hàng cũ đã `deleted_at IS NOT NULL`, kể cả đổi cột
-- không phải status: tombstone là dấu vết cuối cùng của một sub không tái sử
-- dụng (FR-001, FR-012d); hở bất kỳ cột nào là mở đường sửa dấu vết đó.
--
-- DELETE không chặn ở đây — nhưng **không** phải vì retention còn mở, như
-- `security_events`: tombstone là **nhóm (1)**, nhóm duy nhất được giữ vĩnh
-- viễn (`01-architecture.md` §7.1), và một DELETE trên `users` giải phóng PK
-- `sub` — mở lại đường tái phát hành identifier mà FR-001 / FR-012d cấm. Vì
-- vậy DELETE bị chặn ở **tầng grant** (`0002_roles_and_grants.sql` không cấp
-- `DELETE` cho runtime role); trigger này chỉ là lớp thứ hai, chặn UPDATE
-- hồi sinh. Xem `0002` và `tombstone.spec.ts`.

CREATE OR REPLACE FUNCTION account.users_tombstone_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'users: hang tombstone (deleted_at khong NULL) khong duoc UPDATE; sub khong tai su dung (FR-001, FR-012d)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION account.users_tombstone_immutable() IS
  'Blocks every UPDATE on a tombstoned users row: deleted -> active is resurrection, blocked at the database layer (FR-012d).';

DROP TRIGGER IF EXISTS users_tombstone_immutable ON account.users;
CREATE TRIGGER users_tombstone_immutable
  BEFORE UPDATE ON account.users
  FOR EACH ROW
  EXECUTE FUNCTION account.users_tombstone_immutable();

-- ---------------------------------------------------------------------------
-- account_sessions — cookie session, chỉ lưu hash
-- ---------------------------------------------------------------------------
--
-- FR-004 / invariant 3: chỉ lưu **hash** của session identifier, không lưu
-- giá trị cookie. Vì vậy cột `id_hash` không bao giờ nhận giá trị cookie, và cột
-- `session_ref` là con trỏ tới *instance* session chứ không phải credential
-- (FR-006e): nó không dùng để xác thực ai cả.
--
-- FR-004a / invariant 4: session identifier rotate **tại thời điểm xác thực**.
-- Ở tầng schema, điều đó thể hiện bằng việc rotation ghi một hàng mới với
-- `id_hash` và `session_ref` mới; không có đường nào cho phép session mới thừa
-- kế `session_ref` cũ (xem `login_handoffs` bên dưới và AC-008b5).
--
-- FR-004b: `authn_level` + `authn_at` để đo tuổi bằng chứng; hành động nhạy cảm
-- dựa trên `authn_at`, không dựa trên tuổi session.

CREATE TABLE IF NOT EXISTS account.account_sessions (
  id_hash text PRIMARY KEY,
  session_ref text NOT NULL UNIQUE,
  user_sub text REFERENCES account.users (sub) ON DELETE RESTRICT,
  authn_level text,
  authn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  -- Thang mức phải khớp `AUTHN_LEVELS` (`libs/account-domain`) và
  -- `AUTHN_LEVEL_VALUES` (`libs/auth-contracts`): anonymous, password,
  -- totp, passkey. Không có 'otp' — ladder dùng `totp`.
  CONSTRAINT account_sessions_authn_level_check CHECK (
    authn_level IS NULL OR authn_level IN ('anonymous', 'password', 'totp', 'passkey')
  ),
  -- Bằng chứng xác thực là cặp: có level thì phải có mốc thời gian và ngược lại.
  -- Session anonymous (chưa xác thực) để cả hai cột NULL.
  CONSTRAINT account_sessions_authn_pair_check CHECK (
    (authn_level IS NULL) = (authn_at IS NULL)
  ),
  CONSTRAINT account_sessions_expiry_check CHECK (expires_at > created_at)
);

COMMENT ON TABLE account.account_sessions IS
  'Browser cookie session. Stores only the session identifier hash, never the cookie value (FR-004, invariant 3).';
COMMENT ON COLUMN account.account_sessions.id_hash IS
  'Hash of the session identifier. The cookie value is never stored here.';
COMMENT ON COLUMN account.account_sessions.session_ref IS
  'account_session_ref of the session instance. Internal identifier, NOT a credential (FR-006e).';
COMMENT ON COLUMN account.account_sessions.authn_at IS
  'Authentication time, used to measure evidence age for sensitive actions (FR-004b, SR-005).';

-- Truy vấn phục vụ BFF endpoint `GET /account/sessions` (FR-009) và nhánh chặn
-- ngay tại `db-account` khi suspend (FR-012): "mọi session của sub này còn sống
-- không", sắp theo thời điểm tạo. Đây là truy vấn duy nhất cần index ngoài PK
-- và các index của ràng buộc UNIQUE (index UNIQUE của `session_ref` đã có sẵn).
CREATE INDEX IF NOT EXISTS account_sessions_user_sub_idx
  ON account.account_sessions (user_sub, created_at DESC);

-- ---------------------------------------------------------------------------
-- login_handoffs — ràng buộc handle X ↔ session trình nó
-- ---------------------------------------------------------------------------
--
-- FR-006c2 / `01-architecture.md` §3.6.1: **first-binding-wins là một thuộc tính
-- của ràng buộc UNIQUE, không phải một quy tắc kiểm tra**. Chỉ một thao tác atomic
-- duy nhất tạo được bản ghi (`INSERT ... ON CONFLICT` rồi so khớp, hoặc
-- `INSERT ... ON CONFLICT DO UPDATE ... WHERE` theo điều kiện); mọi thao tác sau đó
-- là so khớp, không phải ghi. Đọc-rồi-ghi sẽ mất toàn bộ tính chất này dưới tải
-- đồng thời — xem AC-008b2.
--
-- FR-006c3: session đã bind không bị session khác ghi đè. Cột `session_ref` được
-- bảo vệ bởi trigger `login_handoffs_rebind_guard` bên dưới, vì `session_ref`
-- **có** đổi trong đúng một trường hợp: chuyển binding khi rotate (FR-006c4 /
-- §3.6.2). Ở mọi state khác, đổi `session_ref` là vi phạm.
--
-- `state` chỉ nhận đúng bốn giá trị của §3.6: `bound` → `consumed` |
-- `session_rotated` | `expired`. FR-006g: hết hạn thì từ chối, không có đường gia
-- hạn âm thầm — nên `expires_at` không được NULL và không có cột `extended_at`.

CREATE TABLE IF NOT EXISTS account.login_handoffs (
  -- PRIMARY KEY chứ không phải UNIQUE thêm: UNIQUE trên `handle_hash` *là* cơ chế
  -- first-binding-wins (FR-006c2), và mỗi index phải gắn với một truy vấn hoặc
  -- ràng buộc khác nhau — index trùng lặp chỉ tốn ghi
  -- (`01-architecture.md` §3.2).
  handle_hash text PRIMARY KEY,
  session_ref text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'bound',
  expires_at timestamptz NOT NULL,
  CONSTRAINT login_handoffs_state_check CHECK (
    state IN ('bound', 'consumed', 'session_rotated', 'expired')
  )
);

COMMENT ON TABLE account.login_handoffs IS
  'Binding between an auth handle X and the session that presented it. X is never stored in plaintext (01-architecture.md §3.6).';
COMMENT ON COLUMN account.login_handoffs.handle_hash IS
  'Hash of handle X. X arrives via the query string and can leak into intermediary logs; only the hash is stored. The PRIMARY KEY is the first-binding-wins mechanism (FR-006c2).';
COMMENT ON COLUMN account.login_handoffs.session_ref IS
  'Pointer to a session, NOT a credential. Changed only once, in the rebinding transaction during rotation (FR-006c4).';

-- Truy vấn dọn dẹp của nhóm (2) (`01-architecture.md` §7.1): TTL ngắn, xoá hẳn
-- khi hết hạn hoặc đã consume. Không có retention tự động nào khác đọc cột này,
-- nên index gắn với đúng một câu DELETE theo mốc thời gian.
CREATE INDEX IF NOT EXISTS login_handoffs_expires_at_idx
  ON account.login_handoffs (expires_at);

-- Chuyển binding chỉ hợp lệ khi state chuyển **từ `bound`** sang
-- `session_rotated`. Mọi thay đổi `session_ref` khác — đặc biệt là ghi đè binding
-- của session khác (FR-006c3), đổi binding lần thứ hai (FR-006c4: "một thao tác
-- atomic duy nhất", không có đường session thứ ba thừa kế X), hay hồi sinh hàng
-- `consumed`/`expired` rồi đổi binding — bị raise ở tầng database.
--
-- ⚠️ Bốn nhóm luật, thay cho bản cũ chỉ kiểm `NEW.state`:
--   0. `handle_hash` là PRIMARY KEY và **là** cơ chế first-binding-wins
--      (FR-006c2). Runtime role có UPDATE trên bảng này, nên không có một luật
--      riêng, `UPDATE ... SET handle_hash = '<khác>'` giải phóng PK và cho
--      phép bind lần thứ hai — đúng đường FR-006c3/c4 cấm. Luật này đứng
--      trước mọi luật khác vì nó bảo vệ chính định danh của hàng.
--   1. `consumed`/`expired` là trạng thái **kết thúc** (FR-006d2: "không có
--      đường dùng lại"; FR-006g: "không có đường gia hạn"): mọi UPDATE trên hàng
--      đã kết thúc bị chặn. Bản cũ cho UPDATE tự do, chỉ cần NEW.state trông hợp lệ —
--      hàng `consumed` đổi sang `session_rotated` + session_ref mới là tái bind
--      một handoff đã dùng.
--   2. Forward-only: từ `session_rotated` chỉ tới `consumed`/`expired`; quay lại
--      `bound` là đưa binding về trạng thái chưa dùng.
--   3. `session_ref` chỉ đổi khi `bound → session_rotated` — không phân biệt
--      trạng thái cũ là điểm hở của bản trước.
CREATE OR REPLACE FUNCTION account.login_handoffs_rebind_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.handle_hash IS DISTINCT FROM OLD.handle_hash THEN
    RAISE EXCEPTION
      'login_handoffs: handle_hash la PRIMARY KEY va co che first-binding-wins (FR-006c2), khong duoc doi; doi no la giai phong PK de bind lai'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state IN ('consumed', 'expired') THEN
    RAISE EXCEPTION
      'login_handoffs: hang da % la trang thai ket thuc, khong duoc UPDATE nua (FR-006d2, FR-006g)',
      OLD.state
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.state = 'session_rotated'
     AND NEW.state NOT IN ('session_rotated', 'consumed', 'expired') THEN
    RAISE EXCEPTION
      'login_handoffs: tu session_rotated chi duoc chuyen sang consumed hoac expired (FR-006d2, FR-006g)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.session_ref IS DISTINCT FROM OLD.session_ref THEN
    IF NOT (OLD.state = 'bound' AND NEW.state = 'session_rotated') THEN
      RAISE EXCEPTION
        'login_handoffs: session_ref chi doi duoc khi chuyen binding luc rotate session, tu bound sang session_rotated (FR-006c3, FR-006c4)'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION account.login_handoffs_rebind_guard() IS
  'Blocks handle_hash changes (PRIMARY KEY, first-binding-wins mechanism, FR-006c2); blocks binding overwrites (FR-006c3); allows the single rebinding transition bound -> session_rotated (FR-006c4); consumed/expired are terminal and reject UPDATE (FR-006d2, FR-006g).';

DROP TRIGGER IF EXISTS login_handoffs_rebind_guard ON account.login_handoffs;
CREATE TRIGGER login_handoffs_rebind_guard
  BEFORE UPDATE ON account.login_handoffs
  FOR EACH ROW
  EXECUTE FUNCTION account.login_handoffs_rebind_guard();

-- ---------------------------------------------------------------------------
-- security_events — audit append-only
-- ---------------------------------------------------------------------------
--
-- Invariant 8 / SR-002: **append-only**, UPDATE bị từ chối ở tầng database chứ
-- không phải bằng quy ước tầng ứng dụng. `security_events` là bảng duy nhất
-- cần chặn UPDATE vì nó là bảng audit; `login_handoffs` và
-- `account_outbox_events` cần UPDATE để sống (chuyển binding, đánh dấu đã
-- publish) nên ở lại mức grant — xem `0002_roles_and_grants.sql`.
--
-- Cố ý **không** có FK tới `users`: audit phải sống sót qua tombstone
-- (`01-architecture.md` §3.1, §7.1 nhóm (3)).

CREATE TABLE IF NOT EXISTS account.security_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_sub text,
  type text NOT NULL,
  outcome text NOT NULL,
  reason text,
  ip inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT security_events_outcome_check CHECK (outcome IN ('success', 'failure'))
);

COMMENT ON TABLE account.security_events IS
  'Append-only audit. No FK to users so auditing survives tombstones; UPDATE is rejected (SR-002, invariant 8).';
COMMENT ON COLUMN account.security_events.subject_sub IS
  'Subject sub, may be NULL when it cannot be determined (e.g. a probe for a nonexistent account). No FK.';
COMMENT ON COLUMN account.security_events.metadata IS
  'Sanitized payload only. Never stores passwords, tokens, code_verifier or assertions (SR-001, invariant 9).';

-- Truy vấn FR-012k / AC-008m: đọc tombstone qua đường nội bộ đều audit theo
-- `sub`; đó là một trong những nơi đọc audit nhiều nhất, sắp theo thời điểm.
CREATE INDEX IF NOT EXISTS security_events_subject_sub_idx
  ON account.security_events (subject_sub, occurred_at DESC)
  WHERE subject_sub IS NOT NULL;

-- ---------------------------------------------------------------------------
-- account_outbox_events — transactional outbox sang `auth`
-- ---------------------------------------------------------------------------
--
-- Invariant 6: trạng thái account được ghi vào `db-account` **trước**, lan sang
-- `auth` **sau**. Bảng này là hàng đang chờ bước "sau"; nó được INSERT trong
-- **cùng transaction** với thay đổi trạng thái, nên không tồn tại trạng thái
-- "đã đổi xong nhưng chưa có event".
--
-- FR-006n: `event_id` là idempotency key UNIQUE — `account` gửi lại cùng
-- `event_id` khi không biết request trước đã commit hay chưa, và consumer
-- xử lý idempotent.

CREATE TABLE IF NOT EXISTS account.account_outbox_events (
  event_id text PRIMARY KEY,
  aggregate_type text NOT NULL DEFAULT 'user',
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT account_outbox_events_attempts_check CHECK (attempts >= 0)
);

COMMENT ON TABLE account.account_outbox_events IS
  'Transactional outbox to auth. Written in the same transaction as the state change (invariant 6).';
COMMENT ON COLUMN account.account_outbox_events.event_id IS
  'Idempotency key. account resends the same event_id when it does not know whether the previous request committed (FR-006n).';

-- Đúng một truy vấn đọc tranh chấp hàng chưa publish: relay outbox, `FOR UPDATE
-- SKIP LOCKED`. Index phục vụ riêng câu đó — không truy vấn nào khác lọc theo
-- `published_at`.
CREATE INDEX IF NOT EXISTS account_outbox_events_unpublished_idx
  ON account.account_outbox_events (occurred_at)
  WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only enforcement cho security_events (SR-002)
-- ---------------------------------------------------------------------------
--
-- Chặn ở tầng trigger, không chặn ở tầng grant: `ecoma_account_runtime` cần
-- UPDATE cho hàng loạt bảng khác, và tách quyền theo từng bảng không đủ để bảo
-- vệ audit khỏi một `UPDATE` có chủ đích. Trigger là lớp enforce bất biến của
-- tính chất append-only, đúng như `REVOKE CONNECT` là lớp enforce của ranh giới
-- database.
--
-- DELETE không bị chặn ở đây: retention của nhóm (3) là quyết định **còn mở**
-- (`01-architecture.md` §10) và việc xoá phải là một thao tác có chủ đích của
-- quy trình retention. Ghi nó ở đây để không ai đọc "append-only" thành "không
-- bao giờ xoá".

CREATE OR REPLACE FUNCTION account.security_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'security_events la bang audit append-only: UPDATE bi tu choi (SR-002)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

COMMENT ON FUNCTION account.security_events_append_only() IS
  'Enforces the append-only property of the audit log (SR-002, invariant 8). DELETE is not blocked here because group (3) retention is still an open decision.';

DROP TRIGGER IF EXISTS security_events_append_only ON account.security_events;
CREATE TRIGGER security_events_append_only
  BEFORE UPDATE ON account.security_events
  FOR EACH ROW
  EXECUTE FUNCTION account.security_events_append_only();

COMMIT;