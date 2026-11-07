/**
 * Value object `Subject` — định danh ổn định của một người dùng trong hệ thống.
 *
 * ⚠️ **`sub` không tái sử dụng, không tái phát hành** (invariant 7 của
 * `docs/applications/account/01-architecture.md`). Xoá account KHÔNG giải phóng `sub`:
 * tombstone giữ `sub` để token cũ không resolve nhầm sang người khác. Vì vậy
 * entropy sinh ở đây phải đủ lớn để việc đoán là không thực tế, và caller phải
 * truyền vào entropy do CSPRNG sinh — thư viện này không tự sinh (xem
 * `createSubject`).
 *
 * Library này thuần TypeScript: không SQL, không Node builtin, không I/O. Entropy
 * do caller cung cấp và được kiểm tra tại đây.
 */

/** Prefix bắt buộc, giúp phân biệt `sub` với các định danh khác trong log. */
const SUBJECT_PREFIX = 'sub_';

/** Số ký tự base32 của phần entropy — 32 × 5 bit = 160 bit. */
const SUBJECT_ENTROPY_LENGTH = 32;

/**
 * Alphabet base32 chuẩn RFC 4648, viết thường, không padding. Chữ thường bắt buộc
 * để `sub` không phụ thuộc case-folding khi đi qua header, log hay storage.
 */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Brand ở mức type: hai `Subject` chỉ tương đương khi cùng chuỗi. */
declare const subjectBrand: unique symbol;

/** Opaque value object — không có constructor public, chỉ qua `createSubject`. */
export type Subject = string & { readonly [subjectBrand]?: true };

/** Regex đầy đủ cho một `sub` hợp lệ. */
const SUBJECT_PATTERN = new RegExp(
  `^${SUBJECT_PREFIX}[${BASE32_ALPHABET}]{${SUBJECT_ENTROPY_LENGTH}}$`,
  'u',
);

/**
 * Kiểm tra một chuỗi bất kỳ có phải `Subject` hợp lệ không.
 *
 * Dùng khi đọc `sub` từ nguồn bên ngoài (DB, contract) — nơi giá trị đã đi qua
 * serialization nên không còn giữ brand.
 */
export function isSubject(value: unknown): value is Subject {
  return typeof value === 'string' && SUBJECT_PATTERN.test(value);
}

/**
 * Tạo `Subject` mới từ entropy do caller sinh.
 *
 * @param entropy Chuỗi base32 viết thường, đúng {@link SUBJECT_ENTROPY_LENGTH} ký tự.
 *   Caller lấy từ CSPRNG (`crypto.getRandomValues`) rồi encode base32 — thư viện này
 *   không tự sinh entropy để giữ ranh giới "không I/O" của tầng domain.
 *
 * @throws TypeError nếu entropy sai kiểu hoặc sai định dạng.
 *
 * ⚠️ Không có đường nào trong API này nhận lại một `sub` cũ để tái phát hành: caller
 * muốn sinh `Subject` mới thì gọi hàm này, còn tái sử dụng `sub` cũ là vi phạm
 * invariant 7 và không có API nào cho phép.
 */
export function createSubject(entropy: string): Subject {
  if (typeof entropy !== 'string') {
    throw new TypeError('Subject entropy phải là chuỗi.');
  }
  if (!SUBJECT_PATTERN.test(`${SUBJECT_PREFIX}${entropy}`)) {
    throw new TypeError(
      `Subject entropy phải là ${SUBJECT_ENTROPY_LENGTH} ký tự base32 viết thường (${BASE32_ALPHABET}).`,
    );
  }
  return `${SUBJECT_PREFIX}${entropy}` as Subject;
}

/**
 * Lấy phần entropy của `sub` (bỏ prefix).
 *
 * Chỉ phục vụ log/audit chẩn đoán — entropy tự nó KHÔNG phải bí mật và không được
 * dùng làm credential.
 */
export function subjectEntropy(subject: Subject): string {
  return subject.slice(SUBJECT_PREFIX.length);
}
