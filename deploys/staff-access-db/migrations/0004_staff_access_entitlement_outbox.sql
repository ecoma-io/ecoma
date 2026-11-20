-- 0004_staff_access_entitlement_outbox.sql — transactional outbox cho entitlement
-- events (P2.1, issue #437).
--
-- Pattern tham chiếu: apps/account/db/migrations/0001_identity_core.sql
-- (account.account_outbox_events). Source of truth:
-- - docs/domains/staff-access/README.md §3 (invariant A8): thay đổi entitlement
--   được ghi cùng outbox trong một transaction; không tồn tại trạng thái "đã
--   đổi state nhưng thiếu event".
-- - libs/staff-access-contracts/src/entitlement-events-contract.ts (P1.2, đã
--   lock): envelope event qua `entitlementEvent()`, KHÔNG có transport field.
--
-- ⚠️ Đơn vị này KHÔNG dựng relay/queue — P2.2 lo. Bảng này chỉ là hàng chờ:
-- relay sẽ claim qua `FOR UPDATE SKIP LOCKED` trên partial index dưới đây.
--
-- Forward-fix; idempotent (IF NOT EXISTS / OR REPLACE); chạy lại là no-op.

BEGIN;

-- ---------------------------------------------------------------------------
-- entitlement_outbox_events — event chờ publish, cùng transaction với state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.entitlement_outbox_events (
  -- Idempotency key: producer gửi lại cùng event_id khi không biết lần trước
  -- đã commit hay chưa; consumer xử lý idempotent theo event_id (FR của
  -- account_outbox_events, áp dụng nguyên văn cho outbox này).
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL DEFAULT 'entitlement',
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  -- Consumer settlement receipt (ADR-0014 settlement protocol): NULL = not yet
  -- settled by consumer; 'applied' = consumer published a receipt. Outbox-first
  -- ordering is preserved: settle_status is only ever set by the settlement
  -- reconciler from a receipt, never by the relay publish path.
  settle_status text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT entitlement_outbox_events_attempts_check CHECK (attempts >= 0),
  -- Audit-in-spirit (SR-014 áp dụng nguyên văn): payload là envelope hợp đồng
  -- đã validate; chặn key secret/token ở cửa cuối schema. Tên sự kiện/aggregate
  -- bị ghim để một drift contract không lọt qua outbox.
  CONSTRAINT entitlement_outbox_events_payload_no_secret_keys CHECK (
    NOT (payload ?| ARRAY[
      'token', 'access_token', 'refresh_token', 'secret', 'password', 'authorization'
    ])
  ),
  CONSTRAINT entitlement_outbox_events_event_type_check CHECK (
    event_type IN ('entitlement.granted', 'entitlement.revoked')
  ),
  CONSTRAINT entitlement_outbox_events_aggregate_type_check CHECK (
    aggregate_type = 'entitlement'
  )
);

COMMENT ON TABLE staff_access.entitlement_outbox_events IS
  'Transactional outbox for entitlement events. Written in the same transaction as the entitlement state change (invariant A8): no state change exists without its event. event_id is the idempotency key.';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.event_id IS
  'Idempotency key of the event; the producer resends the same event_id when it does not know whether the previous write committed.';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.aggregate_id IS
  'Affected pair as "<staff_id>/<product>" — the read-model key the event applies to.';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.event_type IS
  'Entitlement event type from the locked contract: entitlement.granted | entitlement.revoked.';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.payload IS
  'EntitlementEvent envelope from staff-access-contracts. Availability only — no verdict, permission, transport or secret (ADR-0009, SR-014).';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.published_at IS
  'Delivery timestamp, set by the outbox relay (P2.2). NULL means pending.';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.attempts IS
  'Delivery attempt counter for the relay; 0 until the first claim.';
COMMENT ON COLUMN staff_access.entitlement_outbox_events.last_error IS
  'Last delivery error of the relay; NULL when delivery has not failed.';

-- Đúng một truy vấn đọc tranh chấp hàng chưa publish: relay outbox, `FOR UPDATE
-- SKIP LOCKED`. Index phục vụ riêng câu đó — không truy vấn nào khác lọc theo
-- `published_at`.
CREATE INDEX IF NOT EXISTS entitlement_outbox_events_unpublished_idx
  ON staff_access.entitlement_outbox_events (occurred_at)
  WHERE published_at IS NULL;

COMMENT ON INDEX staff_access.entitlement_outbox_events_unpublished_idx IS
  'Serves exactly one query: the outbox relay claiming pending events FOR UPDATE SKIP LOCKED (P2.2).';

-- ---------------------------------------------------------------------------
-- Grants — runtime role ghi event trong cùng transaction với entitlement
-- ---------------------------------------------------------------------------

-- Runtime INSERT/SELECT đầy đủ; UPDATE chỉ ở cấp cột published_at/attempts/
-- last_error (pattern column-level security-high 41070536326 của
-- role_assignments): runtime không thể đổi identity/payload/event của event đã
-- ghi ngay cả khi trigger bị vô hiệu — defense in depth hai lớp độc lập.
-- (DELETE không cấp: outbox chỉ append + đánh dấu published; retention là
-- quyết định còn mở và phải là thao tác có chủ đích của P2.2+.)
GRANT SELECT, INSERT ON staff_access.entitlement_outbox_events TO ecoma_staff_access_runtime;
GRANT UPDATE (published_at, attempts, last_error, settle_status)
  ON staff_access.entitlement_outbox_events TO ecoma_staff_access_runtime;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON staff_access.entitlement_outbox_events FROM ecoma_staff_access_runtime;

COMMIT;
