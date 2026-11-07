/**
 * Upstream endpoint và endpoint pool.
 *
 * Source of truth: `docs/domains/llm-marketplace/domain-model.md` §1, §3.4, §3.5, §4;
 * `docs/domains/llm-marketplace/domain-model.md` §3, §5.
 *
 * Bất biến:
 * - Một endpoint thuộc **đúng một** pool (`endpointPoolId`).
 * - Một pool thuộc **đúng một** offer (`offerId`); scope pool derive từ offer,
 *   không từ input client.
 * - Health của endpoint chỉ đổi qua operation tường minh; không có setter ngầm.
 * - Health của pool là **giá trị suy ra** từ endpoint, không phải field lưu.
 */

import {
  isEpochMillis,
  isEndpointPoolId,
  isModelOfferId,
  isOpaqueLabel,
  isUpstreamEndpointId,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  MAX_ENDPOINT_PROTOCOL_LENGTH,
  MAX_ENDPOINT_URL_LENGTH,
  MAX_ENDPOINT_WEIGHT,
  type EndpointPoolId,
  type LlmMarketplaceResult,
  type ModelOfferId,
  type UpstreamEndpointId,
} from './shared';

/** Trạng thái health của một upstream endpoint. */
export type EndpointHealthStatus = 'healthy' | 'degraded' | 'down';

/** Giá trị canonical của `EndpointHealthStatus`. */
export const ENDPOINT_HEALTH_STATUS: Readonly<Record<EndpointHealthStatus, EndpointHealthStatus>> =
  Object.freeze({
    healthy: 'healthy',
    degraded: 'degraded',
    down: 'down',
  });

/** Type guard cho `EndpointHealthStatus`. */
export function isEndpointHealthStatus(value: unknown): value is EndpointHealthStatus {
  return value === 'healthy' || value === 'degraded' || value === 'down';
}

/**
 * Protocol của upstream endpoint (opaque label, ví dụ `openai_chat`,
 * `anthropic_messages`, `openai_embeddings`).
 *
 * Không phải enum của lib: tập protocol hợp lệ do adapter quyết định. Lib chỉ
 * validate hình dạng để khoá so khớp không chứa dấu cách hay ký tự điều khiển.
 */
export function isEndpointProtocol(value: unknown): value is string {
  return (
    isOpaqueLabel(value) &&
    value.length <= MAX_ENDPOINT_PROTOCOL_LENGTH &&
    /^[a-z][a-z0-9_]*$/u.test(value)
  );
}

/**
 * Hình dạng URL tuyệt đối được chấp nhận.
 *
 * Không dùng `URL` (không có trong lib `es2022` và là global của host, không
 * phải Web API thuần): domain chỉ cần hình dạng, không cần parse đầy đủ.
 *
 * - Scheme `http`/`https` (không phân biệt hoa thường).
 * - Authority là hostname DNS (label chữ-số, cho phép `-` ở giữa) hoặc IPv6
 *   literal trong `[]`, kèm port tuỳ chọn.
 * - Không cho userinfo (`@`), fragment (`#`), whitespace hay ký tự điều khiển.
 */
const ENDPOINT_URL_PATTERN =
  /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([0-9]{1,5}))?(\/[^\s?#]*)?(?:\?([^\s#]*))?$/iu;

/**
 * URL upstream endpoint.
 *
 * Yêu cầu: URL tuyệt đối, scheme `https:` hoặc `http:`, có host, không chứa
 * credential trong userinfo và không có fragment. HTTP được chấp nhận ở tầng
 * domain vì endpoint nội bộ có thể dùng nó; việc bắt buộc HTTPS là policy của
 * deployment, không phải shape của domain.
 */
export function isEndpointUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_URL_LENGTH ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    return false;
  }
  const match = ENDPOINT_URL_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const port = match[3];
  if (port !== undefined) {
    const parsedPort = Number(port);
    if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      return false;
    }
  }
  return true;
}

/**
 * Trọng số của endpoint: số nguyên `1..MAX_ENDPOINT_WEIGHT`.
 *
 * Trọng số 0 bị từ chối: endpoint có weight 0 vẫn nằm trong pool và vẫn tính
 * vào health, nhưng không bao giờ được chọn — trạng thái đó không diễn đạt được
 * bằng dữ liệu và dễ che lỗi cấu hình. Muốn tắt endpoint thì đặt health `down`.
 */
