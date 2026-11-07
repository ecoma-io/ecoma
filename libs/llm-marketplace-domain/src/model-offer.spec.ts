import { describe, expect, it } from 'vitest';

import {
  MODEL_OFFER_ACTIVATABLE_STATUSES,
  MODEL_OFFER_STATUS,
  activateModelOffer,
  addEndpointToPool,
  assignPublicAlias,
  assertPublicAliasUnique,
  createCapabilitySet,
  createEndpointPool,
  createEndpointPoolId,
  createModelOffer,
  createModelOfferId,
  createSellerTenantId,
  createUpstreamEndpoint,
  createUpstreamEndpointId,
  deactivateModelOffer,
  isModelOffer,
  isModelOfferServing,
  isModelOfferStatus,
  isPublicAlias,
  replaceCapabilities,
  retireModelOffer,
  type EndpointPool,
  type ModelOffer,
  type SellerOperationalEligibility,
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
const TENANT = createSellerTenantId('tenant-1');
const OFFER_ID = createModelOfferId('offer-1');
const POOL_ID = createEndpointPoolId('pool-1');

function offerResult(overrides: Record<string, unknown> = {}) {
  return createModelOffer({
    id: OFFER_ID,
    sellerTenantId: TENANT,
    normalizedModelId: 'gpt-4o',
    capabilities: ['text_generation'],
    createdAt: AT,
    ...overrides,
  });
}

function offer(overrides: Record<string, unknown> = {}): ModelOffer {
  return expectOk(offerResult(overrides));
}

function activeOffer(at = AT + 10): ModelOffer {
  return expectOk(
    activateModelOffer({
      offer: offer(),
      eligibility: verdict(),
      pools: [healthyPool()],
      activatedAt: at,
    }),
  );
}

function healthyPool(
  offerId = OFFER_ID,
  health: 'healthy' | 'degraded' | 'down' = 'healthy',
): EndpointPool {
  const pool = expectOk(createEndpointPool({ id: POOL_ID, offerId, createdAt: AT }));
  const endpoint = expectOk(
    createUpstreamEndpoint({
      id: createUpstreamEndpointId('ep-1'),
      endpointPoolId: POOL_ID,
      url: 'https://api.provider.example/v1',
      protocol: 'openai_chat',
      health,
      createdAt: AT,
    }),
  );
  return expectOk(addEndpointToPool({ pool, endpoint, addedAt: AT + 2 }));
}

function verdict(
  overrides: Partial<SellerOperationalEligibility> = {},
): SellerOperationalEligibility {
  return { tenantId: TENANT, eligible: true, blockers: [], assessedAt: AT, ...overrides };
}

describe('isModelOfferStatus / MODEL_OFFER_STATUS', () => {
  it('covers exactly the four statuses', () => {
    expect(Object.keys(MODEL_OFFER_STATUS).toSorted()).toEqual([
      'active',
      'draft',
      'inactive',
      'retired',
    ]);
    expect(Object.isFrozen(MODEL_OFFER_STATUS)).toBe(true);
    expect(isModelOfferStatus('draft')).toBe(true);
    expect(isModelOfferStatus('retired')).toBe(true);
    expect(isModelOfferStatus('paused')).toBe(false);
  });
});

describe('isPublicAlias', () => {
  it('accepts lowercase names and rejects other shapes', () => {
    expect(isPublicAlias('gpt-4o')).toBe(true);
    expect(isPublicAlias('my.model_1')).toBe(true);
    expect(isPublicAlias('GPT-4o')).toBe(false);
    expect(isPublicAlias('-gpt')).toBe(false);
    expect(isPublicAlias('gpt 4o')).toBe(false);
    expect(isPublicAlias('')).toBe(false);
    expect(isPublicAlias('a'.repeat(201))).toBe(false);
    expect(isPublicAlias(null)).toBe(false);
  });
});

describe('createModelOffer', () => {
  it('creates a frozen draft with no event timestamps', () => {
    const created = offer({ publicAlias: 'gpt-4o' });
    expect(created.status).toBe('draft');
    expect(created.publicAlias).toBe('gpt-4o');
    expect(created.capabilities.capabilities).toEqual(['text_generation']);
    expect(created.activatedAt).toBeNull();
    expect(created.deactivatedAt).toBeNull();
    expect(created.retiredAt).toBeNull();
    expect(created.updatedAt).toBe(AT);
    expect(Object.isFrozen(created)).toBe(true);
    expect(isModelOffer(created)).toBe(true);
  });

  it('allows an offer without a public alias', () => {
    expect(offer().publicAlias).toBeNull();
  });

  it.each([
    [{ id: '' }, 'invalid_model_offer_id'],
    [{ sellerTenantId: '' }, 'invalid_seller_tenant_id'],
    [{ normalizedModelId: 'GPT-4o' }, 'invalid_normalized_model_id'],
    [{ capabilities: [] }, 'invalid_capability_set'],
    [{ capabilities: ['bad one'] }, 'invalid_capability'],
    [{ createdAt: 1.5 }, 'invalid_timestamp'],
    [{ publicAlias: 'GPT' }, 'invalid_public_alias'],
  ] as const)('rejects invalid input %j', (overrides, code) => {
    expect(
      expectRejection(
        createModelOffer({
          id: OFFER_ID,
          sellerTenantId: TENANT,
          normalizedModelId: 'gpt-4o',
          capabilities: ['text_generation'],
          createdAt: AT,
          ...(overrides as object),
        }),
      ),
    ).toBe(code);
  });

  it('rejects a duplicate offer id', () => {
    expect(expectRejection(offerResult({ existing: [offer()] }))).toBe('duplicate_model_offer_id');
  });

  it('rejects a public alias already used by another offer', () => {
    const existing = [offer({ id: createModelOfferId('offer-2'), publicAlias: 'gpt-4o' })];
    expect(expectRejection(offerResult({ publicAlias: 'gpt-4o', existing }))).toBe(
      'invalid_public_alias',
    );
  });

  it('allows the same alias when the existing offer has none', () => {
    const existing = [offer({ id: createModelOfferId('offer-2') })];
    expect(expectOk(offerResult({ publicAlias: 'gpt-4o', existing })).publicAlias).toBe('gpt-4o');
  });

  it('rejects a malformed existing list', () => {
    expect(expectRejection(offerResult({ existing: [{ bad: true }] }))).toBe('invalid_model_offer');
    expect(expectRejection(offerResult({ existing: 'nope' }))).toBe('ambiguous_context');
  });
});

describe('assignPublicAlias', () => {
  it('assigns the alias while draft and advances updatedAt', () => {
    const assigned = expectOk(
      assignPublicAlias({ offer: offer(), publicAlias: 'gpt-4o', assignedAt: AT + 1 }),
    );
    expect(assigned.publicAlias).toBe('gpt-4o');
    expect(assigned.updatedAt).toBe(AT + 1);
    expect(Object.isFrozen(assigned)).toBe(true);
  });

  it('refuses to change the alias after activation', () => {
    expect(
      expectRejection(
        assignPublicAlias({ offer: activeOffer(), publicAlias: 'new-name', assignedAt: AT + 20 }),
      ),
    ).toBe('public_alias_immutable');
  });

  it('rejects a retired offer before the immutability check', () => {
    const retired = expectOk(retireModelOffer({ offer: offer(), retiredAt: AT + 1 }));
    expect(
      expectRejection(
        assignPublicAlias({ offer: retired, publicAlias: 'new-name', assignedAt: AT + 2 }),
      ),
    ).toBe('offer_retired');
  });

  it('rejects an alias used by another offer but allows keeping its own', () => {
    const assigned = expectOk(
      assignPublicAlias({ offer: offer(), publicAlias: 'gpt-4o', assignedAt: AT + 1 }),
    );
    const other = offer({ id: createModelOfferId('offer-2'), publicAlias: 'other' });
    expect(
      expectRejection(
        assignPublicAlias({
          offer: assigned,
          publicAlias: 'other',
          assignedAt: AT + 2,
          existing: [assigned, other],
        }),
      ),
    ).toBe('invalid_public_alias');
    expect(
      expectOk(
        assignPublicAlias({
          offer: assigned,
          publicAlias: 'gpt-4o',
          assignedAt: AT + 2,
          existing: [assigned],
        }),
      ).publicAlias,
    ).toBe('gpt-4o');
  });

  it('rejects invalid input, timestamps and context', () => {
    expect(
      expectRejection(
        assignPublicAlias({ offer: { bad: true } as never, publicAlias: 'x', assignedAt: AT }),
      ),
    ).toBe('invalid_model_offer');
    expect(
      expectRejection(assignPublicAlias({ offer: offer(), publicAlias: 'X', assignedAt: AT })),
    ).toBe('invalid_public_alias');
    expect(
      expectRejection(assignPublicAlias({ offer: offer(), publicAlias: 'x', assignedAt: AT - 1 })),
    ).toBe('timestamp_regression');
    expect(
      expectRejection(assignPublicAlias({ offer: offer(), publicAlias: 'x', assignedAt: 'now' })),
    ).toBe('invalid_timestamp');
    expect(
      expectRejection(
        assignPublicAlias({
          offer: offer(),
          publicAlias: 'x',
          assignedAt: AT + 1,
          existing: 'nope' as unknown as readonly ModelOffer[],
        }),
      ),
    ).toBe('ambiguous_context');
    expect(
      expectRejection(
        assignPublicAlias({
          offer: offer(),
          publicAlias: 'x',
          assignedAt: AT + 1,
          existing: [{}] as never,
        }),
      ),
    ).toBe('invalid_model_offer');
  });
});

describe('replaceCapabilities', () => {
  it('replaces the set on a draft and on an active offer', () => {
    const draft = expectOk(
      replaceCapabilities({
        offer: offer(),
        capabilities: ['vision', 'embedding'],
        updatedAt: AT + 1,
      }),
    );
    expect(draft.capabilities.capabilities).toEqual(['embedding', 'vision']);

    const active = expectOk(
      replaceCapabilities({ offer: activeOffer(), capabilities: ['vision'], updatedAt: AT + 20 }),
    );
    expect(active.status).toBe('active');
    expect(active.capabilities.capabilities).toEqual(['vision']);
  });

  it('rejects a retired offer', () => {
    const retired = expectOk(retireModelOffer({ offer: offer(), retiredAt: AT + 1 }));
    expect(
      expectRejection(
        replaceCapabilities({ offer: retired, capabilities: ['vision'], updatedAt: AT + 2 }),
      ),
    ).toBe('offer_retired');
  });

  it('rejects an empty or invalid set and a regressing timestamp', () => {
    expect(
      expectRejection(replaceCapabilities({ offer: offer(), capabilities: [], updatedAt: AT + 1 })),
    ).toBe('invalid_capability_set');
    expect(
      expectRejection(
        replaceCapabilities({ offer: offer(), capabilities: ['bad one'], updatedAt: AT + 1 }),
      ),
    ).toBe('invalid_capability');
    expect(
      expectRejection(
        replaceCapabilities({ offer: offer(), capabilities: ['vision'], updatedAt: AT - 1 }),
      ),
    ).toBe('timestamp_regression');
    expect(
      expectRejection(
        replaceCapabilities({ offer: offer(), capabilities: ['vision'], updatedAt: 'x' }),
      ),
    ).toBe('invalid_timestamp');
    expect(
      expectRejection(
        replaceCapabilities({
          offer: { bad: true } as never,
          capabilities: ['vision'],
          updatedAt: AT,
        }),
      ),
    ).toBe('invalid_model_offer');
  });
});

describe('activateModelOffer', () => {
  it('activates a draft when eligible and a pool is healthy', () => {
    const activated = activeOffer();
    expect(activated.status).toBe('active');
    expect(activated.activatedAt).toBe(AT + 10);
    expect(activated.updatedAt).toBe(AT + 10);
    expect(activated.deactivatedAt).toBeNull();
    expect(Object.isFrozen(activated)).toBe(true);
    expect(isModelOffer(activated)).toBe(true);
  });

  it('re-activates an inactive offer', () => {
    const inactive = expectOk(
      deactivateModelOffer({ offer: activeOffer(), deactivatedAt: AT + 20 }),
    );
    const reactivated = expectOk(
      activateModelOffer({
        offer: inactive,
        eligibility: verdict(),
        pools: [healthyPool()],
        activatedAt: AT + 30,
      }),
    );
    expect(reactivated.status).toBe('active');
    expect(reactivated.activatedAt).toBe(AT + 30);
    expect(reactivated.deactivatedAt).toBe(AT + 20);
  });

  it('refuses activating an already active offer instead of silently succeeding', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: activeOffer(),
          eligibility: verdict(),
          pools: [healthyPool()],
          activatedAt: AT + 20,
        }),
      ),
    ).toBe('offer_already_active');
  });

  it('refuses activating a retired offer', () => {
    const retired = expectOk(retireModelOffer({ offer: offer(), retiredAt: AT + 1 }));
    expect(
      expectRejection(
        activateModelOffer({
          offer: retired,
          eligibility: verdict(),
          pools: [healthyPool()],
          activatedAt: AT + 2,
        }),
      ),
    ).toBe('offer_retired');
  });

  it('rejects a verdict belonging to another tenant', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict({ tenantId: createSellerTenantId('tenant-2') }),
          pools: [healthyPool()],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('eligibility_tenant_mismatch');
  });

  it('rejects an ineligible verdict and a stale verdict', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict({ eligible: false, blockers: ['restricted'] }),
          pools: [healthyPool()],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('seller_not_eligible');
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict({ assessedAt: AT - 1 }),
          pools: [healthyPool()],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('seller_not_eligible');
  });

  it('rejects a malformed verdict', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: { bad: true } as never,
          pools: [healthyPool()],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('invalid_eligibility_verdict');
  });

  it('requires at least one healthy pool', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict(),
          pools: [healthyPool(OFFER_ID, 'degraded')],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('endpoint_pool_not_healthy');
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict(),
          pools: [],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('endpoint_pool_missing');
  });

  it('rejects pools of another offer', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict(),
          pools: [healthyPool(createModelOfferId('offer-2'))],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('pool_offer_mismatch');
  });

  it('rejects a duplicate pool id in the input list', () => {
    const pool = healthyPool();
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict(),
          pools: [pool, pool],
          activatedAt: AT + 10,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects invalid input shapes and timestamps', () => {
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict(),
          pools: [healthyPool()],
          activatedAt: 'x',
        }),
      ),
    ).toBe('invalid_timestamp');
    expect(
      expectRejection(
        activateModelOffer({
          offer: { bad: true } as never,
          eligibility: verdict(),
          pools: [healthyPool()],
          activatedAt: AT,
        }),
      ),
    ).toBe('invalid_model_offer');
    expect(
      expectRejection(
        activateModelOffer({
          offer: offer(),
          eligibility: verdict(),
          pools: [healthyPool()],
          activatedAt: AT - 1,
        }),
      ),
    ).toBe('timestamp_regression');
  });
});

