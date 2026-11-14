-- 0008_portal_authorization.sql — bề mặt authorization cho human principal
-- (portal BFF) trên control plane của bounded context `remote-cache`
-- (issue #202; quyết định phạm vi Internal Developer Portal #177).
--
-- Bổ sung ba khối, tất cả forward-fix và idempotent (runner không có ledger —
-- mọi statement chạy lại được):
--
-- 1. `internal_nonces` — kho nonce bền cho envelope HMAC nội bộ
--    `ecoma-internal-v2` (`@ecoma-io/internal-auth-contracts`): portal BFF ký
--    mọi call control plane bằng envelope này, mang actor sub đã verify của
--    developer Ecoma. Claim nonce là chiếm-ghi nguyên tử
--    (DELETE hết hạn + INSERT ... ON CONFLICT DO NOTHING RETURNING) chạy ngay
--    trong đường verify — prune theo lô cùng statement, không cần job riêng
--    ở M1 (pattern `staff_access.internal_nonces`, migration 0005 của
--    staff-access).
-- 2. Widen CHECK `audit_log_action_check` với vocabulary mutation qua portal:
--    `project_created`, `api_key_created`, `api_key_revoked` (R15: mọi
--    administrative mutation qua portal tạo audit entry với actor, action,
--    target, time, outcome). Actor là `user:<member_sub>` cho mutation do
--    người dùng khởi phát; đại diện giá trị của actor là quyết định cần được
--    ADR human-principal authorization ghi nhận (issue #202 bước 1).
-- 3. Guard tính bất invariant của phân lớp credential: trigger chặn mọi
--    UPDATE đổi `trusted_ci` trên `api_keys` (domain model §2.4 — class set
--    lúc tạo, không đổi sau đó). Runtime role vốn không có grant UPDATE cột
--    này (0002/0007); trigger là defense-in-depth cho các đường
--    migrator/superuser, cùng pattern trigger revoke-only ở 0001.
--
-- COMMENT ON text is English per language policy; `--` comments are
-- developer comments (Vietnamese).

BEGIN;

-- ---------------------------------------------------------------------------
-- internal_nonces — replay guard của envelope HMAC nội bộ
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remote_cache.internal_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS internal_nonces_expires_at_idx
  ON remote_cache.internal_nonces (expires_at);

COMMENT ON TABLE remote_cache.internal_nonces IS
  'Replay guard for the ecoma-internal-v2 HMAC envelope that the portal BFF uses to call the control plane (issue #202). A claim is an atomic consume-and-record (DELETE expired rows, then INSERT ... ON CONFLICT DO NOTHING RETURNING) executed by the verification path; expired rows are pruned by the same statement, so no separate prune job is needed in M1 (pattern staff_access.internal_nonces).';

COMMENT ON COLUMN remote_cache.internal_nonces.nonce IS
  'Nonce of the internal envelope (at least 128 bits of entropy, format-checked by the verification library). Primary key of the store: the UNIQUE constraint is what makes the claim atomic.';

COMMENT ON COLUMN remote_cache.internal_nonces.expires_at IS
  'Claim expiry, anchored to the envelope timestamp plus the accepted skew window plus a pruning buffer — a nonce outlives exactly its replay window.';

GRANT SELECT, INSERT, DELETE ON remote_cache.internal_nonces TO ecoma_remote_cache_runtime;
-- DELETE chỉ phục vụ prune theo lô trong cùng statement claim; không có đường
-- code nào xoá nonce còn hiệu lực (claim là INSERT ... ON CONFLICT DO NOTHING).
--
-- ⚠️ Vì sao runtime vẫn cần DELETE (và không tách role pruner riêng như
-- `apps/account/db/migrations/0007_nonce_pruner_role.sql`): role pruner ở
-- account tồn tại để cho MỘT CRON JOB ngoài chạy prune theo lô — Worker prune
-- cần principal trung gian vì credential `_migrator_` không bao giờ nằm trong
-- secret của Worker. Ở remote-cache KHÔNG có job prune nào: prune chạy
-- trong chính statement claim (`DELETE ... WHERE expires_at <= now()`), tức là
-- cùng một transaction với INSERT, trên CHÍNH client của request. Tách
-- DELETE ra role khác sẽ phá vỡ cơ chế này: claim cần xoá hàng hết hạn và
-- insert nonce MỚI trong MỘT statement nguyên tử — hai principal khác nhau
-- không chia được một transaction.
--
-- Ràng buộc thực tế nằm ở câu SQL, không ở grant: DELETE đi kèm điều kiện
-- `expires_at <= now()`, nên hàng còn hiệu lực không bị xoá dù runtime có
-- quyền DELETE — quyền này cho phép *câu lệnh*, không cho phép *xoá nonce
-- còn hiệu lực*. Mọi claim nonce của remote-cache đều nằm trong
-- `src/portal-auth.ts` (`claimNonce`); đường đó là consumer DUY NHẤT.
-- Đây là cùng hình dạng quyền với `staff_access.internal_nonces`
-- (`apps/staff-access/db/migrations/0005_internal_nonces.sql`), nơi cũng không
-- có job prune riêng mà claim tự prune theo lô.

-- ---------------------------------------------------------------------------
-- Audit vocabulary: các mutation qua portal (R15, issue #202)
-- ---------------------------------------------------------------------------

ALTER TABLE remote_cache.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_check;

ALTER TABLE remote_cache.audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'quota_exceeded',
    'quota_limit_set',
    'retention_cleanup',
    'cache_put',
    'tenant_bootstrap',
    'project_created',
    'api_key_created',
    'api_key_revoked'
  ));

COMMENT ON CONSTRAINT audit_log_action_check ON remote_cache.audit_log IS
  'Closed action vocabulary of the audit log; widened by 0007 with tenant_bootstrap and by 0008 with the portal mutations project_created, api_key_created and api_key_revoked (issue #202, R15).';

-- ---------------------------------------------------------------------------
-- Guard tính bất invariant của phân lớp credential (domain model §2.4)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remote_cache.api_key_trust_class_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trusted_ci IS DISTINCT FROM OLD.trusted_ci THEN
    RAISE EXCEPTION
      'remote_cache: credential class (trusted_ci) is set at creation and never changes (domain model 2.4); issue a new key instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION remote_cache.api_key_trust_class_guard() IS
  'Blocks any UPDATE that would move an api_key between the trusted CI and developer credential classes; the class is fixed at creation (domain model 2.4). Revocation (revoked_at) is unaffected. Applications must treat SQLSTATE 23000 (integrity_constraint_violation) as the credential-class-immutable error; the class-level code is deliberate because no 23xxx subclass matches a trigger-enforced domain invariant.';

DROP TRIGGER IF EXISTS api_key_trust_class_guard ON remote_cache.api_keys;
CREATE TRIGGER api_key_trust_class_guard
  BEFORE UPDATE ON remote_cache.api_keys
  FOR EACH ROW
  EXECUTE FUNCTION remote_cache.api_key_trust_class_guard();

COMMIT;
