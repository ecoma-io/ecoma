-- 0003_tenant_members_entitlement_provenance.sql — provenance entitlement trên tenant_members + entitlement_sync_state.
--
-- P3.x: ghi ánh xạ staff_id → sub tại điểm confluent như provenance trên hàng
-- membership, và provenance event trên entitlement_sync_state. Additive only.

BEGIN;

-- F4: explicit staff_id column on tenant_members (nullable, indexed).
ALTER TABLE pact.tenant_members
  ADD COLUMN IF NOT EXISTS staff_id text NULL;

CREATE INDEX IF NOT EXISTS tenant_members_staff_id_idx
  ON pact.tenant_members (staff_id);

-- Provenance columns on tenant_members (existing).
ALTER TABLE pact.tenant_members
  ADD COLUMN IF NOT EXISTS entitlement_event_id uuid NULL,
  ADD COLUMN IF NOT EXISTS entitlement_revision bigint NULL,
  ADD COLUMN IF NOT EXISTS source text NULL,
  ADD COLUMN IF NOT EXISTS entitlement_revoked_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_members_source_check'
  ) THEN
    ALTER TABLE pact.tenant_members
      ADD CONSTRAINT tenant_members_source_check
      CHECK (source IS NULL OR source IN ('entitlement', 'bootstrap', 'admin'));
  END IF;
END $$;

-- F0: provenance columns on entitlement_sync_state.
ALTER TABLE pact.entitlement_sync_state
  ADD COLUMN IF NOT EXISTS entitlement_event_id uuid NULL,
  ADD COLUMN IF NOT EXISTS entitlement_revision bigint NULL,
  ADD COLUMN IF NOT EXISTS source text NULL;

CREATE INDEX IF NOT EXISTS entitlement_sync_state_event_id_idx
  ON pact.entitlement_sync_state (entitlement_event_id);

COMMENT ON COLUMN pact.tenant_members.staff_id IS
  'staff_id của Staff Access directory ánh xạ vào membership (nullable; NULL cho bootstrap/admin).';
COMMENT ON COLUMN pact.tenant_members.entitlement_event_id IS
  'event_id của entitlement event đã confluent vào membership này (provenance).';
COMMENT ON COLUMN pact.tenant_members.entitlement_revision IS
  'revision của entitlement event đã confluent (provenance).';
COMMENT ON COLUMN pact.tenant_members.source IS
  'Nguồn tạo membership: entitlement | bootstrap | admin.';
COMMENT ON COLUMN pact.tenant_members.entitlement_revoked_at IS
  'Thời điểm revoke projection entitlement đã được ghi (NULL = chưa revoke).';

COMMENT ON COLUMN pact.entitlement_sync_state.entitlement_event_id IS
  'event_id của entitlement event đã áp dụng (provenance; NULL cho bootstrap/admin).';
COMMENT ON COLUMN pact.entitlement_sync_state.entitlement_revision IS
  'revision của entitlement event đã áp dụng (provenance).';
COMMENT ON COLUMN pact.entitlement_sync_state.source IS
  'Nguồn áp dụng: entitlement | bootstrap | admin (NULL nếu không rõ).';

COMMIT;
