/**
 * Value object `BackofficeAccountId` — Account ID (`sub`) của một staff member,
 * tức **reference** xuyên service mà `backoffice` giữ để nối staff entry sang
 * hồ sơ danh tính của `account`.
 *
 * Source of truth:
 * - `docs/domains/staff-access/domain-model.md` §3, §4.1: một staff member
 *   gắn đúng một Account ID; Account ID là **reference**, không FK xuyên
 *   database; **email KHÔNG phải primary identity key**.
 * - `docs/architecture/01-architecture.md` §4 và invariant 7: danh tính xuyên
 *   service là `sub`, không tái sử dụng, không tái phát hành.
 *
 * ⚠️ **Tự viết, không import `@ecoma-io/account-domain`.** Hình thức giống
 * `Subject` của account-domain (prefix + base32 + entropy) và **cùng một con số
 * entropy** — đó là yêu cầu, không phải trùng hợp (xem chú thích của
 * {@link BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS}). Ranh giới phụ thuộc là quy tắc
 * module-boundary (một BC không import implementation của BC khác —
 * `docs/architecture/05-code-architecture.md` §3), nên lib này khai báo riêng
 * định danh mà nó sở hữu; test `account-id.spec.ts` ghim hai bên bằng cách đọc
 * file nguồn của producer, không bằng cạnh import.
 *
 * Mức entropy: định danh này **không** phải định danh do `backoffice` phát hành
 * mà là **reference tới Account ID (`sub`) mà `account` cấp** — nên ngưỡng của nó
 * là ngưỡng của producer thật, tức 32 ký tự / 160 bit của `Subject`
 * (`libs/account-domain/src/subject.ts`). Một định danh local 52 ký tự từng được
 * khai báo ở đây (260 bit, "> 256 bit" cho một định danh tự sinh) là **bug**: giá
 * trị đó phá chính invariant mà file này mô tả — một `sub` thật do `account` cấp
 * không qua được {@link isBackofficeAccountId}, tức 503 fail-closed vĩnh viễn khi
 * auth token thật được wire (finding F1, issue #101). Ngưỡng ≥ 256 bit chỉ đúng
 * cho định danh sinh local; tham chiếu không sinh thì không có ngưỡng riêng.
 */

/** Prefix bắt buộc, giúp phân biệt `sub` với các định danh khác trong log. */
const ACCOUNT_ID_PREFIX = 'sub_';

/**
 * Số ký tự base32 của phần entropy — ghim bằng producer thật của giá trị này.
 *
 * Định danh `backoffice` giữ KHÔNG phải định danh tự sinh của BC này mà là
 * reference tới Account ID (`sub`) mà `account` cấp qua `Subject`
 * (`libs/account-domain/src/subject.ts`): 32 ký tự base32 = 160 bit. Định danh
 * consumer dùng con số của producer, không tự khai số khác — lệch số là mọi `sub`
 * thật bị {@link isBackofficeAccountId} từ chối (F1, issue #101). 52 ký tự cũ
 * (260 bit) tuy vượt ngưỡng của producer nhưng phủ định invariant
 * "định danh này là reference tới `sub` của `account`".
 *
 * Hằng được test ghim ở hai đầu: bài test ở đây ghim giá trị + ngưỡng, và
 * `accepts-subjects-issued-by-account-domain` đọc file nguồn producer để ĐO
 * hằng đó với `SUBJECT_ENTROPY_LENGTH` thật — hai lib đổi số phải đỏ ở ít nhất
 * một bên trước khi merge.
 */
export const BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS = 32;

/**
 * Ngưỡng entropy tối thiểu theo bit — theo **producer** của giá trị này.
 *
 * 32 ký tự × 5 bit = 160 bit, khớp `Subject` của `account`. Con số 256 bit từng
 * nằm ở đây là ngưỡng của một định danh **tự sinh**; `backoffice` không tự sinh
 * `sub` (đó là invariant của `account`), nên ngưỡng của nó là ngưỡng của producer.
 * Hằng độc lập để test so khớp hai bên riêng — đừng suy "ENTROPY_CHARS × 5 ≥
 * MIN_BITS" trong code thư viện gọi.
 */