export function isEndpointWeight(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_ENDPOINT_WEIGHT
  );
}

/** Một upstream endpoint. */
export interface UpstreamEndpoint {
  readonly id: UpstreamEndpointId;
  /** Pool duy nhất chứa endpoint này. */
  readonly endpointPoolId: EndpointPoolId;
  readonly url: string;
  readonly protocol: string;
  readonly health: EndpointHealthStatus;
  readonly weight: number;
  readonly createdAt: number;
  /** Thời điểm health hiện tại được ghi; `null` khi chưa có lần đổi health nào. */
  readonly healthRecordedAt: number | null;
}

/** Input tạo upstream endpoint. */
export interface CreateUpstreamEndpointInput {
  readonly id: unknown;
  readonly endpointPoolId: unknown;
  readonly url: unknown;
  readonly protocol: unknown;
  /** Mặc định `degraded`: endpoint mới chưa được probe nên không được coi là healthy. */
  readonly health?: unknown;
  readonly weight?: unknown;
  readonly createdAt: unknown;
}

/**
 * Tạo upstream endpoint.
 *
 * Guard: mọi field hợp lệ; `health` mặc định `degraded` — một endpoint chưa
 * được health check **không** được mặc định `healthy`, vì như vậy một pool mới
 * có thể mở activation trước lần probe đầu tiên.
 */
