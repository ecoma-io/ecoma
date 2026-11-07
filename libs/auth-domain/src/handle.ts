import { AuthConfigurationError, OAuthProtocolError } from './errors';

/**
 * Domain separation cho handle X/Y/Z (FR-016l).
 *
 * ⚠️ Ba giá trị này phải TÁCH BIỆT và không được gộp. Cùng `transaction_id`
 * với ba domain khác nhau phải ra ba handle khác nhau — nếu không, handle của
 * loại này sẽ dùng được cho loại kia và mất hết ý nghĩa của state machine.
 */
export const HANDLE_DOMAINS = {
  /** Handle X — bàn giao sang `/login` của `account`. */
  loginHandoff: 'login-handoff',
  /** Handle Y — tiếp tục consent. */
  consentContinuation: 'consent-continuation',
  /** Handle Z — hoàn tất, đổi lấy authorization code. */
  authorizationCode: 'authorization-code',
} as const;

export type HandleDomain = (typeof HANDLE_DOMAINS)[keyof typeof HANDLE_DOMAINS];

/** Miền hợp lệ, dùng để chặn domain lạ từ ngoài đi vào. */
const VALID_DOMAINS: ReadonlySet<string> = new Set<string>(Object.values(HANDLE_DOMAINS));

/**
 * Độ dài `transaction_id` tối thiểu, tính bằng ký tự base64url.
 * 32 ký tự base64url = 192 bit; thiết kế yêu cầu ≥ 256 bit entropy, nên
 * mint dùng 43 ký tự (32 byte). Con số ở đây là chặn dưới cho INPUT, không
 * phải kích thước phát sinh.
 */
export const MIN_TRANSACTION_ID_LENGTH = 43;

/** Ký tự hợp lệ trong handle/transaction id: base64url, không padding. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/u;

const encoder = new TextEncoder();

function requireBase64Url(value: string, field: string): void {
  if (!BASE64URL_RE.test(value)) {
    throw new AuthConfigurationError(`${field} khong phai base64url hop le`);
  }
}

/**
 * Length-prefixed byte concatenation.
 *
 * ⚠️ KHÔNG nối chuỗi trực tiếp rồi phân tách bằng separator — đó là lỗi
 * canonicalization cổ điển: `("ab","c")` và `("a","bc")` cho cùng một chuỗi
 * nối, tức hai input khác nhau cùng một HMAC. Vì `transaction_id` có thể do
 * bên gọi kiểm soát một phần, đây là đường thật để vượt domain separation.
 *
 * Format: mỗi trường được đứng trước bởi độ dài của nó, `len:bytes`. Bộ đặc
 * biểu này **injective** — không có hai bộ `(domain, id)` khác nhau cho ra
 * cùng một chuỗi byte.
 */
export function lengthPrefixed(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length + 1;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    // Độ dài tối đa 255 byte mỗi trường: transaction id ngắn, domain là hằng
    // số cố định, nên một byte là đủ và tránh phải xử lý prefix nhiều byte.
    if (part.length > 255) {
      throw new AuthConfigurationError('truong dai qua gioi han 255 byte');
    }
    out[offset] = part.length;
    offset += 1;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Ký HMAC-SHA-256, trả về base64url không padding. */
async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, message as unknown as BufferSource);
  return new Uint8Array(signature);
}

async function importKey(rawSecret: string): Promise<Uint8Array> {
  // Worker Secret là base64 32 byte. KHÔNG dùng trực tiếp chuỗi của secret làm
  // khoá HMAC — chuỗi đó là văn bản, và người đọc được cấu hình cũng đọc được
  // khoá nếu dùng sai. 32 byte = 256 bit là kích thước chuẩn cho HMAC-SHA-256.
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlToBytes(rawSecret);
  } catch (cause) {
    throw new AuthConfigurationError(
      'K_auth khong giai ma duoc tu base64url; Worker Secret phai la 32 byte base64url',
      { cause },
    );
  }
  if (keyBytes.length !== 32) {
    throw new AuthConfigurationError(`K_auth phai dai 32 byte, thuc te la ${keyBytes.length} byte`);
  }
  return keyBytes;
}

