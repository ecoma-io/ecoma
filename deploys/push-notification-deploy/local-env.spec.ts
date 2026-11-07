/**
 * Spec của generator secret riêng có trong entry này (`generateBase64Key32`).
 *
 * Hình giá trị là CONTRACT với composition root (`main.ts` của app push `atob`
 * rồi kiểm ĐÚNG 32 byte AES-256), nên test sống NGAY TẠI deploy project sở hữu
 * generator — lib dùng chung không biết hình đặc thù này. Cùng hình test seam
 * với spec colocated của `platform-deploy`.
 */
import { describe, expect, it } from 'vitest';

import { generateBase64Key32 } from './local-generators.js';

describe('generateBase64Key32', () => {
  it('base64 key decodes to exactly 32 bytes', () => {
    const key = generateBase64Key32();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(Buffer.from(key, 'base64').length).toBe(32);
  });
});
