/**
 * Provider credential — hash-only, plaintext show-once.
 *
 * Source of truth: `docs/domains/llm-marketplace/domain-model.md` §1, §3.7, §4, §5.
 *
 * Ranh giới crypto: lib này **không** hash, **không** verify, **không** import
 * bất kỳ thư viện crypto nào. Domain nhận một **opaque hash** do caller cấp
 * (adapter tính bằng thuật toán của nó) và chỉ giữ hash đó. Việc chọn thuật
 * toán, salt và so khớp plaintext là trách nhiệm của caller. Vì vậy không có
 * `verifyCredential` trong public surface: một operation so sánh plaintext sẽ
 * biến domain thành nơi giữ thuật toán hash, điều lib này không làm.
 *
 * Bất biến:
 * - `credentialHash` không bao giờ được trả ngược ra ngoài cùng một lần tạo —
 *   `ProviderCredential` là bản ghi lưu, không phải kết quả tạo.
 * - Plaintext chỉ xuất hiện trong `CreatedProviderCredential.plaintext`, một
 *   object **không được lưu** và chỉ trả về đúng một lần từ `createProviderCredential`.
 * - Revoke là terminal và hiệu lực ngay: mọi operation dùng credential sau
 *   revoke trả `credential_revoked`.
 *
 * Hai trục scope tách biệt (ADR-0027 §8):
 * - **Trục upstream** — `provider` là khoá upstream API provider; credential của
 *   provider A không dùng được cho endpoint của provider B.
 * - **Trục sở hữu** — `sellerTenantId` là Seller tenant **sở hữu** credential;
 *   chỉ serving path của đúng tenant đó được dùng nó. Hai Seller tenant dùng
 *   cùng upstream provider vẫn có hai credential độc lập — cùng `provider`
 *   không tạo quyền dùng chung, và không có lookup credential theo `provider`
 *   xuyên tenant (không API nào như vậy ở public surface).
 */

import {
  isEpochMillis,
  isOpaqueLabel,
  isProviderCredentialId,
  isSellerActorId,
  isSellerTenantId,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  MAX_CREDENTIAL_HASH_LENGTH,
  MAX_CREDENTIAL_PLAINTEXT_LENGTH,
  type LlmMarketplaceResult,
  type ProviderCredentialId,
  type SellerActorId,
  type SellerTenantId,
} from './shared';
import { isProviderKey } from './model-identity';

/**
 * Hash opaque của credential.
 *
 * Domain không biết thuật toán: chỉ validate hình dạng. Giá trị phải là chuỗi
 * in được, không whitespace đầu/cuối, không rỗng, ≤ 512 ký tự. Domain **không**
 * kiểm entropy hay prefix thuật toán — đó là việc của adapter.
 */
export function isCredentialHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CREDENTIAL_HASH_LENGTH &&
    value.trim() === value &&
    !/\s/u.test(value)
  );
}

/**
 * Plaintext tại biên tạo.
 *
 * Chỉ được đọc một lần để trả cho caller; không được lưu vào `ProviderCredential`
 * và không được nằm trong bất kỳ error object nào. Guard ở đây chỉ chặn giá trị
 * rỗng/quá dài; domain không đánh giá độ mạnh mật khẩu.
 */
export function isCredentialPlaintext(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_CREDENTIAL_PLAINTEXT_LENGTH
  );
}

/**
 * Provider credential đã lưu — **không có plaintext**.
 *
 * `revokedAt === null` nghĩa là đang active; khác `null` nghĩa là đã revoke và
 * không bao giờ active lại.
 */
export interface ProviderCredential {
  readonly id: ProviderCredentialId;
  readonly provider: string;
  /**
   * Seller tenant **sở hữu** credential (ADR-0027 §8; marketplace §3.7).
   * `createdBy` chỉ là audit của actor tạo, không phải sở hữu.
   */
  readonly sellerTenantId: SellerTenantId;
  /** Hash opaque do caller cấp. Domain không hash và không so khớp. */
  readonly credentialHash: string;
  readonly createdBy: SellerActorId;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly revokedBy: SellerActorId | null;
}

/**
 * Kết quả tạo credential — **show-once**.
 *
 * `plaintext` chỉ tồn tại trong object này. Nó không nằm trong `credential`, nên
 * adapter lưu `credential` sẽ không lưu plaintext kể cả khi serialize cả object
 * kết quả — nhưng adapter vẫn phải không lưu cả object này. Domain không chặn
 * được `JSON.stringify`/interpolation trên object trả về; việc không log
 * plaintext là trách nhiệm của caller (xem `docs/domains/llm-marketplace/domain-model.md` §3.5).
 */
export interface CreatedProviderCredential {
  readonly credential: ProviderCredential;
  readonly plaintext: string;
}

