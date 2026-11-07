import { describe, expect, it } from 'vitest';

import {
  MAX_MODEL_NAME_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
  assertProviderModelNameUnique,
  createNormalizedModelIdentity,
  createProviderModelName,
  isNormalizedModelId,
  isNormalizedModelIdentity,
  isProviderKey,
  isProviderModelName,
  mapProviderModelToNormalizedIdentity,
  normalizeModelId,
  type NormalizedModelIdentity,
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

function identity(
  normalizedModelId: string,
  pairs: readonly (readonly [string, string])[],
): NormalizedModelIdentity {
  return expectOk(
    createNormalizedModelIdentity(
      normalizedModelId,
      pairs.map(([provider, model]) => ({ provider, model })),
    ),
  );
}

describe('isProviderKey', () => {
  it('accepts lowercase provider keys', () => {
    expect(isProviderKey('openai')).toBe(true);
    expect(isProviderKey('azure-openai')).toBe(true);
    expect(isProviderKey('my_provider')).toBe(true);
    expect(isProviderKey(`a${'b'.repeat(MAX_PROVIDER_KEY_LENGTH - 1)}`)).toBe(true);
  });

  it('rejects empty, uppercase, leading-digit, spaced and over-limit values', () => {
    expect(isProviderKey('')).toBe(false);
    expect(isProviderKey('OpenAI')).toBe(false);
    expect(isProviderKey('1openai')).toBe(false);
    expect(isProviderKey('open ai')).toBe(false);
    expect(isProviderKey(`a${'b'.repeat(MAX_PROVIDER_KEY_LENGTH)}`)).toBe(false);
    expect(isProviderKey(null)).toBe(false);
  });
});

describe('isProviderModelName', () => {
  it('accepts the raw provider spelling verbatim, including case and dots', () => {
    expect(isProviderModelName('gpt-4o-2024-08-06')).toBe(true);
    expect(isProviderModelName('Claude-3.5-Sonnet')).toBe(true);
    expect(isProviderModelName('a'.repeat(MAX_MODEL_NAME_LENGTH))).toBe(true);
  });

  it('rejects empty, padded, whitespace-containing and over-limit values', () => {
    expect(isProviderModelName('')).toBe(false);
    expect(isProviderModelName(' gpt-4o')).toBe(false);
    expect(isProviderModelName('gpt-4o ')).toBe(false);
    expect(isProviderModelName('gpt 4o')).toBe(false);
    expect(isProviderModelName('a'.repeat(MAX_MODEL_NAME_LENGTH + 1))).toBe(false);
    expect(isProviderModelName(42)).toBe(false);
  });
});

describe('isNormalizedModelId', () => {
  it('accepts canonical lowercase ids', () => {
    expect(isNormalizedModelId('gpt-4o')).toBe(true);
    expect(isNormalizedModelId('claude-3.5-sonnet')).toBe(true);
    expect(isNormalizedModelId('4o-mini')).toBe(true);
    expect(isNormalizedModelId('a_b')).toBe(true);
  });

  it('rejects uppercase, leading punctuation, whitespace and empty values', () => {
    expect(isNormalizedModelId('GPT-4o')).toBe(false);
    expect(isNormalizedModelId('-gpt')).toBe(false);
    expect(isNormalizedModelId('.gpt')).toBe(false);
    expect(isNormalizedModelId('gpt 4o')).toBe(false);
    expect(isNormalizedModelId('')).toBe(false);
  });
});

describe('createProviderModelName', () => {
  it('creates a frozen raw identity', () => {
    const raw = expectOk(createProviderModelName('openai', 'gpt-4o'));
    expect(raw).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(Object.isFrozen(raw)).toBe(true);
  });

  it('rejects an invalid provider or model with the specific code', () => {
    expect(expectRejection(createProviderModelName('OpenAI', 'gpt-4o'))).toBe(
      'invalid_provider_key',
    );
    expect(expectRejection(createProviderModelName('openai', ' gpt-4o'))).toBe(
      'invalid_provider_model_name',
    );
  });
});

describe('createNormalizedModelIdentity', () => {
  it('creates a frozen identity with unique raw names', () => {
    const created = identity('gpt-4o', [
      ['openai', 'gpt-4o'],
      ['azure', 'gpt-4o-2024-08-06'],
    ]);
    expect(created.normalizedModelId).toBe('gpt-4o');
    expect(created.providerModelNames).toHaveLength(2);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.providerModelNames)).toBe(true);
    expect(Object.isFrozen(created.providerModelNames[0])).toBe(true);
  });

  it('accepts an identity with no raw names yet', () => {
    expect(identity('gpt-4o', []).providerModelNames).toEqual([]);
  });

  it('rejects an invalid normalized id', () => {
    expect(expectRejection(createNormalizedModelIdentity('GPT-4o', []))).toBe(
      'invalid_normalized_model_id',
    );
  });

  it('rejects a non-array raw name list', () => {
    expect(expectRejection(createNormalizedModelIdentity('gpt-4o', 'openai/gpt-4o'))).toBe(
      'invalid_provider_model_identity',
    );
  });

  it('rejects an invalid raw name entry', () => {
    expect(
      expectRejection(
        createNormalizedModelIdentity('gpt-4o', [{ provider: 'OpenAI', model: 'gpt-4o' }]),
      ),
    ).toBe('invalid_provider_model_name');
  });

  it('rejects a duplicated raw identity', () => {
    expect(
      expectRejection(
        createNormalizedModelIdentity('gpt-4o', [
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'openai', model: 'gpt-4o' },
        ]),
      ),
    ).toBe('duplicate_provider_model');
  });
});

