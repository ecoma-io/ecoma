-- 0005_pacts_sha_lookup_index.sql — bỏ UNIQUE (tenant_id, provider_id,
-- consumer_id, content_sha) của pacts, giữ làm index tra cứu thường.
--
-- #221: UNIQUE `pacts_tenant_sha_key` cấm một nội dung tồn tại qua nhiều
-- consumer version — publish trùng sha dưới version mới vi phạm ràng buộc và
-- lộ ra thành 500. Model dữ liệu đúng là model upstream Pact Broker: pact
-- theo (consumer version, provider), nội dung dedup bằng sha — version mới
-- tạo hàng pact riêng trỏ cùng nội dung. Domain model đã ghi nguyên văn
-- (docs/domains/pact-broker/domain-model.md §2.1: "Một pact gắn liền với
-- consumer version và provider, có content SHA-256"), nên UNIQUE này lệch
-- baseline, không phải model mới cần ADR.
--
-- Index tra cứu theo sha vẫn cần cho verification/matrix read surface, giờ
-- không unique. Forward-fix, không rollback data: hàng nào đã publish được
-- giữ nguyên; ràng buộc cũ bị drop chứ không re-create.
--
-- Idempotent theo quy ước chung: DROP IF EXISTS + CREATE IF NOT EXISTS.

BEGIN;

DROP INDEX IF EXISTS pact.pacts_tenant_sha_key;
CREATE INDEX IF NOT EXISTS pacts_tenant_sha_idx
  ON pact.pacts (tenant_id, provider_id, consumer_id, content_sha);

COMMENT ON INDEX pact.pacts_tenant_sha_idx IS
  'Lookup index for verification and matrix reads by content sha within a tenant. Deliberately NOT unique: upstream Pact Broker allows one content across many consumer versions — a pact row is keyed by (consumer version, provider) per pacts_tenant_consumer_version_provider_key (issue #221).';

COMMIT;
