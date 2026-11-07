/**
 * Model cua routing candidate — mot provider/endpoint (hoac offer) co the phuc
 * vu mot model alias, kèm dieu kien eligibility.
 *
 * Candidate chi chua tinh chat tinh static. Tat ca thong tin thuc chay
 * (health, policy, tenant scope) duoc truyen vao cua ham evaluateEligibility
 * nhu facts — domain khong truy vấn authorization/health ben ngoai.
 */

import { isNonEmptyString } from './shared';

export type CandidateId = string & { readonly __brand: unique symbol };

export type CandidateStatus = 'active' | 'disabled' | 'retired';

export const CANDIDATE_STATUS = {
  active: 'active',
  disabled: 'disabled',
  retired: 'retired',
} as const;

export type CandidateCapability = {
  readonly model: string;
  readonly streaming: boolean;
};

export type Candidate = {
  readonly candidateId: CandidateId;
  readonly status: CandidateStatus;
  readonly priority: number; // so nho = uu tien cao hon
  readonly capability: CandidateCapability;
  readonly endpoints: readonly string[];
  readonly offerId: string;
};

export function isCandidateId(value: unknown): value is CandidateId {
  return isNonEmptyString(value);
}

export function isCandidateStatus(value: unknown): value is CandidateStatus {
  return (
    typeof value === 'string' &&
    (value === CANDIDATE_STATUS.active ||
      value === CANDIDATE_STATUS.disabled ||
      value === CANDIDATE_STATUS.retired)
  );
}

export function isCandidateCapability(value: unknown): value is CandidateCapability {
  return (
    typeof value === 'object' &&
    value !== null &&
    isNonEmptyString((value as CandidateCapability).model) &&
    typeof (value as CandidateCapability).streaming === 'boolean'
  );
}

export function isCandidate(value: unknown): value is Candidate {
  return (
    typeof value === 'object' &&
    value !== null &&
    isCandidateId((value as Candidate).candidateId) &&
    isCandidateStatus((value as Candidate).status) &&
    typeof (value as Candidate).priority === 'number' &&
    Number.isSafeInteger((value as Candidate).priority) &&
    isCandidateCapability((value as Candidate).capability) &&
    Array.isArray((value as Candidate).endpoints) &&
    (value as Candidate).endpoints.every((e: unknown) => isNonEmptyString(e)) &&
    isNonEmptyString((value as Candidate).offerId)
  );
}

export function createCandidateId(value: unknown): CandidateId {
  if (!isCandidateId(value)) {
    throw new Error('invalid candidate id');
  }
  return value as CandidateId;
}
