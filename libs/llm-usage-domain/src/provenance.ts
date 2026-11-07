/**
 * `Provenance` — giá trị truy vết usage về attempt/provider gốc.
 *
 * `timestamp` là ISO 8601 UTC do caller truyền vào; domain KHÔNG đọc đồng hồ.
 */

import type { Provenance } from './types';

/** Tạo `Provenance`. Caller truyền tất cả tham số, kể cả timestamp. */
export function createProvenance({
  provider,
  model,
  attempt_id,
  request_id,
  normalizer_version,
  raw_usage_reference,
  timestamp,
}: {
  provider: string;
  model: string;
  attempt_id: string;
  request_id: string;
  normalizer_version: string;
  raw_usage_reference: string;
  timestamp: string;
}): Provenance {
  return {
    provider,
    model,
    attempt_id,
    request_id,
    normalizer_version,
    raw_usage_reference,
    timestamp,
  } as const;
}

/** Kiểm một giá trị có phải `Provenance` không (type guard). */
export function isProvenance(value: unknown): value is Provenance {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const p = value as Provenance;
  return (
    typeof p.provider === 'string' &&
    typeof p.model === 'string' &&
    typeof p.attempt_id === 'string' &&
    typeof p.request_id === 'string' &&
    typeof p.normalizer_version === 'string' &&
    typeof p.raw_usage_reference === 'string' &&
    typeof p.timestamp === 'string'
  );
}
