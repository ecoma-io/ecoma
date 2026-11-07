-- 0002_entitlement_sync_state.sql — trạng thái đồng bộ entitlement event của pact-broker.
--
-- Bảng này lưu revision entitlement event lớn nhất đã áp dụng cho mỗi cặp
-- (staff_id, product) — consumer idempotent: event revision <= revision đã thấy
-- bị bỏ qua (compare-and-drop qua `shouldApplyEntitlementEvent`).
--
-- Đây là bảng'état của consumer entitlement (P3.2): không có FK sang database
-- khác (one-service-one-database), `staff_id` là tham chiếu opaque của Staff
-- Access directory (không phải `sub`; xem `01-architecture.md` §3.1).

BEGIN;

CREATE TABLE IF NOT EXISTS pact.entitlement_sync_state (
  staff_id text NOT NULL,
  product text NOT NULL,
  revision bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_sync_state_pk PRIMARY KEY (staff_id, product)
);

CREATE INDEX IF NOT EXISTS entitlement_sync_state_product_idx
  ON pact.entitlement_sync_state (product);

COMMENT ON TABLE pact.entitlement_sync_state IS
  'Trang thai dong bo entitlement event: revision lon nhat da ap apply cho moi cap (staff_id, product).';
COMMENT ON COLUMN pact.entitlement_sync_state.staff_id IS
  'Ma nhan su cua Staff Access directory (tham chieu opaque, khong FK, khong phai sub).';
COMMENT ON COLUMN pact.entitlement_sync_state.product IS
  'San pham noi bat trong ENTITLEMENT_PRODUCTS (backoffice, pact-broker, remote-cache).';
COMMENT ON COLUMN pact.entitlement_sync_state.revision IS
  'Revision lon nhat cua event entitlement da ap apply cho cap (staff_id, product).';

-- Runtime role: DML voi bang state (consumer doc va cap nhat).
GRANT SELECT, INSERT, UPDATE ON TABLE pact.entitlement_sync_state TO ecoma_pact_broker_runtime;

COMMIT;
