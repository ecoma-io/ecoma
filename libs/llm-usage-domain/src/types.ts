/**
 * Canonical types của bounded context `llm-usage`.
 *
 * Nguồn: `docs/domains/llm-usage/domain-model.md` §1–§12,
 *
 * Mọi giá trị là readonly / immutable. Không có Node builtin, không I/O,
 * không đồng hồ, không randomness.
 */

export type TokenCount = number | null;

/**
 * NormalizedUsage — schema chung của `llm-usage` sau khi chuẩn hóa từ định dạng provider.
 *
 * - `input_tokens`, `output_tokens`: số token hoặc `null` (unknown).
 * - `cached_tokens`: subset của `input_tokens`, KHÔNG cộng vào tổng.
 * - `reasoning_tokens`: subset của `output_tokens`, KHÔNG cộng vào tổng.
 * - `request_count`: 0 / 1 / null, không âm.
 *
 * Tổng token normalized = input + output (cached/reasoning không được tính hai lần).
 * Nếu bất kỳ thành phần nào cần cho tổng là null → tổng là null (unknown), không coi null là 0.
 */
export interface NormalizedUsage {
  readonly input_tokens: TokenCount;
  readonly output_tokens: TokenCount;
  readonly cached_tokens: TokenCount;
  readonly reasoning_tokens: TokenCount;
  readonly request_count: TokenCount;
}

export type UsageStatus = 'known' | 'missing' | 'malformed' | 'partial';

export const USAGE_STATUS: Readonly<Record<UsageStatus, UsageStatus>> = {
  known: 'known',
  missing: 'missing',
  malformed: 'malformed',
  partial: 'partial',
} as const;

/**
 * Provenance — đủ để truy vết usage về attempt/provider gốc.
 *
 * `timestamp` là ISO 8601 UTC do caller truyền vào; domain không đọc đồng hồ.
 */
export interface Provenance {
  readonly provider: string;
  readonly model: string;
  readonly attempt_id: string;
  readonly request_id: string;
  readonly normalizer_version: string;
  readonly raw_usage_reference: string;
  readonly timestamp: string;
}

/**
 * ParsedProviderUsage — định dạng provider đã được parse (lớp adapter/infrastructure
 * phụ trách parse raw HTTP payload, domain KHÔNG đọc raw HTTP).
 *
 * Đây là input model của `normalizeUsage`. Các trường có thể null/unknown nếu
 * provider không cung cấp.
 */
export interface ParsedProviderUsage {
  readonly provider: string;
  readonly model: string;
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cached_tokens?: number | null;
  readonly reasoning_tokens?: number | null;
  readonly request_count?: number | null;
  readonly raw_usage: unknown;
}

/**
 * AttemptUsage — usage của một provider attempt (normalized + raw reference +
 * normalizer version + provenance). Dùng cho audit / reconciliation, KHÔNG nhân
 * lên charge.
 */
export interface AttemptUsage {
  readonly usage: NormalizedUsage;
  readonly status: UsageStatus;
  readonly provenance: Provenance;
  readonly raw_usage_reference: string;
}

/**
 * RequestUsage — usage tổng hợp cho một logical request.
 *
 * - `attempts`: tất cả attempt của logical request.
 * - `aggregated`: tổng của các attempt completed (theo sum — xem U-1 trong DoF);
 *   null khi không có attempt completed nào.
 * - `status`: trạng thái tổng hợp của request-level usage.
 */
export interface RequestUsage {
  readonly request_id: string;
  readonly attempts: readonly AttemptUsage[];
  readonly aggregated: NormalizedUsage | null;
  readonly status: UsageStatus;
}

/**
 * Correction — điều chỉnh usage sau khi ghi. Idempotent theo khóa
 * `(reservation_id, correction_id)` (request-level) hoặc
 * `(attempt_id, correction_id)` (attempt-level).
 */
export interface Correction {
  readonly correction_id: string;
  readonly scope: 'request' | 'attempt';
  readonly reservation_id?: string;
  readonly attempt_id?: string;
  readonly usage: NormalizedUsage;
}

/**
 * ReconciliationResult — kết quả so sánh request-level với tổng attempt-level +
 * settlement.
 *
 * Domain chỉ so sánh và trả về kết quả, KHÔNG sở hữu settlement và KHÔNG overwrite
 * dữ liệu.
 */
export interface ReconciliationResult {
  readonly outcome: 'match' | 'mismatch' | 'incomplete';
  readonly detail: string;
}

/**
 * DomainError — value object lỗi domain: `code` ổn định + `message` tiếng Anh ngắn
 * gọn (runtime string, không chứa secret/token/identifier nhạy cảm).
 */
export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
}

export type DomainErrorCode =
  | 'invalid_usage'
  | 'invalid_token_count'
  | 'invalid_correction'
  | 'unknown_normalizer_version'
  | 'usage_missing'
  | 'usage_malformed';
