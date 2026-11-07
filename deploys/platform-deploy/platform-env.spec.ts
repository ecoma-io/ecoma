import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { lookupPostgresPassword, upsertLocalEnv } from './platform-env.js';
import type { ExecResult } from '@ecoma-io/deployment';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-env-spec-'));
  cleanup.push(dir);
  return dir;
}

/** ExecResult hình đúng CLI: chỉ cần status/stdout/stderr cho các pure parser. */
function execResult(
  overrides: Partial<{ status: number | null; stdout: string; stderr: string }> = {},
): ExecResult {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

describe('lookupPostgresPassword', () => {
  it('found: trims the plaintext value on exit 0', () => {
    const lookup = lookupPostgresPassword(execResult({ status: 0, stdout: 's3cret\n' }));
    expect(lookup).toEqual({ state: 'found', password: 's3cret' });
  });

  it('empty stdout on exit 0 is missing, not found', () => {
    expect(lookupPostgresPassword(execResult({ status: 0, stdout: '\n' }))).toEqual({
      state: 'missing',
    });
  });

  it('the `[secret]` masking string is an error, never a password', () => {
    const lookup = lookupPostgresPassword(execResult({ status: 0, stdout: '[secret]' }));
    expect(lookup).toMatchObject({ state: 'error', detail: expect.stringContaining('[secret]') });
  });

  it('missing key on non-zero exit is missing (three-state contract)', () => {
    expect(
      lookupPostgresPassword(
        execResult({ status: 1, stderr: "no value for the key 'postgres:password'" }),
      ),
    ).toEqual({ state: 'missing' });
  });

  it('real errors never embed the raw command output (leak guard)', () => {
    // stdout của `config get` khi exit 0 CHÍNH LÀ mật khẩu: nếu CLI đổi hành vi
    // exit-code, nhét raw output vào error string là đường leak thật.
    const lookup = lookupPostgresPassword(
      execResult({ status: 1, stdout: 'SUPER-SECRET', stderr: 'boom' }),
    );
    expect(lookup).toMatchObject({
      state: 'error',
      detail: expect.stringMatching(/^(?!.*SUPER-SECRET)(?!.*boom).*$/su),
    });
  });
});

describe('upsertLocalEnv', () => {
  it('creates the file with only the owned keys when it does not exist', () => {
    const root = tempWorktree();
    const { envPath } = upsertLocalEnv(root, { ROOT_HOST: 'fbi.com:44301', NOT_OWNED: 'x' });
    expect(readFileSync(envPath, 'utf8')).toBe('ROOT_HOST=fbi.com:44301\n');
  });

  it('merges byte-preservingly: foreign lines keep their exact bytes and position', () => {
    const root = tempWorktree();
    const original = ['MY_VAR=keep me  ', '# comment', 'ROOT_HOST=old:80', 'OTHER=1', ''].join(
      '\n',
    );
    writeFileSync(join(root, '.env'), original, 'utf8');
    upsertLocalEnv(root, { ROOT_HOST: 'fbi.com:44301' });
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(
      ['MY_VAR=keep me  ', '# comment', 'ROOT_HOST=fbi.com:44301', 'OTHER=1', ''].join('\n'),
    );
  });

  it('adds a previously absent owned key at the end without a misplaced blank line', () => {
    const root = tempWorktree();
    writeFileSync(join(root, '.env'), 'OTHER=1\n', 'utf8');
    upsertLocalEnv(root, { ROOT_DOMAIN: 'fbi.com:44301' });
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('OTHER=1\nROOT_DOMAIN=fbi.com:44301\n');
  });

  it('refuses values containing newlines (structure corruption guard)', () => {
    const root = tempWorktree();
    writeFileSync(join(root, '.env'), 'ROOT_HOST=ok\n', 'utf8');
    expect(() => upsertLocalEnv(root, { ROOT_HOST: 'evil\nINJECTED=1' })).toThrow(/newline/u);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('ROOT_HOST=ok\n');
  });
});
