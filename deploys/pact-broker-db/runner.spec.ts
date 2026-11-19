import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseArgs,
  readJournalEntries,
  STATEMENT_TIMEOUT_MS,
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

describe('withStatementTimeout', () => {
  it('injects statement_timeout into a bare connection URL', () => {
    const url = withStatementTimeout(
      'postgresql://migrator:pw@db.internal:5432/db-pact-broker',
      300_000,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('options')).toBe(`-c statement_timeout=${STATEMENT_TIMEOUT_MS}`);
    expect(parsed.pathname).toBe('/db-pact-broker');
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
