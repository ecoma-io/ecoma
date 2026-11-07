/**
 * `classifyUsage` — phân loại usage từ provider thành `UsageStatus`.
 *
 * `null`/`undefined` → `missing` (provider không trả), mảng / giá trị nguyên
 * thủy → `malformed`, object không có trường token nào → `partial`, có ít nhất
 * một trường token → `known`. KHÔNG silently coi missing/malformed là 0.
 *
 * Nguồn: `docs/domains/llm-usage/domain-model.md` §5.
 */

import type { UsageStatus } from './types';

/**
 * Phân loại usage từ giá trị thô của provider.
 */
export function classifyUsage(providerUsage: unknown): UsageStatus {
  if (providerUsage === null || providerUsage === undefined) {
    return 'missing';
  }
  // Mảng hoặc giá trị nguyên thủy không phải bản ghi usage hợp lệ → malformed.
  if (Array.isArray(providerUsage) || typeof providerUsage !== 'object') {
    return 'malformed';
  }
  const p = providerUsage as Record<string, unknown>;
  const hasTokenField =
    p.input_tokens !== undefined ||
    p.output_tokens !== undefined ||
    p.cached_tokens !== undefined ||
    p.reasoning_tokens !== undefined ||
    p.request_count !== undefined;
  return hasTokenField ? 'known' : 'partial';
}
