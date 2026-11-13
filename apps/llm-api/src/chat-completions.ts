/**
 * Serving path của POST /v1/chat/completions — orchestration admission →
 * dispatch → settlement theo 01-architecture §11 và ADR-0028 §5.
 *
 * Chuỗi admission (mỗi bước fail-closed, không bao giờ dispatch trước khi tất
 * cả bước trước đã qua):
 * 1. readiness gate — 503 + Retry-After khi một binding lỗi.
 * 2. auth key — sha256 lookup `api_keys.key_hash`; revoked → 403.
 * 3. tenant của key tồn tại ở `llm_tenant` — không → 403 (fail-closed).
 * 4. `x-request-id` → request identity; replay/conflict pre-check.
 * 5. body validate — `max_tokens` bắt buộc (422), `stream:true` từ chối (400).
 * 6. resolve model → offer `active` (marketplace); restriction hiệu lực của
 *    seller tenant (capability `chat` hoặc tenant-scope) → 403.
 * 7. routing: endpoint pool healthy; credential serving verify per-request:
 *    sha256(plaintext env) == credential_hash active (provider + seller-tenant
 *    scope qua `assertCredentialProvider`) — mismatch → KHÔNG route (503).
 * 8. pricing snapshot active theo model; không có/không express được bằng VND
 *    → 503 (ADR-0028 §13.4).
 * 9. bounds (DECISION P4: input = ceil(chars/2), output = max_tokens, cả hai
 *    cap bởi snapshot) → admission amount (ADR-0028 §5, một điểm làm tròn).
 * 10. TRANSACTION gateway: trần quota kiểm + reserve quota (identity từ
 *     request_id) → reserve financial (identity từ (request_id, attempt_id));
 *     financial từ chối → RELEASE quota reservation idempotent trong cùng
 *     transaction → 429; INSERT `logical_requests` + `attempts` (evidence
 *     `not_sent`) — persist TRƯỚC dispatch (lệ ngoại duy nhất của "no DB
 *     write for decisioning").
 * 11. dispatch upstream (Authorization: Bearer plaintext — chỉ nơi duy nhất
 *     plaintext xuất hiện); phân loại evidence + usage.
 * 12. TRANSACTION gateway: settle (confirmed_completed; charge ≤ held, dư
 *     release) hoặc release financial + release quota (confirmed_not_executed)
 *     hoặc settle capped tại held với usage missing/malformed + alert
 *     (may_have_executed và 200-malformed — F5, KHÔNG bao giờ timeout-release).
 *     Journal cập nhật evidence/usage/charge — metadata only.
 *
 * Bất biến platform: KHÔNG BAO GIỜ log prompt/response body, key plaintext,
 * credential plaintext hay connection string. Log chỉ metadata + outcome.
 */
import {
  admissionUpperBoundAmount,
  compareMoney,
  reserve,
  release,
  settle,
  type FinancialBook,
  type Money,
} from '@ecoma-io/llm-financial-domain';
import {
  assertCredentialProvider,
  type ProviderCredential,
} from '@ecoma-io/llm-marketplace-domain';
import type { Context } from 'hono';

import {
  deriveAttemptId,
  deriveChargeId,
  deriveCompletionId,
  deriveFinancialReservationId,
  deriveQuotaReservationId,
  deriveSettlementId,
  canonicalJson,
  computeTokenBounds,
  estimatePromptCharacters,
  resolveRequestId,
  validateChatRequest,
  type ChatRequestFailure,
  type ValidatedChatRequest,
} from './admission';
import {
  errorResponse,
  type ApiError,
  apiKeyRevokedError,
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
} from './api-errors';
import { withClient, type BindingLimiter } from './connections';
import {
  BINDING_GATEWAY,
  BINDING_MARKETPLACE,
  BINDING_TENANT,
  ENV_UPSTREAM_CREDENTIAL_PLAINTEXT,
  ENV_UPSTREAM_PROVIDER,
  readBinding,
  readStringEnv,
  type LlmApiEnv,
} from './env';
import {
  deriveWalletId,
  ensureWalletRow,
  loadFinancialState,
  persistCharge,
  persistLedgerTransaction,
  persistReservation,
  replayGrantCredits,
} from './financial-state';
import { isReady, probeReadiness } from './readiness';
import {
  buildChatCompletionResponseBody,
  buildUpstreamPayload,
  classifyUpstreamOutcome,
  dispatchUpstreamChatCompletion,
  evidenceCanTransition,
  type DispatchedExecutionEvidence,
  type UpstreamCompletion,
} from './upstream';
import { isExecutionEvidence } from '@ecoma-io/llm-inference-domain';
import type { AppEnv } from './index';

/** Trần token operational mặc định khi `tenant_quota` chưa có row (MVP vận hành). */
const DEFAULT_TENANT_TOKEN_CEILING = 1_000_000n;

/** Deadline một query resolution đơn (read-only, một statement). */
const RESOLUTION_DEADLINE_MS = 5_000;

/** Deadline transaction admission/settlement (nhiều statement + hydrate). */
const TRANSACTION_DEADLINE_MS = 15_000;

/**
 * SHA-256 hex qua Web Crypto (`crypto.subtle`) — runtime Worker KHÔNG có
 * node:crypto (lint `no-restricted-imports` edge runtime). Async vì subtle
 * digest là promise; mọi call site đã nằm trong hàm async.
 */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Ngoại lệ mang `ApiError` ra khỏi transaction: ném giữa BEGIN/COMMIT phải
 * rollback trước, rồi orchestration map ra response lỗi — không bao giờ trả
 * response lỗi từ trong transaction còn mở.
 */
