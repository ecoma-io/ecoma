/**
 * TOTP (RFC 6238) — verify một mã xác thực bước hai, và secret đi kèm dưới dạng
 * Base32 cho authenticator app.
 *
 * ## Điều kiện docs đã chốt
 *
 * - FR-005 (`docs/applications/account/02-requirements.md` §1.2): `authenticators` gộp
 *   passkey và TOTP bằng discriminator; "TOTP secret mã hoá ở tầng ứng dụng".
 * - Model assurance (`docs/applications/account/01-architecture.md`, mục assurance cùng
 *   JSDoc của `./acr`): email-OTP là phương thức đăng nhập duy nhất; **MFA tuỳ chọn**
 *   gồm TOTP và Passkey/WebAuthn; "passkey trước TOTP" còn mở nhưng thứ tự đó chỉ là
 *   thứ tự ra mắt, không đổi thuật toán của phương thức thứ hai.
 *
 * ## Ranh giới của file này (cái nó KHÔNG làm)
 *
 * ⚠️ **File này KHÔNG lưu secret vào đâu cả** — nó là thư viện thuần: nhận secret đã
 * có, trả kết quả verify. Vòng đời lưu trữ (mã hoá tầng ứng dụng bằng primitive nào,
 * key đặt đâu) là quyết định **chưa chốt** tại `docs/applications/account/01-architecture.md`
 * §10 "Primitive mã hoá TOTP secret tầng ứng dụng, và nơi giữ key — Trước khi lưu TOTP
 * secret". Bởi vậy không có migration, không có bảng, không có route trong phạm vi này.
 *
 * ## HMAC bằng WebCrypto
 *
 * `runtime:universal` cấm Node builtin (`crypto`/`node:crypto`) — TOTP chỉ cần
 * HMAC-SHA-1/256/512 và cả ba đều có trên `crypto.subtle` của Workers, Node ≥ 19 và
 * jsdom. SHA-1 ở đây **không** phải điểm yếu: HMAC-SHA-1 không bị ảnh hưởng bởi va
 * chạm của SHA-1, và RFC 6238 giữ nó để tương thích với mọi authenticator đang chạy.
 * Recommended defaults của RFC là SHA-256 — hằng số `DEFAULT_TOTP_ALGORITHM` neo đó.
 */

import { base32Decode, base32Encode } from './base32';

/** Thuật toán HMAC của TOTP — RFC 6238 §5.1 (R3/R4). */
export type TotpAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-512';

/** Thuật toán recommend mặc định của RFC 6238 — mọi secret mới sinh theo đây. */
export const DEFAULT_TOTP_ALGORITHM: TotpAlgorithm = 'SHA-256';

/** Bước thời gian (giây) của mã TOTP — RFC 6238 §5.2 (R2). */
export const TOTP_STEP_SECONDS = 30;

/** Số chữ số của mã — RFC 6238 §5.3 mặc định 6, authenticator phổ biến nhất là 6. */
export const TOTP_DIGITS = 6;

/** Số bước thời gian cho phép lệch khi verify — ±1 bước = ±30s quanh đồng hồ server. */
export const TOTP_ALLOWED_DRIFT_STEPS = 1;

/** Độ dài secret tối thiểu (byte) — RFC 4226 §4 đề nghị ≥ 16 byte, ta cần ≥ 20. */
export const MIN_TOTP_SECRET_BYTES = 20;

/** Thời điểm gốc Unix của TOTP — mọi counter tính từ đây (RFC 6238 §5.1). */
export const TOTP_EPOCH_SECONDS = 0;

/**
 * Sinh secret TOTP mới — random từ CSPRNG, trả Base32 chuẩn cho authenticator app.
 *
 * @param random Nguồn byte do caller truyền (mặc định `crypto.getRandomValues`);
 *   test truyền nguồn tất định. `size` mặc định 20 byte (160 bit) — đủ theo RFC 4226
 *   §4 và không phình to URI trong QR code.
 */
export function generateTotpSecret(
  size: number = MIN_TOTP_SECRET_BYTES,
  random?: (length: number) => Uint8Array,
): string {
  const bytes = random === undefined ? randomBytes(size) : random(size);
  return base32Encode(bytes);
}

