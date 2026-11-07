/**
 * Provider model name và normalized model identity.
 *
 * Source of truth: `docs/domains/llm-marketplace/domain-model.md` §1, §2.2, §2.3, §4;
 * `docs/domains/llm-marketplace/domain-model.md` §2, §4.
 *
 * Hai khái niệm khác nhau và không được trộn:
 *
 * - **ProviderModelName** là **raw identity**: tên model đúng như provider gọi.
 *   Chỉ có ý nghĩa trong phạm vi một provider, không so sánh xuyên provider.
 * - **NormalizedModelIdentity** là identity canonical dùng để dedup/group offer
 *   xuyên provider.
 *
 * Lib cung cấp **operation thuần** validate và map `(provider, provider model
 * name) → normalized identity`. Lib **không** giữ registry, không đọc bảng map,
 * không suy ra identity từ dữ liệu lịch sử: mapping là input của caller.
 */

import {
  isOpaqueLabel,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  MAX_MODEL_NAME_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
  type LlmMarketplaceResult,
} from './shared';

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const NORMALIZED_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/**
 * Provider key.
 *
 * Hình dạng lowercase, bắt đầu bằng chữ cái, cho phép `-` và `_`. Đây là khoá so
 * khớp; tên hiển thị của provider không thuộc domain.
 */
export function isProviderKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PROVIDER_KEY_LENGTH &&
    PROVIDER_KEY_PATTERN.test(value)
  );
}

/**
 * Provider model name (raw identity).
 *
 * Giữ nguyên như provider công bố: không lowercase, không trim, không bỏ dấu
 * chấm. Raw identity không được chuẩn hoá — chuẩn hoá là việc của
 * `NormalizedModelIdentity`, và một raw name bị viết lại sẽ không còn so khớp
 * được với payload provider trả về.
 */
export function isProviderModelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MODEL_NAME_LENGTH &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

/**
 * Normalized model identity.
 *
 * Hình dạng lowercase, bắt đầu bằng chữ số hoặc chữ cái, cho phép `.`, `_`, `-`.
 * Đây là identity canonical cho dedup/group; hai offer cùng identity nghĩa là
 * cùng một model xét theo marketplace.
 */
export function isNormalizedModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MODEL_NAME_LENGTH &&
    NORMALIZED_MODEL_ID_PATTERN.test(value)
  );
}

/** Raw identity theo provider: provider key + provider model name. */
export interface ProviderModelName {
  readonly provider: string;
  readonly model: string;
}

/**
 * Normalized identity canonical.
 *
 * `providerModelNames` là các raw identity đã biết map tới identity này. Tập này
 * là **dữ liệu caller cấp**, không phải registry của lib.
 */
export interface NormalizedModelIdentity {
  readonly normalizedModelId: string;
  readonly providerModelNames: readonly ProviderModelName[];
}

/**
 * Tạo một `ProviderModelName` đã validate.
 *
 * Guard: `provider` qua `isProviderKey`, `model` qua `isProviderModelName`.
 */
export function createProviderModelName(
  provider: unknown,
  model: unknown,
): LlmMarketplaceResult<ProviderModelName> {
  if (!isProviderKey(provider)) {
    return llmMarketplaceFailure('invalid_provider_key');
  }
  if (!isProviderModelName(model)) {
    return llmMarketplaceFailure('invalid_provider_model_name');
  }
  return llmMarketplaceOk(Object.freeze({ provider, model }));
}

/** Shape guard cho `ProviderModelName`. */
export function isProviderModelNameRecord(value: unknown): value is ProviderModelName {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { provider?: unknown; model?: unknown };
  return isProviderKey(candidate.provider) && isProviderModelName(candidate.model);
}

/**
 * Tạo `NormalizedModelIdentity` từ identity và tập raw identity đã biết.
 *
 * Guard:
 * - `normalizedModelId` qua `isNormalizedModelId`.
 * - `providerModelNames` là mảng, mọi phần tử hợp lệ, không trùng cặp
 *   `(provider, model)` — trùng raw identity trong cùng một identity không có
 *   nghĩa và che mất lỗi map.
 *
 * Không kiểm tra rằng một raw identity chỉ thuộc một identity: tính duy nhất
 * xuyên identity là bất biến của **tập** identity, và được kiểm ở
 * `assertProviderModelNameUnique` tại biên ghi.
 */
export function createNormalizedModelIdentity(
  normalizedModelId: unknown,
  providerModelNames: unknown,
): LlmMarketplaceResult<NormalizedModelIdentity> {
  if (!isNormalizedModelId(normalizedModelId)) {
    return llmMarketplaceFailure('invalid_normalized_model_id');
  }
  if (!Array.isArray(providerModelNames)) {
    return llmMarketplaceFailure('invalid_provider_model_identity');
  }
  if (!providerModelNames.every(isProviderModelNameRecord)) {
    return llmMarketplaceFailure('invalid_provider_model_name');
  }
  const keys = providerModelNames.map((entry) => `${entry.provider}\u0000${entry.model}`);
  if (new Set(keys).size !== keys.length) {
    return llmMarketplaceFailure('duplicate_provider_model');
  }
  return llmMarketplaceOk(
    Object.freeze({
      normalizedModelId,
      providerModelNames: Object.freeze(
        providerModelNames.map((entry) =>
          Object.freeze({ provider: entry.provider, model: entry.model }),
        ),
      ),
    }),
  );
}

