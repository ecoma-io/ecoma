import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MIGRATION_LOCK_KEY,
  STATEMENT_TIMEOUT_MS,
  verifyLedgerChecksums,
  decideAdoption,
  parseArgs,
  readJournalEntries,
  withConnectionOptions,
} from './runner.mts';

/**
 * Spec unit colocated của wrapper — hàm thuần, không Docker (06-testing.md §4).
 * Behavior chạy thật (kit + PostgreSQL) thuộc `tests/integrations/` và target
 * `test-integration`.
 */

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));

describe('parseArgs', () => {
  it('defaults to migrate mode with the project config', () => {
    expect(parseArgs([])).toEqual({ mode: 'migrate', configPath: 'drizzle.config.ts' });
  });

  it('accepts explicit mode and --config', () => {
    expect(parseArgs(['adopt', '--config', 'other.config.ts'])).toEqual({
      mode: 'adopt',
      configPath: 'other.config.ts',
    });
    expect(parseArgs(['stamp', '--config', 'other.config.ts'])).toEqual({
      mode: 'stamp',
      configPath: 'other.config.ts',
    });
    expect(parseArgs(['--config', 'a.ts', 'migrate'])).toEqual({
      mode: 'migrate',
      configPath: 'a.ts',
    });
  });

  it('rejects unknown arguments and a dangling --config', () => {
    expect(() => parseArgs(['verify'])).toThrow(/unknown argument/u);
    expect(() => parseArgs(['--config'])).toThrow(/--config requires a path/u);
    expect(() => parseArgs(['--config', '--flag'])).toThrow(/--config requires a path/u);
  });
});

describe('MIGRATION_LOCK_KEY', () => {
  it('pins the hashtext value the legacy runner computed server-side', () => {
    // Runner cũ `apps/auth/db/apply.mts` khóa bằng
    // `pg_advisory_lock(hashtext('db-auth'))` — PostgreSQL 17 trả
    // -209279805. Đổi khóa khi cutover là phá mutual exclusion với stack cũ.
    expect(MIGRATION_LOCK_KEY).toBe(-209_279_805n);
  });
});

describe('withConnectionOptions', () => {
  it('appends the statement_timeout directive as an encoded options parameter', () => {
    const url = withConnectionOptions('postgresql://migrator:pw@db.internal:5432/db-auth', [
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    ]);
    expect(url.endsWith(`options=-c%20statement_timeout%3D${STATEMENT_TIMEOUT_MS}`)).toBe(true);
  });

  it('passes through unchanged when there is no directive to inject', () => {
    const raw = 'postgresql://migrator@localhost/db';
    expect(withConnectionOptions(raw, [])).toBe(raw);
  });

  it('preserves query parameters of the URL that already carries them', () => {
    const url = withConnectionOptions(
      'postgresql://migrator@localhost/db?application_name=migrator',
      [`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`],
    );
    expect(url.startsWith('postgresql://migrator@localhost/db?application_name=migrator')).toBe(
      true,
    );
    expect(url).toContain('&options=');
  });

  it('refuses to guess merge semantics when options is already present', () => {
    // Production không bao giờ ghép `options` vào URL (deploy units chỉ ghép
    // DATABASE_URL trần), nên có `options=` sẵn là hình lạ — fail closed thay
    // vì đoán thứ tự merge của các directive `-c`.
    expect(() =>
      withConnectionOptions('postgresql://migrator@localhost/db?options=-c x', ['-c x=1']),
    ).toThrow(/options parameter/u);
  });

  it('keeps a raw password with URL-reserved characters untouched', () => {
    // Deploy units ghép DATABASE_URL trần (không percent-encode) — mật khẩu có
    // thể chứa `% @ : / ? #`. `new URL` ném lỗi "Invalid URL" trên những ký tự
    // đó; node-postgres thì nhận nguyên. Ghép chuỗi phải giữ mọi ký tự.
    const raw = `postgresql://migrator:S3nt1n3l-Bo'x1%@:/?#@localhost:5432/db-x`;
    const url = withConnectionOptions(raw, [`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`]);
    expect(url.startsWith(raw)).toBe(true);
    expect(url.endsWith(`options=-c%20statement_timeout%3D${STATEMENT_TIMEOUT_MS}`)).toBe(true);
  });
});

