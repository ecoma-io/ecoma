-- 0003_cache_entries.sql — metadata cho data plane Nx (P4.2, issue #454).
--
-- Bang `cache_entries` la ban ghi metadata cua mot artifact cache da luu tren
-- object storage, pham vi project. Object storage key duoc sinh tu project/tenant
-- (khong tu input client) — namespace isolation la rang buoc bao mat, khong phai
-- quy uoc. Immutability duoc enforce o hai lop: UNIQUE (project_id, hash) o
-- schema va conditional creation o object storage (etagDoesNotMatch '*').
--
-- ⚠️ Khong co quota/retention/usage (P4.3) va khong co hardening CI credential
-- (P4.4) o file nay. Bang chi giu metadata toi thieu can cho GET/PUT hit/miss.

BEGIN;

CREATE TABLE IF NOT EXISTS remote_cache.cache_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES remote_cache.projects (id),
  hash text NOT NULL,
  object_key text NOT NULL,
  size_bytes bigint NOT NULL,
  content_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cache_entries_project_hash_unique UNIQUE (project_id, hash),
  CONSTRAINT cache_entries_size_positive CHECK (size_bytes > 0)
);

COMMENT ON TABLE remote_cache.cache_entries IS
  'Metadata of one immutable cache artifact stored in object storage, scoped to a project (P4.2 data plane). One row per (project, hash); re-PUT of an existing hash is rejected at the UNIQUE constraint and at the storage conditional-creation gate. No quota/retention/usage here (P4.3).';

COMMENT ON COLUMN remote_cache.cache_entries.project_id IS
  'Owning project — isolation unit of the data plane. Every read/write filters by this column so a credential of another project can never resolve the row (namespace isolation).';

COMMENT ON COLUMN remote_cache.cache_entries.hash IS
  'Nx cache key (hash of the task). Combined with project_id forms the UNIQUE key; the same hash in two projects is two distinct cache entries.';

COMMENT ON COLUMN remote_cache.cache_entries.object_key IS
  'Key in object storage, derived from tenant/project/hash by the server. Never accepted from client input.';

COMMENT ON COLUMN remote_cache.cache_entries.size_bytes IS
  'Number of bytes stored, validated against the Content-Length of the upload (P4.2).';

CREATE INDEX IF NOT EXISTS cache_entries_project_created_idx
  ON remote_cache.cache_entries (project_id, created_at, id);

-- ---------------------------------------------------------------------------
-- Grants cho runtime role tren bang moi — cung luat least-privilege voi 0002.
-- Bang vua tao o migration nay nen grant nam cung file (0002 chay truoc khi
-- bang ton tai).
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON remote_cache.cache_entries TO ecoma_remote_cache_runtime;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON remote_cache.cache_entries FROM ecoma_remote_cache_runtime;
REVOKE UPDATE ON remote_cache.cache_entries FROM ecoma_remote_cache_runtime;

COMMIT;
