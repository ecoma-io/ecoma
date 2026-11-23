-- 0006_outbox_settle.sql — settle evidence cho revocation SLA (ADR-0014 amendment).
--
-- Expand, backward compatible: thêm cột `settled_at` (consumer-side
-- acknowledgement) vào outbox. NULL = chưa được consumer xác nhận đã apply;
-- non-NULL = consumer đã apply thành công và ghi nhận settle. Không đổi wire
-- contract (envelope không mang transport field).
--
-- Forward-fix; idempotent (IF NOT EXISTS); chạy lại là no-op.

BEGIN;

ALTER TABLE staff_access.entitlement_outbox_events
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

COMMENT ON COLUMN staff_access.entitlement_outbox_events.settled_at IS
  'Consumer-side settlement acknowledgement (ADR-0014): thời điểm consumer xác nhận đã áp dụng event. NULL = chưa settle; redrive chỉ áp dụng cho row published nhưng settled_at NULL quá deadline.';

-- Index phục vụ reconcile redrive query: published + unsettled, theo published_at.
CREATE INDEX IF NOT EXISTS entitlement_outbox_events_published_unsettled_idx
  ON staff_access.entitlement_outbox_events (published_at)
  WHERE published_at IS NOT NULL AND settled_at IS NULL;

COMMENT ON INDEX staff_access.entitlement_outbox_events_published_unsettled_idx IS
  'Serves reconciliation redrive: published rows not yet settled by consumer.';

-- Runtime được UPDATE settled_at (bổ sung đặc quyền UPDATE cột settled_at
-- cho role runtime, bên cạnh settle_status đã grant ở 0004).
GRANT UPDATE (settled_at)
  ON staff_access.entitlement_outbox_events TO ecoma_staff_access_runtime;

COMMIT;
