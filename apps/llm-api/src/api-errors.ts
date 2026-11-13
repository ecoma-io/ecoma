/**
 * Bảng lỗi API ổn định của serving path (ADR-0027 §7; 01-architecture §16).
 *
 * Mọi lỗi client nhận được đi qua MỘT builder duy nhất: phong bì lỗi chuẩn
 * OpenAI `{"error":{"message","type","param","code"}}` với status + mã ỔN ĐỊNH
 * (client code against codes, not strings). Quy tắc không rò rỉ:
 * - message KHÔNG bao giờ chứa chi tiết provider/credential/connection string
 *   hay nội dung prompt/response — chỉ mô tả lớp lỗi.
 * - `param` luôn `null` ở MVP (không có field-level validation detail nào
 *   được hứa).
 * - `retry_after` chỉ có trên status 429/503 (header `retry-after`).
 *
 * Mỗi mapping (status, type, code) là hợp đồng ổn định — đổi một mã là breaking
 * change của API surface, không phải refactor nội bộ.
 */

/** Status HTTP mà serving path trả ra. */
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503;

/** Một lỗi API ổn định: status + phong bì OpenAI + header retry-after tuỳ chọn. */
export class ApiError extends Error {
  readonly status: ApiErrorStatus;
  readonly errorType: string;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    status: ApiErrorStatus;
    errorType: string;
    code: string | null;
    message: string;
    retryAfterSeconds?: number | null;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.errorType = input.errorType;
    this.code = input.code;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }

  /** Phong bì lỗi JSON — hàm thuần, key order ghim cố định. */
  body(): string {
    return JSON.stringify({
      error: {
        message: this.message,
        type: this.errorType,
        param: null,
        code: this.code,
      },
    });
  }
}

/** Mã lỗi ổn định — union literal để caller khớp chính xác một mã. */
export const API_ERROR_CODES = [
  'invalid_api_key',
  'api_key_revoked',
  'tenant_not_active',
  'streaming_not_supported',
  'max_tokens_required',
  'model_not_found',
  'offer_restricted',
  'no_candidate',
  'pricing_unavailable',
  'upstream_credential_unavailable',
  'insufficient_quota',
  'insufficient_funds',
  'rate_limit_exceeded',
  'upstream_error',
  'request_id_replay',
  'idempotency_conflict',
  'service_unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Dựng `Response` lỗi từ một {@link ApiError}: byte body (byte-compat của
 * runtime — xem `index.ts`), content-type JSON, `retry-after` khi có.
 */