describe('isNormalizedModelIdentity', () => {
  it('accepts a created identity', () => {
    expect(isNormalizedModelIdentity(identity('gpt-4o', [['openai', 'gpt-4o']]))).toBe(true);
  });

  it('rejects broken shapes', () => {
    expect(isNormalizedModelIdentity({ normalizedModelId: 'GPT-4o', providerModelNames: [] })).toBe(
      false,
    );
    expect(isNormalizedModelIdentity({ normalizedModelId: 'gpt-4o' })).toBe(false);
    expect(
      isNormalizedModelIdentity({
        normalizedModelId: 'gpt-4o',
        providerModelNames: [
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'openai', model: 'gpt-4o' },
        ],
      }),
    ).toBe(false);
    expect(isNormalizedModelIdentity(null)).toBe(false);
  });
});

describe('mapProviderModelToNormalizedIdentity', () => {
  const identities: readonly NormalizedModelIdentity[] = [
    identity('gpt-4o', [
      ['openai', 'gpt-4o'],
      ['azure', 'gpt-4o-2024-08-06'],
    ]),
    identity('claude-3.5-sonnet', [['anthropic', 'claude-3-5-sonnet-20241022']]),
  ];

  it('maps a raw identity to its canonical identity', () => {
    const mapped = expectOk(
      mapProviderModelToNormalizedIdentity(identities, 'azure', 'gpt-4o-2024-08-06'),
    );
    expect(mapped.normalizedModelId).toBe('gpt-4o');
  });

  it('returns the exact identity object from the supplied list', () => {
    const mapped = expectOk(mapProviderModelToNormalizedIdentity(identities, 'openai', 'gpt-4o'));
    expect(mapped).toBe(identities[0]);
  });

  it('rejects an unknown raw identity', () => {
    expect(
      expectRejection(mapProviderModelToNormalizedIdentity(identities, 'openai', 'gpt-5')),
    ).toBe('invalid_provider_model_identity');
  });

  it('rejects an invalid raw identity before consulting the list', () => {
    expect(
      expectRejection(mapProviderModelToNormalizedIdentity(identities, 'OpenAI', 'gpt-4o')),
    ).toBe('invalid_provider_key');
  });

  it('rejects a non-array or broken identity list', () => {
    expect(expectRejection(mapProviderModelToNormalizedIdentity(null, 'openai', 'gpt-4o'))).toBe(
      'invalid_provider_model_identity',
    );
    expect(
      expectRejection(mapProviderModelToNormalizedIdentity([{ bad: true }], 'openai', 'gpt-4o')),
    ).toBe('invalid_provider_model_identity');
  });

  it('rejects an ambiguous map where a raw identity appears in two identities', () => {
    const ambiguous = [
      identity('gpt-4o', [['openai', 'gpt-4o']]),
      identity('gpt-4o-mini', [['openai', 'gpt-4o']]),
    ];
    expect(
      expectRejection(mapProviderModelToNormalizedIdentity(ambiguous, 'openai', 'gpt-4o')),
    ).toBe('inconsistent_context');
  });
});

