/**
 * Root key của credential version `K1` — **một** nguồn sự thật cho toàn bộ test của app.
 *
 * ⚠️ **Vì sao key nằm ở đây mà không nằm trong `app-env.ts`.** Composition root đọc root key
 * từ Worker Secret `PUSH_CREDENTIAL_ROOT_KEY_K1` (`main.ts` → `buildCipher`), và fixture seed
 * credential phải mã hoá bằng **đúng** key đó — nếu hai bên lệch nhau thì credential seed
 * không giải mã được, và cổng chặn enable (`credential_decryption_failed`) làm đỏ test.
 * Tách ra module lá cho phép `app-env.ts` (env của Worker) và `d1-harness.ts` (credential seed)
 * cùng trỏ tới **một** giá trị, thay vì hai bản copy có thể lệch nhau.
 *
 * ⚠️ **Đây là material test, không phải credential.** Nó nằm trong repo; một root key
 * production phải nằm trong Worker Secret. Nó tồn tại vì `buildCipher` fail-closed khi thiếu
 * key của version đang phục vụ (`K1`), nên không thể dựng context mà thiếu nó.
 */

import { WebCryptoCredentialCipher } from '@ecoma-io/push-notification-infrastructure';

/** Root key 32 byte của version `K1` — 32 byte cố định, không phải secret. */
export const ROOT_KEY_K1: Uint8Array = new Uint8Array(32).fill(7);

/**
 * Root key `K1` ở dạng base64 — **đúng** giá trị mà Worker Secret `PUSH_CREDENTIAL_ROOT_KEY_K1`
 * mang trong môi trường test.
 */
export const ROOT_KEY_K1_BASE64: string = btoa(String.fromCodePoint(...ROOT_KEY_K1));

/**
 * Cipher `K1` (current `K1`) dựng từ `ROOT_KEY_K1` — dùng để mã hoá/giải mã credential
 * **giống hệt** composition root đang chạy.
 */
export function rootKeyCipherK1(): WebCryptoCredentialCipher {
  return new WebCryptoCredentialCipher({
    keysByVersion: { K1: Uint8Array.from(ROOT_KEY_K1) },
    currentVersion: 'K1',
  });
}
