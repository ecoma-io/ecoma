/**
 * Taxonomy lỗi của tầng domain `llm-seller-pricing`.
 *
 * Pattern: `libs/staff-access-domain/src/errors.ts` — một domain error chỉ mang
 * `code` ổn định + `message` ngắn gọn, không field nào cho offer id thật, giá trị
 * usage, token, secret hay payload tuỳ ý.
 *
 * Vì sao không cho phép mang dữ liệu: một error object đi thẳng ra log và ra
 * response, nên nó là nơi rò rỉ *dễ nhất* — nó mang theo ngữ cảnh của lỗi. Cho
 * phép nhét `offerId` hay payload vào message là biến log thành kênh thu thập
 * identifier không kiểm soát. Muốn thêm ngữ cảnh cho chẩn đoán thì thêm
 * mã mới vào taxonomy, không gắn dữ liệu vào mã cũ.
 *
 * Message là ENGLISH theo language policy của repo: đây là runtime string, không
 * phải documentation.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type LlmPricingDomainErrorCode =
  | 'invalid_offer_id'
  | 'invalid_currency'
  | 'invalid_scale'
  | 'invalid_rounding_rule'
  | 'invalid_price'
  | 'invalid_price_rule'
  | 'invalid_schedule'
  | 'invalid_timezone'
  | 'invalid_peak_window'
  | 'invalid_peak_schedule'
  | 'invalid_version'
  | 'invalid_effective_from'
  | 'invalid_version_transition'
  | 'invalid_version_history'
  | 'invalid_admission_time'
  | 'no_applicable_version'
  | 'invalid_usage'
  | 'incomplete_usage'
  | 'token_subset_violation'
  | 'invalid_snapshot'
  | 'amount_overflow';

/**
 * Message của từng mã — bảng đọc nguồn duy nhất của factory. Message là
 * ENGLISH: runtime string không viết tiếng Việt.
 *
 * Freeze: consumer chỉ được **đọc** bảng này. Không freeze thì một call site có
 * thể sửa message và mọi error sinh ra sau đó mang text không canonical — phá
 * đúng bảo đảm error không mang payload mà bảng này tồn tại để giữ.
 */
export const LLM_PRICING_DOMAIN_ERROR_MESSAGES: Record<LlmPricingDomainErrorCode, string> =
  Object.freeze({
    invalid_offer_id: 'Offer ID is not valid.',
    invalid_currency: 'Currency code is not valid.',
    invalid_scale: 'Price or amount scale is outside the supported range.',
    invalid_rounding_rule: 'Rounding rule is not valid.',
    invalid_price: 'Price is not a valid non-negative fixed-point integer.',
    invalid_price_rule: 'Cached or reasoning price rule is not valid.',
    invalid_schedule: 'Pricing schedule structure is not valid.',
    invalid_timezone: 'Time zone is not a valid IANA time zone.',
    invalid_peak_window: 'Peak window is not valid.',
    invalid_peak_schedule: 'Peak pricing configuration is not valid.',
    invalid_version: 'Pricing version is not valid.',
    invalid_effective_from: 'Effective-from timestamp is not valid.',
    invalid_version_transition: 'Pricing version transition is not valid.',
    invalid_version_history: 'Pricing version history is not monotonic.',
    invalid_admission_time: 'Admission timestamp is not valid.',
    no_applicable_version: 'No pricing version applies to this admission time.',
    invalid_usage: 'Token usage is not valid.',
    incomplete_usage: 'Token usage is missing a category that the pricing schedule needs.',
    token_subset_violation: 'Cached or reasoning token count exceeds its parent category.',
    invalid_snapshot: 'Pricing snapshot structure is not valid.',
    amount_overflow: 'Fixed-point arithmetic exceeded the supported magnitude.',
  });

/** Error domain: `code` ổn định + `message` ngắn gọn. */
export interface LlmPricingDomainError {
  readonly code: LlmPricingDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ `LLM_PRICING_DOMAIN_ERROR_MESSAGES`, không có chỗ nào lọt dữ
 * liệu call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function llmPricingDomainError(code: LlmPricingDomainErrorCode): LlmPricingDomainError {
  // `Object.hasOwn` thay vì chỉ số mảng trực tiếp: lookup kế thừa từ
  // `Object.prototype` (`'toString'`) trả về một function thay vì `undefined`,
  // khi đó factory sẽ trả về một error rác thay vì ném.
  const message = Object.hasOwn(LLM_PRICING_DOMAIN_ERROR_MESSAGES, code)
    ? LLM_PRICING_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM Pricing domain error code is not valid: ${String(code)}`);
  }
  return { code, message };
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain, nên
 * `'toString' in LLM_PRICING_DOMAIN_ERROR_MESSAGES` là `true` và guard sẽ nhận
 * `{ code: 'toString' }` là domain error hợp lệ — trong khi factory lại ném
 * `TypeError`. Hai hướng ngược nhau trên cùng taxonomy là cửa lách kiểm đầu vào.
 */
export function isLlmPricingDomainError(value: unknown): value is LlmPricingDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // Shape khung: chỉ đúng hai field `code` + `message`. Object có thêm field
  // (payload dồn vào từ call site) không phải domain error, khớp với kết quả mà
  // factory tạo ra (không có chỗ cho payload).
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string') {
    return false;
  }
  const expected = Object.hasOwn(LLM_PRICING_DOMAIN_ERROR_MESSAGES, candidate.code)
    ? LLM_PRICING_DOMAIN_ERROR_MESSAGES[candidate.code as LlmPricingDomainErrorCode]
    : undefined;
  // Message phải khớp **chính xác** bảng canonical, không chỉ là string: error
  // không được mang payload/identifier, và một object `{ code, message }` do
  // caller dựng lại (đọc từ log, cache, event payload) là đường dễ nhất để một
  // message tự do lọt vào. So khớp nguyên văn biến guard thành kiểm "error này
  // do factory sinh ra", tức là bảo đảm đó vẫn đúng sau khi rời process.
  return expected !== undefined && candidate.message === expected;
}
