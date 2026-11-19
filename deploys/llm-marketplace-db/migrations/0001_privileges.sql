-- 0001_privileges.sql — quyền default của `db-llm-marketplace` trong slice db-migration của Issue #22.
--
-- ⚠️ `db-llm-marketplace` CHƯA có schema nghiệp vụ nào: các bảng marketplace thuộc Issue #24
-- scope (`llm-marketplace` được `llm-api` tiêu thụ qua contract/event projection, không đọc
-- trực tiếp). File này chỉ cấp default privilege migrator → runtime ở mức database để target
-- `marketplace` của runner apply được thay đổi không gì trên database trong slice này, và để
-- runtime sẵn sàng nhận DML khi schema/bảng được tạo trong slice sau.
-- Không CREATE SCHEMA, không bảng, không thao tác dữ liệu trong file này.
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_marketplace_migrator
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecoma_llm_marketplace_runtime;