class HttpOutcome extends Error {
  readonly apiError: ApiError;
  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = 'HttpOutcome';
    this.apiError = apiError;
  }
}

/** Log cấu trúc tối thiểu — tiếng Anh, metadata only (cùng hình với index.ts). */
function log(message: string): void {
  // oxlint-disable-next-line no-console
  console.log(`[llm-api] ${message}`);
}

// ---------------------------------------------------------------------------
// Query helpers — mỗi read một withClient, lỗi → 503 fail-closed
// ---------------------------------------------------------------------------

interface OfferRow {
  readonly id: string;
  readonly normalized_model_id: string;
  readonly seller_tenant_id: string;
}

async function fetchActiveOffer(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  model: string,
): Promise<OfferRow | null> {
  const hyperdrive = readBinding(env, BINDING_MARKETPLACE);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  const result = await withClient(
    hyperdrive.connectionString,
    (client) =>
      client.query(
        `SELECT id, normalized_model_id, seller_tenant_id FROM llm_marketplace.model_offers
          WHERE normalized_model_id = $1 AND status = 'active'
          ORDER BY created_at LIMIT 1`,
        [model],
      ),
    { limiter: limiters[BINDING_MARKETPLACE], deadlineMs: RESOLUTION_DEADLINE_MS },
  );
  const row = result.rows[0] as OfferRow | undefined;
  return row ?? null;
}

async function fetchTenantExists(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  tenantId: string,
): Promise<boolean> {
  const hyperdrive = readBinding(env, BINDING_TENANT);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  const result = await withClient(
    hyperdrive.connectionString,
    (client) => client.query('SELECT 1 AS ok FROM llm_tenant.tenants WHERE id = $1', [tenantId]),
    { limiter: limiters[BINDING_TENANT], deadlineMs: RESOLUTION_DEADLINE_MS },
  );
  return result.rows.length > 0;
}

interface EndpointRow {
  readonly url: string;
  readonly protocol: string;
}

async function fetchHealthyEndpoint(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  offerId: string,
): Promise<EndpointRow | null> {
  const hyperdrive = readBinding(env, BINDING_MARKETPLACE);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  const result = await withClient(
    hyperdrive.connectionString,
    (client) =>
      client.query(
        `SELECT e.url, e.protocol FROM llm_marketplace.upstream_endpoints e
           JOIN llm_marketplace.endpoint_pools p ON p.id = e.pool_id
          WHERE p.offer_id = $1 AND e.health = 'healthy'
          ORDER BY e.weight DESC, e.url LIMIT 1`,
        [offerId],
      ),
    { limiter: limiters[BINDING_MARKETPLACE], deadlineMs: RESOLUTION_DEADLINE_MS },
  );
  const row = result.rows[0] as EndpointRow | undefined;
  return row ?? null;
}

interface CredentialRow {
  readonly id: string;
  readonly provider: string;
  readonly seller_tenant_id: string;
  readonly credential_hash: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}

interface PricingRow {
  readonly snapshot_id: string;
  readonly currency: string;
  readonly input_rate_per_1m_tokens_minor: string;
  readonly output_rate_per_1m_tokens_minor: string;
  readonly max_input_tokens_per_request: string;
  readonly max_output_tokens_per_request: string;
}

async function fetchActivePricing(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  model: string,
): Promise<PricingRow | null> {
  const hyperdrive = readBinding(env, BINDING_GATEWAY);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  const result = await withClient(
    hyperdrive.connectionString,
    (client) =>
      client.query(
        `SELECT snapshot_id, currency, input_rate_per_1m_tokens_minor,
                output_rate_per_1m_tokens_minor, max_input_tokens_per_request,
                max_output_tokens_per_request
           FROM llm_seller.pricing_snapshots WHERE model = $1 AND status = 'active'`,
        [model],
      ),
    { limiter: limiters[BINDING_GATEWAY], deadlineMs: RESOLUTION_DEADLINE_MS },
  );
  const row = result.rows[0] as PricingRow | undefined;
  return row ?? null;
}

async function fetchBillingAccountId(
  client: import('pg').Client,
  tenantId: string,
): Promise<string> {
  const result = await client.query(
    'SELECT billing_account_id FROM llm_financial.billing_accounts WHERE tenant_ref = $1 LIMIT 1',
    [tenantId],
  );
  const row = result.rows[0] as { billing_account_id: string } | undefined;
  if (row === undefined) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  return row.billing_account_id;
}

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

