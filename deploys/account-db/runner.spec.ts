import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MIGRATION_LOCK_KEY,
  STATEMENT_TIMEOUT_MS,
  decideAdoption,
  parseArgs,
  readJournalEntries,
  withStatementTimeout,
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
    // Runner cũ `apps/account/db/apply.mts` khóa bằng
    // `pg_advisory_lock(hashtext('db-account'))` — PostgreSQL 17 trả
    // -1206903334. Đổi khóa khi cutover là phá mutual exclusion với stack cũ.
    expect(MIGRATION_LOCK_KEY).toBe(153_835_401n);
  });
});

describe('withStatementTimeout', () => {
  it('injects statement_timeout into a bare connection URL', () => {
    const url = withStatementTimeout(
      'postgresql://migrator:pw@db.internal:5432/db-account',
      300_000,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('options')).toBe(`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
    expect(parsed.pathname).toBe('/db-account');
  });

  it('preserves existing options and query parameters', () => {
    const url = withStatementTimeout(
      'postgresql://migrator@localhost/db?application_name=migrator&options=-c search_path%3Dpublic',
      1_000,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('application_name')).toBe('migrator');
    expect(parsed.searchParams.get('options')).toBe(
      '-c search_path=public -c statement_timeout=1000',
    );
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
