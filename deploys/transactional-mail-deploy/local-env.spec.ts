/**
 * Spec của generator secret riêng có trong entry này (`generateHexKey64`).
 *
 * Hình giá trị là CONTRACT với loader phía app (`FINGERPRINT_KEY_HEX` và
 * `HEX_KEY_64` chỉ chấp nhận `/^[0-9a-f]{64}$/`), nên test sống NGAY TẠI
 * deploy project sở hữu generator — generator là hàm private của entry trước
 * khi tách module, và lib dùng chung không biết hình đặc thù này. Cùng hình
 * test seam với spec colocated của `platform-deploy`.
 */
import { describe, expect, it } from 'vitest';

import { generateHexKey64 } from './local-generators.js';

describe('generateHexKey64', () => {
  it('hex key is exactly 64 lowercase hex characters', () => {
    expect(generateHexKey64()).toMatch(/^[0-9a-f]{64}$/u);
  });
});
