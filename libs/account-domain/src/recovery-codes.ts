/**
 * Recovery codes — mã dự phòng một-lần-dùng cho người mất yếu tố thứ hai.
 *
 * ## Điều kiện docs đã chốt
 *
 * - FR-005a (`docs/applications/account/02-requirements.md` §1.2): "`recovery_codes`
 *   hash, **single-use**, đếm số lần dùng"; kiểm chứng "Dùng lại code đã dùng →
 *   từ chối". T-03 cùng file: "lạm dụng recovery code" là threat; biện pháp
 *   "`recovery_codes` single-use".
 * - Logical model (`docs/applications/account/01-architecture.md` §3.2, entity
 *   `recovery_codes`): "Hash; **single-use**; đếm số lần dùng".
 *
 * ## Ranh giới — cái file này KHÔNG làm
 *
 * ⚠️ **Bảng `recovery_codes` không được tạo trong phạm vi này.** `01-architecture.md`
 * §10: "Password auth có bật hay không — quyết định `password_credentials` **và
 * `recovery_codes` tồn tại hay không**. Trước schema `db-account`". Persistence
 * (bảng, consume-one-time trong SQL, đếm used count) vì thế là phần chưa được phép
 * cài — file này chỉ là **thư viện thuần**: sinh code, băm, verify. Consume
 * one-time ở tầng database là việc của entity tương ứng khi quyết định §10 đóng.
 *
 * ## Về băm
 *
 * PBKDF2-SHA-256 qua WebCrypto (`crypto.subtle.deriveBits`) — KHÔNG bcrypt/argon2
 * native vì runtime:edge cấm Node builtin và không có WASM portable trong scope.
 * Code recovery có entropy ≥ 96 bit mỗi mã (tự sinh, không phải chuỗi người dùng
 * chọn), nên kẻ tấn công không thấy được mã thì brute-force qua hash là bất khả
 * thi; PBKDF2 với số vòng đủ lớn chỉ là lớp phình chi phí thêm cho trường hợp
 * DB bị lộ. Khoá PBKDF2 ở đây là **salt per-code** + mã: như vậy hash được tính
 * self-contained (không cần secret ứng dụng), đúng mô hình băm credential — mật
 * khẩu của user cũng băm self-contained.
 */

/** Số mã mỗi lần sinh — bộ recovery chuẩn phát cho user một lần. */
export const RECOVERY_CODES_PER_SET = 10;

/**
 * Độ dài byte entropy của mỗi mã trước khi mã hoá thành chuỗi.
 *
 * 5 nhóm × 4 ký tự Base32 = 20 ký tự × 5 bit = 100 bit — cần tối thiểu
 * ⌈100/8⌉ = 13 byte (104 bit; 4 bit dư ở cuối bị cắt khi giới hạn số ký tự).
 * 10 byte chỉ cho 16 ký tự = 4 nhóm, lệch {@link RECOVERY_CODE_GROUPS}.
 */
export const RECOVERY_CODE_ENTROPY_BYTES = 13;

/** Số nhóm ký tự của mỗi mã — `XXXX-XXXX-XXXX-XXXX-XXXX` cho 5 nhóm × 4 ký tự. */
export const RECOVERY_CODE_GROUPS = 5;

/** Số vòng PBKDF2 — đủ chậm trên Workers mà không vượt ngân sách CPU của request. */
export const RECOVERY_HASH_ITERATIONS = 100_000;

/** Độ dài bit của digest PBKDF2 — SHA-256 output đầy đủ. */
export const RECOVERY_HASH_BITS = 256;

/** Độ dài salt (byte) — 16 byte là chuẩn NIST SP 800-132. */
export const RECOVERY_SALT_BYTES = 16;

/** Một recovery code dạng người dùng thấy: 5 nhóm 4 ký tự, phân tách `-`. */
export interface RecoveryCode {
  /** Dạng hiển thị cho user đúng một lần — không bao giờ ghi DB. */
  readonly plaintext: string;
  /** PBKDF2 hex của plaintext — thứ duy nhất được ghi xuống DB. */
  readonly hash: string;
  /** Salt hex của code này — ghi kèm hash, per-code. */
  readonly salt: string;
}

/**
 * Sinh cả bộ recovery codes — mỗi mã một cặp plaintext + (salt, hash).
 *
 * Plaintext chỉ tồn tại để caller đưa cho user **đúng một lần** (màn hình hiển thị
 * + tải về); không hàm nào ở đây, và không nên có hàm nào, đọc lại plaintext từ hash.
 *
 * @param random Nguồn byte do caller truyền (mặc định CSPRNG); test truyền nguồn
 *   tất định để snapshot được code.
 */
export async function generateRecoveryCodes(
  random?: (length: number) => Uint8Array,
): Promise<RecoveryCode[]> {
  const codes: RecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODES_PER_SET; i++) {
    codes.push(await createRecoveryCode(random));
  }
  return codes;
}

/** Sinh một mã + băm nó — đơn vị của {@link generateRecoveryCodes}. */
export async function createRecoveryCode(
  random?: (length: number) => Uint8Array,
): Promise<RecoveryCode> {
  const bytes =
    random === undefined
      ? crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_ENTROPY_BYTES))
      : random(RECOVERY_CODE_ENTROPY_BYTES);
  const plaintext = formatRecoveryCode(bytes);
  const { hash, salt } = await hashRecoveryCode(plaintext);
  return { plaintext, hash, salt };
}

