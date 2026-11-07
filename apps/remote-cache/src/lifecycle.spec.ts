import { describe, expect, it, vi, beforeEach } from 'vitest';

import { getTenantById } from '@ecoma-io/remote-cache-infrastructure';
import {
  TenantLifecycleCache,
  LIFECACHE_TTL_MS,
  isTenantLifecycleAllowed,
  enforceTenantLifecycle,
  getTenantStatusFromDb,
} from './lifecycle';

vi.mock('@ecoma-io/remote-cache-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/remote-cache-infrastructure')>();
  return {
    ...actual,
    getTenantById: vi.fn<() => unknown>(),
  };
});

const mockedGetTenantById = getTenantById as unknown as ReturnType<typeof vi.fn>;

const TENANT_ID = 'tenant-123';
const ACTIVE_ROW = {
  id: TENANT_ID,
  name: 't',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  mockedGetTenantById.mockReset();
});

describe('TenantLifecycleCache', () => {
  it('returns null for missing tenant', () => {
    const cache = new TenantLifecycleCache();
    expect(cache.get('unknown')).toBeNull();
  });

  it('returns status after set and expires after TTL', () => {
    vi.useFakeTimers();
    try {
      const cache = new TenantLifecycleCache(50);
      cache.set('tenant-1', 'active');
      expect(cache.get('tenant-1')).toBe('active');

      vi.setSystemTime(Date.now() + 100);
      expect(cache.get('tenant-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates entry on demand', () => {
    const cache = new TenantLifecycleCache();
    cache.set('tenant-1', 'active');
    expect(cache.get('tenant-1')).toBe('active');
    cache.invalidate('tenant-1');
    expect(cache.get('tenant-1')).toBeNull();
  });
});

describe('LIFECACHE_TTL_MS', () => {
  it('is a positive short TTL', () => {
    expect(LIFECACHE_TTL_MS).toBeGreaterThan(0);
    expect(LIFECACHE_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('isTenantLifecycleAllowed', () => {
  it('returns true only for active status', () => {
    expect(isTenantLifecycleAllowed('active')).toBe(true);
    expect(isTenantLifecycleAllowed('suspended')).toBe(false);
    expect(isTenantLifecycleAllowed('deleted')).toBe(false);
    expect(isTenantLifecycleAllowed(null)).toBe(false);
  });

  it('returns false for unknown status outside the union (fail-closed)', () => {
    expect(isTenantLifecycleAllowed('terminated')).toBe(false);
    expect(isTenantLifecycleAllowed('Active')).toBe(false);
    expect(isTenantLifecycleAllowed('')).toBe(false);
  });
});

describe('getTenantStatusFromDb', () => {
  it('returns null when tenant not found', async () => {
    mockedGetTenantById.mockResolvedValue(null);
    const db = {} as never;
    const status = await getTenantStatusFromDb(db, TENANT_ID);
    expect(status).toBeNull();
  });

  it('returns tenant status from DB', async () => {
    mockedGetTenantById.mockResolvedValue(ACTIVE_ROW);
    const db = {} as never;
    const status = await getTenantStatusFromDb(db, TENANT_ID);
    expect(status).toBe('active');
  });

  it('throws tenant_lookup_failed domain error when DB lookup fails', async () => {
    mockedGetTenantById.mockRejectedValue(new Error('DB connection lost'));
    const db = {} as never;
    await expect(getTenantStatusFromDb(db, TENANT_ID)).rejects.toMatchObject({
      code: 'tenant_lookup_failed',
    });
  });
});

describe('enforceTenantLifecycle', () => {
  it('allows active tenant', async () => {
    mockedGetTenantById.mockResolvedValue(ACTIVE_ROW);
    const status = await enforceTenantLifecycle({} as never, TENANT_ID, true);
    expect(status).toBe('active');
    expect(mockedGetTenantById).toHaveBeenCalledTimes(1);
  });

  it('always queries DB even on read path (useCache=true, fail-closed)', async () => {
    mockedGetTenantById.mockResolvedValue(ACTIVE_ROW);
    await enforceTenantLifecycle({} as never, TENANT_ID, true);
    await enforceTenantLifecycle({} as never, TENANT_ID, true);
    // Both calls hit the DB — no cache short-circuit on read path.
    expect(mockedGetTenantById).toHaveBeenCalledTimes(2);
  });

  it('rejects suspended tenant', async () => {
    mockedGetTenantById.mockResolvedValue({ ...ACTIVE_ROW, status: 'suspended' });
    await expect(enforceTenantLifecycle({} as never, TENANT_ID, true)).rejects.toMatchObject({
      code: 'tenant_suspended',
    });
  });

  it('rejects deleted tenant', async () => {
    mockedGetTenantById.mockResolvedValue({ ...ACTIVE_ROW, status: 'deleted' });
    await expect(enforceTenantLifecycle({} as never, TENANT_ID, true)).rejects.toMatchObject({
      code: 'tenant_deleted',
    });
  });

  it('rejects missing tenant (fail-closed)', async () => {
    mockedGetTenantById.mockResolvedValue(null);
    await expect(enforceTenantLifecycle({} as never, TENANT_ID, true)).rejects.toMatchObject({
      code: 'tenant_not_found',
    });
  });

  it('rejects tenant lookup failure (fail-closed)', async () => {
    mockedGetTenantById.mockRejectedValue(new Error('DB connection lost'));
    await expect(enforceTenantLifecycle({} as never, TENANT_ID, true)).rejects.toMatchObject({
      code: 'tenant_lookup_failed',
    });
  });
});
