/**
 * Unit test bảng lỗi API ổn định (`api-errors.ts`): phong bì OpenAI đúng key
 * order, header `retry-after` chỉ trên 429/503, và bảng (status, type, code)
 * của MỌI builder — đổi một mã là breaking change của API surface, nên bảng
 * được ghim nguyên biểu thức ở đây.
 */
import { describe, expect, it } from 'vitest';

import {
  apiKeyRevokedError,
  errorResponse,
  idempotencyConflictError,
  insufficientFundsError,
  insufficientQuotaError,
  invalidApiKeyError,
  invalidRequestError,
  maxTokensRequiredError,
  modelNotFoundError,
  noCandidateError,
  offerRestrictedError,
  pricingUnavailableError,
  rateLimitExceededError,
  requestIdReplayError,
  serviceUnavailableError,
  streamingNotSupportedError,
  tenantNotActiveError,
  upstreamCredentialUnavailableError,
  upstreamError,
  type ApiError,
} from './api-errors';

/** Bảng mapping ổn định: builder → (status, type, code) — hợp đồng client code against. */
const MAPPING_TABLE: readonly { readonly name: string; readonly error: ApiError }[] = [
  { name: 'invalidApiKeyError', error: invalidApiKeyError() },
  { name: 'apiKeyRevokedError', error: apiKeyRevokedError() },
  { name: 'tenantNotActiveError', error: tenantNotActiveError() },
  { name: 'invalidRequestError', error: invalidRequestError('bad body') },
  { name: 'streamingNotSupportedError', error: streamingNotSupportedError() },
  { name: 'maxTokensRequiredError', error: maxTokensRequiredError() },
  { name: 'modelNotFoundError', error: modelNotFoundError('ghost-model') },
  { name: 'offerRestrictedError', error: offerRestrictedError() },
  { name: 'noCandidateError', error: noCandidateError() },
  { name: 'pricingUnavailableError', error: pricingUnavailableError() },
  { name: 'upstreamCredentialUnavailableError', error: upstreamCredentialUnavailableError() },
  { name: 'insufficientQuotaError', error: insufficientQuotaError() },
  { name: 'insufficientFundsError', error: insufficientFundsError() },
  { name: 'rateLimitExceededError', error: rateLimitExceededError(null) },
  { name: 'upstreamError', error: upstreamError() },
  { name: 'requestIdReplayError', error: requestIdReplayError() },
  { name: 'idempotencyConflictError', error: idempotencyConflictError() },
  { name: 'serviceUnavailableError', error: serviceUnavailableError() },
];

describe('ApiError envelope', () => {
  it('renders the OpenAI error envelope with a frozen key order', () => {
    const error = invalidApiKeyError();
    expect(error.body()).toBe(
      '{"error":{"message":"Missing or invalid API key. Provide Authorization: Bearer <key>.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}',
    );
  });

  it('keeps param always null and escapes embedded quotes through JSON.stringify', () => {
    const error = modelNotFoundError('ghost\'model"</script>');
    const parsed = JSON.parse(error.body()) as {
      error: { code: string; message: string; param: string | null };
    };
    expect(parsed.error.param).toBeNull();
    expect(parsed.error.code).toBe('model_not_found');
    expect(parsed.error.message).toContain('ghost\'model"</script>');
  });
});

describe('errorResponse', () => {
  it('sets the JSON content type and the exact status', () => {
    const response = errorResponse(modelNotFoundError('m'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('adds retry-after only when the error carries it', () => {
    expect(errorResponse(serviceUnavailableError()).headers.get('retry-after')).toBe('1');
    expect(errorResponse(rateLimitExceededError(30)).headers.get('retry-after')).toBe('30');
    expect(errorResponse(invalidApiKeyError()).headers.get('retry-after')).toBeNull();
  });

  it('returns the error body verbatim', async () => {
    const error = requestIdReplayError();
    const body = await errorResponse(error).text();
    expect(body).toBe(error.body());
  });
});

describe('stable mapping table', () => {
  it('pins every builder to its exact (status, type, code) triple', () => {
    const expected: Record<string, [number, string, string | null]> = {
      invalidApiKeyError: [401, 'invalid_request_error', 'invalid_api_key'],
      apiKeyRevokedError: [403, 'invalid_request_error', 'api_key_revoked'],
      tenantNotActiveError: [403, 'invalid_request_error', 'tenant_not_active'],
      invalidRequestError: [400, 'invalid_request_error', null],
      streamingNotSupportedError: [400, 'invalid_request_error', 'streaming_not_supported'],
      maxTokensRequiredError: [422, 'invalid_request_error', 'max_tokens_required'],
      modelNotFoundError: [404, 'invalid_request_error', 'model_not_found'],
      offerRestrictedError: [403, 'invalid_request_error', 'offer_restricted'],
      noCandidateError: [503, 'service_unavailable', 'no_candidate'],
      pricingUnavailableError: [503, 'service_unavailable', 'pricing_unavailable'],
      upstreamCredentialUnavailableError: [
        503,
        'service_unavailable',
        'upstream_credential_unavailable',
      ],
      insufficientQuotaError: [429, 'insufficient_quota', 'insufficient_quota'],
      insufficientFundsError: [429, 'insufficient_quota', 'insufficient_funds'],
      rateLimitExceededError: [429, 'rate_limit_error', 'rate_limit_exceeded'],
      upstreamError: [502, 'service_unavailable', 'upstream_error'],
      requestIdReplayError: [409, 'invalid_request_error', 'request_id_replay'],
      idempotencyConflictError: [409, 'invalid_request_error', 'idempotency_conflict'],
      serviceUnavailableError: [503, 'service_unavailable', 'service_unavailable'],
    };
    for (const { name, error } of MAPPING_TABLE) {
      const triple = expected[name];
      // Vitest `expect` chỉ nhận MỘT argument — message chẩn đoán đi kèm qua
      // ghi chú tường minh thay vì argument thứ hai.
      expect(triple !== undefined, `builder ${name} missing from the expected table`).toBe(true);
      expect([error.status, error.errorType, error.code]).toEqual(triple);
    }
  });

  it('carries a retry hint on every retryable 503 code and the upstream 429', () => {
    expect(noCandidateError().retryAfterSeconds).toBe(1);
    expect(pricingUnavailableError().retryAfterSeconds).toBe(1);
    expect(upstreamCredentialUnavailableError().retryAfterSeconds).toBe(1);
    expect(serviceUnavailableError().retryAfterSeconds).toBe(1);
    expect(rateLimitExceededError(null).retryAfterSeconds).toBeNull();
    expect(rateLimitExceededError(120).retryAfterSeconds).toBe(120);
  });

  it('never embeds infrastructure or secret material in messages', () => {
    // Header guidance ("Authorization: Bearer <key>") là chỉ dẫn client hợp lệ;
    // những gì KHÔNG được bao giờ xuất hiện là hạ tầng nội bộ hay secret thật.
    const forbidden = [
      'postgres',
      'postgresql',
      'hyperdrive',
      'connection string',
      'sk-',
      'wrangler',
    ];
    for (const { error } of MAPPING_TABLE) {
      const message = error.message.toLowerCase();
      for (const needle of forbidden) {
        expect(
          message.includes(needle),
          `${error.code ?? error.message} contains "${needle}"`,
        ).toBe(false);
      }
    }
  });
});
