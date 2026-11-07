/**
 * Contract `GET /internal/account/profiles?subs=<sub1,sub2,...>` — provider
 * `account`, consumer `backoffice` (issue #325, giai đoạn 1).
 *
 * Trả `displayName` theo batch cho một tập `sub` được hỏi rõ. Điểm khác với
 * contract `status`: ở đây response **có** mang dữ liệu hồ sơ (tên hiển thị),
 * nhưng chỉ cho những `sub` caller hỏi — server không bao giờ trả "tất cả
 * profile" hay cho phép liệt kê dò. Trần 100 `sub` mỗi request chặn một caller
 * biến contract này thành đường tải toàn bộ danh sách người dùng.
 *
 * `displayName: null` là một giá trị hợp lệ mang ý nghĩa nghiệp vụ ("chưa đặt
 * tên"), không phải lỗi — giống cách `not_found` của contract `status` là giá
 * trị chứ không phải HTTP 404.
 */

/** Trần số `sub` tối đa trong một request batch. */
export const ACCOUNT_PROFILES_MAX_SUBS = 100;

/**
 * Trần độ dài `displayName` mà validator chấp nhận — mirror app-level
 * `DISPLAY_NAME_MAX_LENGTH` của `apps/account` (200).
 *
 * Giống `authn_level` ở barrel: contract khai báo lại ràng buộc wire thay vì
 * import tầng app, để consumer có hàng rào hình thức mà không kéo phụ thuộc
 * `type:domain`/`type:application` (bị cấm với `type:contracts`).
 */
export const ACCOUNT_PROFILES_DISPLAY_NAME_MAX_LENGTH = 200;

/** Một mục profile trong response — `displayName: null` = sub đó chưa đặt tên. */
export interface AccountProfileEntry {
  readonly sub: string;
  readonly displayName: string | null;
}

/** Thân response — chỉ có đúng một trường `profiles`. */
export interface AccountProfilesResponse {
  readonly profiles: readonly AccountProfileEntry[];
}

/**
 * Nhóm trường hồ sơ mà một entry bị cấm mang — response của contract này chỉ
 * được có tên hiển thị, không hơn. Nếu account thêm email/avatar vào entry thì
 * đó là rò dữ liệu vượt contract và phải bị consumer từ chối ngay.
 */
export const FORBIDDEN_ACCOUNT_PROFILE_ENTRY_FIELDS = [
  'email',
  'avatar_url',
  'display_name',
  'name',
  'locale',
  'timezone',
  'status',
  'created_at',
] as const;

/** Lý do từ chối response. */
export type AccountProfilesRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'oversized_batch';

/** Kết quả validate — discriminated union. */
export type AccountProfilesValidation =
  | { readonly ok: true; readonly payload: AccountProfilesResponse }
  | {
      readonly ok: false;
      readonly reason: AccountProfilesRejectionReason;
      readonly detail: string;
    };

/** Kiểm tra một entry có đúng hình `{sub, displayName}` không. */
export function isAccountProfileEntry(value: unknown): value is AccountProfileEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('sub') || !keys.includes('displayName')) {
    return false;
  }
  if (typeof record.sub !== 'string' || record.sub.length === 0) {
    return false;
  }
  if (record.displayName === null) {
    return true;
  }
  return (
    typeof record.displayName === 'string' &&
    record.displayName.length > 0 &&
    record.displayName.length <= ACCOUNT_PROFILES_DISPLAY_NAME_MAX_LENGTH
  );
}

/**
 * Validate response của `GET /internal/account/profiles`.
 *
 * Chặn từng entry trước, rồi chặn ceiling batch: một response vượt 100 mục là
 * server đã phá trần contract, consumer không được tin.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateAccountProfilesResponse(payload: unknown): AccountProfilesValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'profiles') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }

  if (!Array.isArray(record.profiles)) {
    return { ok: false, reason: 'invalid_payload', detail: 'profiles must be an array.' };
  }

  if (record.profiles.length > ACCOUNT_PROFILES_MAX_SUBS) {
    return {
      ok: false,
      reason: 'oversized_batch',
      detail: `profiles exceeds the batch ceiling of ${ACCOUNT_PROFILES_MAX_SUBS} entries.`,
    };
  }

  for (const entry of record.profiles) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const entryRecord = entry as Record<string, unknown>;
      for (const field of FORBIDDEN_ACCOUNT_PROFILE_ENTRY_FIELDS) {
        if (field in entryRecord) {
          return {
            ok: false,
            reason: 'invalid_entry',
            detail: `Profile entry carries a forbidden field: ${field}.`,
          };
        }
      }
    }
    if (!isAccountProfileEntry(entry)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: 'Profile entry must be {sub: string, displayName: string | null}.',
      };
    }
  }

  return { ok: true, payload: { profiles: record.profiles as readonly AccountProfileEntry[] } };
}

/**
 * Dựng response hợp lệ từ các dòng DB.
 *
 * Một chỗ dựng duy nhất: endpoint account không được ghép response bằng tay,
 * nên không có đường nào lọt trường ngoài contract qua mắt validator.
 */
export function accountProfilesResponse(
  entries: ReadonlyArray<{ readonly sub: string; readonly displayName: string | null }>,
): AccountProfilesResponse {
  return { profiles: entries.map((entry) => ({ sub: entry.sub, displayName: entry.displayName })) };
}

/**
 * Khử trùng lặp danh sách `sub` của request, giữ thứ tự xuất hiện đầu tiên.
 *
 * Caller (endpoint account lẫn BFF) dùng hàm này thay vì tự viết `Set`, để
 * dedupe — có tính đến trần batch sau khi khử — thống nhất ở cả hai phía.
 */
export function dedupeProfileSubs(subs: readonly string[]): string[] {
  return [...new Set(subs)];
}