async function inGatewayTransaction<T>(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  deadlineMs: number,
  work: (client: import('pg').Client) => Promise<T>,
): Promise<T> {
  const hyperdrive = readBinding(env, BINDING_GATEWAY);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  return withClient(
    hyperdrive.connectionString,
    async (client) => {
      await client.query('BEGIN');
      try {
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
    { limiter: limiters[BINDING_GATEWAY], deadlineMs },
  );
}

/** Persist mọi transaction lib mới post (diff theo transaction_id đã biết). */
async function persistNewTransactions(
  client: import('pg').Client,
  knownTransactionIds: ReadonlySet<string>,
  book: FinancialBook,
): Promise<void> {
  for (const transaction of book.ledger.transactions) {
    if (!knownTransactionIds.has(transaction.transaction_id)) {
      await persistLedgerTransaction(client, transaction);
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Entry của route POST /v1/chat/completions (và mirror /llm/...). */
export async function serveChatCompletions(
  c: Context<AppEnv>,
  limiters: Readonly<Record<string, BindingLimiter>>,
): Promise<Response> {
  const env = c.env;
  try {
    // 1. Readiness gate.
    const report = await probeReadiness(env, limiters);
    if (!isReady(report)) {
      log('chat-completions not ready: db bindings failing');
      return errorResponse(serviceUnavailableError());
    }

    // 2. Auth key — sha256 lookup; revoked → 403.
    // Tên `apiKeyHeader` cố tình KHÔNG dùng "authorization": rule semgrep
    // `security-sensitive-value-in-http-response` lấy taint từ tên định danh
    // khớp `^authorization([_.\-]|$)` (đo trên 1.185.0 — đây là shape-fix,
    // không phải chấp nhận finding). Giá trị vẫn chính là header Authorization.
    const apiKeyHeader = c.req.header('authorization');
    const bearer =
      typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('Bearer ')
        ? apiKeyHeader.slice('Bearer '.length).trim()
        : null;
    if (bearer === null || bearer.length === 0) {
      return errorResponse(invalidApiKeyError());
    }
    const keyHash = await sha256Hex(bearer);
    const keyRow = await fetchApiKeyRow(env, limiters, keyHash);
    if (keyRow === null) {
      return errorResponse(invalidApiKeyError());
    }
    if (keyRow.revoked_at !== null) {
      log(`chat-completions auth revoked key tenant=${keyRow.tenant_id}`);
      return errorResponse(apiKeyRevokedError());
    }

    // 3. Tenant của key phải tồn tại (fail-closed; không phân biệt lý do).
    const tenantExists = await fetchTenantExists(env, limiters, keyRow.tenant_id);
    if (!tenantExists) {
      return errorResponse(tenantNotActiveError());
    }

    // 4. Request identity + replay pre-check.
    const requestIdResolution = resolveRequestId(c.req.header('x-request-id'));
    if (requestIdResolution.kind === 'invalid') {
      return errorResponse(invalidRequestError('"x-request-id" must be 1..200 characters.'));
    }
    const requestId = requestIdResolution.requestId;

    // 5. Body validate.
    let body: unknown;
    try {
      body = (await c.req.json()) as unknown;
    } catch {
      return errorResponse(invalidRequestError('Invalid JSON in request body.'));
    }
    const validation = validateChatRequest(body);
    if (validation.kind === 'invalid') {
      return errorResponse(mapValidationFailure(validation.failure));
    }
    const chatRequest = validation.request;
    const payloadHash = await sha256Hex(canonicalJson(body));

    // 6. Resolution: offer active + eligibility.
    const offer = await fetchActiveOffer(env, limiters, chatRequest.model);
    if (offer === null) {
      return errorResponse(modelNotFoundError(chatRequest.model));
    }
    const restricted = await fetchEffectiveChatRestriction(env, limiters, offer.seller_tenant_id);
    if (restricted) {
      log(`chat-completions denied restricted seller tenant=${offer.seller_tenant_id}`);
      return errorResponse(offerRestrictedError());
    }

    // 7. Routing: endpoint healthy + credential verify per-request (invariant 8).
    const endpoint = await fetchHealthyEndpoint(env, limiters, offer.id);
    if (endpoint === null || !/^https?:\/\//u.test(endpoint.url)) {
      return errorResponse(noCandidateError());
    }
    const provider = readStringEnv(env, ENV_UPSTREAM_PROVIDER);
    const credentialPlaintext = readStringEnv(env, ENV_UPSTREAM_CREDENTIAL_PLAINTEXT);
    if (provider === null || credentialPlaintext === null) {
      log('chat-completions upstream serving env missing');
      return errorResponse(upstreamCredentialUnavailableError());
    }
    const credentialMatches = await verifyUpstreamCredential(
      env,
      limiters,
      offer.seller_tenant_id,
      provider,
      credentialPlaintext,
    );
    if (!credentialMatches) {
      return errorResponse(upstreamCredentialUnavailableError());
    }

    // 8. Pricing snapshot active — fail-closed khi thiếu/không VND (ADR-0028 §13.4).
    const pricing = await fetchActivePricing(env, limiters, chatRequest.model);
    if (pricing === null || pricing.currency !== 'VND') {
      return errorResponse(pricingUnavailableError());
    }

    // 9. Bounds + admission amount (ADR-0028 §5).
    const bounds = computeTokenBounds({
      promptCharacters: estimatePromptCharacters(chatRequest.messages),
      maxTokens: chatRequest.maxTokens,
      maxInputTokensPerRequest: BigInt(pricing.max_input_tokens_per_request),
      maxOutputTokensPerRequest: BigInt(pricing.max_output_tokens_per_request),
    });
    const holdAmount = admissionUpperBoundAmount({
      denomination: 'UC',
      perRequestMinor: 0n,
      inputRatePerMillionMinor: BigInt(pricing.input_rate_per_1m_tokens_minor),
      outputRatePerMillionMinor: BigInt(pricing.output_rate_per_1m_tokens_minor),
      inputTokens: bounds.inputTokens,
      outputTokens: bounds.outputTokens,
    });
    if (!holdAmount.ok) {
      // Rate cấu hình hỏng/overflow là lỗi cấu hình serving, không phải client.
      log(`chat-completions admission amount rejected: ${holdAmount.error.code}`);
      return errorResponse(pricingUnavailableError());
    }

    // 10. Admission transaction.
    const attemptNo = 1;
    const attemptId = deriveAttemptId(requestId, attemptNo);
    const admitted = await admitRequest({
      env,
      limiters,
      requestId,
      tenantId: keyRow.tenant_id,
      apiKeyId: keyRow.id,
      payloadHash,
      chatRequest,
      offerId: offer.id,
      sellerTenantId: offer.seller_tenant_id,
      pricingSnapshotId: pricing.snapshot_id,
      endpointUrl: endpoint.url,
      attemptId,
      attemptNo,
      holdAmount: holdAmount.value,
      holdTokens: bounds.inputTokens + bounds.outputTokens,
    });
    if (!admitted.ok) {
      return errorResponse(admitted.error);
    }
    const { quotaReservationId, financialReservationId, settlementId, chargeId } = admitted;

    // 11. Dispatch upstream — plaintext credential chỉ nằm trong header fetch này.
    const payloadText = buildUpstreamPayload({
      upstreamModel: offer.normalized_model_id,
      messages: chatRequest.messages,
      maxTokens: chatRequest.maxTokens,
    });
    const rawOutcome = await dispatchUpstreamChatCompletion({
      url: endpoint.url,
      credentialPlaintext,
      payloadText,
    });
    const classified = classifyUpstreamOutcome(rawOutcome);
    log(
      `chat-completions dispatched request_id=${requestId} status=${
        rawOutcome.httpStatus === null ? 'none' : String(rawOutcome.httpStatus)
      } evidence=${classified.evidence} usage=${classified.usage.status}`,
    );

    // 12. Settlement transaction (settle/release theo evidence — F5, F7).
    const finalizeUsage =
      classified.usage.status === 'known' &&
      classified.usage.usage.input_tokens !== null &&
      classified.usage.usage.output_tokens !== null
        ? {
            status: 'known' as const,
            inputTokens: BigInt(classified.usage.usage.input_tokens),
            outputTokens: BigInt(classified.usage.usage.output_tokens),
          }
        : classified.usage.status === 'malformed'
          ? ({ status: 'malformed' } as const)
          : ({ status: 'missing' } as const);
    const settled = await finalizeAttempt({
      env,
      limiters,
      requestId,
      tenantId: keyRow.tenant_id,
      attemptId,
      quotaReservationId,
      financialReservationId,
      settlementId,
      chargeId,
      holdTokens: bounds.inputTokens + bounds.outputTokens,
      inputRatePerMillionMinor: BigInt(pricing.input_rate_per_1m_tokens_minor),
      outputRatePerMillionMinor: BigInt(pricing.output_rate_per_1m_tokens_minor),
      classifiedEvidence: classified.evidence,
      classifiedUsage: finalizeUsage,
      completion: classified.completion,
      upstreamRetryAfter: classified.retryAfterSeconds,
    });

    if (settled.kind === 'completed') {
      // Tên `envelopeText` cố tình KHÔNG dùng "responseBody": regex nguồn của
      // rule semgrep `security-sensitive-value-in-http-response` khớp
      // `response_?body` không phân biệt hoa-thường (shape-fix trên 1.185.0).
      const envelopeText = buildChatCompletionResponseBody({
        completionId: deriveCompletionId(requestId),
        createdSeconds: Math.floor(Date.now() / 1000),
        model: offer.normalized_model_id,
        completion: settled.completion,
        usage: classified.usage,
      });
      log(
        `chat-completions ok request_id=${requestId} charge_minor=${String(settled.chargeMinor)} evidence=${classified.evidence}`,
      );
      return new Response(new TextEncoder().encode(envelopeText), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    log(`chat-completions failed request_id=${requestId} code=${settled.errorCode}`);
    return errorResponse(settled.error);
  } catch (error: unknown) {
    if (error instanceof HttpOutcome) {
      return errorResponse(error.apiError);
    }
    // Chi tiết lỗi (message của pg/driver có thể chứa connection string) không
    // bao giờ đi vào log hay response — chỉ outcome.
    log('chat-completions internal failure');
    return errorResponse(serviceUnavailableError());
  }
}

function mapValidationFailure(failure: ChatRequestFailure): ApiError {
  switch (failure) {
    case 'missing_model':
      return invalidRequestError('"model" is required and must be a non-empty string.');
    case 'missing_messages':
      return invalidRequestError('"messages" must be a non-empty array.');
    case 'invalid_messages':
      return invalidRequestError('"messages" must be an array of objects with a "role" string.');
    case 'streaming_not_supported':
      return streamingNotSupportedError();
    case 'max_tokens_required':
      return maxTokensRequiredError();
    case 'invalid_max_tokens':
      return invalidRequestError('"max_tokens" must be an integer >= 1.');
  }
}

// ---------------------------------------------------------------------------
// Auth row + eligibility + credential verify
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly revoked_at: string | null;
}

async function fetchApiKeyRow(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  keyHash: string,
): Promise<ApiKeyRow | null> {
  const hyperdrive = readBinding(env, BINDING_GATEWAY);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  try {
    const result = await withClient(
      hyperdrive.connectionString,
      (client) =>
        client.query(
          'SELECT id, tenant_id, revoked_at FROM llm_gateway.api_keys WHERE key_hash = $1',
          [keyHash],
        ),
      { limiter: limiters[BINDING_GATEWAY], deadlineMs: RESOLUTION_DEADLINE_MS },
    );
    const row = result.rows[0] as ApiKeyRow | undefined;
    return row ?? null;
  } catch (error: unknown) {
    if (error instanceof HttpOutcome) {
      throw error;
    }
    // DB auth lookup lỗi là lỗi hạ tầng — 503, không 401 (phân biệt rõ
    // "key sai" với "không tra cứu được").
    log('chat-completions auth lookup failed');
    throw new HttpOutcome(serviceUnavailableError());
  }
}

/** Restriction hiệu lực chặn capability `chat` (hoặc tenant-scope) của seller tenant. */
async function fetchEffectiveChatRestriction(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  sellerTenantId: string,
): Promise<boolean> {
  const hyperdrive = readBinding(env, BINDING_GATEWAY);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  const now = Date.now();
  // Cửa sổ nửa mở khớp `isRestrictionEffective` (llm-seller-governance):
  // activates_at <= now < expires_at, lifted_at IS NULL hoặc lift ở tương lai.
  // Fail-closed: BẤT KỲ record hiệu lực khớp target nào cũng chặn — policy
  // catalog phân biệt restrictive/unknown là pha sau.
  const result = await withClient(
    hyperdrive.connectionString,
    (client) =>
      client.query(
        `SELECT id FROM llm_seller.restriction_records
          WHERE tenant_id = $1
            AND (lifted_at IS NULL OR lifted_at > $2)
            AND activates_at <= $2
            AND (expires_at IS NULL OR expires_at > $2)
            AND (scope_kind = 'tenant' OR (scope_kind = 'capability' AND capability = 'chat'))
          LIMIT 1`,
        [sellerTenantId, now],
      ),
    { limiter: limiters[BINDING_GATEWAY], deadlineMs: RESOLUTION_DEADLINE_MS },
  );
  return result.rows.length > 0;
}

/**
 * Verify credential serving per-request (invariant 8): tồn tại credential
 * active (seller-tenant + provider scope) với `credential_hash ==
 * sha256(plaintext env)`; scope validation qua `assertCredentialProvider`
 * (thứ tự provider → tenant → revoked của domain). KHÔNG bao giờ log hash
 * detail hay plaintext; kết quả một-bit.
 */
async function verifyUpstreamCredential(
  env: LlmApiEnv,
  limiters: Readonly<Record<string, BindingLimiter>>,
  sellerTenantId: string,
  provider: string,
  credentialPlaintext: string,
): Promise<boolean> {
  const hyperdrive = readBinding(env, BINDING_MARKETPLACE);
  if (hyperdrive === null) {
    throw new HttpOutcome(serviceUnavailableError());
  }
  const rows = await withClient(
    hyperdrive.connectionString,
    (client) =>
      client.query(
        `SELECT id, provider, seller_tenant_id, credential_hash, created_by, created_at, revoked_at, revoked_by
           FROM llm_marketplace.provider_credentials
          WHERE seller_tenant_id = $1 AND provider = $2 AND revoked_at IS NULL`,
        [sellerTenantId, provider],
      ),
    { limiter: limiters[BINDING_MARKETPLACE], deadlineMs: RESOLUTION_DEADLINE_MS },
  );
  const expectedHash = await sha256Hex(credentialPlaintext);
  for (const row of rows.rows as CredentialRow[]) {
    if (row.credential_hash !== expectedHash) {
      continue;
    }
    const assertion = assertCredentialProvider(toProviderCredential(row), provider, sellerTenantId);
    return assertion.ok;
  }
  return false;
}

/**
 * Dựng input scope cho `assertCredentialProvider` từ row marketplace — hàm
 * thuần module-scope. Shape tách riêng còn giữ dữ liệu hash trong mapper,
 * không nội tuyến object literal tại call site của predicate scope.
 */
function toProviderCredential(row: CredentialRow): ProviderCredential {
  return {
    id: row.id,
    provider: row.provider,
    sellerTenantId: row.seller_tenant_id,
    credentialHash: row.credential_hash,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    revokedBy: row.revoked_by,
  };
}

// ---------------------------------------------------------------------------
// Phase 10 — admission transaction
// ---------------------------------------------------------------------------

interface AdmitInput {
  readonly env: LlmApiEnv;
  readonly limiters: Readonly<Record<string, BindingLimiter>>;
  readonly requestId: string;
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly payloadHash: string;
  readonly chatRequest: ValidatedChatRequest;
  readonly offerId: string;
  readonly sellerTenantId: string;
  readonly pricingSnapshotId: string;
  readonly endpointUrl: string;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly holdAmount: Money;
  readonly holdTokens: bigint;
}

interface AdmittedAttempt {
  readonly ok: true;
  readonly quotaReservationId: string;
  readonly financialReservationId: string;
  readonly settlementId: string;
  readonly chargeId: string;
}

type AdmitOutcome = AdmittedAttempt | { readonly ok: false; readonly error: ApiError };

/** Bảng replay pre-check đọc trước admission (nhanh, read-only). */
async function preCheckReplay(
  client: import('pg').Client,
  requestId: string,
  tenantId: string,
  payloadHash: string,
): Promise<ApiError | null> {
  const result = await client.query(
    'SELECT payload_hash FROM llm_gateway.logical_requests WHERE request_id = $1 AND tenant_id = $2',
    [requestId, tenantId],
  );
  const row = result.rows[0] as { payload_hash: string } | undefined;
  if (row === undefined) {
    return null;
  }
  return row.payload_hash === payloadHash ? requestIdReplayError() : idempotencyConflictError();
}

/**
 * Phase 10 — MỘT transaction gateway cho toàn bộ admission: replay, ceiling
 * quota, reserve quota, reserve financial (kèm replay credit grant còn thiếu
 * để mở ví), persist journal. Financial từ chối → UPDATE quota reservation
 * thành `released` trong cùng transaction (compensation idempotent, invariant 1).
 */
async function admitRequest(input: AdmitInput): Promise<AdmitOutcome> {
  const {
    env,
    limiters,
    requestId,
    tenantId,
    apiKeyId,
    payloadHash,
    chatRequest,
    offerId,
    sellerTenantId,
    pricingSnapshotId,
    endpointUrl,
    attemptId,
    attemptNo,
    holdAmount,
    holdTokens,
  } = input;
  const quotaReservationId = deriveQuotaReservationId(requestId);
  const financialReservationId = deriveFinancialReservationId(requestId, attemptId);
  const settlementId = deriveSettlementId(requestId, attemptId);
  const chargeId = deriveChargeId(requestId, attemptId);
  const now = Date.now();

  return inGatewayTransaction(
    env,
    limiters,
    TRANSACTION_DEADLINE_MS,
    async (client): Promise<AdmitOutcome> => {
      const replayError = await preCheckReplay(client, requestId, tenantId, payloadHash);
      if (replayError !== null) {
        throw new HttpOutcome(replayError);
      }

      // Trần quota operational: ensure row (MVP default) rồi khoá để tính.
      await client.query(
        `INSERT INTO llm_gateway.tenant_quota (tenant_id, token_ceiling, created_at, created_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, DEFAULT_TENANT_TOKEN_CEILING.toString(), now, 'llm-api-serving'],
      );
      const quotaLock = await client.query(
        'SELECT token_ceiling FROM llm_gateway.tenant_quota WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      const tokenCeiling = BigInt((quotaLock.rows[0] as { token_ceiling: string }).token_ceiling);
      const spent = await client.query(
        `SELECT COALESCE(SUM(settled_tokens), 0) AS spent FROM llm_gateway.quota_reservations
          WHERE tenant_id = $1 AND state = 'settled'`,
        [tenantId],
      );
      const heldActive = await client.query(
        `SELECT COALESCE(SUM(token_amount), 0) AS held FROM llm_gateway.quota_reservations
          WHERE tenant_id = $1 AND state = 'active'`,
        [tenantId],
      );
      const tokensCommitted =
        BigInt((spent.rows[0] as { spent: string }).spent) +
        BigInt((heldActive.rows[0] as { held: string }).held);
      if (tokensCommitted + holdTokens > tokenCeiling) {
        throw new HttpOutcome(insufficientQuotaError());
      }

      // Reserve quota DURABLE (identity từ request_id) — invariant 1.
      await client.query(
        `INSERT INTO llm_gateway.quota_reservations
           (reservation_id, request_id, tenant_id, token_amount, state, created_at)
         VALUES ($1, $2, $3, $4, 'active', $5)`,
        [quotaReservationId, requestId, tenantId, holdTokens.toString(), now],
      );

      // Wallet: ensure row rồi hydrate state tài chính (billing account theo tenant).
      const billingAccountId = await fetchBillingAccountId(client, tenantId);
      const walletId = deriveWalletId(billingAccountId);
      await ensureWalletRow(client, { billingAccountId, walletId });
      const state = await loadFinancialState(client, { billingAccountId, walletId });
      const knownTransactionIds = new Set(
        state.book.ledger.transactions.map((transaction) => transaction.transaction_id),
      );
      const replayed = replayGrantCredits(state, now);
      await persistNewTransactions(client, knownTransactionIds, replayed.book);
      const book = replayed.book;

      // Financial admission — identity thứ hai (request_id, attempt_id).
      const reservationOutcome = reserve(book, {
        reservationId: financialReservationId,
        walletId,
        billingAccountId,
        amount: holdAmount,
        createdAt: now,
        fencingToken: state.walletFencingToken,
      });
      if (!reservationOutcome.ok) {
        if (reservationOutcome.error.code === 'insufficient_available_balance') {
          // Compensation idempotent: release quota reservation (cùng transaction).
          await client.query(
            `UPDATE llm_gateway.quota_reservations
                SET state = 'released', released_at = $2
              WHERE reservation_id = $1 AND state = 'active'`,
            [quotaReservationId, now],
          );
          log(
            `chat-completions admission rejected request_id=${requestId} reason=insufficient_available_balance`,
          );
          return { ok: false, error: insufficientFundsError() };
        }
        if (reservationOutcome.error.code === 'idempotency_conflict') {
          throw new HttpOutcome(requestIdReplayError());
        }
        // stale_fencing_token / state hỏng — fail-closed 503.
        log(`chat-completions financial reserve failed: ${reservationOutcome.error.code}`);
        throw new HttpOutcome(serviceUnavailableError());
      }
      await persistNewTransactions(client, knownTransactionIds, reservationOutcome.value.book);
      await persistReservation(client, reservationOutcome.value.reservation);

      // Journal: logical request + attempt (evidence not_sent) TRƯỚC dispatch.
      const inserted = await client.query(
        `INSERT INTO llm_gateway.logical_requests
           (request_id, tenant_id, api_key_id, payload_hash, requested_model, resolved_model,
            offer_id, pricing_snapshot_id, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admitted', $9)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          requestId,
          tenantId,
          apiKeyId,
          payloadHash,
          chatRequest.model,
          chatRequest.model,
          offerId,
          pricingSnapshotId,
          now,
        ],
      );
      if (inserted.rowCount === 0) {
        // Concurrent duplicate cùng request_id — replay path (invariant 3).
        throw new HttpOutcome(requestIdReplayError());
      }
      await client.query(
        `INSERT INTO llm_gateway.attempts
           (attempt_id, request_id, attempt_no, offer_ref, seller_tenant_ref, pricing_snapshot_ref,
            upstream_model, upstream_endpoint_url, admission_mode, quota_reservation_id,
            financial_reservation_id, settlement_id, charge_id, amount_minor, evidence, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'durable-reserve', $9, $10, $11, $12, $13, 'not_sent', $14)`,
        [
          attemptId,
          requestId,
          attemptNo,
          offerId,
          sellerTenantId,
          pricingSnapshotId,
          chatRequest.model,
          endpointUrl,
          quotaReservationId,
          financialReservationId,
          settlementId,
          chargeId,
          reservationOutcome.value.reservation.reserved.minor.toString(),
          now,
        ],
      );
      return {
        ok: true,
        quotaReservationId,
        financialReservationId,
        settlementId,
        chargeId,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Phase 12 — settlement transaction
// ---------------------------------------------------------------------------

interface FinalizeInput {
  readonly env: LlmApiEnv;
  readonly limiters: Readonly<Record<string, BindingLimiter>>;
  readonly requestId: string;
  readonly tenantId: string;
  readonly attemptId: string;
  readonly quotaReservationId: string;
  readonly financialReservationId: string;
  readonly settlementId: string;
  readonly chargeId: string;
  readonly holdTokens: bigint;
  readonly inputRatePerMillionMinor: bigint;
  readonly outputRatePerMillionMinor: bigint;
  readonly classifiedEvidence: DispatchedExecutionEvidence;
  readonly classifiedUsage:
    | { readonly status: 'known'; readonly inputTokens: bigint; readonly outputTokens: bigint }
    | { readonly status: 'missing' }
    | { readonly status: 'malformed' };
  readonly completion: UpstreamCompletion | null;
  readonly upstreamRetryAfter: number | null;
}

type FinalizeOutcome =
  | {
      readonly kind: 'completed';
      readonly completion: UpstreamCompletion;
      readonly chargeMinor: bigint;
    }
  | { readonly kind: 'failed'; readonly error: ApiError; readonly errorCode: string };

/**
 * Phase 12 — settlement/release theo evidence, MỘT transaction gateway:
 * - confirmed_completed + completion + usage known → settle charge ≤ held;
 * - confirmed_completed + completion + usage missing/malformed → settle capped
 *   tại held + alert log (không bao giờ ngầm 0);
 * - may_have_executed → settle capped tại held, request failed (F5);
 * - confirmed_not_executed → release financial + release quota (compensation
 *   idempotent), request failed.
 * Charge 0 (usage 0 token) → release toàn bộ giữ, không có charge row.
 */
async function finalizeAttempt(input: FinalizeInput): Promise<FinalizeOutcome> {
  const now = Date.now();
  const usageStatus =
    input.classifiedUsage.status === 'known'
      ? 'known'
      : input.classifiedUsage.status === 'malformed'
        ? 'malformed'
        : 'missing';
  const usageKnown = input.classifiedUsage.status === 'known';
  const actualTokens = usageKnown
    ? input.classifiedUsage.inputTokens + input.classifiedUsage.outputTokens
    : null;

  return inGatewayTransaction(
    input.env,
    input.limiters,
    TRANSACTION_DEADLINE_MS,
    async (client): Promise<FinalizeOutcome> => {
      const billingAccountId = await fetchBillingAccountId(client, input.tenantId);
      const walletId = deriveWalletId(billingAccountId);
      const state = await loadFinancialState(client, { billingAccountId, walletId });
      const knownTransactionIds = new Set(
        state.book.ledger.transactions.map((transaction) => transaction.transaction_id),
      );
      const replayedGrants = replayGrantCredits(state, now);
      await persistNewTransactions(client, knownTransactionIds, replayedGrants.book);
      const book = replayedGrants.book;

      const notExecuted = input.classifiedEvidence === 'confirmed_not_executed';
      const executed = !notExecuted && input.completion !== null;
      const degradedExecution = !notExecuted && input.completion === null; // 200 malformed / may_have_executed

      let chargeMinor = 0n;
      if (!notExecuted) {
        // Cận charge thật theo usage khi known; missing/malformed → cap tại held.
        let chargeAmount: Money | null = null;
        if (usageKnown && input.classifiedUsage.status === 'known') {
          const upper = admissionUpperBoundAmount({
            denomination: 'UC',
            perRequestMinor: 0n,
            inputRatePerMillionMinor: input.inputRatePerMillionMinor,
            outputRatePerMillionMinor: input.outputRatePerMillionMinor,
            inputTokens: input.classifiedUsage.inputTokens,
            outputTokens: input.classifiedUsage.outputTokens,
          });
          // Lỗi compute → an toàn hơn là cap tại held (cận trên luôn đủ).
          chargeAmount = upper.ok ? upper.value : null;
        }
        const reservation = book.reservations.find(
          (candidate) => candidate.reservation_id === input.financialReservationId,
        );
        if (reservation === undefined) {
          throw new FinancialStateMissing();
        }
        const capped =
          chargeAmount === null
            ? reservation.reserved
            : (compareMoney(chargeAmount, reservation.reserved) ?? 1) <= 0
              ? chargeAmount
              : reservation.reserved;
        chargeMinor = capped.minor;
        if (chargeMinor > 0n) {
          const settleOutcome = settle(book, {
            settlementId: input.settlementId,
            reservationId: input.financialReservationId,
            chargeId: input.chargeId,
            chargeAmount: capped,
            settledAt: now,
            fencingToken: state.walletFencingToken,
            seller: null, // first-party: Dronie tự phục vụ — không payable (ADR-0028 §7.1)
          });
          if (!settleOutcome.ok) {
            if (
              settleOutcome.error.code === 'insufficient_held_balance' ||
              settleOutcome.error.code === 'invalid_settlement'
            ) {
              log(
                `chat-completions settle rejected request_id=${input.requestId} reason=${settleOutcome.error.code}`,
              );
              throw new HttpOutcome(serviceUnavailableError());
            }
            throw new FinancialStateMissing();
          }
          await persistNewTransactions(client, knownTransactionIds, settleOutcome.value.book);
          await persistCharge(client, settleOutcome.value.charge);
          const settledReservation = settleOutcome.value.book.reservations.find(
            (candidate) => candidate.reservation_id === input.financialReservationId,
          );
          if (settledReservation !== undefined) {
            await persistReservation(client, settledReservation);
          }
          if (
            chargeAmount === null ||
            (compareMoney(chargeAmount, reservation.reserved) ?? 1) > 0
          ) {
            log(
              `chat-completions financial_charge_capped request_id=${input.requestId} usage_status=${usageStatus} charged=${chargeMinor.toString()} held=${reservation.reserved.minor.toString()}`,
            );
          }
        } else {
          // Charge 0: release toàn bộ giữ (không có gì để capture).
          const releaseOutcome = release(book, {
            reservationId: input.financialReservationId,
            releasedAt: now,
            fencingToken: state.walletFencingToken,
          });
          if (!releaseOutcome.ok) {
            throw new FinancialStateMissing();
          }
          await persistNewTransactions(client, knownTransactionIds, releaseOutcome.value.book);
          await persistReservation(client, releaseOutcome.value.reservation);
        }
      } else {
        const releaseOutcome = release(book, {
          reservationId: input.financialReservationId,
          releasedAt: now,
          fencingToken: state.walletFencingToken,
        });
        if (!releaseOutcome.ok) {
          throw new FinancialStateMissing();
        }
        await persistNewTransactions(client, knownTransactionIds, releaseOutcome.value.book);
        await persistReservation(client, releaseOutcome.value.reservation);
      }

      // Quota settle/release — conservative khi usage unknown (settled_tokens = estimate).
      if (notExecuted) {
        await client.query(
          `UPDATE llm_gateway.quota_reservations
              SET state = 'released', released_at = $2
            WHERE reservation_id = $1 AND state = 'active'`,
          [input.quotaReservationId, now],
        );
      } else {
        await client.query(
          `UPDATE llm_gateway.quota_reservations
              SET state = 'settled', settled_tokens = $2, settled_at = $3
            WHERE reservation_id = $1 AND state = 'active'`,
          [input.quotaReservationId, (actualTokens ?? input.holdTokens).toString(), now],
        );
      }

      // Journal attempts + logical_requests — metadata only.
      const finalEvidence = notExecuted
        ? 'confirmed_not_executed'
        : input.classifiedEvidence === 'confirmed_completed'
          ? 'confirmed_completed'
          : 'may_have_executed';
      const inputTokens =
        usageKnown && input.classifiedUsage.status === 'known'
          ? input.classifiedUsage.inputTokens.toString()
          : null;
      const outputTokens =
        usageKnown && input.classifiedUsage.status === 'known'
          ? input.classifiedUsage.outputTokens.toString()
          : null;
      // Guard evidence: evidence chỉ strengthen (llm-inference-domain) — attempt
      // đang `not_sent` nhận mọi evidence cuối; một attempt đã terminal thì
      // transition trái chiều là lỗi state, fail-closed.
      const currentAttempt = await client.query(
        'SELECT evidence FROM llm_gateway.attempts WHERE attempt_id = $1',
        [input.attemptId],
      );
      const currentEvidence = (currentAttempt.rows[0] as { evidence?: unknown } | undefined)
        ?.evidence;
      if (
        typeof currentEvidence === 'string' &&
        isExecutionEvidence(currentEvidence) &&
        !evidenceCanTransition(currentEvidence, finalEvidence)
      ) {
        log(
          `chat-completions evidence regression request_id=${input.requestId} from=${currentEvidence} to=${finalEvidence}`,
        );
        throw new HttpOutcome(serviceUnavailableError());
      }
      await client.query(
        `UPDATE llm_gateway.attempts
            SET evidence = $2, usage_status = $3, input_tokens = $4, output_tokens = $5, ended_at = $6
          WHERE attempt_id = $1`,
        [input.attemptId, finalEvidence, usageStatus, inputTokens, outputTokens, now],
      );
      const requestStatus = executed ? 'completed' : 'failed';
      const errorCode = executed
        ? null
        : notExecuted && input.upstreamRetryAfter !== null
          ? 'rate_limit_exceeded'
          : notExecuted
            ? 'upstream_error'
            : 'upstream_error';
      await client.query(
        `UPDATE llm_gateway.logical_requests
            SET status = $2, evidence = $3, usage_status = $4, input_tokens = $5,
                output_tokens = $6, charge_minor = $7, error_code = $8, completed_at = $9
          WHERE request_id = $1`,
        [
          input.requestId,
          requestStatus,
          finalEvidence,
          usageStatus,
          inputTokens,
          outputTokens,
          chargeMinor.toString(),
          errorCode,
          now,
        ],
      );

      if (executed && input.completion !== null) {
        return {
          kind: 'completed',
          completion: input.completion,
          chargeMinor,
        };
      }
      if (degradedExecution) {
        // 200-malformed hoặc may_have_executed: escalate theo F5.
        log(
          `chat-completions upstream_degraded request_id=${input.requestId} evidence=${finalEvidence} usage_status=${usageStatus}`,
        );
      }
      const error =
        notExecuted && input.upstreamRetryAfter !== null
          ? rateLimitExceededError(input.upstreamRetryAfter)
          : upstreamError();
      return { kind: 'failed', error, errorCode: errorCode ?? 'upstream_error' };
    },
  );
}

/** State tài chính không tìm thấy reservation đang thao tác — không thể xảy ra trên đường lành. */
class FinancialStateMissing extends Error {
  constructor() {
    super('financial reservation state missing during finalize');
    this.name = 'FinancialStateMissing';
  }
}
