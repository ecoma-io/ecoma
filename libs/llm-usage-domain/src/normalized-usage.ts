/**
 * `NormalizedUsage` — value object invariant của bounded context `llm-usage`.
 *
 * Nguồn ràng buộc:
 * - `docs/domains/llm-usage/domain-model.md` §3: `cached_tokens ≤ input_tokens`
 *
 * `TokenCount = number | null` — `null` là unknown, KHÔNG phải 0. Không có giá trị âm.
 * Category null → tổng null (không coi null là 0).
 */

import type { NormalizedUsage, TokenCount } from './types';

/** Kiểm một `TokenCount` có giá trị hợp lệ không (số không âm, hoặc null). */
export function isValidTokenCount(value: TokenCount): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/** Tạo `NormalizedUsage` từ các thành phần, kiểm invariant `cached ≤ input` khi có thể. */
export function createNormalizedUsage({
  input_tokens,
  output_tokens,
  cached_tokens,
  reasoning_tokens,
  request_count,
}: {
  input_tokens: TokenCount;
  output_tokens: TokenCount;
  cached_tokens: TokenCount;
  reasoning_tokens: TokenCount;
  request_count: TokenCount;
}): NormalizedUsage {
  const fields: Record<string, TokenCount> = {
    input_tokens,
    output_tokens,
    cached_tokens,
    reasoning_tokens,
    request_count,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (!isValidTokenCount(value)) {
      throw new TypeError(
        `${name} phải là số không âm hoặc null (unknown), nhận: ${JSON.stringify(value)}`,
      );
    }
  }

  // Invariant: cached_tokens ≤ input_tokens, chỉ đánh giá khi cả hai đã biết.
  if (cached_tokens !== null && input_tokens !== null && cached_tokens > input_tokens) {
    throw new TypeError(
      `cached_tokens (${cached_tokens}) không được lớn hơn input_tokens (${input_tokens})`,
    );
  }

  // Invariant: reasoning_tokens là subset của output_tokens; không kiểm cưỡng
  // vì DoF chỉ khuyến nghị semantic (không ép invariant khi chỉ một phần biết).
  return { input_tokens, output_tokens, cached_tokens, reasoning_tokens, request_count } as const;
}

/**
 * Tổng token normalized = input + output.
 * Trả `null` khi input hoặc output là null (unknown), KHÔNG coi null là 0.
 * Cached/reasoning không được tính vào tổng (subset, không double-count).
 */
export function computeTotalTokens(usage: NormalizedUsage): number | null {
  if (usage.input_tokens === null || usage.output_tokens === null) {
    return null;
  }
  return usage.input_tokens + usage.output_tokens;
}

/**
 * Validate invariant của một `NormalizedUsage`.
 * Trả về `{ valid: true }` hoặc `{ valid: false, violation: string }`.
 * Không mutate input.
 */
export function validateUsageInvariants(usage: NormalizedUsage): {
  readonly valid: boolean;
  readonly violation?: string;
} {
  if (
    usage.cached_tokens !== null &&
    usage.input_tokens !== null &&
    usage.cached_tokens > usage.input_tokens
  ) {
    return { valid: false, violation: 'cached_tokens phải ≤ input_tokens' };
  }
  return { valid: true };
}

/** Kiểm một object có phải `NormalizedUsage` không (type guard, không mutate). */
export function isNormalizedUsage(value: unknown): value is NormalizedUsage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const u = value as NormalizedUsage;
  return (
    isValidTokenCount(u.input_tokens) &&
    isValidTokenCount(u.output_tokens) &&
    isValidTokenCount(u.cached_tokens) &&
    isValidTokenCount(u.reasoning_tokens) &&
    isValidTokenCount(u.request_count)
  );
}