describe('assertProviderModelNameUnique', () => {
  it('accepts an identity whose raw names are new', () => {
    const existing = [identity('gpt-4o', [['openai', 'gpt-4o']])];
    const candidate = identity('gpt-4o-mini', [['openai', 'gpt-4o-mini']]);
    expect(expectOk(assertProviderModelNameUnique(existing, candidate))).toBe(candidate);
  });

  it('allows the same identity to extend its own raw names', () => {
    const existing = [identity('gpt-4o', [['openai', 'gpt-4o']])];
    const candidate = identity('gpt-4o', [
      ['openai', 'gpt-4o'],
      ['azure', 'gpt-4o'],
    ]);
    expect(expectOk(assertProviderModelNameUnique(existing, candidate))).toBe(candidate);
  });

  it('rejects a raw identity already claimed by another identity', () => {
    const existing = [identity('gpt-4o', [['openai', 'gpt-4o']])];
    const candidate = identity('gpt-4o-mini', [['openai', 'gpt-4o']]);
    expect(expectRejection(assertProviderModelNameUnique(existing, candidate))).toBe(
      'duplicate_provider_model',
    );
  });

  it('rejects a broken existing list or candidate', () => {
    const candidate = identity('gpt-4o-mini', [['openai', 'gpt-4o-mini']]);
    expect(
      expectRejection(
        assertProviderModelNameUnique(
          [{ bad: true }] as unknown as readonly NormalizedModelIdentity[],
          candidate,
        ),
      ),
    ).toBe('invalid_provider_model_identity');
    expect(
      expectRejection(
        assertProviderModelNameUnique([], { bad: true } as unknown as NormalizedModelIdentity),
      ),
    ).toBe('invalid_provider_model_identity');
  });
});

describe('normalizeModelId', () => {
  it('lowercases and collapses separators deterministically', () => {
    expect(expectOk(normalizeModelId('GPT-4o'))).toBe('gpt-4o');
    expect(expectOk(normalizeModelId('Claude 3.5 Sonnet'))).toBe('claude-3.5-sonnet');
    expect(expectOk(normalizeModelId('meta--llama__3'))).toBe('meta-llama__3');
    expect(expectOk(normalizeModelId('---GPT 4o---'))).toBe('gpt-4o');
  });

  it('rejects a padded input instead of silently trimming it', () => {
    expect(expectRejection(normalizeModelId('  Claude 3.5 Sonnet  '))).toBe(
      'invalid_normalized_model_id',
    );
  });

  it('is idempotent on an already-canonical id', () => {
    expect(expectOk(normalizeModelId('gpt-4o'))).toBe('gpt-4o');
  });

  it('rejects empty, non-string and over-limit inputs', () => {
    expect(expectRejection(normalizeModelId(''))).toBe('invalid_normalized_model_id');
    expect(expectRejection(normalizeModelId(null))).toBe('invalid_normalized_model_id');
    expect(expectRejection(normalizeModelId('a'.repeat(MAX_MODEL_NAME_LENGTH + 1)))).toBe(
      'invalid_normalized_model_id',
    );
  });

  it('rejects an input that normalizes to nothing', () => {
    expect(expectRejection(normalizeModelId('---'))).toBe('invalid_normalized_model_id');
    expect(expectRejection(normalizeModelId('!!!'))).toBe('invalid_normalized_model_id');
  });
});
