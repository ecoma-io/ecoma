import { afterEach, describe, expect, it } from 'vitest';

import { legalIncludeDrafts } from './legal-build-mode';

/**
 * Fail-closed của cờ draft-preview: chỉ đúng chuỗi `"true"` bật preview; giá
 * trị thiếu, rỗng, `"1"`, `"TRUE"` đều là production semantics. Đây là chốt
 * an toàn của Phase 5 — production KHÔNG ĐƯỢC nhìn thấy draft vì bất kỳ lý
 * do nào, nên đường "bật nhầm" phải hẹp nhất có thể.
 */

const ENV_KEY = 'NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS';

/**
 * Gỡ biến env qua một vị trí tĩnh duy nhất — oxlint cấm `delete` với key
 * động (`no-dynamic-delete`); key ở đây là hằng số build-time nên helper
 * bọc `Reflect.deleteProperty` không đáng, gán `undefined` không tương đương
 * (biến vẫn tồn tại với giá trị undefined) — dùng helper xoá 3 lần với key
 * literal.
 */
function removeEnv(): void {
  delete process.env.NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS;
}

function withEnv(value: string | undefined, run: () => void): void {
  const previous = process.env[ENV_KEY];
  try {
    if (value === undefined) {
      removeEnv();
    } else {
      process.env[ENV_KEY] = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      removeEnv();
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
}

afterEach(() => {
  removeEnv();
});

describe('legalIncludeDrafts', () => {
  it('is false by default — no environment variable means production semantics', () => {
    withEnv(undefined, () => {
      expect(legalIncludeDrafts()).toBe(false);
    });
  });

  it('is only true for the exact string "true"', () => {
    withEnv('true', () => {
      expect(legalIncludeDrafts()).toBe(true);
    });
  });

  it('is fail-closed for every other value', () => {
    for (const value of ['', '1', 'yes', 'TRUE', 'True', ' true', 'true ', 'false', '0']) {
      withEnv(value, () => {
        expect(legalIncludeDrafts(), `value: "${value}"`).toBe(false);
      });
    }
  });
});