/** Secret Base32 → byte nhị phân cho HMAC; ném {@link Base32DecodeError} khi sai. */
export function decodeTotpSecret(base32Secret: string): Uint8Array {
  const bytes = base32Decode(base32Secret);
  if (bytes.length < MIN_TOTP_SECRET_BYTES) {
    throw new Error(
      `TOTP secret is too short: ${bytes.length} bytes, minimum ${MIN_TOTP_SECRET_BYTES}`,
    );
  }
  return bytes;
}

/**
 * Đổi bước thời gian hiện tại thành counter TOTP — floor về 30 giây, số nguyên.
 *
 * counter = floor((t − T0) / X). Trả số nguyên để byte 8 của HMAC là nguyên;
 * `Number.isSafeInteger` là điều kiện vì counter phải đi qua `BigInt` an toàn.
 */
export function totpCounterAt(
  unixSeconds: number,
  stepSeconds: number = TOTP_STEP_SECONDS,
): number {
  return Math.floor((unixSeconds - TOTP_EPOCH_SECONDS) / stepSeconds);
}

/**
 * Tính một mã TOTP ở counter cụ thể — chính thuật toán RFC 6238, không bước verify.
 *
 * Ký hiệu: HMAC(key, 8-byte BE counter) → dynamic truncation (RFC 4226 §5.3) —
 * offset lấy từ **byte cuối** của digest (`& 0x0f`), extract 31 bit tại đó, modulo
 * 10^digits, đệm số 0 đầu.
 *
 * @param secretBytes Byte nhị phân của secret.
 * @param counter Counter 8-byte (an toàn vì < 2^53).
 * @param algorithm Thuật toán HMAC — URL của `crypto.subtle.importKey`.
 */
export async function computeTotp(
  secretBytes: Uint8Array,
  counter: number,
  algorithm: TotpAlgorithm = DEFAULT_TOTP_ALGORITHM,
  digits: number = TOTP_DIGITS,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    // Copy sang buffer mới gắn `ArrayBuffer` cụ thể (`new Uint8Array(n)` mang kiểu
    // `Uint8Array<ArrayBuffer>`, khớp `BufferSource` của lib.dom chặt hơn — không
    // nhận `Uint8Array<ArrayBufferLike>`): vừa thỏa WebIDL, vừa cắt tham chiếu tới
    // buffer gốc dài hơn cần thiết.
    copyBytes(secretBytes),
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );

  const message = new Uint8Array(8);
  const counterBig = BigInt(counter);
  for (let i = 0; i < 8; i++) {
    // Byte 8 BE: byte cao nhất ở vị trí 0.
    message[7 - i] = Number((counterBig >> BigInt(i * 8)) & 0xffn);
  }

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));

  // Dynamic truncation (RFC 4226 §5.3): offset từ NIBBLE CUỐI của digest — với
  // SHA-1 là byte 19, với SHA-256 là byte 31, SHA-512 là byte 63. Dùng
  // `signature.length − 1` để đúng cho cả ba thuật toán (bẫy: hardcode 19 là chỉ
  // đúng cho SHA-1). CHỈ byte đầu của bốn byte trích ra bị mask `& 0x7f` — mask
  // cả bốn là xoá bit của giá trị và lệch mã ở hàng đơn vị (bẫy đã bắt được bằng
  // test vector RFC).
  const offset = (signature[signature.length - 1] ?? 0) & 0x0f;
  const binary =
    // offset ∈ [0, 15] và digest ≥ 20 byte nên bốn chỉ số dưới luôn hợp lệ; `?? 0`
    // chỉ để khớp noUncheckedIndexedAccess, không đổi giá trị.
    (((signature[offset] ?? 0) & 0x7f) << 24) |
    ((signature[offset + 1] ?? 0) << 16) |
    ((signature[offset + 2] ?? 0) << 8) |
    (signature[offset + 3] ?? 0);
  const code = binary % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * Verify một mã người dùng nhập vào, cho phép lệch ±`drift` bước thời gian.
 *
 * ⚠️ Thứ tự duyệt là **từ đứng gần nhất ra lệch xa nhất** (`0, +1, −1, …`): bước
 * thời gian hiện tại gần như luôn thắng, và ca lệch chỉ chạy khi cần. Kết quả trả
 * cả counter khớp để caller (tầng lưu trữ) ghi "last used counter" chống replay
 * trên cùng một counter.
 *
 * @param code Mã người dùng nhập — **bình thường hoá**: bỏ khoảng trắng, giữ chữ số.
 *   Chuỗi sai hình dạng → `null`, không phải một mã không trùng.
 * @param atUnixSeconds Thời điểm hiện tại (giây Unix) — caller truyền, không đọc đồng hồ.
 * @param drift Số bước cho phép lệch (mặc định ±1).
 */
