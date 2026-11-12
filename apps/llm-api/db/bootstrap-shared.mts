/**
 * Shared surface của hai bootstrap runner 8a/8b (ADR-0020 Quyết định 4, 12, 13).
 *
 * Quy ước chung:
 * - **Fail-closed**: thiếu env, sai database, divergence dữ liệu đều dừng run
 *   với mã exit khác 0 và thông báo kèm hướng dẫn — không có giá trị mặc định
 *   im lặng, không có trạng thái "half-configured".
 * - **stdout chỉ chứa dòng máy đọc** (`KEY=value`); log người đọc đi stderr,
 *   để deploy pipeline extract verdict từ stdout không bị nhiễu.
 * - Credential plaintext không bao giờ được log/echo ở bất kỳ runner nào.
 * - Mọi giá trị thời gian là epoch millis (millisecond) — khớp domain.
 */

import { createHash } from 'node:crypto';
import type { Client } from 'pg';

/** Tên Seller tenant canonical (định danh công khai, ADR-0027 §2). */
export const CANONICAL_SELLER_TENANT_NAME = 'dronie';

/** Seller tenant id hằng số — dùng chung 8a/8b vì hai runner chạm hai database. */
export const SELLER_TENANT_ID = 'seller-tenant-dronie';

/** Id membership của owner trong bước seed 8a (ADR-0020 Quyết định 13, ADR-0027 §2). */
export const SELLER_OWNER_MEMBERSHIP_ID = 'seller-membership-dronie-owner';

/** Principal id hằng số trong code (ADR-0020 Quyết định 12, ADR-0027 §3). */
export const LEGAL_PRINCIPAL_ID = 'first-party-principal-ecoma-io';

/** Type verification gắn trục legal — principal-scoped. */
export const PRINCIPAL_LEGAL_CASE_TYPE = 'legal-identity';

/** Type verification gắn trục tax — principal-scoped. */
export const PRINCIPAL_TAX_CASE_TYPE = 'tax';

/** Ánh xạ `type → trục profile` của bootstrap (cấu hình provisioning §3.6). */
export const BOOTSTRAP_PROFILE_AXES = Object.freeze([
  Object.freeze({ type: PRINCIPAL_LEGAL_CASE_TYPE, axis: 'legal' }),
  Object.freeze({ type: PRINCIPAL_TAX_CASE_TYPE, axis: 'tax' }),
]);

/** Các verification type bắt buộc để seller nội bộ đủ điều kiện (§4). */
export const BOOTSTRAP_REQUIRED_TYPES = Object.freeze([
  PRINCIPAL_LEGAL_CASE_TYPE,
  PRINCIPAL_TAX_CASE_TYPE,
]);

/** Id hằng số của hai case principal-scoped. */
export const PRINCIPAL_LEGAL_CASE_ID = 'verification-case-ecoma-io-legal-identity';
export const PRINCIPAL_TAX_CASE_ID = 'verification-case-ecoma-io-tax';

/** Id hằng số của hai evidence reference. */
export const LEGAL_EVIDENCE_ID = 'evidence-ecoma-io-legal-identity';
export const TAX_EVIDENCE_ID = 'evidence-ecoma-io-tax';

/** Actor provisioning ghi vào mọi attribution của run bootstrap. */
export const BOOTSTRAP_ACTOR_ENV = 'ECOMA_GOVERNANCE_ACTOR';

/** Env chứa `sub` Superadmin bootstrap — owner của tenant canonical. */
export const OWNER_SUB_ENV = 'ECOMA_SELLER_TENANT_OWNER_SUB';

// ---------------------------------------------------------------------------
// Bước 9 — Consumer tenant canonical (`llm-consumer-tenant`, Issue #24)
// ---------------------------------------------------------------------------

/** Tên Consumer tenant canonical — hằng trong code, không bao giờ `ecoma-internal` (ADR-0020 Quyết định 9). */
export const CANONICAL_CONSUMER_TENANT_NAME = 'ecoma';

/** Consumer tenant id hằng số — hai database của bước 9 cùng đọc hằng này (không truyền giá trị xuyên DB). */
export const CONSUMER_TENANT_ID = 'consumer-tenant-ecoma';

/** Id membership của owner trong bước seed 9 (ADR-0020 Quyết định 13). */
export const CONSUMER_OWNER_MEMBERSHIP_ID = 'consumer-membership-ecoma-owner';

/** Env chứa `sub` Superadmin bootstrap — owner của Consumer tenant canonical. */
export const CONSUMER_TENANT_OWNER_SUB_ENV = 'ECOMA_CONSUMER_TENANT_OWNER_SUB';

/** Env chứa chuỗi kết nối migrator của `db-llm-tenant` cho bước 9. */
export const CONSUMER_TENANT_DATABASE_URL_ENV = 'ECOMA_TENANT_DATABASE_URL';

/** Env chứa chuỗi kết nối migrator của `db-llm-gateway` cho bước 9 (API key). */
export const CONSUMER_GATEWAY_DATABASE_URL_ENV = 'ECOMA_GATEWAY_DATABASE_URL';

