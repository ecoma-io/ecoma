-- 0004_tenant_classification_and_plan.sql — phân loại tenant, plan và invariant Free-slot.
--
-- Triển khai việc schema bắt buộc theo
-- docs/domains/pact-broker/domain-model.md §2.6 (classification, plan,
-- một-free-slot-mỗi-owner): classification là cột NOT NULL với đúng hai giá
-- trị ('first_party' | 'customer'); plan ('free' | 'paid') tồn tại khi và chỉ
-- khi classification là 'customer' (tenant first_party không có plan); một
-- owner giữ tối đa một tenant 'free' chưa deleted đồng thời, được bắt bởi
-- partial unique index tenants_one_free_per_owner_key — tenant suspended vẫn
-- chiếm slot, tenant deleted nhả slot, và tenant first_party không bao giờ
-- khớp predicate vì plan của nó là NULL.
--
-- Sửa danh tính canonical (ADR-0020 quyết định 9: mọi ecoma-internal còn lại
-- được đọc là ecoma). Một hàng tên 'ecoma-internal' chỉ có thể do chính các
-- writer internal của service này ghi — bootstrap helper
-- (db/bootstrap-tenant.mts trước khi đổi tên, khi đó mang tên
-- 'ecoma-internal') hoặc đường ensureTenant của entitlement; không đường nào
-- dành cho customer có thể sinh ra tên đó. Vì vậy việc đổi tên thành 'ecoma'
-- là sửa lỗi xác định theo nguồn gốc (origin-established), không phải đoán,
-- và hàng canonical được phân loại 'first_party' không có plan. Việc đổi tên
-- fail-closed khi cả 'ecoma' và 'ecoma-internal' cùng tồn tại: khi đó hàng
-- nào là canonical là mơ hồ và phải được operator giải quyết trước khi chạy
-- lại migration.
--
-- Những hàng vẫn chưa có classification sau backfill first_party (ví dụ một
-- hàng seed 'local' cũ) làm migration fail-closed kèm tên các hàng vi phạm:
-- dữ liệu local lane là disposable và được dựng lại bằng local-up sau
-- local-down; database nào khác cần quyết định tường minh của operator cho
-- từng hàng. Không có phép đoán classification ngầm nào ở đây.
--
-- Additive và forward-only; mọi câu lệnh chạy lại được (guard IF NOT EXISTS /
-- DO-block, như 0003), nên runner có thể replay mọi file. KHÔNG chèn hàng
-- tenant, membership hay machine-token ở đây: ADR-0020 dành dữ liệu bootstrap
-- cho tầng bootstrap, không phải cho migration.

BEGIN;

-- Các cột mới được thêm nullable: NOT NULL trên classification chỉ được đặt
-- sau backfill fail-closed bên dưới, để hàng legacy được nêu tên trong lỗi
-- thay vì vi phạm constraint mà không có lời giải thích.
ALTER TABLE pact.tenants
  ADD COLUMN IF NOT EXISTS classification text,
  ADD COLUMN IF NOT EXISTS plan text;

-- Sửa danh tính canonical (ADR-0020 quyết định 9).
DO $$
DECLARE
  legacy_count integer;
  canonical_count integer;
BEGIN
  SELECT count(*) INTO legacy_count FROM pact.tenants WHERE name = 'ecoma-internal';
  SELECT count(*) INTO canonical_count FROM pact.tenants WHERE name = 'ecoma';

  IF legacy_count > 0 AND canonical_count > 0 THEN
    RAISE EXCEPTION
      'migration 0004: both an "ecoma" and an "ecoma-internal" tenant row exist; which row is the canonical internal tenant is ambiguous. Resolve the duplicate manually (keep the row that carries real data) and re-run this migration';
  END IF;

  IF legacy_count > 0 THEN
    UPDATE pact.tenants SET name = 'ecoma' WHERE name = 'ecoma-internal';
  END IF;
END
$$;

