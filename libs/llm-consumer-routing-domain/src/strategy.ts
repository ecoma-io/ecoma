/**
 * Routing strategy selection — chay tren tap eligible (da qua gate eligibility).
 *
 * Tat ham la thuan: nhan tap eligible + trang thai dien vao, tra ket qua chon
 * hoac rejection. Khong luu counter o module global/process memory/Worker.
 * Round-robin cursor truyen vao/tra ra (stateless); persistence o ngoai domain.
 *
 * Weighted chua duoc trien khai (chưa co algorithm/ran buoc trong so duoc chot).
 */

import type { Candidate, CandidateId } from './candidate';
import type { DomainOk, DomainRejection } from './shared';
import { isNonEmptyString } from './shared';

export type RoutingStrategy = 'priority' | 'round_robin' | 'lowest_price';

export const ROUTING_STRATEGY = {
  priority: 'priority',
  round_robin: 'round_robin',
  lowest_price: 'lowest_price',
} as const;

export function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  return (
    typeof value === 'string' &&
    (value === ROUTING_STRATEGY.priority ||
      value === ROUTING_STRATEGY.round_robin ||
      value === ROUTING_STRATEGY.lowest_price)
  );
}

/** Ket qua round-robin: candidate duoc chon + cursor ke tiep. */
export type RoundRobinResult =
  | DomainOk<{ readonly candidateId: CandidateId; readonly nextCursor: RoundRobinCursor }>
  | DomainRejection<'no_eligible_candidate' | 'invalid_strategy_input'>;

export type RoundRobinCursor = number & { readonly __brand: unique symbol };