// ---------------------------------------------------------------------------
// Bước 10 — Sponsor funding bootstrap (`llm-financial`, ADR-0028 §6, Issue #24)
// ---------------------------------------------------------------------------

/**
 * Sponsor id hằng trong code (ADR-0020 Quyết định 12 pattern): env chỉ
 * **assert** khớp hằng này, không bao giờ định danh sponsor qua env — giá trị
 * khác là divergence fail-closed.
 */
export const SPONSOR_ID = 'sponsor_ecoma_internal';

/** Billing account id hằng số của tenant consumer (natural key là `tenant_ref`). */
export const CONSUMER_BILLING_ACCOUNT_ID = 'billing-account-ecoma';

/** Funding authorization id hằng số (natural key là cặp sponsor + billing account). */
export const SPONSOR_FUNDING_AUTHORIZATION_ID = 'sponsor-auth-ecoma-consumer';

/** Id grant khởi tạo — đúng tên ADR-0028 §6 B4 (`grant_ecoma_initial`). */
export const SPONSOR_GRANT_ID = 'grant_ecoma_initial';

/**
 * Denomination duy nhất của funding bootstrap (ADR-0028 §2: grant UC vào ví
 * consumer). Cố định trong code — amount env là số minor units trong miền này.
 */
export const SPONSOR_FUNDING_DENOMINATION = 'UC' as const;

/** Env assert định danh sponsor (giá trị phải khớp `SPONSOR_ID`). */
export const SPONSOR_ID_ENV = 'ECOMA_SPONSOR_ID';

/** Env trần sponsor — bắt buộc, số nguyên ≥ 0, minor units, không có mặc định. */
export const SPONSOR_CEILING_ENV = 'ECOMA_SPONSOR_CEILING';

/**
 * Env trần per-account của authorization — bắt buộc, số nguyên ≥ 0 HOẶC chữ
 * `null` nghĩa là explicit không trần per-account (ADR-0028 §6 B3).
 */
export const SPONSOR_AUTHORIZATION_CEILING_ENV = 'ECOMA_SPONSOR_AUTHORIZATION_CEILING';

/** Env evidence_ref của authorization — bắt buộc, opaque. */
export const SPONSOR_AUTHORIZATION_EVIDENCE_REF_ENV = 'ECOMA_SPONSOR_AUTHORIZATION_EVIDENCE_REF';

/** Env amount grant khởi tạo — bắt buộc, số nguyên > 0, minor units. */
export const SPONSOR_GRANT_AMOUNT_ENV = 'ECOMA_SPONSOR_GRANT_AMOUNT';

/** Env `tenant_id` do bước 9 xuất ra (deploy wiring đọc từ `CONSUMER_TENANT_RESULT`). */
export const CONSUMER_TENANT_ID_ENV = 'ECOMA_CONSUMER_TENANT_ID';

/** Kết quả máy đọc của một run bootstrap, in ra stdout dòng cuối. */
export interface BootstrapRunResult {
  readonly outcome: 'created' | 'no-op' | 'created-draft-unhealthy';
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Đọc env bắt buộc; thiếu hoặc rỗng là lỗi lập trình triển khai — fail-closed
 * kèm hướng dẫn đặt giá trị (ADR-0020 Quyết định 12: config asserts).
 */
export function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    fail(
      `missing required environment variable ${name}; set it on the bootstrap command environment`,
    );
  }
  return raw.trim();
}

/**
 * Đọc env tùy chọn; trả `undefined` khi thiếu/rỗng. Không bao giờ dùng cho
 * secret bắt buộc của đường phục vụ — secret thiếu phải fail-closed.
 */
export function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw.trim();
}

/** Dừng run với mã exit 1 — thông báo đi stderr, không bao giờ có fallback im lặng. */
export function fail(message: string): never {
  console.error(`bootstrap failed: ${message}`);
  process.exit(1);
}

/** SHA-256 hex của credential plaintext — dạng lưu duy nhất của secret. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Khẳng định kết nối đang trỏ đúng database mục tiêu (ADR-0020 Quyết định 4:
 * một sub-bước một database). URL sai là lỗi triển khai, không tự sửa.
 */
export async function assertBootstrapDatabase(
  client: Client,
  expectedDatabase: string,
): Promise<void> {
  const current = await client.query<{ database: string }>('SELECT current_database() AS database');
  const actual = current.rows[0]?.database;
  if (actual !== expectedDatabase) {
    fail(
      `DATABASE_URL points to database "${actual ?? 'unknown'}" but this runner seeds "${expectedDatabase}"`,
    );
  }
}

/** In kết quả máy đọc ra stdout — dòng `KEY=value`, không kèm log người đọc. */
export function printResult(key: string, value: string): void {
  process.stdout.write(`${key}=${value}\n`);
}

/** In kết quả run dạng JSON một dòng (stdout). */
export function printResultJson(key: string, result: BootstrapRunResult): void {
  process.stdout.write(`${key}=${JSON.stringify(result)}\n`);
}

/** Ghi log người đọc ra stderr — stdout được dành riêng cho dòng máy đọc. */
export function log(message: string): void {
  console.error(`[bootstrap] ${message}`);
}
