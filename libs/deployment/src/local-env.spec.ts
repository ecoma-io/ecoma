import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateAppSecret,
  generateInternalHmacSecret,
  generatePostgresPassword,
  isConfigKeyMissing,
  readRootHostFromEnv,
} from './local-env.js';
import type { ExecResult } from './index.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-env-spec-'));
  cleanup.push(dir);
  return dir;
}

/** ExecResult hình đúng CLI: chỉ cần status/stdout/stderr cho các pure parser. */
function execResult(
  overrides: Partial<{ status: number | null; stdout: string; stderr: string }> = {},
): ExecResult {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

describe('isConfigKeyMissing', () => {
  it('matches the canonical CLI missing-key messages case-insensitively', () => {
    expect(
      isConfigKeyMissing(
        execResult({ status: 1, stderr: "error: no value for the key 'postgres:password'" }),
      ),
    ).toBe(true);
    expect(
      isConfigKeyMissing(
        execResult({ status: 1, stderr: 'configuration key "postgres:password" not found' }),
      ),
    ).toBe(true);
  });

  it('is false for unrelated failures (wrong passphrase, backend errors)', () => {
    // Fail-closed là điểm của hàm này: sai passphrase exit != 0 nhưng KHÔNG
    // được nhận nhầm là "chưa có key" — regen secret trên lỗi đó là đè giá trị
    // đang sống trong state.
    expect(
      isConfigKeyMissing(execResult({ status: 1, stderr: 'failed to decrypt secret value' })),
    ).toBe(false);
    expect(isConfigKeyMissing(execResult({ status: 1, stderr: '' }))).toBe(false);
  });
});

describe('secret generators', () => {
  it('postgres password is 24 bytes of base64url', () => {
    const password = generatePostgresPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(new Set([generatePostgresPassword(), password]).size).toBe(2);
  });

  it('app secret and internal HMAC secret are 32 bytes of base64url and differ across calls', () => {
    for (const secret of [generateAppSecret(), generateInternalHmacSecret()]) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }
    expect(generateInternalHmacSecret()).not.toBe(generateInternalHmacSecret());
  });
});

describe('readRootHostFromEnv', () => {
  it('returns undefined for a missing file or an empty value', () => {
    expect(readRootHostFromEnv(tempWorktree())).toBeUndefined();
    const root = tempWorktree();
    writeFileSync(join(root, '.env'), 'ROOT_HOST=\n', 'utf8');
    expect(readRootHostFromEnv(root)).toBeUndefined();
  });

  it('reads the value and survives values containing `=`', () => {
    const root = tempWorktree();
    writeFileSync(join(root, '.env'), 'OTHER=x\nROOT_HOST=fbi.com:44301\n', 'utf8');
    expect(readRootHostFromEnv(root)).toBe('fbi.com:44301');
    const root2 = tempWorktree();
    writeFileSync(join(root2, '.env'), 'ROOT_HOST=a=b=c\n', 'utf8');
    expect(readRootHostFromEnv(root2)).toBe('a=b=c');
  });
});
