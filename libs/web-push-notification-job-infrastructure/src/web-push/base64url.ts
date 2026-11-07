/**
 * base64url theo RFC 4648 §5 — **không padding**, dùng `atob`/`btoa` của platform
 * (Workers runtime có sẵn; test runtime Node ≥ 16 cũng có).
 *
 * Cả hai API này hoạt động trên alphabet **standard** (RFC 4648 §4) và **từ chối**
 * ký tự ngoài alphabet, nên phải chuyển `base64url → base64` trước khi decode. Việc
 * tự viết bảng tra cứu base64url sẽ phải xử lý padding và length lẻ — `atob` lo sẵn
 * và throw đúng kiểu lỗi cho input rác, đó là phần ta cần.
 */

/** Chuỗi `standard base64` → `base64url` không padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunk để không dựng string khổng lồ: `String.fromCharCode(...bytes)` blow stack
  // với payload 3993 octet là đủ sập.
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * `base64url` (không padding) → byte.
 *
 * `atob` chấp nhận input thiếu padding, nên không cần tự thêm `=`. Ký tự ngoài
 * alphabet làm `atob` throw `InvalidCharacterError` — ta chuyển thành `null` để caller
 * phân loại thành transient/before_send thay vì lỗi runtime.
 */
export function fromBase64Url(value: string): Uint8Array | null {
  if (value.length === 0) {
    return null;
  }
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Decode base64url và bắt buộc **độ dài** khớp.
 *
 * Vì `atob` bỏ qua ký tự `\n`/`\r` và cho phép chuỗi rỗng, kiểm tra độ dài là cần
 * thiết để chặn material sai kích thước — ví dụ `p256dh` 64 octet thay vì 65.
 */
export function decodeBase64UrlExact(value: string, expectedOctets: number): Uint8Array | null {
  const bytes = fromBase64Url(value);
  if (bytes === null || bytes.length !== expectedOctets) {
    return null;
  }
  return bytes;
}
