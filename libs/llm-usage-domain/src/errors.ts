/**
 * Taxonomy lỗi của tầng domain `llm-usage`.
 *
 * Pattern: `libs/remote-cache-domain/src/errors.ts` — một domain error chỉ mang
 * `code` ổn định + `message` tiếng Anh ngắn gọn, không field nào cho
 * identifier/token/secret hay payload tuỳ ý. Message là runtime string do developer
 * viết (ngôn ngữ English theo language policy), không được dịch sang tiếng Việt.
 */

export type DomainErrorCode = import('./types').DomainErrorCode;

/** Message tiếng Anh của từng mã — bảng nguồn duy nhất của factory. */
export const LLM_USAGE_DOMAIN_ERROR_MESSAGES: Record<DomainErrorCode, string> = {
  invalid_usage: 'Usage value is not valid.',
  invalid_token_count: 'Token count is not valid.',
  invalid_correction: 'Correction is not valid.',
  unknown_normalizer_version: 'Normalizer version is not recognized.',
  usage_missing: 'Usage is missing from provider.',
  usage_malformed: 'Usage from provider is malformed.',
};

/** Error domain: `code` ổn định + `message` tiếng Anh ngắn gọn. */
export interface LLMUsageDomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
}

/** Tạo một domain error từ mã — message lấy từ bảng nguồn duy nhất. */
export function llmUsageDomainError(code: DomainErrorCode): LLMUsageDomainError {
  return { code, message: LLM_USAGE_DOMAIN_ERROR_MESSAGES[code] };
}

/** Kiểm một giá trị có phải domain error của context này không — type guard. */
export function isLLMUsageDomainError(value: unknown): value is LLMUsageDomainError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LLMUsageDomainError).code === 'string' &&
    Object.hasOwn(LLM_USAGE_DOMAIN_ERROR_MESSAGES, (value as LLMUsageDomainError).code) &&
    typeof (value as LLMUsageDomainError).message === 'string'
  );
}

/** Một domain error không chứa field nào ngoài `code` và `message`. */
export function domainErrorKeys(error: LLMUsageDomainError): readonly string[] {
  return Object.keys(error) as readonly string[];
}
