import { describe, expect, it } from 'vitest';

import * as marketplaceSurface from './index';
import {
  MAX_CREDENTIAL_HASH_LENGTH,
  MAX_CREDENTIAL_PLAINTEXT_LENGTH,
  PROVIDER_CREDENTIAL_INTERNAL_FIELDS,
  assertCredentialProvider,
  createProviderCredential,
  createProviderCredentialId,
  createSellerActorId,
  createSellerTenantId,
  isCredentialHash,
  isCredentialLabel,
  isCredentialPlaintext,
  isProviderCredential,
  isProviderCredentialActive,
  isPublicProviderCredentialShape,
  revokeProviderCredential,
  toPublicProviderCredential,
  type ProviderCredential,
} from './index';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

const AT = 1_700_000_000_000;
const HASH = 'sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const TENANT = createSellerTenantId('tenant-1');
const OTHER_TENANT = createSellerTenantId('tenant-2');

function credential(overrides: Record<string, unknown> = {}): ProviderCredential {
  return expectOk(
    createProviderCredential({
      id: createProviderCredentialId('cred-1'),
      provider: 'openai',
      sellerTenantId: TENANT,
      credentialHash: HASH,
      plaintext: 'sk-test-abc',
      createdBy: createSellerActorId('sub-1'),
      createdAt: AT,
      ...overrides,
    }),
  ).credential;
}

describe('isCredentialHash', () => {
  it('accepts an opaque printable hash at the length boundary', () => {
    expect(isCredentialHash(HASH)).toBe(true);
    expect(isCredentialHash('a'.repeat(MAX_CREDENTIAL_HASH_LENGTH))).toBe(true);
  });

  it('rejects empty, padded, whitespace-bearing and over-limit hashes', () => {
    expect(isCredentialHash('')).toBe(false);
    expect(isCredentialHash(' hash')).toBe(false);
    expect(isCredentialHash('hash ')).toBe(false);
    expect(isCredentialHash('ha sh')).toBe(false);
    expect(isCredentialHash('a'.repeat(MAX_CREDENTIAL_HASH_LENGTH + 1))).toBe(false);
    expect(isCredentialHash(null)).toBe(false);
  });
});

describe('isCredentialPlaintext', () => {
  it('accepts any non-empty string at the length boundary', () => {
    expect(isCredentialPlaintext('sk-test')).toBe(true);
    expect(isCredentialPlaintext('a'.repeat(MAX_CREDENTIAL_PLAINTEXT_LENGTH))).toBe(true);
  });

  it('rejects empty and over-limit plaintext', () => {
    expect(isCredentialPlaintext('')).toBe(false);
    expect(isCredentialPlaintext('a'.repeat(MAX_CREDENTIAL_PLAINTEXT_LENGTH + 1))).toBe(false);
    expect(isCredentialPlaintext(42)).toBe(false);
  });
});

