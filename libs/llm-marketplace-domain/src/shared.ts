/**
 * Kiến trúc dùng chung của domain library `llm-marketplace`.
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào —
 * domain không đọc đồng hồ (`Date.now()`), không parse RFC 3339, không sinh số
 * ngẫu nhiên. Mọi hàm là thuần: không sửa input, không giữ state, và trả result
 * (`ok`/`error`) thay vì ném exception cho dữ liệu đầu vào hỏng.
 *
 * Runtime string (error message) viết bằng ENGLISH theo language policy của repo.
 */

import {
  llmMarketplaceDomainError,
  type LlmMarketplaceDomainError,
  type LlmMarketplaceDomainErrorCode,
} from './errors';

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------

/** Nhánh thành công: mang giá trị đã validate. */
export interface LlmMarketplaceOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface LlmMarketplaceFailure {
  readonly ok: false;
  readonly error: LlmMarketplaceDomainError;
}

/** Kết quả của một operation domain. */
export type LlmMarketplaceResult<Value> = LlmMarketplaceOk<Value> | LlmMarketplaceFailure;

/** Dựng nhánh thành công. */
export function llmMarketplaceOk<Value>(value: Value): LlmMarketplaceResult<Value> {
  return Object.freeze({ ok: true, value });
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy. */
export function llmMarketplaceFailure<Value = never>(
  code: LlmMarketplaceDomainErrorCode,
): LlmMarketplaceResult<Value> {
  return Object.freeze({ ok: false, error: llmMarketplaceDomainError(code) });
}

// ---------------------------------------------------------------------------
// Định danh
// ---------------------------------------------------------------------------

/**
 * `sub` — Account ID do `account` phát hành, chỉ lấy từ verified authentication
 * context. Tham chiếu opaque, không FK xuyên database.
 */
declare const sellerActorBrand: unique symbol;

/** Account ID (`sub`) đã qua validate. */
export type SellerActorId = string & { readonly [sellerActorBrand]?: true };

/**
 * Định danh Seller tenant.
 *
 * Library này **không** import `llm-seller-*`: đây là bản khai báo tại biên của
 * giá trị tham chiếu mà `llm-marketplace` nhận từ contract. Brand khác với
 * brand của `llm-seller-*` là chủ ý — hai library không dùng chung type, chỉ
 * dùng chung *giá trị* chuỗi opaque.
 */
declare const sellerTenantIdBrand: unique symbol;

/** Định danh Seller tenant. */
export type SellerTenantId = string & { readonly [sellerTenantIdBrand]?: true };

declare const modelOfferIdBrand: unique symbol;

/** Định danh model offer. */
export type ModelOfferId = string & { readonly [modelOfferIdBrand]?: true };

declare const upstreamEndpointIdBrand: unique symbol;

/** Định danh upstream endpoint. */
export type UpstreamEndpointId = string & { readonly [upstreamEndpointIdBrand]?: true };

declare const endpointPoolIdBrand: unique symbol;

/** Định danh endpoint pool. */
export type EndpointPoolId = string & { readonly [endpointPoolIdBrand]?: true };

declare const providerCredentialIdBrand: unique symbol;

/** Định danh provider credential. */
export type ProviderCredentialId = string & { readonly [providerCredentialIdBrand]?: true };

/** Độ dài tối đa của mọi định danh opaque để chặn payload bất thường từ input. */
export const MAX_OPAQUE_ID_LENGTH = 200;

/** Độ dài tối đa của URL upstream endpoint. */
export const MAX_ENDPOINT_URL_LENGTH = 2048;

/** Độ dài tối đa của provider model name (raw identity). */
export const MAX_MODEL_NAME_LENGTH = 200;

/** Độ dài tối đa của public alias. */
export const MAX_PUBLIC_ALIAS_LENGTH = 200;

/** Độ dài tối đa của provider key. */
export const MAX_PROVIDER_KEY_LENGTH = 64;

/** Độ dài tối đa của endpoint protocol label. */
export const MAX_ENDPOINT_PROTOCOL_LENGTH = 64;

/** Độ dài tối đa của credential hash (opaque với domain). */
export const MAX_CREDENTIAL_HASH_LENGTH = 512;

/** Độ dài tối đa của credential plaintext tại biên tạo. */
export const MAX_CREDENTIAL_PLAINTEXT_LENGTH = 4096;

/** Trọng số tối đa của một upstream endpoint. */
export const MAX_ENDPOINT_WEIGHT = 1000;

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

/**
 * Opaque label (blocker, protocol, ...).
 *
 * Đây là **dữ liệu cấu hình** do caller cấp, không phải enum của lib. Lib
 * validate hình dạng, không liệt kê giá trị hợp lệ.
 */
export function isOpaqueLabel(value: unknown): value is string {
  return isOpaqueId(value);
}

/** Type guard cho `SellerActorId` — dùng khi đọc `sub` từ token/DB/contract. */
export function isSellerActorId(value: unknown): value is SellerActorId {
  return isOpaqueId(value);
}

/** Type guard cho `SellerTenantId`. */
export function isSellerTenantId(value: unknown): value is SellerTenantId {
  return isOpaqueId(value);
}

/** Type guard cho `ModelOfferId`. */
export function isModelOfferId(value: unknown): value is ModelOfferId {
  return isOpaqueId(value);
}

/** Type guard cho `UpstreamEndpointId`. */
export function isUpstreamEndpointId(value: unknown): value is UpstreamEndpointId {
  return isOpaqueId(value);
}

/** Type guard cho `EndpointPoolId`. */
export function isEndpointPoolId(value: unknown): value is EndpointPoolId {
  return isOpaqueId(value);
}

/** Type guard cho `ProviderCredentialId`. */
export function isProviderCredentialId(value: unknown): value is ProviderCredentialId {
  return isOpaqueId(value);
}

/**
 * Dựng `SellerActorId` từ giá trị đã verify.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createSellerActorId(value: string): SellerActorId {
  if (!isSellerActorId(value)) {
    throw new TypeError('Seller actor ID is not valid.');
  }
  return value;
}

/** Dựng `SellerTenantId`. @throws TypeError khi giá trị không hợp lệ. */
export function createSellerTenantId(value: string): SellerTenantId {
  if (!isSellerTenantId(value)) {
    throw new TypeError('Seller tenant ID is not valid.');
  }
  return value;
}

/** Dựng `ModelOfferId`. @throws TypeError khi giá trị không hợp lệ. */
export function createModelOfferId(value: string): ModelOfferId {
  if (!isModelOfferId(value)) {
    throw new TypeError('Model offer ID is not valid.');
  }
  return value;
}

/** Dựng `UpstreamEndpointId`. @throws TypeError khi giá trị không hợp lệ. */
export function createUpstreamEndpointId(value: string): UpstreamEndpointId {
  if (!isUpstreamEndpointId(value)) {
    throw new TypeError('Upstream endpoint ID is not valid.');
  }
  return value;
}

/** Dựng `EndpointPoolId`. @throws TypeError khi giá trị không hợp lệ. */
export function createEndpointPoolId(value: string): EndpointPoolId {
  if (!isEndpointPoolId(value)) {
    throw new TypeError('Endpoint pool ID is not valid.');
  }
  return value;
}

/** Dựng `ProviderCredentialId`. @throws TypeError khi giá trị không hợp lệ. */
export function createProviderCredentialId(value: string): ProviderCredentialId {
  if (!isProviderCredentialId(value)) {
    throw new TypeError('Provider credential ID is not valid.');
  }
  return value;
}

/**
 * Timestamp epoch millis hợp lệ: số nguyên an toàn, không âm.
 *
 * Mọi field thời gian của domain (offer, endpoint health, credential) đều là mốc
 * tuyệt đối, nên giá trị âm không biểu diễn thời điểm nào. Chấp nhận nó sẽ làm
 * guard thứ tự (`activatedAt < updatedAt`) và audit trail so sánh trên dữ liệu
 * không có nghĩa.
 */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
