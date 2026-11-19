-- 0003_narrow_default_privileges.sql — thu hẹp default privileges của `db-llm-marketplace` trong slice db-migration của Issue #22.
--
-- ADP toàn database của `0001` cấp cho runtime DML trên MỌI bảng migrator tạo sau đó,
-- ở BẤT KỂ schema nào (kể cả `public` nếu có bảng lọt vào). ADP theo schema của `0002`
-- (`IN SCHEMA llm_marketplace`) mới là ranh giới đúng. REVOKE không kèm `IN SCHEMA`
-- chỉ đụng tuple default-ACL toàn cục trong `pg_default_acl` (`defaclnamespace = 0`),
-- nên entry theo schema của `0002` giữ nguyên: sau file này runtime chỉ còn DML trên
-- bảng nằm trong `llm_marketplace`.
-- Không viết lại `0001` (forward-fix — viết lại cũng không hoàn tác được entry
-- `pg_default_acl` đã ghi trên stack đã provision; apply không ledger, catalog
-- PostgreSQL sau apply là nguồn sự thật).
-- DDL idempotent, không ledger, không down-migration (ADR-0025 §6, 02-delivery.md §3).

ALTER DEFAULT PRIVILEGES FOR ROLE ecoma_llm_marketplace_migrator
  REVOKE ALL ON TABLES FROM ecoma_llm_marketplace_runtime;
