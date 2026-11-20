import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.ts';

describe('cli argument parsing', () => {
  it('parses a validate invocation with value and boolean flags', () => {
    const { subcommand, flags } = parseArgs([
      'validate',
      '--database',
      'db-remote-cache',
      '--confirm-disposable-target',
      '--migrator-role',
      'ecoma_remote_cache_migrator',
    ]);
    expect(subcommand).toBe('validate');
    expect(flags.get('--database')).toBe('db-remote-cache');
    expect(flags.get('--confirm-disposable-target')).toBe(true);
    expect(flags.get('--migrator-role')).toBe('ecoma_remote_cache_migrator');
  });

  it('refuses an unknown subcommand', () => {
    expect(() => parseArgs(['destroy'])).toThrow(/usage/u);
    expect(() => parseArgs([])).toThrow(/usage/u);
  });

  it('refuses unknown flags — no silent pass-through of a typo', () => {
    expect(() => parseArgs(['capture', '--datbase', 'db-account'])).toThrow(/unknown argument/u);
  });

  it('refuses a value flag without a value and a duplicated flag', () => {
    expect(() => parseArgs(['capture', '--out'])).toThrow(/requires a value/u);
    expect(() => parseArgs(['capture', '--database', 'a', '--database', 'b'])).toThrow(
      /more than once/u,
    );
  });
});
