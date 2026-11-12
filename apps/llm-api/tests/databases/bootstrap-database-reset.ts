/**
 * Reset toàn bộ trạng thái business của các database mà chuỗi kịch bản
 * bootstrap 8a/8b/bước-9/bước-10 ghi (`db-llm-gateway` schema `llm_seller` +
 * `llm_gateway` + `llm_financial`, `db-llm-marketplace` schema
 * `llm_marketplace`, `db-llm-tenant` schema `llm_tenant`) về trạng thái "chưa
 * seed" — dùng bởi
 * `afterEach`/`afterAll` của các spec bootstrap và có thể dùng lại cho nhóm
 * kịch bản cần seed fresh.
 *
 * Vì sao tồn tại: `startLlmApiDatabase()` là factory không memoise, nên **mỗi
 * spec file** được một container riêng, nhưng mọi test trong cùng một file chia
 * sẻ cùng database. Một chuỗi kịch bản cố ý chạy tuần tự vẫn phải để lại trạng
 * thái ổn định khi assertion giữa chuỗi thất bại — nếu không, test sau báo sai
 * nguyên nhân. Reset ở biên (hook) chứ không ở cuối thân test: hook vẫn chạy khi
 * test đỏ.
 *
 * Hai schema KHÔNG có FK chéo (ADR-0027 §8: `seller_tenant_id` cố ý không FK),
 * nên mỗi schema reset độc lập và thứ tự giữa hai lời gọi không quan trọng.
 *
 * `bootstrap_audit` ở cả hai schema là cột identity không FK — `TRUNCATE ... CASCADE`
 * chỉ theo FK nên phải liệt kê tường minh; bỏ sót làm `RESTART IDENTITY` không
 * đặt lại chuỗi và làm mọi assertion "đúng N dòng audit" phụ thuộc test chạy trước.
 * Danh sách bảng khớp `migrations.spec.ts` (một nguồn thật cho tập bảng của #23).
 */

import type { LlmApiDatabase } from '../integrations/harness.ts';

/** Bảng nghiệp vụ `llm_seller` (db-llm-gateway) — migration `gateway/0002`. */
const GATEWAY_TABLES: readonly string[] = [
  'seller_memberships',
  'principal_associations',
  'verification_submissions',
  'verification_cases',
  'restriction_records',
  'principal_evidence',
  'principal_legal_profiles',
  'principal_tax_profiles',
  'legal_principals',
  'seller_tenants',
  'bootstrap_audit',
];

/** Bảng nghiệp vụ `llm_marketplace` (db-llm-marketplace) — migration `marketplace/0004`. */
const MARKETPLACE_TABLES: readonly string[] = [
  'model_offers',
  'endpoint_pools',
  'upstream_endpoints',
  'provider_credentials',
  'bootstrap_audit',
];

/** Bảng nghiệp vụ `llm_tenant` (db-llm-tenant) — migration `tenant/0002`. */
const TENANT_TABLES: readonly string[] = ['tenants', 'memberships', 'bootstrap_audit'];

/** Bảng runtime `llm_gateway` (db-llm-gateway) — migration `gateway/0003`. */
const GATEWAY_RUNTIME_TABLES: readonly string[] = ['api_keys', 'bootstrap_audit'];

/** Bảng nghiệp vụ `llm_financial` (db-llm-gateway) — migration `gateway/0004`. */
const FINANCIAL_TABLES: readonly string[] = [
  'sponsor_grants',
  'sponsor_funding_authorizations',
  'billing_accounts',
  'sponsors',
  'bootstrap_audit',
];

/**
 * `TRUNCATE` một tập bảng đã đóng gói identifier, `RESTART IDENTITY` để cột
 * identity trở về 1 — assertion về thứ tự audit không phụ thuộc số lần chạy.
 * Tên bảng là hằng trong file này, không đến từ input bên ngoài.
 */
async function truncate(
  db: LlmApiDatabase,
  key: 'gateway' | 'tenant' | 'marketplace',
  schema: string,
  tables: readonly string[],
): Promise<void> {
  const client = await db.connectAsMigrator(key);
  try {
    await client.query(
      `TRUNCATE ${tables.map((table) => `${schema}.${table}`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await client.end();
  }
}

/** Đưa `llm_seller` của `db-llm-gateway` về trạng thái chưa seed. */
export function resetSellerGovernance(db: LlmApiDatabase): Promise<void> {
  return truncate(db, 'gateway', 'llm_seller', GATEWAY_TABLES);
}

/** Đưa `llm_marketplace` của `db-llm-marketplace` về trạng thái chưa seed. */
export function resetMarketplace(db: LlmApiDatabase): Promise<void> {
  return truncate(db, 'marketplace', 'llm_marketplace', MARKETPLACE_TABLES);
}

/**
 * Đưa trạng thái bước 9 về "chưa seed": `llm_tenant` của `db-llm-tenant` và
 * `llm_gateway` của `db-llm-gateway` (hai database mà runner bước 9 ghi — hai
 * schema không FK chéo nên mỗi schema reset độc lập).
 */
export async function resetConsumerTenant(db: LlmApiDatabase): Promise<void> {
  await truncate(db, 'tenant', 'llm_tenant', TENANT_TABLES);
  await truncate(db, 'gateway', 'llm_gateway', GATEWAY_RUNTIME_TABLES);
}

/**
 * Đưa trạng thái bước 10 về "chưa seed": `llm_financial` của `db-llm-gateway`.
 * FK nội schema được liệt kê theo thứ tự con → cha cho tường minh; `CASCADE`
 * bảo đảm mọi referencing table đều nằm trong tập đã liệt kê.
 */
export function resetFinancial(db: LlmApiDatabase): Promise<void> {
  return truncate(db, 'gateway', 'llm_financial', FINANCIAL_TABLES);
}