/** Input tạo provider credential. */
export interface CreateProviderCredentialInput {
  readonly id: unknown;
  readonly provider: unknown;
  /** Seller tenant sở hữu credential — bắt buộc, ADR-0027 §8. */
  readonly sellerTenantId: unknown;
  readonly credentialHash: unknown;
  readonly plaintext: unknown;
  readonly createdBy: unknown;
  readonly createdAt: unknown;
  /** Credential đã có — dùng cho guard trùng `id`. */
  readonly existing?: readonly ProviderCredential[];
}

/**
 * Tạo provider credential.
 *
 * Guard:
 * - `id`, `provider`, `sellerTenantId`, `createdBy`, `createdAt` hợp lệ.
 * - `credentialHash` qua `isCredentialHash`.
 * - `plaintext` qua `isCredentialPlaintext` — plaintext rỗng là lỗi lập trình ở
 *   caller, không được tạo credential không có secret.
 * - `existing` (nếu cấp) mọi phần tử hợp lệ, không trùng `id`.
 *
 * Trả `CreatedProviderCredential`: bản ghi lưu cộng plaintext một lần. Seed ghi
 * owning tenant (`sellerTenantId`) cùng lúc với việc tạo credential (ADR-0027 §8).
 */
export function createProviderCredential(
  input: CreateProviderCredentialInput,
): LlmMarketplaceResult<CreatedProviderCredential> {
  if (!isProviderCredentialId(input.id)) {
    return llmMarketplaceFailure('invalid_provider_credential_id');
  }
  if (!isProviderKey(input.provider)) {
    return llmMarketplaceFailure('invalid_provider_key');
  }
  if (!isSellerTenantId(input.sellerTenantId)) {
    return llmMarketplaceFailure('invalid_seller_tenant_id');
  }
  if (!isCredentialHash(input.credentialHash)) {
    return llmMarketplaceFailure('invalid_credential_hash');
  }
  if (!isCredentialPlaintext(input.plaintext)) {
    return llmMarketplaceFailure('invalid_credential_plaintext');
  }
  if (!isSellerActorId(input.createdBy)) {
    return llmMarketplaceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmMarketplaceFailure('ambiguous_context');
  }
  if (!existing.every(isProviderCredential)) {
    return llmMarketplaceFailure('invalid_provider_credential');
  }
  if (existing.some((credential) => credential.id === input.id)) {
    return llmMarketplaceFailure('duplicate_provider_credential_id');
  }
  const credential: ProviderCredential = Object.freeze({
    id: input.id,
    provider: input.provider,
    sellerTenantId: input.sellerTenantId,
    credentialHash: input.credentialHash,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    revokedAt: null,
    revokedBy: null,
  });
  return llmMarketplaceOk(Object.freeze({ credential, plaintext: input.plaintext }));
}

/** Input revoke credential. */
export interface RevokeProviderCredentialInput {
  readonly credential: ProviderCredential;
  readonly revokedBy: unknown;
  readonly revokedAt: unknown;
}

/**
 * Revoke credential — terminal và hiệu lực ngay.
 *
 * Guard:
 * - `credential` hợp lệ; `revokedBy`/`revokedAt` hợp lệ.
 * - Credential đã revoke trả `credential_already_revoked`: không ghi đè thời
 *   điểm revoke, vì đó là dữ liệu audit.
 * - `revokedAt >= createdAt` (`timestamp_regression`).
 *
 * Không có operation "un-revoke": credential đã revoke vĩnh viễn, muốn dùng lại
 * provider phải tạo credential mới với `id` mới.
 */
export function revokeProviderCredential(
  input: RevokeProviderCredentialInput,
): LlmMarketplaceResult<ProviderCredential> {
  if (!isProviderCredential(input.credential)) {
    return llmMarketplaceFailure('invalid_provider_credential');
  }
  if (!isSellerActorId(input.revokedBy)) {
    return llmMarketplaceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.revokedAt)) {
    return llmMarketplaceFailure('invalid_timestamp');
  }
  if (input.credential.revokedAt !== null) {
    return llmMarketplaceFailure('credential_already_revoked');
  }
  if (input.revokedAt < input.credential.createdAt) {
    return llmMarketplaceFailure('timestamp_regression');
  }
  return llmMarketplaceOk(
    Object.freeze({
      ...input.credential,
      revokedAt: input.revokedAt,
      revokedBy: input.revokedBy,
    }),
  );
}

/** Credential còn dùng được không: chưa revoke. */
export function isProviderCredentialActive(credential: ProviderCredential): boolean {
  return (
    isProviderCredential(credential) &&
    credential.revokedAt === null &&
    credential.revokedBy === null
  );
}

