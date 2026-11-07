/**
 * Generator secret riêng của lane push-notification — tách khỏi entry
 * (`local.ts`) vì entry chạy `main()` ngay khi import (side effect), còn spec
 * cần import generator mà không kích hoạt lifecycle.
 *
 * `generateInternalHmacSecret` (runtimeSharedSecret/adminToken/
 * applicationToken) dùng bản dùng chung của `@ecoma-io/deployment`; khoá dưới
 * đây là hình ĐẶC THÙ của push nên sống ở deploy project sở hữu contract
 * loader phía app (`buildCipher` kiểm ĐÚNG 32 byte).
 */
import { randomBytes } from 'node:crypto';

/**
 * Sinh root key AES-256 **32 byte dạng base64** cho lane push-notification
 * local (Worker Secret `PUSH_CREDENTIAL_ROOT_KEY_K1` của cặp WIC push).
 *
 * Hình giá trị là CONTRACT của composition root (`main.ts` của app push):
 * giá trị được `atob` giải mã rồi kiểm ĐÚNG 32 byte (AES-256) — hình khác làm
 * cả control plane lẫn consumer chết ngay lúc boot với lỗi độ dài key. Base64
 * chuẩn (có `+/=`) là hình secret production dùng nên giữ nguyên ở local; giá
 * trị xoay mỗi lần `up` là vô hại vì D1 `push` trên volume state là ephemeral
 * theo thiết kế local (không credential nào sống qua hai lần up).
 */
export function generateBase64Key32(): string {
  return randomBytes(32).toString('base64');
}
