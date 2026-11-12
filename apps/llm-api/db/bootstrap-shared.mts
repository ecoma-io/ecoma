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