/**
 * Khẳng định credential dùng được cho đúng provider **và** đúng Seller tenant
 * sở hữu, ở trạng thái chưa revoke.
 *
 * Đây là **scope validation**, không phải authentication, với hai trục độc lập
 * fail-closed (ADR-0027 §8; marketplace §3.7):
 * - Trục upstream: credential của provider A không dùng được cho provider B
 *   (`credential_provider_mismatch`).
 * - Trục sở hữu: credential của Seller tenant A không dùng được cho serving
 *   path của Seller tenant B (`credential_tenant_mismatch`) — tenant đối chiếu
 *   là `sellerTenantId` của offer đang phục vụ, không phải input client.
 *
 * Thứ tự kiểm cố định để không tiết lộ trạng thái của credential không thuộc
 * phạm vi caller: provider trước, sở hữu sau, revoke cuối cùng — lệch provider
 * và lệch tenant đều che trạng thái revoke (đã revoke hay chưa là dữ liệu nội
 * bộ của credential mà caller sai scope không được đọc).
 */
export function assertCredentialProvider(
  credential: ProviderCredential,
  provider: unknown,
  sellerTenantId: unknown,
): LlmMarketplaceResult<ProviderCredential> {
  if (!isProviderCredential(credential)) {
    return llmMarketplaceFailure('invalid_provider_credential');
  }
  if (!isProviderKey(provider)) {
    return llmMarketplaceFailure('invalid_provider_key');
  }
  if (!isSellerTenantId(sellerTenantId)) {
    return llmMarketplaceFailure('invalid_seller_tenant_id');
  }
  if (credential.provider !== provider) {
    return llmMarketplaceFailure('credential_provider_mismatch');
  }
  if (credential.sellerTenantId !== sellerTenantId) {
    return llmMarketplaceFailure('credential_tenant_mismatch');
  }
  if (!isProviderCredentialActive(credential)) {
    return llmMarketplaceFailure('credential_revoked');
  }
  return llmMarketplaceOk(credential);
}

/**
 * Shape guard cho `ProviderCredential` đọc từ storage/contract.
 *
 * Adapter phải gọi trước khi dùng credential cho scope validation. Không có
 * cách nào lấy plaintext từ bản ghi này — nếu shape chứa field lạ, guard vẫn
 * chấp nhận object thừa field nhưng domain không bao giờ đọc chúng.
 */
export function isProviderCredential(value: unknown): value is ProviderCredential {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof ProviderCredential, unknown>>;
  if (
    !isProviderCredentialId(candidate.id) ||
    !isProviderKey(candidate.provider) ||
    !isSellerTenantId(candidate.sellerTenantId) ||
    !isCredentialHash(candidate.credentialHash) ||
    !isSellerActorId(candidate.createdBy) ||
    !isEpochMillis(candidate.createdAt)
  ) {
    return false;
  }
  if (candidate.revokedAt === null) {
    return candidate.revokedBy === null;
  }
  return (
    isEpochMillis(candidate.revokedAt) &&
    candidate.revokedAt >= candidate.createdAt &&
    isSellerActorId(candidate.revokedBy)
  );
}

/**
 * Chiếu credential sang public projection: **không có hash**.
 *
 * Không có đường nào để metadata credential đi ra contract/UI mà mang hash, kể
 * cả hash opaque. Projection được liệt kê từng field, không dùng spread: thêm
 * field nội bộ vào `ProviderCredential` không được tự động rò rỉ qua đây.
 */
export interface PublicProviderCredential {
  readonly id: ProviderCredentialId;
  readonly provider: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

/** Chiếu credential sang dạng công bố được. */
export function toPublicProviderCredential(
  credential: ProviderCredential,
): PublicProviderCredential {
  if (!isProviderCredential(credential)) {
    // Projection không có result type: record hỏng là lỗi lập trình ở caller,
    // nhưng vẫn phải từ chối rõ ràng thay vì trả object thiếu field.
    throw new TypeError('toPublicProviderCredential: provider credential is not valid.');
  }
  return Object.freeze({
    id: credential.id,
    provider: credential.provider,
    createdAt: credential.createdAt,
    revokedAt: credential.revokedAt,
  });
}

/** Tên field nội bộ không được có mặt trong projection công bố. */
export const PROVIDER_CREDENTIAL_INTERNAL_FIELDS: readonly string[] = Object.freeze([
  'credentialHash',
  'sellerTenantId',
  'createdBy',
  'revokedBy',
  'plaintext',
]);

/** `true` khi object không mang field nội bộ nào (dùng ở test/contract guard). */
export function isPublicProviderCredentialShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return PROVIDER_CREDENTIAL_INTERNAL_FIELDS.every(
    (field) => !Object.hasOwn(value as Record<string, unknown>, field),
  );
}

/**
 * Type guard cho `isOpaqueLabel` được tái xuất ở module này để consumer không
 * phải import hai module chỉ để validate label cùng credential.
 */
export const isCredentialLabel = isOpaqueLabel;