describe('deactivateModelOffer', () => {
  it('deactivates an active offer and keeps activation history', () => {
    const inactive = expectOk(
      deactivateModelOffer({ offer: activeOffer(), deactivatedAt: AT + 20 }),
    );
    expect(inactive.status).toBe('inactive');
    expect(inactive.deactivatedAt).toBe(AT + 20);
    expect(inactive.activatedAt).toBe(AT + 10);
  });

  it('rejects deactivating an offer that is already inactive', () => {
    const inactive = expectOk(
      deactivateModelOffer({ offer: activeOffer(), deactivatedAt: AT + 20 }),
    );
    expect(expectRejection(deactivateModelOffer({ offer: inactive, deactivatedAt: AT + 30 }))).toBe(
      'offer_already_inactive',
    );
  });

  it('rejects draft, retired, malformed and regressing input', () => {
    expect(expectRejection(deactivateModelOffer({ offer: offer(), deactivatedAt: AT + 1 }))).toBe(
      'invalid_offer_transition',
    );
    const retired = expectOk(retireModelOffer({ offer: offer(), retiredAt: AT + 1 }));
    expect(expectRejection(deactivateModelOffer({ offer: retired, deactivatedAt: AT + 2 }))).toBe(
      'offer_retired',
    );
    expect(expectRejection(deactivateModelOffer({ offer: activeOffer(), deactivatedAt: AT }))).toBe(
      'timestamp_regression',
    );
    expect(
      expectRejection(deactivateModelOffer({ offer: { bad: true } as never, deactivatedAt: AT })),
    ).toBe('invalid_model_offer');
    expect(
      expectRejection(deactivateModelOffer({ offer: activeOffer(), deactivatedAt: 'x' })),
    ).toBe('invalid_timestamp');
  });
});

