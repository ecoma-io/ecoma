/**
 * Seller endpoint fallback configuration.
 *
 * Source of truth: `docs/domains/llm-marketplace/domain-model.md` §1, §3.5, §4;
 * `docs/domains/llm-marketplace/domain-model.md` §3.6, §7.
 *
 * Ranh giới bắt buộc: đây là fallback **phía Seller trong một offer** — thứ tự
 * ưu tiên endpoint trong một pool, và pool nào được phép fallback sang pool
 * nào của **cùng một offer**. Nó KHÔNG phải routing fallback của consumer:
 * chọn giữa các offer, priority/round-robin/lowest-price, alias và eligibility
 * thuộc `llm-consumer-routing-domain`. Lib này không mô hình hoá strategy nào.
 *
 * Đây là **value object** và không tham chiếu ngược pool/endpoint ngoài offer:
 * `createSellerFallbackConfig` nhận đủ ngữ cảnh để kiểm tính đóng (closed
 * world) của cấu hình, vì một cấu hình trỏ tới pool không thuộc offer là cấu
 * hình không thể thực thi.
 */

import {
  isEndpointPoolId,
  isUpstreamEndpointId,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  type EndpointPoolId,
  type LlmMarketplaceResult,
  type UpstreamEndpointId,
} from './shared';
import type { EndpointPool, UpstreamEndpoint } from './endpoint';
import { isEndpointPool } from './endpoint';

/**
 * Thứ tự ưu tiên endpoint trong một pool.
 *
 * `endpointIds` là danh sách có thứ tự, không rỗng, không trùng. Endpoint trong
 * pool nhưng không có trong danh sách không được ưu tiên — chúng vẫn là ứng
 * viên fallback sau danh sách, theo thứ tự canonical của pool.
 */
export interface EndpointPreference {
  readonly poolId: EndpointPoolId;
  readonly endpointIds: readonly UpstreamEndpointId[];
}

/**
 * Cấu hình fallback phía Seller cho một offer.
 *
 * - `poolPreference`: thứ tự pool được thử trong offer. Không rỗng, không trùng
 *   pool, mọi pool thuộc offer.
 * - `endpointPreferences`: thứ tự endpoint ưu tiên bên trong từng pool. Mỗi
 *   `poolId` phải nằm trong `poolPreference` và mọi endpoint phải thuộc đúng
 *   pool đó. Không có preference cho một pool nghĩa là dùng thứ tự canonical.
 * - `allowCrossPoolFallback`: có được chuyển sang pool kế tiếp trong
 *   `poolPreference` khi pool hiện tại không còn endpoint phục vụ được không.
 *   `false` nghĩa là offer chỉ dùng pool đầu tiên còn phục vụ được và không
 *   chuyển tiếp — cấu hình như vậy không "fallback", và `create` vẫn chấp nhận
 *   để caller biểu diễn "không fallback".
 */
export interface SellerFallbackConfig {
  readonly offerId: string;
  readonly poolPreference: readonly EndpointPoolId[];
  readonly endpointPreferences: readonly EndpointPreference[];
  readonly allowCrossPoolFallback: boolean;
}

/** Ngữ cảnh kiểm tính đóng của cấu hình. */
export interface SellerFallbackConfigContext {
  /** Offer mà cấu hình áp dụng. */
  readonly offerId: unknown;
  /** Toàn bộ pool của offer — dùng để kiểm pool/endpoint có thật. */
  readonly pools: readonly EndpointPool[];
}

/** Input tạo cấu hình fallback. */
export interface CreateSellerFallbackConfigInput {
  readonly offerId: unknown;
  readonly poolPreference: unknown;
  readonly endpointPreferences?: unknown;
  readonly allowCrossPoolFallback?: unknown;
  readonly context: SellerFallbackConfigContext;
}

/**
 * Tạo `SellerFallbackConfig` đã validate.
 *
 * Guard, theo thứ tự (fail closed):
 * 1. Ngữ cảnh: `context.pools` là mảng pool hợp lệ và **mọi** pool thuộc
 *    `context.offerId` (`pool_offer_mismatch` khi lệch).
 * 2. `offerId` hợp lệ và khớp `context.offerId` (`inconsistent_context`).
 * 3. `poolPreference` là mảng không rỗng, phần tử là `EndpointPoolId`, không
 *    trùng (`duplicate_fallback_entry`), mọi pool có trong `context.pools`
 *    (`fallback_pool_not_in_offer`).
 * 4. `endpointPreferences`: mỗi mục có `poolId` trong `poolPreference`, không
 *    trùng `poolId` giữa các mục, `endpointIds` không rỗng/không trùng và mọi
 *    endpoint thuộc đúng pool đó (`fallback_endpoint_not_in_pool`).
 * 5. `allowCrossPoolFallback` là boolean thật; vắng mặt mặc định `true`.
 */