describe('createProviderCredential', () => {
  it('records the owning Seller tenant and returns the stored record without plaintext plus the plaintext exactly once', () => {
    const created = expectOk(
      createProviderCredential({
        id: createProviderCredentialId('cred-1'),
        provider: 'openai',
        sellerTenantId: TENANT,
        credentialHash: HASH,
        plaintext: 'sk-test-abc',
        createdBy: createSellerActorId('sub-1'),
        createdAt: AT,
      }),
    );
    expect(created.plaintext).toBe('sk-test-abc');
    expect(Object.hasOwn(created.credential, 'plaintext')).toBe(false);
    expect(created.credential.sellerTenantId).toBe('tenant-1');
    expect(created.credential.credentialHash).toBe(HASH);
    expect(created.credential.revokedAt).toBeNull();
    expect(created.credential.revokedBy).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.credential)).toBe(true);
    expect(isProviderCredentialActive(created.credential)).toBe(true);
  });

  it.each([
    [{ id: '' }, 'invalid_provider_credential_id'],
    [{ provider: 'OpenAI' }, 'invalid_provider_key'],
    [{ sellerTenantId: '' }, 'invalid_seller_tenant_id'],
    [{ credentialHash: '' }, 'invalid_credential_hash'],
    [{ credentialHash: 'ha sh' }, 'invalid_credential_hash'],
    [{ plaintext: '' }, 'invalid_credential_plaintext'],
    [{ createdBy: '' }, 'invalid_actor'],
    [{ createdAt: 'now' }, 'invalid_timestamp'],
  ] as const)('rejects invalid input %j', (overrides, code) => {
    expect(
      expectRejection(
        createProviderCredential({
          id: createProviderCredentialId('cred-1'),
          provider: 'openai',
          sellerTenantId: TENANT,
          credentialHash: HASH,
          plaintext: 'sk-test-abc',
          createdBy: createSellerActorId('sub-1'),
          createdAt: AT,
          ...(overrides as object),
        }),
      ),
    ).toBe(code);
  });

  it('rejects a duplicate credential id', () => {
    expect(
      expectRejection(
        createProviderCredential({
          id: createProviderCredentialId('cred-1'),
          provider: 'openai',
          sellerTenantId: TENANT,
          credentialHash: HASH,
          plaintext: 'sk-test-abc',
          createdBy: createSellerActorId('sub-1'),
          createdAt: AT,
          existing: [credential()],
        }),
      ),
    ).toBe('duplicate_provider_credential_id');
  });

  it('rejects a malformed existing list', () => {
    expect(
      expectRejection(
        createProviderCredential({
          id: createProviderCredentialId('cred-2'),
          provider: 'openai',
          sellerTenantId: TENANT,
          credentialHash: HASH,
          plaintext: 'sk-test-abc',
          createdBy: createSellerActorId('sub-1'),
          createdAt: AT,
          existing: [{ bad: true }] as unknown as readonly ProviderCredential[],
        }),
      ),
    ).toBe('invalid_provider_credential');
    expect(
      expectRejection(
        createProviderCredential({
          id: createProviderCredentialId('cred-2'),
          provider: 'openai',
          sellerTenantId: TENANT,
          credentialHash: HASH,
          plaintext: 'sk-test-abc',
          createdBy: createSellerActorId('sub-1'),
          createdAt: AT,
          existing: 'nope' as unknown as readonly ProviderCredential[],
        }),
      ),
    ).toBe('ambiguous_context');
  });
});

describe('revokeProviderCredential', () => {
  it('revokes once and stamps actor plus time', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 10,
      }),
    );
    expect(revoked.revokedAt).toBe(AT + 10);
    expect(revoked.revokedBy).toBe('sub-2');
    expect(isProviderCredentialActive(revoked)).toBe(false);
    expect(Object.isFrozen(revoked)).toBe(true);
  });

  it('rejects a second revoke without overwriting the audit data', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 10,
      }),
    );
    expect(
      expectRejection(
        revokeProviderCredential({
          credential: revoked,
          revokedBy: createSellerActorId('sub-3'),
          revokedAt: AT + 20,
        }),
      ),
    ).toBe('credential_already_revoked');
  });

  it('rejects a revoke timestamp before creation', () => {
    expect(
      expectRejection(
        revokeProviderCredential({
          credential: credential(),
          revokedBy: createSellerActorId('sub-2'),
          revokedAt: AT - 1,
        }),
      ),
    ).toBe('timestamp_regression');
  });

  it('rejects invalid input, actor, timestamp and record', () => {
    expect(
      expectRejection(
        revokeProviderCredential({
          credential: { bad: true } as unknown as ProviderCredential,
          revokedBy: createSellerActorId('sub-2'),
          revokedAt: AT,
        }),
      ),
    ).toBe('invalid_provider_credential');
    expect(
      expectRejection(
        revokeProviderCredential({ credential: credential(), revokedBy: '', revokedAt: AT }),
      ),
    ).toBe('invalid_actor');
    expect(
      expectRejection(
        revokeProviderCredential({
          credential: credential(),
          revokedBy: createSellerActorId('sub-2'),
          revokedAt: 1.5,
        }),
      ),
    ).toBe('invalid_timestamp');
  });
});

describe('isProviderCredentialActive', () => {
  it('fails closed for an invalid record', () => {
    expect(isProviderCredentialActive({ bad: true } as unknown as ProviderCredential)).toBe(false);
  });

  it('requires both revoked fields to be null', () => {
    expect(
      isProviderCredentialActive({ ...credential(), revokedAt: AT + 1, revokedBy: null } as never),
    ).toBe(false);
  });
});