/** Shape guard cho `NormalizedModelIdentity` đọc từ storage/contract. */
export function isNormalizedModelIdentity(value: unknown): value is NormalizedModelIdentity {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { normalizedModelId?: unknown; providerModelNames?: unknown };
  if (!isNormalizedModelId(candidate.normalizedModelId)) {
    return false;
  }
  if (!Array.isArray(candidate.providerModelNames)) {
    return false;
  }
  if (!candidate.providerModelNames.every(isProviderModelNameRecord)) {
    return false;
  }
  const keys = candidate.providerModelNames.map(
    (entry: ProviderModelName) => `${entry.provider}\u0000${entry.model}`,
  );
  return new Set(keys).size === keys.length;
}

/**
 * Map `(provider, provider model name)` sang normalized identity.
 *
 * Đây là **phép tra thuần** trên danh sách identity do caller cấp, không phải
 * registry. Trả `invalid_provider_model_identity` khi input không hợp lệ và
 * `inconsistent_context` khi danh sách identity chứa phần tử hỏng hoặc một raw
 * identity xuất hiện ở nhiều identity — cả hai đều là dữ liệu cấu hình sai, và
 * đoán một identity trong trường hợp đó sẽ che mất lỗi dedup.
 */
export function mapProviderModelToNormalizedIdentity(
  identities: unknown,
  provider: unknown,
  model: unknown,
): LlmMarketplaceResult<NormalizedModelIdentity> {
  const raw = createProviderModelName(provider, model);
  if (!raw.ok) {
    return raw;
  }
  if (!Array.isArray(identities)) {
    return llmMarketplaceFailure('invalid_provider_model_identity');
  }
  if (!identities.every(isNormalizedModelIdentity)) {
    return llmMarketplaceFailure('invalid_provider_model_identity');
  }
  const matches = identities.filter((identity) =>
    identity.providerModelNames.some(
      (entry) => entry.provider === raw.value.provider && entry.model === raw.value.model,
    ),
  );
  if (matches.length === 0) {
    return llmMarketplaceFailure('invalid_provider_model_identity');
  }
  if (matches.length > 1) {
    return llmMarketplaceFailure('inconsistent_context');
  }
  return llmMarketplaceOk(matches[0]);
}

/**
 * Khẳng định một raw identity chưa được map sang identity khác.
 *
 * `existing` là tập identity hiện có của offer/seller; `candidate` là identity
 * đang được ghi. Trùng raw identity ở hai normalized identity là cấu hình
 * không thể dedup đúng, nên bị từ chối thay vì ghi đè.
 */
export function assertProviderModelNameUnique(
  existing: readonly NormalizedModelIdentity[],
  candidate: NormalizedModelIdentity,
): LlmMarketplaceResult<NormalizedModelIdentity> {
  if (!Array.isArray(existing) || !existing.every(isNormalizedModelIdentity)) {
    return llmMarketplaceFailure('invalid_provider_model_identity');
  }
  if (!isNormalizedModelIdentity(candidate)) {
    return llmMarketplaceFailure('invalid_provider_model_identity');
  }
  for (const identity of existing) {
    if (identity.normalizedModelId === candidate.normalizedModelId) {
      continue;
    }
    const collision = candidate.providerModelNames.some((entry) =>
      identity.providerModelNames.some(
        (other) => other.provider === entry.provider && other.model === entry.model,
      ),
    );
    if (collision) {
      return llmMarketplaceFailure('duplicate_provider_model');
    }
  }
  return llmMarketplaceOk(candidate);
}

/**
 * Chuẩn hoá một chuỗi thành hình dạng normalized model id.
 *
 * Hàm thuần, không giữ registry: lowercase, thay mọi cụm ký tự ngoài
 * `[a-z0-9._-]` bằng `-`, gộp `-` liên tiếp, bỏ `-` đầu/cuối, chặn ký tự đầu
 * không phải chữ-số. Trả `invalid_normalized_model_id` khi kết quả rỗng hoặc quá
 * dài.
 *
 * Caller vẫn phải quyết định identity cuối cùng: hai raw name khác nhau có thể
 * chuẩn hoá về cùng một chuỗi, và va chạm đó do `assertProviderModelNameUnique`
 * phát hiện ở biên ghi.
 */
export function normalizeModelId(value: unknown): LlmMarketplaceResult<string> {
  if (!isOpaqueLabel(value) || value.length > MAX_MODEL_NAME_LENGTH) {
    return llmMarketplaceFailure('invalid_normalized_model_id');
  }
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-._]+/u, '')
    .replace(/[-._]+$/u, '');
  if (!isNormalizedModelId(normalized)) {
    return llmMarketplaceFailure('invalid_normalized_model_id');
  }
  return llmMarketplaceOk(normalized);
}
