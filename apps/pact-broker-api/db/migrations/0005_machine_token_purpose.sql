-- 0005_machine_token_purpose.sql — cột `purpose` của machine token (expand-only).
--
-- ADR-0032 §2 (quyết định 6 của #205): purpose là creation-time metadata +
-- validation, KHÔNG phải authorization runtime — request time không bao giờ
-- đọc purpose để quyết định allow/deny; scope và role quyết định. Giá trị:
-- 'developer' | 'ci'; NULL = không khai (đường machine token của Pact CLI
-- không bắt buộc purpose — contract FR-008 của CLI giữ nguyên; đường user
-- (portal) bắt buộc chọn purpose lúc tạo, kiểm ở tầng route).
--
-- Additive và forward-only (expand): cột nullable + CHECK, replay được bằng
-- guard IF NOT EXISTS; không đọc lại cột mới ở migration này (contract
-- rollout). Không data rewrite nào — mọi hàng hiện có giữ NULL đúng nghĩa
-- "không khai".

BEGIN;

ALTER TABLE pact.machine_tokens
  ADD COLUMN IF NOT EXISTS purpose text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'machine_tokens_purpose_check'
  ) THEN
    ALTER TABLE pact.machine_tokens
      ADD CONSTRAINT machine_tokens_purpose_check
      CHECK (purpose IS NULL OR purpose IN ('developer', 'ci'));
  END IF;
END
$$;

COMMENT ON COLUMN pact.machine_tokens.purpose IS
  'Creation-time purpose label: developer or ci; NULL = not declared (machine path). Metadata and creation-time validation only - never a runtime authorization input (ADR-0032 section 2); scope and role decide.';

COMMIT;