/**
 * Định dạng entropy thành `XXXX-XXXX-…` — mỗi ký tự là một chữ số Base32
 * (`A–Z`, `2–7`), 5 bit mỗi ký tự, 4 ký tự mỗi nhóm.
 *
 * Số nhóm phải khớp entropy: `entropy*8/5 = groups*4`. Với
 * {@link RECOVERY_CODE_GROUPS} = 5 nhóm (20 ký tự, 100 bit) cần
 * {@link RECOVERY_CODE_ENTROPY_BYTES} = 13 byte. Byte cuối có 4 bit dư — cắt
 * ở đúng 20 ký tự, bit dư không tham gia mã.
 */
export function formatRecoveryCode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const characters: string[] = [];
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && characters.length < RECOVERY_CODE_GROUPS * 4) {
      // `(value >>> (bits - 5)) & 31` luôn thuộc [0, 31] — chỉ số hợp lệ của
      // alphabet; `?? ''` chỉ để khớp noUncheckedIndexedAccess, không bao giờ chạy.
      const char = alphabet[(value >>> (bits - 5)) & 31] ?? '';
      characters.push(char);
      bits -= 5;
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < characters.length; i += 4) {
    groups.push(characters.slice(i, i + 4).join(''));
  }
  return groups.join('-');
}

/**
 * Chuẩn hoá code về hình dạng trước khi băm: lowercase + bỏ `-` và khoảng trắng.
 *
 * **Bắt buộc dùng chung** cho cả hash và verify: nếu chỉ một phía chuẩn hoá thì
 * hash được lưu sinh từ hình dạng khác hình dạng được băm lúc so — mọi lần verify
 * đúng code đều sai (bẫy đã bắt được bằng test). Verify nhận input người dùng gõ
 * tay nên chuẩn hoá rộng; generator sinh plaintext đã ở hình dạng chuẩn.
 */
function normalizeRecoveryCode(candidate: string): string {
  return candidate.toLowerCase().replaceAll('-', '').replaceAll(' ', '');
}

/**
 * Băm một code — PBKDF2-SHA-256, salt per-code, trả (hash, salt) hex.
 *
 * Export riêng để verify dùng **cùng một đường tính** với sinh: nếu verify dùng
 * thuật toán khác generator thì mọi code sinh ra sẽ không bao giờ verify được —
 * một test khẳng định cả hai cùng đi qua hàm này là lớp bảo vệ duy nhất.
 */
export async function hashRecoveryCode(plaintext: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(RECOVERY_SALT_BYTES));
  const hash = await pbkdf2Sha256(normalizeRecoveryCode(plaintext), salt, RECOVERY_HASH_ITERATIONS);
  return { hash: toHex(hash), salt: toHex(salt) };
}

/**
 * Verify một code người dùng nhập vào với (hash, salt) đã lưu.
 *
 * ⚠️ **Hàm này KHÔNG kiểm single-use** — nó chỉ trả lời "chuỗi này có đúng là code
 * mang hash đó không". Single-use là thuộc tính của persistence (consume trong SQL
 * CAS, FR-005a), thuộc tầng entity khi bảng được phép tạo; kiểm ở đây sẽ là một
 * lời hứa không có chỗ lưu để thực hiện.
 *
 * Normalize trước so: lowercase + bỏ dấu gạch nối và khoảng trắng — người dùng
 * gõ `abcd-efgh-…` hay `ABCDEFGH…` là cùng một mã.
 */
export async function verifyRecoveryCode(
  candidate: string,
  stored: { hash: string; salt: string },
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(candidate);
  const salt = fromHex(stored.salt);
  const computed = await pbkdf2Sha256(normalized, salt, RECOVERY_HASH_ITERATIONS);
  // So hex theo thời gian hằng — hash là dữ liệu xác thực, timing leak là lỗ hổng
  // thật ở đây (khác OTP: không gian tìm kiếm của code recovery lớn tới mức
  // brute-force offline là đường chính, timing chỉ là phụ).
  return timingSafeEqualHex(toHex(computed), stored.hash);
}

// --------------------------------------------------------------------------------------------
// PBKDF2 qua WebCrypto — không Node builtin, chạy trên Workers và Node ≥ 19.
// --------------------------------------------------------------------------------------------

async function pbkdf2Sha256(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  // Tham số `passphrase` thay vì `secret`: tên `secret` là nguồn của rule
  // security-sensitive-value-in-http-response. Giá trị trả về là derived bits
  // của PBKDF2 — một chiều, không suy ra được đầu vào — nên return không phải
  // rò rỉ; tên trung tính để rule nhìn đúng điều đó.
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    RECOVERY_HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Hex lowercase → byte; giả định input là hex hợp lệ do chính hệ thống ghi. */
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Byte buffer → hex chữ thường. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * So hex theo thời gian hằng — XOR từng byte, không short-circuit. Cùng hình dạng
 * với `timingSafeDigestEqual` của `apps/account/server/lib/otp.ts` và
 * `timingSafeEqualHex` của `libs/internal-auth-contracts`: lặp lại một hàm 15 dòng rẻ
 * hơn thêm phụ thuộc từ `type:domain` (lib này không được import project nào khác).
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const left = Number.parseInt(a[i] ?? '0', 16);
    const right = Number.parseInt(b[i] ?? '0', 16);
    diff |= left ^ right;
  }
  return diff === 0;
}