export async function verifyTotp(
  base32Secret: string,
  code: string,
  atUnixSeconds: number,
  drift: number = TOTP_ALLOWED_DRIFT_STEPS,
  algorithm: TotpAlgorithm = DEFAULT_TOTP_ALGORITHM,
): Promise<TotpVerification | null> {
  const normalized = code.replaceAll(' ', '');
  if (!/^\d+$/u.test(normalized) || normalized.length !== TOTP_DIGITS) {
    return null;
  }

  const secretBytes = decodeTotpSecret(base32Secret);
  const current = totpCounterAt(atUnixSeconds);

  for (let delta = 0; delta <= drift; delta++) {
    // Từng cặp ±delta, gần nhất trước.
    for (const counter of delta === 0 ? [current] : [current + delta, current - delta]) {
      const expected = await computeTotp(secretBytes, counter, algorithm);
      // So chuỗi là đủ: cả hai đều là chuỗi digit độ dài cố định, so thời gian
      // không có ý nghĩa khi không gian tìm kiếm là 10^6 mã chỉ sống 30 giây.
      if (expected === normalized) {
        return { valid: true, matchedCounter: counter };
      }
    }
  }
  return null;
}

/** Kết quả verify thành công — counter được trả lại để caller chống replay. */
export interface TotpVerification {
  readonly valid: true;
  /** Counter (bước 30 giây) mà mã khớp — ghi lại để từ chối mã cùng counter lần sau. */
  readonly matchedCounter: number;
}

/** Dựng URI `otpauth://totp/…` cho QR code — tham số theo key URI format của Google Authenticator. */
export function otpauthUri(params: {
  /** Tên hiển thị, ví dụ email — được percent-encode. */
  label: string;
  issuer: string;
  secretBase32: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
  stepSeconds?: number;
}): string {
  const algorithm = params.algorithm ?? DEFAULT_TOTP_ALGORITHM;
  const digits = params.digits ?? TOTP_DIGITS;
  const step = params.stepSeconds ?? TOTP_STEP_SECONDS;
  // Secret trong URI là dạng KHÔNG đệm — hình dạng mà mọi authenticator app sinh và
  // đọc (Google Authenticator key URI format). Padding `=` một là rác trong URI, hai
  // bị `URLSearchParams` percent-encode thành `%3D` nên một số app quét QR lỗi.
  // Cắt đệm bằng vòng lặp từ cuối (O(k), k = số đệm ≤ 6) thay vì regex `=+$`:
  // secretBase32 đến từ người dùng (máy quét QR / nhập tay), và CodeQL
  // js/polynomial-redos gắn cờ chính hình dạng regex này.
  let secretUnpadded = params.secretBase32;
  while (secretUnpadded.endsWith('=')) {
    secretUnpadded = secretUnpadded.slice(0, -1);
  }
  const search = new URLSearchParams({
    secret: secretUnpadded,
    issuer: params.issuer,
    algorithm,
    digits: String(digits),
    period: String(step),
  });
  // Label chuẩn: `issuer:account` — percent-encode phần label để an toàn với ký tự đặc biệt.
  return `otpauth://totp/${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.label)}?${search}`;
}

// --------------------------------------------------------------------------------------------
// Helpers — không export, cùng hình dạng với `otp.ts` của app.
// --------------------------------------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Byte buffer → hex chữ thường. */
function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}
