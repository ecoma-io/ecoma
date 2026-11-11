-- 0001_schemas.sql — schema namespace của `db-llm-gateway` trong slice db-migration của Issue #22.
--
-- Tạo hai schema đã đặt tên trong `docs/applications/llm-api/README.md` §Persistence implementation:
-- `llm_financial` (llm-financial: budget escrow/lease, charge, payable, ledger view) và
-- `llm_seller` (llm-seller-pricing: pricing snapshot bound at admission; verdict của
-- llm-seller-governance được tiêu thụ như giá trị hợp đồng).
-- ⚠️ Không có bảng nghiệp vụ nào ở file này: bảng thuộc slice nghiệp vụ của #23/#24 —
-- slice này chỉ tạo namespace đã đặt tên + mặc định quyền, không fabrication nghiệp vụ.
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).

CREATE SCHEMA IF NOT EXISTS llm_financial;

COMMENT ON SCHEMA llm_financial IS
  'Financial schema of db-llm-gateway. Owning domain: llm-financial (budget escrow/lease, charge, payable, ledger view). Business tables belong to later slices of Issue #22 (#23/#24); this slice creates the namespace only.';

CREATE SCHEMA IF NOT EXISTS llm_seller;

COMMENT ON SCHEMA llm_seller IS
  'Seller schema of db-llm-gateway. Owning domains: llm-seller-pricing (pricing snapshot bound at admission) and llm-seller-governance (eligibility verdict consumed as contract value). Business tables belong to later slices of Issue #22 (#23/#24); this slice creates the namespace only.';

-- Runtime chạm được schema (USAGE); DML trên bảng tương lai được cấp qua default privileges
-- bên dưới — migrator tạo bảng sau này thì runtime tự có SELECT/INSERT/UPDATE/DELETE.
GRANT USAGE ON SCHEMA llm_financial TO ecoma_llm_gateway_runtime;
GRANT USAGE ON SCHEMA llm_seller TO ecoma_llm_gateway_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_gateway_migrator IN SCHEMA llm_financial
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecoma_llm_gateway_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_gateway_migrator IN SCHEMA llm_seller
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecoma_llm_gateway_runtime;