export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Codec ngược của {@link base64UrlToBytes}: bytes → base64url không padding.
 *
 * Hai hàm này là BỘ CODEC DUY NHẤT giữa biểu diễn base64url (domain, TS) và
 * dữ liệu binary — không module nào được tự chế phiên bản encoding thứ hai,
 * vì hai bản codec là hai chỗ có thể lệch nhau và chỗ lệch là một so khớp
 * hash sai âm thầm.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * Suy ra handle từ `transaction_id` + domain.
 *
 * `HMAC-SHA-256(K_auth, len(domain) ‖ domain ‖ len(transaction_id) ‖ transaction_id)`
 * rồi base64url. Domain separation nằm TRONG thông điệp HMAC (không phải
 * tiền tố dạng chuỗi rời), nên nó được bảo vệ bởi bản thân hàm băm — thêm
 * tiền tố ngoài HMAC sẽ không có tác dụng gì.
 *
 * ⚠️ Không phải hash của `event_id`. `event_id` là idempotency identifier công
 * khai: nó đi trong payload back-channel và có thể lọt vào log của `account`.
 * Hash nó sẽ cho ra giá trị mà bất kỳ ai biết `event_id` đều tính lại được —
 * đó là lý do §5.6 của thiết kế gọi cơ chế cũ là sai.
 */
export async function deriveHandle(params: {
  key: string;
  transactionId: string;
  domain: HandleDomain;
}): Promise<string> {
  const { key, transactionId, domain } = params;

  if (!VALID_DOMAINS.has(domain)) {
    throw new AuthConfigurationError(`handle domain khong hop le: ${domain}`);
  }
  requireBase64Url(transactionId, 'transaction_id');
  if (transactionId.length < MIN_TRANSACTION_ID_LENGTH) {
    throw new AuthConfigurationError('transaction_id qua ngan');
  }

  const keyBytes = await importKey(key);
  const message = lengthPrefixed([encoder.encode(domain), encoder.encode(transactionId)]);
  const mac = await hmacSha256(keyBytes, message);
  return base64UrlEncode(mac);
}

/**
 * Hash handle để LƯU. Đây KHÔNG phải handle — nó là hash một chiều của handle,
 * dùng để so khớp khi tra cứu mà không lưu plaintext (FR-016p).
 *
 * ⚠️ Không dùng hàm băm nhanh (SHA-256 không có khoá). Ở đây handle đã là HMAC
 * — tức đã là giá trị 256 bit ngẫu nhiên về mặt thực tế — nên hash thêm không
 * tăng entropy; nó chỉ giữ cho cột DB không chứa giá trị dùng được trực tiếp.
 */
export async function hashHandle(handle: string): Promise<string> {
  requireBase64Url(handle, 'handle');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(handle) as unknown as BufferSource,
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** So khớp hằng thời gian cho hai chuỗi cùng độ dài. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Kiểm tra một handle có thực sự thuộc transaction này không.
 *
 * Đây là hàng phòng thủ FR-016q: HMAC đã gắn handle vào `transaction_id`, nên
 * handle của transaction khác sẽ **không** khớp khi so hash — hàm này chỉ làm
 * lỗi rõ ràng hơn thay vì im lặng trả về "không thấy".
 */
export async function assertHandleBelongsToTransaction(params: {
  key: string;
  transactionId: string;
  domain: HandleDomain;
  presentedHandle: string;
}): Promise<void> {
  const expected = await deriveHandle(params);
  const [a, b] = await Promise.all([hashHandle(expected), hashHandle(params.presentedHandle)]);
  if (!timingSafeEqual(a, b)) {
    throw new OAuthProtocolError('invalid_grant', 400, {
      redirectable: false,
      detail: 'handle khong thuoc transaction nay',
    });
  }
}
