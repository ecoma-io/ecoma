import { describe, expect, it } from 'vitest';

import {
  MAX_CREDENTIAL_HASH_LENGTH,
  MAX_CREDENTIAL_PLAINTEXT_LENGTH,
  PROVIDER_CREDENTIAL_INTERNAL_FIELDS,
  assertCredentialProvider,
  createProviderCredential,
  createProviderCredentialId,
  createSellerActorId,
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

function credential(overrides: Record<string, unknown> = {}): ProviderCredential {
  return expectOk(
    createProviderCredential({
      id: createProviderCredentialId('cred-1'),
      provider: 'openai',
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
  it('returns the stored record without plaintext plus the plaintext exactly once', () => {
    const created = expectOk(
      createProviderCredential({
        id: createProviderCredentialId('cred-1'),
        provider: 'openai',
        credentialHash: HASH,
        plaintext: 'sk-test-abc',
        createdBy: createSellerActorId('sub-1'),
        createdAt: AT,
      }),
    );
    expect(created.plaintext).toBe('sk-test-abc');
    expect(Object.hasOwn(created.credential, 'plaintext')).toBe(false);
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

describe('assertCredentialProvider', () => {
  it('accepts a matching active credential and returns the same record', () => {
    const record = credential();
    expect(expectOk(assertCredentialProvider(record, 'openai'))).toBe(record);
  });

  it('checks the provider before the revocation state', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 1,
      }),
    );
    expect(expectRejection(assertCredentialProvider(revoked, 'anthropic'))).toBe(
      'credential_provider_mismatch',
    );
  });

  it('rejects reusing a revoked credential for its own provider', () => {
    const revoked = expectOk(
      revokeProviderCredential({
        credential: credential(),
        revokedBy: createSellerActorId('sub-2'),
        revokedAt: AT + 1,
      }),
    );
    expect(expectRejection(assertCredentialProvider(revoked, 'openai'))).toBe('credential_revoked');
  });

  it('rejects an invalid credential or provider', () => {
    expect(
      expectRejection(
        assertCredentialProvider({ bad: true } as unknown as ProviderCredential, 'openai'),
      ),
    ).toBe('invalid_provider_credential');
    expect(expectRejection(assertCredentialProvider(credential(), 'OpenAI'))).toBe(
      'invalid_provider_key',
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

  it('lists exactly the internal fields', () => {
    expect([...PROVIDER_CREDENTIAL_INTERNAL_FIELDS]).toEqual([
      'credentialHash',
      'createdBy',
      'revokedBy',
      'plaintext',
    ]);
    expect(Object.isFrozen(PROVIDER_CREDENTIAL_INTERNAL_FIELDS)).toBe(true);
  });
});

describe('isCredentialLabel', () => {
  it('is the opaque label guard re-exported for credential consumers', () => {
    expect(isCredentialLabel('restriction_active')).toBe(true);
    expect(isCredentialLabel('')).toBe(false);
  });
});