export function createSellerFallbackConfig(
  input: CreateSellerFallbackConfigInput,
): LlmMarketplaceResult<SellerFallbackConfig> {
  const context = input.context;
  if (typeof context !== 'object' || context === null) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (!Array.isArray(context.pools)) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (!context.pools.every(isEndpointPool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (context.pools.some((pool) => pool.offerId !== context.offerId)) {
    return llmMarketplaceFailure('pool_offer_mismatch');
  }
  if (typeof input.offerId !== 'string' || input.offerId !== context.offerId) {
    return llmMarketplaceFailure('inconsistent_context');
  }
  if (!Array.isArray(input.poolPreference) || input.poolPreference.length === 0) {
    return llmMarketplaceFailure('invalid_fallback_config');
  }
  if (!input.poolPreference.every(isEndpointPoolId)) {
    return llmMarketplaceFailure('invalid_fallback_config');
  }
  const poolPreference = input.poolPreference;
  if (new Set(poolPreference).size !== poolPreference.length) {
    return llmMarketplaceFailure('duplicate_fallback_entry');
  }
  const poolsById = new Map(context.pools.map((pool) => [pool.id, pool]));
  if (poolPreference.some((poolId) => !poolsById.has(poolId))) {
    return llmMarketplaceFailure('fallback_pool_not_in_offer');
  }

  const rawPreferences = input.endpointPreferences ?? [];
  if (!Array.isArray(rawPreferences)) {
    return llmMarketplaceFailure('invalid_fallback_config');
  }
  const endpointPreferences: EndpointPreference[] = [];
  const seenPools = new Set<string>();
  for (const raw of rawPreferences) {
    if (typeof raw !== 'object' || raw === null) {
      return llmMarketplaceFailure('invalid_fallback_config');
    }
    const candidate = raw as { poolId?: unknown; endpointIds?: unknown };
    if (!isEndpointPoolId(candidate.poolId) || !poolPreference.includes(candidate.poolId)) {
      return llmMarketplaceFailure('fallback_pool_not_in_offer');
    }
    if (seenPools.has(candidate.poolId)) {
      return llmMarketplaceFailure('duplicate_fallback_entry');
    }
    seenPools.add(candidate.poolId);
    if (!Array.isArray(candidate.endpointIds) || candidate.endpointIds.length === 0) {
      return llmMarketplaceFailure('invalid_fallback_config');
    }
    if (!candidate.endpointIds.every(isUpstreamEndpointId)) {
      return llmMarketplaceFailure('invalid_upstream_endpoint_id');
    }
    const endpointIds = candidate.endpointIds;
    if (new Set(endpointIds).size !== endpointIds.length) {
      return llmMarketplaceFailure('duplicate_fallback_entry');
    }
    const pool = poolsById.get(candidate.poolId);
    if (
      pool === undefined ||
      endpointIds.some(
        (endpointId) => !pool.endpoints.some((endpoint) => endpoint.id === endpointId),
      )
    ) {
      return llmMarketplaceFailure('fallback_endpoint_not_in_pool');
    }
    endpointPreferences.push(
      Object.freeze({
        poolId: candidate.poolId,
        endpointIds: Object.freeze([...endpointIds]),
      }),
    );
  }

  const allowCrossPoolFallback = input.allowCrossPoolFallback ?? true;
  if (typeof allowCrossPoolFallback !== 'boolean') {
    return llmMarketplaceFailure('invalid_fallback_config');
  }

  return llmMarketplaceOk(
    Object.freeze({
      offerId: input.offerId as string,
      poolPreference: Object.freeze([...poolPreference]),
      endpointPreferences: Object.freeze(endpointPreferences),
      allowCrossPoolFallback,
    }),
  );
}

/** Shape guard cho `SellerFallbackConfig` đọc từ storage/contract. */
export function isSellerFallbackConfig(value: unknown): value is SellerFallbackConfig {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof SellerFallbackConfig, unknown>>;
  if (typeof candidate.offerId !== 'string' || candidate.offerId.length === 0) {
    return false;
  }
  if (typeof candidate.allowCrossPoolFallback !== 'boolean') {
    return false;
  }
  if (!Array.isArray(candidate.poolPreference) || candidate.poolPreference.length === 0) {
    return false;
  }
  if (!candidate.poolPreference.every(isEndpointPoolId)) {
    return false;
  }
  if (new Set(candidate.poolPreference).size !== candidate.poolPreference.length) {
    return false;
  }
  if (!Array.isArray(candidate.endpointPreferences)) {
    return false;
  }
  const seenPools = new Set<string>();
  for (const raw of candidate.endpointPreferences) {
    if (typeof raw !== 'object' || raw === null) {
      return false;
    }
    const preference = raw as { poolId?: unknown; endpointIds?: unknown };
    if (!isEndpointPoolId(preference.poolId)) {
      return false;
    }
    if (!candidate.poolPreference.includes(preference.poolId)) {
      return false;
    }
    if (seenPools.has(preference.poolId)) {
      return false;
    }
    seenPools.add(preference.poolId);
    if (!Array.isArray(preference.endpointIds) || preference.endpointIds.length === 0) {
      return false;
    }
    if (!preference.endpointIds.every(isUpstreamEndpointId)) {
      return false;
    }
    if (new Set(preference.endpointIds).size !== preference.endpointIds.length) {
      return false;
    }
  }
  return true;
}

/** Một ứng viên endpoint đã được xếp thứ tự trong offer. */
export interface OrderedEndpointCandidate {
  readonly poolId: EndpointPoolId;
  readonly endpoint: UpstreamEndpoint;
  /** Thứ tự 1-based trong toàn bộ danh sách ứng viên. */
  readonly rank: number;
}

/** Input xếp thứ tự endpoint ưu tiên theo cấu hình fallback. */
export interface OrderEndpointCandidatesInput {
  readonly config: SellerFallbackConfig;
  /** Toàn bộ pool của offer — phải khớp `config.offerId`. */
  readonly pools: readonly EndpointPool[];
}

/**
 * Xếp thứ tự endpoint ưu tiên theo `SellerFallbackConfig`.
 *
 * Đây là phép **đọc** cấu hình thành danh sách ứng viên, không chọn endpoint và
 * không quyết định retry. Thứ tự:
 *
 * 1. Pool theo `poolPreference`.
 * 2. Trong mỗi pool: endpoint có trong `endpointPreferences` theo đúng thứ tự
 *    đó, rồi các endpoint còn lại theo thứ tự canonical của pool.
 *
 * Chỉ endpoint đang `healthy` hoặc `degraded` được đưa vào danh sách — endpoint
 * `down` không phải ứng viên. Nếu `allowCrossPoolFallback` là `false`, chỉ các
 * ứng viên thuộc **pool đầu tiên còn ứng viên** được giữ lại: không chuyển pool.
 *
 * Trả danh sách rỗng khi không có ứng viên nào; đó không phải lỗi domain, mà là
 * sự thật "offer hiện không có endpoint phục vụ được".
 */
export function orderEndpointCandidates(
  input: OrderEndpointCandidatesInput,
): LlmMarketplaceResult<readonly OrderedEndpointCandidate[]> {
  if (!isSellerFallbackConfig(input.config)) {
    return llmMarketplaceFailure('invalid_fallback_config');
  }
  if (!Array.isArray(input.pools) || !input.pools.every(isEndpointPool)) {
    return llmMarketplaceFailure('invalid_endpoint_pool');
  }
  if (input.pools.some((pool) => pool.offerId !== input.config.offerId)) {
    return llmMarketplaceFailure('pool_offer_mismatch');
  }
  const poolsById = new Map(input.pools.map((pool) => [pool.id, pool]));
  if (input.config.poolPreference.some((poolId) => !poolsById.has(poolId))) {
    return llmMarketplaceFailure('fallback_pool_not_in_offer');
  }

  const perPool: OrderedEndpointCandidate[][] = [];
  for (const poolId of input.config.poolPreference) {
    const pool = poolsById.get(poolId);
    if (pool === undefined) {
      return llmMarketplaceFailure('fallback_pool_not_in_offer');
    }
    const preference = input.config.endpointPreferences.find((entry) => entry.poolId === poolId);
    const preferredIds = preference?.endpointIds ?? [];
    const ordered: UpstreamEndpoint[] = [];
    for (const endpointId of preferredIds) {
      const endpoint = pool.endpoints.find((candidate) => candidate.id === endpointId);
      if (endpoint === undefined) {
        return llmMarketplaceFailure('fallback_endpoint_not_in_pool');
      }
      if (endpoint.health !== 'down') {
        ordered.push(endpoint);
      }
    }
    const preferred = new Set(preferredIds);
    for (const endpoint of pool.endpoints) {
      if (preferred.has(endpoint.id)) {
        continue;
      }
      if (endpoint.health !== 'down') {
        ordered.push(endpoint);
      }
    }
    perPool.push(
      ordered.map(
        (endpoint) => Object.freeze({ poolId, endpoint, rank: 0 }) as OrderedEndpointCandidate,
      ),
    );
  }

  const selected = input.config.allowCrossPoolFallback
    ? perPool.flat()
    : (perPool.find((candidates) => candidates.length > 0) ?? []);
  return llmMarketplaceOk(
    Object.freeze(
      selected.map((candidate, index) =>
        Object.freeze({
          poolId: candidate.poolId,
          endpoint: candidate.endpoint,
          rank: index + 1,
        }),
      ),
    ),
  );
}
