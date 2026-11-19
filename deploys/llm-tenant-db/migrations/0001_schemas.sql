-- 0001_schemas.sql — schema namespace của `db-llm-tenant` trong slice db-migration của Issue #22.
--
-- Tạo schema đã đặt tên trong `docs/applications/llm-api/README.md` §Persistence implementation:
-- `llm_tenant` (llm-consumer-tenant: tenant, membership, workspace, grant, suspension —
-- module trong cùng deploy unit, đọc/ghi qua module, không qua contract).
-- ⚠️ Không có bảng nghiệp vụ nào ở file này: bảng thuộc slice nghiệp vụ của #23/#24 —
-- slice này chỉ tạo namespace đã đặt tên + mặc định quyền, không fabrication nghiệp vụ.
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).

CREATE SCHEMA IF NOT EXISTS llm_tenant;

COMMENT ON SCHEMA llm_tenant IS
  'Tenant schema of db-llm-tenant. Owning domain: llm-consumer-tenant (tenant, membership, workspace, grant, suspension). Business tables belong to later slices of Issue #22 (#23/#24); this slice creates the namespace only.';

-- Runtime chạm được schema (USAGE); DML trên bảng tương lai được cấp qua default privileges
-- bên dưới — migrator tạo bảng sau này thì runtime tự có SELECT/INSERT/UPDATE/DELETE.
GRANT USAGE ON SCHEMA llm_tenant TO ecoma_llm_tenant_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_tenant_migrator IN SCHEMA llm_tenant
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecoma_llm_tenant_runtime;
