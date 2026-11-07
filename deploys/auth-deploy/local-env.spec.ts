/**
 * Spec của generator secret riêng có trong entry này
 * (`generateEs256SigningKeyPem`).
 *
 * Hình giá trị là CONTRACT với `SigningKeyProvider.fromPem` của app auth
 * (parse `BEGIN PRIVATE KEY`, từ chối whitespace đầu/cuối), nên test sống NGAY
 * TẠI deploy project sở hữu generator — lib dùng chung không biết hình đặc thù
 * này. Cùng hình test seam với spec colocated của `platform-deploy`.
 */
import { describe, expect, it } from 'vitest';

import { generateEs256SigningKeyPem } from './local-generators.js';

describe('generateEs256SigningKeyPem', () => {
  it('ES256 signing key is a PKCS#8 PEM without a trailing newline', async () => {
    // `requireSecret` của app từ chối whitespace đầu/cuối — PEM kết thúc bằng
    // '\n' là lỗi boot WIC đã đo thật (#249).
    const pem = await generateEs256SigningKeyPem();
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/u);
    expect(pem.endsWith('-----END PRIVATE KEY-----')).toBe(true);
    expect(pem.endsWith('\n')).toBe(false);
  });
});