describe('retireModelOffer', () => {
  it('retires from draft, active and inactive', () => {
    const fromDraft = expectOk(retireModelOffer({ offer: offer(), retiredAt: AT + 1 }));
    expect(fromDraft.status).toBe('retired');
    expect(fromDraft.retiredAt).toBe(AT + 1);

    const fromActive = expectOk(retireModelOffer({ offer: activeOffer(), retiredAt: AT + 20 }));
    expect(fromActive.status).toBe('retired');
    expect(fromActive.activatedAt).toBe(AT + 10);

    const inactive = expectOk(
      deactivateModelOffer({ offer: activeOffer(), deactivatedAt: AT + 20 }),
    );
    expect(expectOk(retireModelOffer({ offer: inactive, retiredAt: AT + 30 })).status).toBe(
      'retired',
    );
  });

  it('is terminal', () => {
    const retired = expectOk(retireModelOffer({ offer: offer(), retiredAt: AT + 1 }));
    expect(expectRejection(retireModelOffer({ offer: retired, retiredAt: AT + 2 }))).toBe(
      'offer_retired',
    );
    expect(
      expectRejection(
        activateModelOffer({
          offer: retired,
          eligibility: verdict(),
          pools: [healthyPool()],
          activatedAt: AT + 2,
        }),
      ),
    ).toBe('offer_retired');
  });

  it('rejects regressing, invalid or malformed input', () => {
    expect(expectRejection(retireModelOffer({ offer: offer(), retiredAt: AT - 1 }))).toBe(
      'timestamp_regression',
    );
    expect(expectRejection(retireModelOffer({ offer: offer(), retiredAt: 'x' }))).toBe(
      'invalid_timestamp',
    );
    expect(
      expectRejection(retireModelOffer({ offer: { bad: true } as never, retiredAt: AT })),
    ).toBe('invalid_model_offer');
  });
});