describe('decideAdoption', () => {
  it('stamps the journal when a legacy migrated stack has no drizzle history', () => {
    // Stack đã-migrate-cũ bởi runner cũ (catalog là ledger, không có history
    // Drizzle): adopt = stamp toàn bộ journal, migrate sau đó không replay.
    expect(decideAdoption({ historyCovered: false, legacyPresent: true })).toBe('stamp');
  });

  it('no-ops on a fresh database so the first migrate applies for real', () => {
    // Stack trắng: adopt không được stamp — stamp trên DB trắng sẽ đánh dấu
    // mọi migration đã-apply mà không chạy SQL nào, migrate đầu tiên thành
    // no-op và schema không bao giờ tồn tại.
    expect(decideAdoption({ historyCovered: false, legacyPresent: false })).toBe('noop');
  });

  it('no-ops once history already covers the journal', () => {
    // Đã cutover (hoặc adopt chạy lần 2): mọi entry đã trong history.
    expect(decideAdoption({ historyCovered: true, legacyPresent: true })).toBe('noop');
    expect(decideAdoption({ historyCovered: true, legacyPresent: false })).toBe('noop');
  });
});

describe('verifyLedgerChecksums', () => {
  const entries = [
    { tag: '0001_a', when: 1 },
    { tag: '0002_b', when: 2 },
  ];
  const contents: Record<string, string> = {
    '0001_a': 'CREATE TABLE auth.x (id integer);',
    '0002_b': 'ALTER TABLE auth.x ADD COLUMN label text;',
  };
  const checksumOf = (filename: string): string =>
    // Thuật toán của runner cũ (`checksumMigration`): sha256-hex utf8.
    createHash('sha256').update(contents[filename], 'utf-8').digest('hex');

  it('accepts a ledger whose checksums match the files one to one', () => {
    const ledger = entries.map((entry) => ({
      filename: entry.tag,
      checksum: checksumOf(entry.tag),
    }));
    expect(() =>
      verifyLedgerChecksums({ entries, ledger, contentOf: (f) => contents[f] }),
    ).not.toThrow();
  });

  it('joins a ledger filename stored with its .sql suffix against the bare journal tag', () => {
    // Hình thật của lane (chi tiết #375): runner cũ ghi `auth.schema_migrations`
    // với filename kèm `.sql`, journal tag thì không — join phẳng fail closed
    // trên toàn bộ 14 dòng. Chìa khoá phải bỏ suffix; checksum vẫn so theo tag.
    const ledger = entries.map((entry) => ({
      filename: `${entry.tag}.sql`,
      checksum: checksumOf(entry.tag),
    }));
    expect(() =>
      verifyLedgerChecksums({ entries, ledger, contentOf: (f) => contents[f] }),
    ).not.toThrow();
  });

  it('fails closed on a checksum mismatch without writing anything', () => {
    const ledger = [
      { filename: '0001_a', checksum: checksumOf('0001_a') },
      { filename: '0002_b', checksum: 'deadbeef' },
    ];
    expect(() => verifyLedgerChecksums({ entries, ledger, contentOf: (f) => contents[f] })).toThrow(
      /0002_b: checksum mismatch/u,
    );
  });

  it('fails closed when the ledger has a row the journal lacks', () => {
    const ledger = [
      { filename: '0001_a', checksum: checksumOf('0001_a') },
      { filename: '0003_c', checksum: 'whatever' },
    ];
    expect(() => verifyLedgerChecksums({ entries, ledger, contentOf: (f) => contents[f] })).toThrow(
      /0003_c: ledger row has no journal entry/u,
    );
  });

  it('fails closed when the journal has an entry the ledger lacks', () => {
    const ledger = [{ filename: '0001_a', checksum: checksumOf('0001_a') }];
    expect(() => verifyLedgerChecksums({ entries, ledger, contentOf: (f) => contents[f] })).toThrow(
      /0002_b: journal entry missing from the legacy ledger/u,
    );
  });
});

describe('readJournalEntries', () => {
  it('reads tag and when from a well-formed journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-ok-'));
    try {
      mkdirSync(join(dir, 'meta'), { recursive: true });
      writeFileSync(
        join(dir, 'meta', '_journal.json'),
        JSON.stringify({
          entries: [
            { tag: '0000_a', when: 1 },
            { tag: '0001_b', when: 2 },
          ],
        }),
      );
      expect(readJournalEntries(dir, dir)).toEqual([
        { tag: '0000_a', when: 1 },
        { tag: '0001_b', when: 2 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the journal file is missing', () => {
    expect(() => readJournalEntries(projectRoot, 'does-not-exist')).toThrow(/journal not found/u);
  });

  it('fails closed when an entry lacks tag or when', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-bad-'));
    try {
      mkdirSync(join(dir, 'meta'), { recursive: true });
      writeFileSync(
        join(dir, 'meta', '_journal.json'),
        JSON.stringify({ entries: [{ tag: '0000_x' }] }),
      );
      expect(() => readJournalEntries(dir, dir)).toThrow(/missing tag or when/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the journal has no entries array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-empty-'));
    try {
      mkdirSync(join(dir, 'meta'), { recursive: true });
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({}));
      expect(() => readJournalEntries(dir, dir)).toThrow(/no entries array/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