export const BACKOFFICE_ACCOUNT_ID_MIN_ENTROPY_BITS = 160;

/**
 * Alphabet base32 chuẩn RFC 4648, viết thường, không padding. Chữ thường bắt
 * buộc để `sub` không phụ thuộc case-folding khi đi qua header, log hay storage.
 */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Brand ở mức type: hai `BackofficeAccountId` chỉ tương đương khi cùng chuỗi. */
declare const accountIdBrand: unique symbol;

/** Opaque value object — không có constructor public, chỉ qua `createBackofficeAccountId`. */
export type BackofficeAccountId = string & { readonly [accountIdBrand]?: true };

/** Prefix của `BackofficeAccountId` — phơi ra để consumer dùng trong log/audit. */
export const BACKOFFICE_ACCOUNT_ID_PREFIX = ACCOUNT_ID_PREFIX;

/** Regex đầy đủ cho một `BackofficeAccountId` hợp lệ. */
const ACCOUNT_ID_PATTERN = new RegExp(
  `^${ACCOUNT_ID_PREFIX}[${BASE32_ALPHABET}]{${BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS}}$`,
  'u',
);

/**
 * Số bit mà {@link BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS} đạt tới — tiện cho log chẩn đoán và để test ghim ngưỡng trực tiếp.
 */
export const BACKOFFICE_ACCOUNT_ID_ENTROPY_BITS = BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS * 5;

/**
 * Kiểm tra một chuỗi bất kỳ có phải `BackofficeAccountId` hợp lệ không.
 *
 * Dùng khi đọc `sub` từ nguồn bên ngoài (token claim, DB, contract) — nơi giá
 * trị đã đi qua serialization nên không còn giữ brand.
 */
export function isBackofficeAccountId(value: unknown): value is BackofficeAccountId {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value);
}

/**
 * Tạo `BackofficeAccountId` mới từ entropy do caller sinh.
 *
 * @param entropy Chuỗi base32 viết thường, đúng
 *   {@link BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS} ký tự. Caller lấy từ CSPRNG
 *   (`crypto.getRandomValues`) rồi encode base32 — thư viện này không tự sinh
 *   entropy để giữ ranh giới "không I/O" của tầng domain.
 *
 * @throws TypeError nếu entropy sai kiểu hoặc sai định dạng.
 *
 * ⚠️ Không có đường nào trong API này nhận lại một `sub` cũ để tái phát hành:
 * caller muốn sinh ID mới thì gọi hàm này, còn tái sử dụng `sub` cũ cho staff
 * khác là vi phạm §4.1 (mapping 1:1, không tái phát hành) và không có API nào
 * cho phép.
 */
export function createBackofficeAccountId(entropy: string): BackofficeAccountId {
  if (typeof entropy !== 'string') {
    throw new TypeError('BackofficeAccountId entropy phải là chuỗi');
  }
  const full = `${ACCOUNT_ID_PREFIX}${entropy}`;
  if (!ACCOUNT_ID_PATTERN.test(full)) {
    throw new TypeError(
      `BackofficeAccountId entropy phải là ${BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS} ký tự base32 viết thường (${BASE32_ALPHABET})`,
    );
  }
  return full as BackofficeAccountId;
}

/**
 * Lấy phần entropy của `BackofficeAccountId` (bỏ prefix).
 *
 * Chỉ phục vụ chẩn đoán — entropy tự nó KHÔNG phải bí mật; `sub` ở đây là
 * reference của account do `account` cấp, không phải credential.
 */
export function backofficeAccountIdEntropy(accountId: BackofficeAccountId): string {
  return accountId.slice(ACCOUNT_ID_PREFIX.length);
}