describe('assertCredentialProvider — two independent scope axes', () => {
  it('accepts a matching active credential for its owning tenant and returns the same record', () => {
    const record = credential();
    expect(expectOk(assertCredentialProvider(record, 'openai', TENANT))).toBe(record);
  });

  it('rejects a wrong provider (axis a)', () => {
    expect(expectRejection(assertCredentialProvider(credential(), 'anthropic', TENANT))).toBe(
      'credential_provider_mismatch',
    );
  });

  it('rejects cross-tenant use with credential_tenant_mismatch (axis b)', () => {
    expect(expectRejection(assertCredentialProvider(credential(), 'openai', OTHER_TENANT))).toBe(
      'credential_tenant_mismatch',
    );
  });

  it('rejects a revoked credential for its own provider and tenant (axis c)', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 1,
      }),
    );
    expect(expectRejection(assertCredentialProvider(revoked, 'openai', TENANT))).toBe(
      'credential_revoked',
    );
  });

  it('checks the provider before the revocation state', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 1,
      }),
    );
    expect(expectRejection(assertCredentialProvider(revoked, 'anthropic', TENANT))).toBe(
      'credential_provider_mismatch',
    );
  });

  it('checks the owning tenant before the revocation state', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 1,
      }),
    );
    expect(expectRejection(assertCredentialProvider(revoked, 'openai', OTHER_TENANT))).toBe(
      'credential_tenant_mismatch',
    );
  });

  it('reports the provider axis first when provider and tenant both mismatch', () => {
    expect(expectRejection(assertCredentialProvider(credential(), 'anthropic', OTHER_TENANT))).toBe(
      'credential_provider_mismatch',
    );
  });

  it('each axis fails independently of the others', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 1,
      }),
    );
    const matrix: readonly {
      readonly provider: string;
      readonly tenant: typeof TENANT | typeof OTHER_TENANT;
      readonly code: string;
    }[] = [
      { provider: 'anthropic', tenant: OTHER_TENANT, code: 'credential_provider_mismatch' },
      { provider: 'openai', tenant: OTHER_TENANT, code: 'credential_tenant_mismatch' },
      { provider: 'openai', tenant: TENANT, code: 'credential_revoked' },
    ];
    for (const { provider, tenant, code } of matrix) {
      expect(expectRejection(assertCredentialProvider(revoked, provider, tenant))).toBe(code);
    }
  });

  it('rejects an invalid credential, provider or tenant', () => {
    expect(
      expectRejection(
        assertCredentialProvider({ bad: true } as unknown as ProviderCredential, 'openai', TENANT),
      ),
    ).toBe('invalid_provider_credential');
    expect(expectRejection(assertCredentialProvider(credential(), 'OpenAI', TENANT))).toBe(
      'invalid_provider_key',
    );
    expect(expectRejection(assertCredentialProvider(credential(), 'openai', ''))).toBe(
      'invalid_seller_tenant_id',
    );
  });

  it('keeps two seller tenants on the same upstream provider independent — no shared credential path', () => {
    const first = credential();
    const second = expectOk(
      createProviderCredential({
        id: createProviderCredentialId('cred-2'),
        provider: 'openai',
        sellerTenantId: OTHER_TENANT,
        credentialHash: HASH,
        plaintext: 'sk-test-abc',
        createdBy: createSellerActorId('sub-9'),
        createdAt: AT,
      }),
    ).credential;
    expect(first.provider).toBe(second.provider);
    expect(first.sellerTenantId).not.toBe(second.sellerTenantId);
    expect(first.id).not.toBe(second.id);
    expect(expectOk(assertCredentialProvider(first, 'openai', TENANT)).id).toBe('cred-1');
    expect(expectOk(assertCredentialProvider(second, 'openai', OTHER_TENANT)).id).toBe('cred-2');
    expect(expectRejection(assertCredentialProvider(first, 'openai', OTHER_TENANT))).toBe(
      'credential_tenant_mismatch',
    );
    expect(expectRejection(assertCredentialProvider(second, 'openai', TENANT))).toBe(
      'credential_tenant_mismatch',
    );
  });
});