describe('isModelOfferServing', () => {
  it('is true for an active offer with a serving pool', () => {
    expect(isModelOfferServing(activeOffer(), [healthyPool()])).toBe(true);
  });

  it('is false for a draft even with healthy pools', () => {
    expect(isModelOfferServing(offer(), [healthyPool()])).toBe(false);
  });

  it('is false when every endpoint is down', () => {
    expect(isModelOfferServing(activeOffer(), [healthyPool(OFFER_ID, 'down')])).toBe(false);
  });

  it('fails closed on a foreign pool or malformed input', () => {
    expect(isModelOfferServing(activeOffer(), [healthyPool(createModelOfferId('offer-2'))])).toBe(
      false,
    );
    expect(isModelOfferServing(activeOffer(), 'nope' as never)).toBe(false);
    expect(isModelOfferServing({ bad: true } as never, [healthyPool()])).toBe(false);
    expect(isModelOfferServing(activeOffer(), [])).toBe(false);
  });
});

describe('isModelOffer', () => {
  it('accepts each status reached through the operations', () => {
    const draft = offer();
    const active = activeOffer();
    const inactive = expectOk(deactivateModelOffer({ offer: active, deactivatedAt: AT + 20 }));
    const retired = expectOk(retireModelOffer({ offer: inactive, retiredAt: AT + 30 }));
    for (const candidate of [draft, active, inactive, retired]) {
      expect(isModelOffer(candidate)).toBe(true);
    }
  });

  it('rejects inconsistent event timestamps per status', () => {
    expect(isModelOffer({ ...offer(), activatedAt: AT + 1 })).toBe(false);
    expect(isModelOffer({ ...offer(), retiredAt: AT + 1 })).toBe(false);
    expect(isModelOffer({ ...activeOffer(), activatedAt: null })).toBe(false);
    expect(isModelOffer({ ...activeOffer(), retiredAt: AT + 20 })).toBe(false);
    const inactive = expectOk(
      deactivateModelOffer({ offer: activeOffer(), deactivatedAt: AT + 20 }),
    );
    expect(isModelOffer({ ...inactive, deactivatedAt: null })).toBe(false);
    expect(isModelOffer({ ...inactive, activatedAt: null })).toBe(false);
    expect(isModelOffer({ ...inactive, retiredAt: AT + 30 })).toBe(false);
    const retired = expectOk(retireModelOffer({ offer: inactive, retiredAt: AT + 30 }));
    expect(isModelOffer({ ...retired, retiredAt: null })).toBe(false);
  });

  it('rejects event timestamps later than updatedAt and updatedAt before createdAt', () => {
    expect(isModelOffer({ ...activeOffer(), updatedAt: AT + 5 })).toBe(false);
    expect(isModelOffer({ ...offer(), updatedAt: AT - 1 })).toBe(false);
  });

  it('rejects broken field shapes', () => {
    expect(isModelOffer(null)).toBe(false);
    expect(isModelOffer({ ...offer(), capabilities: { capabilities: [] } })).toBe(false);
    expect(isModelOffer({ ...offer(), publicAlias: 'BAD' })).toBe(false);
    expect(isModelOffer({ ...offer(), status: 'paused' })).toBe(false);
    expect(isModelOffer({ ...offer(), normalizedModelId: 'GPT' })).toBe(false);
    expect(isModelOffer({ ...offer(), sellerTenantId: '' })).toBe(false);
  });
});

