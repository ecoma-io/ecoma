import { describe, expect, it } from 'vitest';

import {
  StaffAccessAppConfigurationError,
  loadStaffAccessConfig,
  resolveInternalSecret,
} from './config';

describe('loadStaffAccessConfig — fail-closed', () => {
  it('accepts a complete configuration', () => {
    const config = loadStaffAccessConfig({
      DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
      AUTH_INTERNAL_SECRET: 'current-secret',
    });
    expect(config.hyperdrive.connectionString).toBe('postgres://x');
    expect(config.internalSecret).toBe('current-secret');
    expect(config.internalSecretsByKid.size).toBe(0);
  });

  it('rejects a missing Hyperdrive binding', () => {
    expect(() => loadStaffAccessConfig({})).toThrow(StaffAccessAppConfigurationError);
  });

  it('rejects a missing internal secret', () => {
    expect(() =>
      loadStaffAccessConfig({ DB_STAFF_ACCESS: { connectionString: 'postgres://x' } }),
    ).toThrow(StaffAccessAppConfigurationError);
  });

  it('rejects malformed skew', () => {
    expect(() =>
      loadStaffAccessConfig({
        DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
        AUTH_INTERNAL_SECRET: 'current-secret',
        AUTH_INTERNAL_SKEW_SECONDS: 'not-a-number',
      }),
    ).toThrow(StaffAccessAppConfigurationError);
  });
});

describe('resolveInternalSecret — the resolver of the internal envelope', () => {
  it('resolves the secret of the registered current kid', async () => {
    const config = loadStaffAccessConfig({
      DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
      AUTH_INTERNAL_SECRET: 'current-secret',
      AUTH_INTERNAL_KID: '0123abcd',
    });
    const resolve = resolveInternalSecret(config);
    await expect(resolve('0123abcd')).resolves.toBe('current-secret');
  });

  it('resolves the secret of the registered previous kid', async () => {
    const config = loadStaffAccessConfig({
      DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
      AUTH_INTERNAL_SECRET: 'current-secret',
      AUTH_INTERNAL_KID: '0123abcd',
      AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
      AUTH_INTERNAL_PREVIOUS_SECRET: 'previous-secret',
    });
    const resolve = resolveInternalSecret(config);
    await expect(resolve('abcd0123')).resolves.toBe('previous-secret');
  });

  it('throws for an unknown kid', async () => {
    const config = loadStaffAccessConfig({
      DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
      AUTH_INTERNAL_SECRET: 'current-secret',
      AUTH_INTERNAL_KID: '0123abcd',
    });
    const resolve = resolveInternalSecret(config);
    await expect(resolve('ffffffff')).rejects.toThrow(/unknown internal kid/iu);
  });

  it('throws for any kid when no kid is configured', async () => {
    const config = loadStaffAccessConfig({
      DB_STAFF_ACCESS: { connectionString: 'postgres://x' },
      AUTH_INTERNAL_SECRET: 'current-secret',
    });
    const resolve = resolveInternalSecret(config);
    await expect(resolve('0123abcd')).rejects.toThrow(/unknown internal kid/iu);
  });
});