export function errorResponse(error: ApiError): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (error.retryAfterSeconds !== null) {
    headers['retry-after'] = String(error.retryAfterSeconds);
  }
  return new Response(new TextEncoder().encode(error.body()), {
    status: error.status,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Bảng mapping ổn định — các hàm dựng lỗi chuẩn hoá của từng lớp lỗi
// ---------------------------------------------------------------------------

/** 401 — Authorization header thiếu/sai hình, hoặc key không tồn tại. */
export function invalidApiKeyError(): ApiError {
  return new ApiError({
    status: 401,
    errorType: 'invalid_request_error',
    code: 'invalid_api_key',
    message: 'Missing or invalid API key. Provide Authorization: Bearer <key>.',
  });
}

/** 403 — key đã revoke. */
export function apiKeyRevokedError(): ApiError {
  return new ApiError({
    status: 403,
    errorType: 'invalid_request_error',
    code: 'api_key_revoked',
    message: 'This API key has been revoked.',
  });
}

/** 403 — tenant của key không tồn tại/không khả dụng (fail-closed, không lộ lý do nội bộ). */
export function tenantNotActiveError(): ApiError {
  return new ApiError({
    status: 403,
    errorType: 'invalid_request_error',
    code: 'tenant_not_active',
    message: 'The tenant owning this API key is not active.',
  });
}

/** 400 — body JSON hỏng hoặc shape sai (code null, chuẩn envelope OpenAI chung). */
export function invalidRequestError(message: string): ApiError {
  return new ApiError({
    status: 400,
    errorType: 'invalid_request_error',
    code: null,
    message,
  });
}

/** 400 — `stream: true` bị từ chối ổn định (streaming là non-goal, #28). */
export function streamingNotSupportedError(): ApiError {
  return new ApiError({
    status: 400,
    errorType: 'invalid_request_error',
    code: 'streaming_not_supported',
    message:
      'Streaming responses are not supported on this deployment; omit "stream" or set it to false.',
  });
}

/** 422 — `max_tokens` bắt buộc (DECISION slice P4). */
export function maxTokensRequiredError(): ApiError {
  return new ApiError({
    status: 422,
    errorType: 'invalid_request_error',
    code: 'max_tokens_required',
    message: '"max_tokens" is required on this deployment and must be an integer >= 1.',
  });
}

/** 404 — model không có offer active nào phục vụ (no_candidate, FR-07). */
export function modelNotFoundError(requestedModel: string): ApiError {
  return new ApiError({
    status: 404,
    errorType: 'invalid_request_error',
    code: 'model_not_found',
    // JSON.stringify trong body() tự escape — không escape hai lần.
    message: `The model '${requestedModel}' does not exist or is not served.`,
  });
}

/** 403 — seller tenant của offer bị restriction hiệu lực (deny fail-closed). */
export function offerRestrictedError(): ApiError {
  return new ApiError({
    status: 403,
    errorType: 'invalid_request_error',
    code: 'offer_restricted',
    message: 'The requested model is not available.',
  });
}

/** 503 — không có endpoint upstream khoẻ, hay giá, hay credential serving (fail-closed, retry được). */
export function noCandidateError(): ApiError {
  return new ApiError({
    status: 503,
    errorType: 'service_unavailable',
    code: 'no_candidate',
    message: 'No serving candidate is available for this model. Retry later.',
    retryAfterSeconds: 1,
  });
}

/** 503 — pricing snapshot active thiếu hoặc không express được bằng VND (ADR-0028 §13.4). */
export function pricingUnavailableError(): ApiError {
  return new ApiError({
    status: 503,
    errorType: 'service_unavailable',
    code: 'pricing_unavailable',
    message: 'Pricing for this model is not currently available. Retry later.',
    retryAfterSeconds: 1,
  });
}

/** 503 — credential upstream active không có/hash lệch (invariant 8: mismatch → không route). */
export function upstreamCredentialUnavailableError(): ApiError {
  return new ApiError({
    status: 503,
    errorType: 'service_unavailable',
    code: 'upstream_credential_unavailable',
    message: 'Upstream credentials are not available. Retry later.',
    retryAfterSeconds: 1,
  });
}

/** 429 — trần token operational của tenant đầy. */
export function insufficientQuotaError(): ApiError {
  return new ApiError({
    status: 429,
    errorType: 'insufficient_quota',
    code: 'insufficient_quota',
    message: 'The operational token quota for this tenant is exhausted.',
  });
}

/** 429 — số dư tài chính không đủ giữ cận trên admission (release quota idempotent đã chạy). */
export function insufficientFundsError(): ApiError {
  return new ApiError({
    status: 429,
    errorType: 'insufficient_quota',
    code: 'insufficient_funds',
    message: 'The financial balance for this tenant is insufficient.',
  });
}

/** 429 — upstream từ chối trước thực thi vì rate limit; forward Retry-After hợp lệ. */
export function rateLimitExceededError(retryAfterSeconds: number | null): ApiError {
  return new ApiError({
    status: 429,
    errorType: 'rate_limit_error',
    code: 'rate_limit_exceeded',
    message: 'The upstream provider is rate limiting requests. Retry later.',
    retryAfterSeconds,
  });
}

/** 502 — upstream lỗi/thực thi không xác định/malformed; không lộ chi tiết provider. */
export function upstreamError(): ApiError {
  return new ApiError({
    status: 502,
    errorType: 'service_unavailable',
    code: 'upstream_error',
    message: 'The upstream provider failed to complete the request.',
  });
}

/** 409 — replay cùng request_id (payload khớp): ổn định, KHÔNG mở reserve mới (invariant 3). */
export function requestIdReplayError(): ApiError {
  return new ApiError({
    status: 409,
    errorType: 'invalid_request_error',
    code: 'request_id_replay',
    message:
      'This request_id was already admitted. Replayed requests are never re-executed and the original response body is not stored.',
  });
}

/** 409 — cùng request_id với payload KHÁC: idempotency conflict (invariant 3). */
export function idempotencyConflictError(): ApiError {
  return new ApiError({
    status: 409,
    errorType: 'invalid_request_error',
    code: 'idempotency_conflict',
    message: 'This request_id was already used with a different payload.',
  });
}

/** 503 — DB/binding không sẵn sàng cho serving (fail-closed, có Retry-After). */
export function serviceUnavailableError(): ApiError {
  return new ApiError({
    status: 503,
    errorType: 'service_unavailable',
    code: 'service_unavailable',
    message: 'The service is temporarily unavailable. Retry later.',
    retryAfterSeconds: 1,
  });
}
