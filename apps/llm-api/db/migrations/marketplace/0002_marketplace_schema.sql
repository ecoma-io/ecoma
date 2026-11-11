-- 0002_marketplace_schema.sql — schema namespace `llm_marketplace` của `db-llm-marketplace` trong slice db-migration của Issue #22.
--
-- Tạo schema đã đặt tên trong `docs/applications/llm-api/README.md` §Persistence implementation và
-- `docs/domains/llm-marketplace/domain-model.md` §Runtime/persistence: `llm_marketplace`
-- (llm-marketplace: model offer, capability, upstream endpoint, endpoint pool, provider credential,
-- provider model name, normalized model identity, offer activation).
-- ⚠️ Không có bảng nghiệp vụ nào ở file này: bảng thuộc slice nghiệp vụ của #23/#24 —
-- slice này chỉ tạo namespace đã đặt tên + mặc định quyền, không fabrication nghiệp vụ.
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).
-- Forward-fix: stack đã provision trước slice này nhận schema ở lần apply kế tiếp —
-- apply lại là no-op, catalog PostgreSQL sau apply là nguồn sự thật.

CREATE SCHEMA IF NOT EXISTS llm_marketplace;

COMMENT ON SCHEMA llm_marketplace IS
  'Marketplace schema of db-llm-marketplace. Owning domain: llm-marketplace (model offer, capability, upstream endpoint, endpoint pool, provider credential, provider model name, normalized model identity, offer activation). Business tables belong to later slices of Issue #22 (#23/#24); this slice creates the namespace only.';

-- Runtime chạm được schema (USAGE); DML trên bảng tương lai được cấp qua default privileges
-- bên dưới — migrator tạo bảng sau này thì runtime tự có SELECT/INSERT/UPDATE/DELETE.
GRANT USAGE ON SCHEMA llm_marketplace TO ecoma_llm_marketplace_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_marketplace_migrator IN SCHEMA llm_marketplace
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecoma_llm_marketplace_runtime;
