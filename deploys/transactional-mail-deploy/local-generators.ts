/**
 * Generator secret riêng của lane transactional-mail — tách khỏi entry
 * (`local.ts`) vì entry chạy `main()` ngay khi import (side effect), còn spec
 * cần import generator mà không kích hoạt lifecycle.
 *
 * `generateInternalHmacSecret` (HMAC consumer<->control plane) dùng bản dùng
 * chung của `@ecoma-io/deployment`; hai khoá dưới đây là hình ĐẶC THÙ của mail
 * nên sống ở deploy project sở hữu contract loader phía app.
 */
import { randomBytes } from 'node:crypto';

/**
 * Sinh khoá HMAC-SHA-256 32 byte dạng **64 ký tự hex chữ thường** cho lane
 * transactional-mail local (keyring `request_fingerprint`, khoá quarantine).
 *
 * Hình giá trị là CONTRACT của loader: cả `FINGERPRINT_KEY_HEX` (config.ts của
 * control plane) lẫn `HEX_KEY_64` (config.ts của consumer) chỉ chấp nhận
 * `/^[0-9a-f]{64}$/` — chặn cả hex HOA. `hex` encoding đúng 64 ký tự; một
 * hình khác làm hai Worker chết ngay lúc boot với lỗi "phai la 64 hex chu
 * thuong".
 */
export function generateHexKey64(): string {
  return randomBytes(32).toString('hex');
}
