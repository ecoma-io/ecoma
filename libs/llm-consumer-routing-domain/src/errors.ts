/**
 * Taxonomy loi cua tang domain `llm-consumer-routing`.
 *
 * Pattern: `libs/remote-cache-domain/src/errors.ts` — mot domain error chi
 * mang `code` on dinh + `message` ngan gon, khong field nao cho
 * identifier/token/secret hay payload tuy y. Mot error object di thang ra log
 * va ra response, nen cho phep mang token hay API key trong message la bien
 * log thanh kenh thu thap secret khong kiem soat.
 *
 * Message la ENGLISH theo language policy cua repo (ruling 2026-10-25 ap dung
 * cho DOMAIN_ERROR_MESSAGES cua moi domain).
 */

export type RoutingDomainErrorCode =
  | 'invalid_alias'
  | 'alias_not_found'
  | 'alias_retired'
  | 'invalid_policy_version'
  | 'invalid_candidate'
  | 'no_eligible_candidate'
  | 'fallback_not_allowed'
  | 'fallback_exhausted'
  | 'invalid_strategy_input'
  | 'invalid_snapshot';

export const ROUTING_DOMAIN_ERROR_MESSAGES: Record<RoutingDomainErrorCode, string> = {
  invalid_alias: 'The model alias is not valid.',
  alias_not_found: 'The model alias was not found.',
  alias_retired: 'The model alias has been retired.',
  invalid_policy_version: 'The routing policy version is not valid.',
  invalid_candidate: 'The routing candidate is not valid.',
  no_eligible_candidate: 'No eligible routing candidate exists.',
  fallback_not_allowed: 'Fallback is not allowed for the current attempt evidence.',
  fallback_exhausted: 'All routing fallback candidates are exhausted.',
  invalid_strategy_input: 'The routing strategy input is not valid.',
  invalid_snapshot: 'The routing snapshot is not valid.',
};

export interface RoutingDomainError {
  readonly code: RoutingDomainErrorCode;
  readonly message: string;
}

export function isRoutingDomainError(value: unknown): value is RoutingDomainError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RoutingDomainError).code === 'string' &&
    (value as RoutingDomainError).code in ROUTING_DOMAIN_ERROR_MESSAGES &&
    typeof (value as RoutingDomainError).message === 'string'
  );
}

export function routingDomainError(code: RoutingDomainErrorCode): RoutingDomainError {
  return { code, message: ROUTING_DOMAIN_ERROR_MESSAGES[code] };
}
