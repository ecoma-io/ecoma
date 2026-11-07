/**
 * Use case publish-pact — structural check của payload publish trước khi chạm
 * repo. Upstream kiểm shape ngay trong route; tách ra application để policy
 * "pact nào đủ điều kiện publish" không nằm trong HTTP mapping, và route chỉ
 * dịch kết quả ra 400.
 */
import type { PactContent } from '@ecoma-io/pact-broker-api-domain';

/** Trần số interactions mỗi pact publish (chống payload lạm dụng). */
export const MAX_PACT_INTERACTIONS = 1000;

/** Kết quả structural check — `outcome: 'rejected'` kèm message 400 hiện tại. */
export type PactStructuralDecision =
  | { outcome: 'accepted'; pact: PactContent }
  | { outcome: 'rejected'; message: string };

/**
 * Kiểm tra cấu trúc tối thiểu của payload publish: phải có consumer, provider
 * và interactions là array không vượt `MAX_PACT_INTERACTIONS`. Message rejection
 * giữ nguyên văn của route — response byte-identical.
 */
export function validatePactStructure(body: unknown): PactStructuralDecision {
  const pact = body as PactContent;

  if (!pact.consumer || !pact.provider || !pact.interactions) {
    return {
      outcome: 'rejected',
      message: 'Pact must contain consumer, provider, and interactions',
    };
  }

  if (!Array.isArray(pact.interactions)) {
    return { outcome: 'rejected', message: 'interactions must be an array' };
  }

  if (pact.interactions.length > MAX_PACT_INTERACTIONS) {
    return {
      outcome: 'rejected',
      message: `Pact contains ${pact.interactions.length} interactions; the maximum is ${MAX_PACT_INTERACTIONS}`,
    };
  }

  return { outcome: 'accepted', pact };
}