export function createUpstreamEndpoint(
  input: CreateUpstreamEndpointInput,
): LlmMarketplaceResult<UpstreamEndpoint> {
  if (!isUpstreamEndpointId(input.id)) {
    return llmMarketplaceFailure('invalid_upstream_endpoint_id');
  }
  if (!isEndpointPoolId(input.endpointPoolId)) {
    return llmMarketplaceFailure('invalid_endpoint_pool_id');
  }
  if (!isEndpointUrl(input.url)) {
    return llmMarketplaceFailure('invalid_endpoint_url');
  }
  if (!isEndpointProtocol(input.protocol)) {
    return llmMarketplaceFailure('invalid_endpoint_protocol');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  const health = input.health ?? 'degraded';
  if (!isEndpointHealthStatus(health)) {
    return llmMarketplaceFailure('invalid_endpoint_health');
  }
  const weight = input.weight ?? 1;
  if (!isEndpointWeight(weight)) {
    return llmMarketplaceFailure('invalid_endpoint_weight');
  }
  return llmMarketplaceOk(
    Object.freeze({
      id: input.id,
      endpointPoolId: input.endpointPoolId,
      url: input.url,
      protocol: input.protocol,
      health,
      weight,
      createdAt: input.createdAt,
      healthRecordedAt: null,
    }),
  );
}

/** Input đổi health của endpoint. */
export interface RecordEndpointHealthInput {
  readonly endpoint: UpstreamEndpoint;
  readonly health: unknown;
  readonly recordedAt: unknown;
}

/**
 * Ghi nhận health mới cho endpoint — operation duy nhất đổi health.
 *
 * Guard:
 * - `health` hợp lệ và **khác** health hiện tại. Ghi lại đúng trạng thái cũ trả
 *   `endpoint_health_unchanged`: operation là sự kiện, không phải setter idempotent,
 *   nên một lần probe lặp lại không được tạo ra health event rỗng.
 * - `recordedAt >= createdAt` và `>= healthRecordedAt` — thời gian không lùi.
 *
 * Mọi cặp `(from, to)` khác nhau đều hợp lệ, kể cả `down → healthy` (hồi phục)
 * và `healthy → down` (mất kết nối). Không có trạng thái health terminal.
 */
export function recordEndpointHealth(
  input: RecordEndpointHealthInput,
): LlmMarketplaceResult<UpstreamEndpoint> {
  if (!isUpstreamEndpoint(input.endpoint)) {
    return llmMarketplaceFailure('invalid_upstream_endpoint');
  }
  if (!isEndpointHealthStatus(input.health)) {
    return llmMarketplaceFailure('invalid_endpoint_health');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  const endpoint = input.endpoint;
  if (input.health === endpoint.health) {
    return llmMarketplaceFailure('endpoint_health_unchanged');
  }
  if (input.recordedAt < endpoint.createdAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  if (endpoint.healthRecordedAt !== null && input.recordedAt < endpoint.healthRecordedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...endpoint,
      health: input.health,
      healthRecordedAt: input.recordedAt,
    }),
  );
}

/** Shape guard cho `UpstreamEndpoint` đọc từ storage/contract. */
export function isUpstreamEndpoint(value: unknown): value is UpstreamEndpoint {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof UpstreamEndpoint, unknown>>;
  return (
    isUpstreamEndpointId(candidate.id) &&
    isEndpointPoolId(candidate.endpointPoolId) &&
    isEndpointUrl(candidate.url) &&
    isEndpointProtocol(candidate.protocol) &&
    isEndpointHealthStatus(candidate.health) &&
    isEndpointWeight(candidate.weight) &&
    isEpochMillis(candidate.createdAt) &&
    isNullableTimestamp(candidate.healthRecordedAt) &&
    (candidate.healthRecordedAt === null ||
      (isEpochMillis(candidate.createdAt) &&
        (candidate.healthRecordedAt as number) >= candidate.createdAt))
  );
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isEpochMillis(value);
}

/** Một endpoint pool thuộc đúng một model offer. */
export interface EndpointPool {
  readonly id: EndpointPoolId;
  readonly offerId: ModelOfferId;
  readonly endpoints: readonly UpstreamEndpoint[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Input tạo endpoint pool. */
export interface CreateEndpointPoolInput {
  readonly id: unknown;
  readonly offerId: unknown;
  readonly createdAt: unknown;
  /** Pool đã có — dùng cho guard trùng `id`. */
  readonly existing?: readonly EndpointPool[];
}

/**
 * Tạo endpoint pool rỗng cho một offer.
 *
 * `offerId` là tham số **bắt buộc**: pool không tồn tại ngoài offer, và scope
 * này không được suy ra từ input client ở tầng sau. Guard trùng `id` trên
 * `existing`; mọi phần tử `existing` phải hợp lệ nhưng không cần cùng offer —
 * một offer có nhiều pool là hợp lệ, và danh sách `existing` có thể là toàn bộ
 * pool của marketplace.
 */
export function createEndpointPool(
  input: CreateEndpointPoolInput,
): LlmMarketplaceResult<EndpointPool> {
  if (!isEndpointPoolId(input.id)) {
    return llmMarketplaceFailure('invalid_endpoint_pool_id');
  }
  if (!isModelOfferId(input.offerId)) {
    return llmMarketplaceFailure('invalid_model_offer_id');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (!existing.every(isEndpointPool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (existing.some((pool) => pool.id === input.id)) {
    return llmMarketplaceFailure('duplicate_endpoint_pool_id');
  }
  return llmMarketplaceOk(
    Object.freeze({
      id: input.id,
      offerId: input.offerId,
      endpoints: Object.freeze([]) as readonly UpstreamEndpoint[],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }),
  );
}

/** Input thêm endpoint vào pool. */
export interface AddEndpointToPoolInput {
  readonly pool: EndpointPool;
  readonly endpoint: UpstreamEndpoint;
  readonly addedAt: unknown;
}

/**
 * Thêm endpoint vào pool.
 *
 * Guard: pool/endpoint hợp lệ; `endpoint.endpointPoolId === pool.id` (lệch trả
 * `endpoint_pool_mismatch`, không tự sửa scope); `id` chưa có trong pool;
 * `addedAt >= pool.updatedAt` và `>= endpoint.createdAt`.
 */
export function addEndpointToPool(
  input: AddEndpointToPoolInput,
): LlmMarketplaceResult<EndpointPool> {
  if (!isEndpointPool(input.pool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (!isUpstreamEndpoint(input.endpoint)) {
    return llmMarketplaceFailure('invalid_upstream_endpoint');
  }
  if (!isEpochMillis(input.addedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (input.endpoint.endpointPoolId !== input.pool.id) {
    return llmMarketplaceFailure('endpoint_pool_mismatch');
  }
  if (input.addedAt < input.pool.updatedAt || input.addedAt < input.endpoint.createdAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  if (input.pool.endpoints.some((endpoint) => endpoint.id === input.endpoint.id)) {
    return llmMarketplaceFailure('duplicate_upstream_endpoint_id');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.pool,
      endpoints: Object.freeze([...input.pool.endpoints, input.endpoint]),
      updatedAt: input.addedAt,
    }),
  );
}

/** Input thay một endpoint trong pool bằng bản đã cập nhật. */
export interface ReplaceEndpointInPoolInput {
  readonly pool: EndpointPool;
  readonly endpoint: UpstreamEndpoint;
  readonly replacedAt: unknown;
}

/**
 * Thay endpoint trong pool bằng bản ghi mới (thường sau `recordEndpointHealth`).
 *
 * Guard: `endpoint.endpointPoolId === pool.id`; `endpoint.id` **phải** đã có
 * trong pool (`endpoint_not_in_pool`); `replacedAt >= pool.updatedAt`. Không
 * dùng operation này để thêm endpoint mới — đó là `addEndpointToPool`.
 */
export function replaceEndpointInPool(
  input: ReplaceEndpointInPoolInput,
): LlmMarketplaceResult<EndpointPool> {
  if (!isEndpointPool(input.pool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (!isUpstreamEndpoint(input.endpoint)) {
    return llmMarketplaceFailure('invalid_upstream_endpoint');
  }
  if (!isEpochMillis(input.replacedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (input.endpoint.endpointPoolId !== input.pool.id) {
    return llmMarketplaceFailure('endpoint_pool_mismatch');
  }
  if (!input.pool.endpoints.some((endpoint) => endpoint.id === input.endpoint.id)) {
    return llmMarketplaceFailure('endpoint_not_in_pool');
  }
  if (input.replacedAt < input.pool.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.pool,
      endpoints: Object.freeze(
        input.pool.endpoints.map((endpoint) =>
          endpoint.id === input.endpoint.id ? input.endpoint : endpoint,
        ),
      ),
      updatedAt: input.replacedAt,
    }),
  );
}

/** Input bỏ endpoint khỏi pool. */
export interface RemoveEndpointFromPoolInput {
  readonly pool: EndpointPool;
  readonly endpointId: unknown;
  readonly removedAt: unknown;
}

/**
 * Bỏ endpoint khỏi pool.
 *
 * Guard: endpoint phải đang thuộc pool (`endpoint_not_in_pool`); `removedAt >=
 * pool.updatedAt`. Endpoint cuối cùng được phép bỏ — pool rỗng là trạng thái hợp
 * lệ và có health `down` (xem `deriveEndpointPoolHealth`).
 */
export function removeEndpointFromPool(
  input: RemoveEndpointFromPoolInput,
): LlmMarketplaceResult<EndpointPool> {
  if (!isEndpointPool(input.pool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (!isUpstreamEndpointId(input.endpointId)) {
    return llmMarketplaceFailure('invalid_upstream_endpoint_id');
  }
  if (!isEpochMillis(input.removedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (!input.pool.endpoints.some((endpoint) => endpoint.id === input.endpointId)) {
    return llmMarketplaceFailure('endpoint_not_in_pool');
  }
  if (input.removedAt < input.pool.updatedAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.pool,
      endpoints: Object.freeze(
        input.pool.endpoints.filter((endpoint) => endpoint.id !== input.endpointId),
      ),
      updatedAt: input.removedAt,
    }),
  );
}

/** Shape guard cho `EndpointPool` đọc từ storage/contract. */
export function isEndpointPool(value: unknown): value is EndpointPool {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof EndpointPool, unknown>>;
  if (
    !isEndpointPoolId(candidate.id) ||
    !isModelOfferId(candidate.offerId) ||
    !isEpochMillis(candidate.createdAt) ||
    !isEpochMillis(candidate.updatedAt) ||
    (candidate.updatedAt as number) < candidate.createdAt
  ) {
    return false;
  }
  if (!Array.isArray(candidate.endpoints)) {
    return false;
  }
  if (!candidate.endpoints.every(isUpstreamEndpoint)) {
    return false;
  }
  // Mọi endpoint phải thuộc đúng pool này và id không trùng: một pool đọc từ
  // storage không được mang endpoint của pool khác.
  const ids = candidate.endpoints.map((endpoint) => endpoint.id);
  if (new Set(ids).size !== ids.length) {
    return false;
  }
  return candidate.endpoints.every((endpoint) => endpoint.endpointPoolId === candidate.id);
}

/**
 * Health suy ra của một pool.
 *
 * Định nghĩa chính xác — mọi endpoint trong pool đều **required** (pool không có
 * khái niệm endpoint tuỳ chọn):
 *
 * | healthy | down | degraded | status     |
 * | ------- | ---- | -------- | ---------- |
 * | 0       | *    | *        | `down`     |
 * | ≥ 1     | 0    | *        | `healthy`  |
 * | ≥ 1     | ≥ 1  | *        | `degraded` |
 *
 * Tức pool chỉ `healthy` khi có ít nhất một endpoint healthy **và** không
 * endpoint nào đang `down`. Pool rỗng là `down`.
 */
export interface EndpointPoolHealth {
  readonly status: EndpointHealthStatus;
  /** Pool còn ít nhất một endpoint healthy nên còn phục vụ được. */
  readonly serving: boolean;
  readonly healthyCount: number;
  readonly degradedCount: number;
  readonly downCount: number;
  readonly totalCount: number;
}

/** Suy ra health của pool từ các endpoint của nó. */
export function deriveEndpointPoolHealth(pool: EndpointPool): EndpointPoolHealth {
  if (!isEndpointPool(pool)) {
    // Dữ liệu hỏng không được coi là healthy: fail closed.
    return Object.freeze({
      status: 'down' as const,
      serving: false,
      healthyCount: 0,
      degradedCount: 0,
      downCount: 0,
      totalCount: 0,
    });
  }
  const healthyCount = pool.endpoints.filter((endpoint) => endpoint.health === 'healthy').length;
  const degradedCount = pool.endpoints.filter((endpoint) => endpoint.health === 'degraded').length;
  const downCount = pool.endpoints.filter((endpoint) => endpoint.health === 'down').length;
  const totalCount = pool.endpoints.length;
  let status: EndpointHealthStatus;
  if (healthyCount === 0) {
    status = 'down';
  } else if (downCount > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }
  return Object.freeze({
    status,
    serving: healthyCount > 0,
    healthyCount,
    degradedCount,
    downCount,
    totalCount,
  });
}

/** Health tổng hợp của tất cả pool thuộc một offer. */
export interface OfferEndpointHealth {
  readonly offerId: ModelOfferId;
  /** `healthy` khi có ít nhất một pool healthy; nếu không, `degraded` khi có pool
   *  còn phục vụ được; ngược lại `down`. */
  readonly status: EndpointHealthStatus;
  /** Có ít nhất một pool `healthy` — điều kiện để activation. */
  readonly hasHealthyPool: boolean;
  /** Có ít nhất một pool còn endpoint healthy — offer còn phục vụ được. */
  readonly serving: boolean;
  readonly pools: readonly (EndpointPoolHealth & { readonly poolId: EndpointPoolId })[];
}

/**
 * Suy ra health cấp offer từ danh sách pool.
 *
 * Guard: `pools` là mảng, mọi phần tử hợp lệ và **mọi** pool thuộc `offerId`
 * truyền vào — pool lệch offer bị từ chối nguyên khối (`pool_offer_mismatch`),
 * không lọc rồi tính tiếp. Danh sách rỗng trả `endpoint_pool_missing`.
 */
export function evaluateOfferEndpointHealth(
  offerId: ModelOfferId,
  pools: unknown,
): LlmMarketplaceResult<OfferEndpointHealth> {
  if (!isModelOfferId(offerId)) {
    return llmMarketplaceFailure('invalid_model_offer_id');
  }
  if (!Array.isArray(pools)) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (pools.length === 0) {
    return llmMarketplaceFailure('endpoint_pool_missing');
  }
  if (!pools.every(isEndpointPool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (pools.some((pool) => pool.offerId !== offerId)) {
    return llmMarketplaceFailure('pool_offer_mismatch');
  }
  const poolIds = pools.map((pool) => pool.id);
  if (new Set(poolIds).size !== poolIds.length) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  const entries = pools.map((pool) =>
    Object.freeze({ poolId: pool.id, ...deriveEndpointPoolHealth(pool) }),
  );
  const hasHealthyPool = entries.some((entry) => entry.status === 'healthy');
  const serving = entries.some((entry) => entry.serving);
  const status: EndpointHealthStatus = hasHealthyPool ? 'healthy' : serving ? 'degraded' : 'down';
  return llmMarketplaceOk(
    Object.freeze({
      offerId,
      status,
      hasHealthyPool,
      serving,
      pools: Object.freeze(entries),
    }),
  );
}