export function isRoundRobinCursor(value: unknown): value is RoundRobinCursor {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export type PriceFact = {
  readonly candidateId: CandidateId;
  readonly amount: number; // minor unit, so nguyen
  readonly currency: string;
};

export function isPriceFact(value: unknown): value is PriceFact {
  return (
    typeof value === 'object' &&
    value !== null &&
    isNonEmptyStringId((value as PriceFact).candidateId) &&
    typeof (value as PriceFact).amount === 'number' &&
    Number.isSafeInteger((value as PriceFact).amount) &&
    (value as PriceFact).amount >= 0 &&
    isNonEmptyString((value as PriceFact).currency)
  );
}

function isNonEmptyStringId(value: unknown): value is CandidateId {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Priority: chon candidate co priority cao nhat (so nho = uu tien cao hon).
 * Tie-breap: thu tu nhap vao (input order) — deterministik, lap lap.
 *
 * ⚠️ QUYET DINH CHUA DUOC CHOT:architecture mo ta tie-break la "vd. thu tu khai
 bao" (minh hoa), chua co quy tac duyet. Input order duoc dung nhu mot tie-break
 tam thoi de dam bao deterministik, phai xac lap lai khi co quy tac chinh thuc.
 */
export function selectByPriority(eligible: readonly Candidate[]): RoutingStrategyResult {
  if (!Array.isArray(eligible) || eligible.length === 0) {
    return {
      ok: false,
      reason: 'no_eligible_candidate',
      detail: 'Eligible set empty — no candidate to select.',
    };
  }

  let best: Candidate | undefined;
  for (const candidate of eligible) {
    if (!best || candidate.priority < best.priority) {
      best = candidate;
    }
  }
  // eligible da kiem tra rong o tren, nen best luon duoc gan sau vong lap.
  const bestCandidate: Candidate = best ?? eligible[0];
  return { ok: true, candidateId: bestCandidate.candidateId };
}

/**
 * Round-robin: phan bo dan giua cac candidate eligible theo cursor bền.
 * Cursor la chi so vao tap eligible; nhan cursor hien tai, tra candidate duoc
 * chon + cursor ke tiep ((cursor + 1) % length). Khong luu state o domain.
 */
export function selectRoundRobin(
  eligible: readonly Candidate[],
  cursor: RoundRobinCursor,
): RoundRobinResult {
  if (!Array.isArray(eligible) || eligible.length === 0) {
    return {
      ok: false,
      reason: 'no_eligible_candidate',
      detail: 'Eligible set empty — no candidate to select.',
    };
  }
  if (!isRoundRobinCursor(cursor)) {
    return {
      ok: false,
      reason: 'invalid_strategy_input',
      detail: 'Round-robin cursor invalid.',
    };
  }

  const index = cursor % eligible.length;
  const nextCursor: RoundRobinCursor = ((index + 1) % eligible.length) as RoundRobinCursor;
  return { ok: true, candidateId: eligible[index].candidateId, nextCursor };
}

/**
 * Lowest customer price: chon candidate co customer price thap nhat.
 * Price facts nhan tu caller (khong import/tinh qua llm-seller-pricing-domain).
 * Chua so sanh currency khac nhau — chi xem gia trong `currency` duoc quy dinh.
 * Candidate thieu gia trong currency do -> loai khoi tap so sanh.
 * Gia bang nhau -> tie-break thu tu nhap vao (tam thoi, chua co quy tac chot).
 */
export function selectLowestPrice(
  eligible: readonly Candidate[],
  priceFacts: readonly PriceFact[],
  currency: string,
): RoutingStrategyResult {
  if (!Array.isArray(eligible) || eligible.length === 0) {
    return {
      ok: false,
      reason: 'no_eligible_candidate',
      detail: 'Eligible set empty — no candidate to select.',
    };
  }
  if (!isNonEmptyString(currency)) {
    return {
      ok: false,
      reason: 'invalid_strategy_input',
      detail: 'Currency invalid — cannot compare prices.',
    };
  }

  const eligibleIds = new Set(eligible.map((c) => c.candidateId));
  const pricesInCurrency = priceFacts.filter(
    (pf) => pf.currency === currency && eligibleIds.has(pf.candidateId),
  );

  if (pricesInCurrency.length === 0) {
    return {
      ok: false,
      reason: 'no_eligible_candidate',
      detail: 'No candidate has a price in the specified currency.',
    };
  }

  let best: PriceFact | undefined;
  for (const pf of pricesInCurrency) {
    if (!best || pf.amount < best.amount) {
      best = pf;
    }
  }
  // amount bang nhau -> gan giu phan tu dau tien (input order) -> deterministik.
  // pricesInCurrency da kiem tra rong o tren, nen best luon duoc gan.
  const bestPrice: PriceFact = best ?? pricesInCurrency[0];
  return { ok: true, candidateId: bestPrice.candidateId };
}

export function selectCandidate(
  strategy: RoutingStrategy,
  eligible: readonly Candidate[],
  options: {
    readonly cursor?: RoundRobinCursor;
    readonly priceFacts?: readonly PriceFact[];
    readonly currency?: string;
  },
): RoutingStrategyResult {
  switch (strategy) {
    case ROUTING_STRATEGY.priority:
      return selectByPriority(eligible);
    case ROUTING_STRATEGY.round_robin: {
      if (options.cursor === undefined) {
        return {
          ok: false,
          reason: 'invalid_strategy_input',
          detail: 'Round-robin requires cursor.',
        };
      }
      const rr = selectRoundRobin(eligible, options.cursor);
      return rr;
    }
    case ROUTING_STRATEGY.lowest_price: {
      if (!options.priceFacts || !options.currency) {
        return {
          ok: false,
          reason: 'invalid_strategy_input',
          detail: 'Lowest price requires priceFacts and currency.',
        };
      }
      return selectLowestPrice(eligible, options.priceFacts, options.currency);
    }
    default:
      return {
        ok: false,
        reason: 'invalid_strategy_input',
        detail: 'Routing strategy not supported.',
      };
  }
}

export type RoutingStrategyResult =
  | DomainOk<{ readonly candidateId: CandidateId }>
  | DomainRejection<'no_eligible_candidate' | 'invalid_strategy_input'>;