-- Backfill: tenant internal canonical là first_party không có plan (domain
-- model §2.6). Idempotent: chạy lại ghi lại đúng các giá trị đó.
UPDATE pact.tenants
   SET classification = 'first_party',
       plan = NULL
 WHERE name = 'ecoma';

-- Fail-closed khi còn hàng nào thiếu classification: nếu không, NOT NULL bên
-- dưới sẽ biến một hàng legacy không thể phân loại thành lỗi constraint
-- không có lời giải thích.
DO $$
DECLARE
  unclassified text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO unclassified
    FROM pact.tenants
   WHERE classification IS NULL;

  IF unclassified IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 0004: tenant row(s) still without a classification after the first_party backfill: %. Classification is NOT NULL as of this migration and is never guessed. Local lane data is disposable: rebuild it with "pnpm nx run-many -t local-down -c local" followed by "pnpm nx run-many -t local-up -c local". For any other database, decide each named row explicitly (first_party via the internal bootstrap path, customer via the customer provisioning path) and re-run this migration',
      unclassified;
  END IF;
END
$$;

-- Idempotent: SET NOT NULL trên một cột đã NOT NULL là no-op.
ALTER TABLE pact.tenants
  ALTER COLUMN classification SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_classification_check'
      AND conrelid = 'pact.tenants'::regclass
  ) THEN
    ALTER TABLE pact.tenants
      ADD CONSTRAINT tenants_classification_check
      CHECK (classification IN ('first_party', 'customer'));
  END IF;
END
$$;

-- Giá trị plan hàm ý tenant customer: first_party không có plan (không phải
-- một giá trị enum thứ ba, mà là sự vắng mặt của plan).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_plan_only_when_customer_check'
      AND conrelid = 'pact.tenants'::regclass
  ) THEN
    ALTER TABLE pact.tenants
      ADD CONSTRAINT tenants_plan_only_when_customer_check
      CHECK (plan IS NULL OR classification = 'customer');
  END IF;
END
$$;

-- Tenant customer mang đúng một trong hai plan. Guard tường minh
-- `plan IS NOT NULL` là bắt buộc: biểu thức trần
-- `classification <> 'customer' OR plan IN ('free','paid')` trả về NULL (và
-- PASS) khi plan là NULL, vì SQL CHECK constraint coi NULL là thoả mãn
-- (three-valued logic).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_customer_plan_values_check'
      AND conrelid = 'pact.tenants'::regclass
  ) THEN
    ALTER TABLE pact.tenants
      ADD CONSTRAINT tenants_customer_plan_values_check
      CHECK (classification <> 'customer' OR (plan IS NOT NULL AND plan IN ('free', 'paid')));
  END IF;
END
$$;

-- Invariant Free-slot (domain model §2.6): tối đa một tenant 'free' chưa
-- deleted đồng thời cho mỗi owner_sub. Tenant suspended vẫn chiếm slot (chỉ
-- status 'deleted' nhả slot); first_party không bao giờ khớp vì plan của nó
-- là NULL. Tên index theo convention <table>_<descriptor>_key hiện có.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_free_per_owner_key
  ON pact.tenants (owner_sub)
  WHERE plan = 'free' AND status <> 'deleted';

COMMENT ON COLUMN pact.tenants.classification IS
  'Organizational classification of the tenant: first_party (Ecoma-owned, provisioned only through the internal bootstrap path) or customer (provisioned through the customer path). Never inferred from owner, name, environment or plan; immutable after provisioning; a plan value exists only when classification is customer (domain model 2.6).';
COMMENT ON COLUMN pact.tenants.plan IS
  'Commercial plan of a customer tenant: free or paid. NULL for first_party tenants (plan does not apply — it is not a third enum value). At most one concurrent non-deleted free tenant per owner_sub is enforced by the partial unique index tenants_one_free_per_owner_key; suspended tenants keep consuming the slot, deleted tenants release it (domain model 2.6).';

COMMIT;