describe('isProviderCredential', () => {
  it('accepts a created record', () => {
    expect(isProviderCredential(credential())).toBe(true);
  });

  it('rejects a revokedAt without revokedBy and vice versa', () => {
    expect(isProviderCredential({ ...credential(), revokedAt: AT + 1, revokedBy: null })).toBe(
      false,
    );
    expect(isProviderCredential({ ...credential(), revokedAt: null, revokedBy: 'sub-2' })).toBe(
      false,
    );
  });

  it('rejects a revoke timestamp before creation', () => {
    expect(isProviderCredential({ ...credential(), revokedAt: AT - 1, revokedBy: 'sub-2' })).toBe(
      false,
    );
  });

  it('rejects broken field shapes', () => {
    expect(isProviderCredential(null)).toBe(false);
    expect(isProviderCredential({ ...credential(), credentialHash: 'ha sh' })).toBe(false);
    expect(isProviderCredential({ ...credential(), provider: 'OpenAI' })).toBe(false);
    expect(isProviderCredential({ ...credential(), sellerTenantId: '' })).toBe(false);
    expect(isProviderCredential({ ...credential(), createdAt: 1.2 })).toBe(false);
  });
});

describe('toPublicProviderCredential', () => {
  it('projects only public fields and never the hash or actors', () => {
    const publicView = toPublicProviderCredential(credential());
    expect(publicView).toEqual({
      id: 'cred-1',
      provider: 'openai',
      createdAt: AT,
      revokedAt: null,
    });
    expect(Object.isFrozen(publicView)).toBe(true);
    expect(isPublicProviderCredentialShape(publicView)).toBe(true);
    expect(Object.hasOwn(publicView, 'credentialHash')).toBe(false);
  });

  it('keeps the revocation time in the projection', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 7,
      }),
    );
    expect(toPublicProviderCredential(revoked).revokedAt).toBe(AT + 7);
  });

  it('throws TypeError for an invalid record instead of returning a partial projection', () => {
    expect(() =>
      toPublicProviderCredential({ bad: true } as unknown as ProviderCredential),
    ).toThrow(TypeError);
  });
});

describe('isPublicProviderCredentialShape', () => {
  it('detects any internal field, including plaintext', () => {
    for (const field of PROVIDER_CREDENTIAL_INTERNAL_FIELDS) {
      expect(isPublicProviderCredentialShape({ id: 'cred-1', [field]: 'x' })).toBe(false);
    }
    expect(isPublicProviderCredentialShape(null)).toBe(false);
  });

  it('lists exactly the internal fields, including the owning tenant', () => {
    expect([...PROVIDER_CREDENTIAL_INTERNAL_FIELDS]).toEqual([
      'credentialHash',
      'sellerTenantId',
      'createdBy',
      'revokedBy',
      'plaintext',
    ]);
    expect(Object.isFrozen(PROVIDER_CREDENTIAL_INTERNAL_FIELDS)).toBe(true);
  });

  it('projects without hash, owning tenant or actors even after the record gains fields', () => {
    const publicView = toPublicProviderCredential(credential());
    expect(Object.hasOwn(publicView, 'credentialHash')).toBe(false);
    expect(Object.hasOwn(publicView, 'sellerTenantId')).toBe(false);
    expect(isPublicProviderCredentialShape(publicView)).toBe(true);
  });
});

describe('credential public surface', () => {
  it('exports no lookup-by-provider or cross-tenant credential resolution', () => {
    // ADR-0027 §8 / marketplace §3.7: chọn credential chỉ resolve trong tập
    // credential của Seller tenant sở hữu offer — không lookup theo provider
    // xuyên tenant. Assertion âm trên exported surface, không grep filesystem.
    const credentialExports = Object.keys(marketplaceSurface)
      .filter((name) => /credential/iu.test(name))
      .toSorted();
    expect(credentialExports).toEqual([
      'MAX_CREDENTIAL_HASH_LENGTH',
      'MAX_CREDENTIAL_PLAINTEXT_LENGTH',
      'PROVIDER_CREDENTIAL_INTERNAL_FIELDS',
      'assertCredentialProvider',
      'createProviderCredential',
      'createProviderCredentialId',
      'isCredentialHash',
      'isCredentialLabel',
      'isCredentialPlaintext',
      'isProviderCredential',
      'isProviderCredentialActive',
      'isProviderCredentialId',
      'isPublicProviderCredentialShape',
      'revokeProviderCredential',
      'toPublicProviderCredential',
    ]);
  });
});

describe('isCredentialLabel', () => {
  it('is the opaque label guard re-exported for credential consumers', () => {
    expect(isCredentialLabel('restriction_active')).toBe(true);
    expect(isCredentialLabel('')).toBe(false);
  });
});
