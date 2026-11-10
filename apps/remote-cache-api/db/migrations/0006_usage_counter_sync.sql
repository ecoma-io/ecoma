-- 0006_usage_counter_sync.sql — keep usage_counters in sync with cache_entries (P4.3, issue #461).
--
-- Adds the `usage_counter_sync()` trigger and AFTER INSERT / AFTER DELETE triggers on
-- the `remote_cache.cache_entries` table to automatically keep `remote_cache.usage_counters`
-- (storage_bytes_used and entry_count) in sync whenever an entry is inserted or deleted.
-- This table is durable and reconstructible from `cache_entries`; the trigger keeps the
-- counters consistent with data written to cache_entries, avoiding stale/zero values
-- when quota checks read from usage_counters.
--
-- Idempotent: `DROP TRIGGER IF EXISTS` before creating, `CREATE OR REPLACE FUNCTION`
-- so re-running the migration is a no-op (idempotency pattern per 06-testing.md /
-- migration runner).
-- The trigger function runs as the invoking role (SECURITY INVOKER, PostgreSQL default).
-- The runtime role already has SELECT, INSERT, UPDATE on usage_counters (granted in 0005),
-- so no TRIGGER privilege is needed on cache_entries for the trigger to execute.

BEGIN;

-- ---------------------------------------------------------------------------
-- Trigger function: sync usage_counters after INSERT/DELETE/UPDATE on cache_entries
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remote_cache.usage_counter_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO remote_cache.usage_counters (project_id, storage_bytes_used, entry_count, updated_at)
    VALUES (NEW.project_id, NEW.size_bytes, 1, now())
    ON CONFLICT (project_id) DO UPDATE
      SET storage_bytes_used = usage_counters.storage_bytes_used + EXCLUDED.storage_bytes_used,
          entry_count = usage_counters.entry_count + EXCLUDED.entry_count,
          updated_at = now();
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Neu hang counter chua ton tai (entry chen truoc khi migration chay hoac bo dem bi
    -- xac dinh), tao hang trong voi 0 roi tru de tranh RAISE EXCEPTION abort toan bo
    -- transaction xoa entry.
    INSERT INTO remote_cache.usage_counters (project_id, storage_bytes_used, entry_count, updated_at)
    VALUES (OLD.project_id, 0, 0, now())
    ON CONFLICT (project_id) DO NOTHING;

    UPDATE remote_cache.usage_counters
      SET storage_bytes_used = GREATEST(usage_counters.storage_bytes_used - OLD.size_bytes, 0),
          entry_count = GREATEST(usage_counters.entry_count - 1, 0),
          updated_at = now()
    WHERE project_id = OLD.project_id;
    RETURN OLD;
-- Khong dang ky trigger UPDATE vi cache entries immutable (re-PUT tra 409).
-- Nhanh UPDATE duoc giu lai de neu schema sau nay thay doi.
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Trigger sau khi chen mot cache entry: tang bo dem cua project chinh chu
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS cache_entries_after_insert_sync ON remote_cache.cache_entries;
CREATE TRIGGER cache_entries_after_insert_sync
  AFTER INSERT ON remote_cache.cache_entries
  FOR EACH ROW
  EXECUTE FUNCTION remote_cache.usage_counter_sync();

-- ---------------------------------------------------------------------------
-- Trigger sau khi xoa mot cache entry: giam bo dem cua project chinh chu
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS cache_entries_after_delete_sync ON remote_cache.cache_entries;
CREATE TRIGGER cache_entries_after_delete_sync
  AFTER DELETE ON remote_cache.cache_entries
  FOR EACH ROW
  EXECUTE FUNCTION remote_cache.usage_counter_sync();

-- ---------------------------------------------------------------------------
-- Backfill usage_counters from existing cache_entries (idempotent)
-- ---------------------------------------------------------------------------

INSERT INTO remote_cache.usage_counters (project_id, storage_bytes_used, entry_count, updated_at)
  SELECT project_id, coalesce(sum(size_bytes), 0), count(*), now()
  FROM remote_cache.cache_entries
  GROUP BY project_id
ON CONFLICT (project_id) DO UPDATE
  SET storage_bytes_used = EXCLUDED.storage_bytes_used,
      entry_count = EXCLUDED.entry_count,
      updated_at = now();

COMMIT;
