import { describe, expect, it } from 'vitest';

import {
  migrationsProjectPath,
  PG_DATABASES,
  resolveCandidateIdentity,
  resolveDatabase,
  unresolvedBlockers,
  WORKSPACE_ROOT,
} from './contract.ts';

describe('database inventory resolution', () => {
  it('resolves every PostgreSQL database of the 3a.1 inventory to its migration authority', () => {
    expect(PG_DATABASES).toHaveLength(11);
    for (const contract of PG_DATABASES) {
      expect(resolveDatabase(contract.database)).toEqual(contract);
    }
    expect(resolveDatabase('db-remote-cache').migrationsProject).toBe('remote-cache-db');
    expect(resolveDatabase('db-account').migrationsProject).toBe('account-db');
  });

  it('refuses a database outside the inventory instead of guessing its authority', () => {
    expect(() => resolveDatabase('db-payment')).toThrow(/unknown PostgreSQL database/u);
    expect(() => resolveDatabase('mail')).toThrow(/unknown PostgreSQL database/u);
    expect(() => resolveDatabase('')).toThrow(/unknown PostgreSQL database/u);
  });

  it('maps the contract name to the deploys/<slug>-db project path', () => {
    expect(migrationsProjectPath(resolveDatabase('db-remote-cache'))).toBe(
      `${WORKSPACE_ROOT}/databases/remote-cache-db`,
    );
  });
});

describe('candidate identity resolution', () => {
  it('resolves the exact candidate identity from a release manifest', () => {
    expect(resolveCandidateIdentity({ manifest: { sha: 'abc123', version: '1.2.3' } })).toEqual({
      commitSha: 'abc123',
      version: '1.2.3',
    });
    // `commit` là alias của `sha` trong mẫu build-manifest.
    expect(resolveCandidateIdentity({ manifest: { commit: 'def456', version: '2.0.0' } })).toEqual({
      commitSha: 'def456',
      version: '2.0.0',
    });
  });

  it('accepts explicit flags without a manifest', () => {
    expect(resolveCandidateIdentity({ commitSha: 'abc123', version: '1.2.3' })).toEqual({
      commitSha: 'abc123',
      version: '1.2.3',
    });
  });

  it('lets explicit flags fill what the manifest omits', () => {
    expect(
      resolveCandidateIdentity({ manifest: { version: '1.2.3' }, commitSha: 'abc123' }),
    ).toEqual({ commitSha: 'abc123', version: '1.2.3' });
  });

  it('refuses conflicting inputs instead of silently picking one side', () => {
    expect(() =>
      resolveCandidateIdentity({
        manifest: { sha: 'abc123', version: '1.2.3' },
        commitSha: 'zzz999',
      }),
    ).toThrow(/candidate identity conflict/u);
    expect(() =>
      resolveCandidateIdentity({
        manifest: { sha: 'abc123', version: '1.2.3' },
        version: '9.9.9',
      }),
    ).toThrow(/candidate identity conflict/u);
  });

  it('refuses an incomplete identity — evidence never attaches to a half identity', () => {
    expect(() => resolveCandidateIdentity({ commitSha: 'abc123' })).toThrow(/incomplete/u);
    expect(() => resolveCandidateIdentity({ version: '1.2.3' })).toThrow(/incomplete/u);
    expect(() => resolveCandidateIdentity({})).toThrow(/incomplete/u);
    expect(() => resolveCandidateIdentity({ commitSha: '', version: '1.2.3' })).toThrow(
      /empty SHA or version/u,
    );
  });
});

describe('pre-flight blockers', () => {
  it('reports no blockers for a database whose authority project exists on the tree', () => {
    expect(unresolvedBlockers(resolveDatabase('db-remote-cache'))).toEqual([]);
  });
});
