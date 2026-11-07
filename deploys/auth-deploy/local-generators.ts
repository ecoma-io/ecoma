/**
 * Generator secret riêng của lane auth — tách khỏi entry (`local.ts`) vì
 * entry chạy `main()` ngay khi import (side effect), còn spec cần import
 * generator mà không kích hoạt lifecycle.
 *
 * `generatePostgresPassword`, `generateAppSecret`, `generateInternalHmacSecret`
 * dùng bản dùng chung của `@ecoma-io/deployment`; khoá ký ES256 dưới đây là
 * hình ĐẶC THÙ của auth nên sống ở deploy project sở hữu contract loader phía
 * app (`SigningKeyProvider.fromPem`).
 */

/**
 * Sinh PEM PKCS#8 cho khoá ký ES256 của auth (Worker Secret `AUTH_SIGNING_KEY`).
 *
 * WebCrypto ở runtime local Node: `crypto.subtle.generateKey({ name:
 * 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])` rồi
 * `exportKey('pkcs8')` — đúng spec PKCS#8 mà `SigningKeyProvider.fromPem`
 * parse (`BEGIN PRIVATE KEY`). Khóa sinh MỖI LẦN GỌI; caller quyết định khi
 * nào gọi (một lần cho mỗi lần up auth trên namespace mới) và stack config
 * là nơi giữ nó ổn định giữa các lần deploy — JWKS đổi giữa chừng là mọi
 * token đã cấp không còn verify được.
 *
 * `forge` không được dùng; `node:crypto` là dependency duy nhất — cùng nguồn
 * với `generatePostgresPassword`.
 */
export async function generateEs256SigningKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const derBase64 = Buffer.from(pkcs8).toString('base64');
  const lines = derBase64.match(/.{1,64}/gu) ?? [];
  // KHÔNG phần tử '' cuối: join('\n') với '' đuôi sinh PEM kết thúc bằng '\n'
  // — `requireSecret` của app từ chối mọi giá trị có whitespace đầu/cuối, WIC
  // local rơi vào /ready 503 config_invalid vĩnh viễn (đo trực tiếp ở #249).
  // PEM RFC 7468 không đòi newline cuối; generator này chỉ phục vụ config set.
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----'].join('\n');
}
