import { describe, expect, it } from 'vitest';

import {
  REMOTE_CACHE_TENANT_STATUS,
  REMOTE_CACHE_TENANT_STATUS_REJECTED,
  REMOTE_CACHE_TENANT_STATUSES,
  isRemoteCacheTenantStatus,
  isRemoteCacheTenantStatusActive,
} from './tenant-status';

describe('remote-cache tenant lifecycle status', () => {
  it('exposes exactly the three lifecycle states of the spec', () => {
    expect([...REMOTE_CACHE_TENANT_STATUSES].toSorted()).toEqual(
      ['active', 'deleted', 'suspended'].toSorted(),
    );
    expect(Object.keys(REMOTE_CACHE_TENANT_STATUS).toSorted()).toEqual(
      ['active', 'deleted', 'suspended'].toSorted(),
    );
  });

  it('accepts every listed status and rejects everything else', () => {
    for (const status of REMOTE_CACHE_TENANT_STATUSES) {
      expect(isRemoteCacheTenantStatus(status)).toBe(true);
    }
    expect(isRemoteCacheTenantStatus('Active')).toBe(false);
    expect(isRemoteCacheTenantStatus('terminated')).toBe(false);
    expect(isRemoteCacheTenantStatus('')).toBe(false);
    expect(isRemoteCacheTenantStatus(null)).toBe(false);
    expect(isRemoteCacheTenantStatus(undefined)).toBe(false);
    expect(isRemoteCacheTenantStatus(42)).toBe(false);
  });

  it('isRemoteCacheTenantStatusActive returns true only for active', () => {
    expect(isRemoteCacheTenantStatusActive('active')).toBe(true);
    expect(isRemoteCacheTenantStatusActive('suspended')).toBe(false);
    expect(isRemoteCacheTenantStatusActive('deleted')).toBe(false);
  });

  it('REMOTE_CACHE_TENANT_STATUS_REJECTED contains suspended and deleted only', () => {
    expect([...REMOTE_CACHE_TENANT_STATUS_REJECTED].toSorted()).toEqual(
      ['deleted', 'suspended'].toSorted(),
    );
    for (const status of REMOTE_CACHE_TENANT_STATUS_REJECTED) {
      expect(isRemoteCacheTenantStatusActive(status)).toBe(false);
    }
  });
});
