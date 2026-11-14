-- 0004_api_key_trusted_ci.sql — trusted_ci flag on api_keys (P4.4, issue #462).
--
-- Thêm cột `trusted_ci` vào bảng `remote_cache.api_keys` để phân biệt HAI
-- PHÂN LỚP credential tường minh của domain model §2.4 (set lúc tạo, không
-- đổi sau đó — trigger guard ở 0008):
--
-- `trusted_ci = true`: **Trusted CI credential** — credential máy tin cậy
-- (pipeline được duy trì); mọi ghi cache ở data plane đòi key trusted kèm
-- scope `write`. Qua đường API, chỉ một key trusted mới tạo được key trusted
-- khác — key không tin cậy không bao giờ tự nâng cấp thành trusted.
--
-- `trusted_ci = false`: **Developer credential** — credential portal cấp cho
-- người dùng (issue #202); không trusted, không ghi được cache ở data plane
-- (A32), phân biệt tường minh với trusted CI ở cả UI lẫn API (R20). Lưu ý
-- phiên bản trước của comment này mô tả `false` chỉ cho key fork/PR — hai
-- phân lớp trên là ngữ nghĩa đúng theo domain model §2.4.
--
-- Cột mặc định là `false` (fail-closed): mỗi key mới tạo là không tin cậy.

BEGIN;

ALTER TABLE remote_cache.api_keys
  ADD COLUMN IF NOT EXISTS trusted_ci boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN remote_cache.api_keys.trusted_ci IS
  'Credential class of the key, set at creation and immutable afterwards '
  '(domain model 2.4; guarded by the api_key_trust_class_guard trigger from 0008). '
  'true = trusted CI credential: writes at the data plane require this class plus the write scope, '
  'and only a trusted key can create another trusted key through the API. '
  'false = developer credential issued by the portal: never trusted for cache writes (R20). '
  'Defaults to false for fail-closed security.';

COMMIT;