describe('assertPublicAliasUnique', () => {
  it('accepts an unused alias and an alias owned by the same offer', () => {
    const assigned = offer({ publicAlias: 'gpt-4o' });
    expect(expectOk(assertPublicAliasUnique('gpt-4o', []))).toBe('gpt-4o');
    expect(expectOk(assertPublicAliasUnique('gpt-4o', [assigned], assigned.id))).toBe('gpt-4o');
  });

  it('rejects an alias owned by another offer', () => {
    const assigned = offer({ publicAlias: 'gpt-4o' });
    expect(expectRejection(assertPublicAliasUnique('gpt-4o', [assigned]))).toBe(
      'invalid_public_alias',
    );
  });

  it('rejects an invalid alias or broken offer list', () => {
    expect(expectRejection(assertPublicAliasUnique('BAD', []))).toBe('invalid_public_alias');
    expect(expectRejection(assertPublicAliasUnique('ok', [{ bad: true }] as never))).toBe(
      'invalid_model_offer',
    );
    expect(expectRejection(assertPublicAliasUnique('ok', 'nope' as never))).toBe(
      'invalid_model_offer',
    );
  });
});

describe('MODEL_OFFER_ACTIVATABLE_STATUSES', () => {
  it('lists exactly draft and inactive, and is frozen', () => {
    expect(MODEL_OFFER_ACTIVATABLE_STATUSES).toEqual(['draft', 'inactive']);
    expect(Object.isFrozen(MODEL_OFFER_ACTIVATABLE_STATUSES)).toBe(true);
  });
});

describe('capability set coupling', () => {
  it('stores a canonical capability set, not the caller array', () => {
    const created = offer({ capabilities: ['vision', 'embedding'] });
    expect(created.capabilities).toEqual(expectOk(createCapabilitySet(['embedding', 'vision'])));
  });
});
