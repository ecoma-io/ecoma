import { describe, expect, it } from 'vitest';

import {
  addEndpointToPool,
  createEndpointPool,
  createEndpointPoolId,
  createModelOfferId,
  createSellerFallbackConfig,
  createUpstreamEndpoint,
  createUpstreamEndpointId,
  isSellerFallbackConfig,
  orderEndpointCandidates,
  type EndpointPool,
  type SellerFallbackConfig,
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
const OFFER = createModelOfferId('offer-1');
const POOL_A = createEndpointPoolId('pool-a');
const POOL_B = createEndpointPoolId('pool-b');

function pool(
  id: typeof POOL_A | typeof POOL_B,
  endpoints: readonly { id: string; health?: 'healthy' | 'degraded' | 'down' }[] = [],
): EndpointPool {
  let created = expectOk(createEndpointPool({ id, offerId: OFFER, createdAt: AT }));
  endpoints.forEach((entry, index) => {
    const endpoint = expectOk(
      createUpstreamEndpoint({
        id: createUpstreamEndpointId(entry.id),
        endpointPoolId: id,
        url: 'https://api.provider.example/v1',
        protocol: 'openai_chat',
        health: entry.health ?? 'healthy',
        createdAt: AT,
      }),
    );
    created = expectOk(addEndpointToPool({ pool: created, endpoint, addedAt: AT + index + 1 }));
  });
  return created;
}

const pools: readonly EndpointPool[] = [
  pool(POOL_A, [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
  pool(POOL_B, [{ id: 'b1' }, { id: 'b2' }]),
];

function configResult(overrides: Record<string, unknown> = {}) {
  return createSellerFallbackConfig({
    offerId: OFFER,
    poolPreference: [POOL_B, POOL_A],
    context: { offerId: OFFER, pools },
    ...overrides,
  });
}

function config(overrides: Record<string, unknown> = {}): SellerFallbackConfig {
  return expectOk(configResult(overrides));
}

describe('createSellerFallbackConfig', () => {
  it('creates a frozen config that keeps the declared preference order', () => {
    const created = config({
      endpointPreferences: [{ poolId: POOL_B, endpointIds: ['b2', 'b1'] }],
    });
    expect(created.offerId).toBe(OFFER);
    expect(created.poolPreference).toEqual([POOL_B, POOL_A]);
    expect(created.endpointPreferences[0].endpointIds).toEqual(['b2', 'b1']);
    expect(created.allowCrossPoolFallback).toBe(true);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.poolPreference)).toBe(true);
    expect(Object.isFrozen(created.endpointPreferences)).toBe(true);
    expect(Object.isFrozen(created.endpointPreferences[0])).toBe(true);
  });

  it('does not mutate the caller arrays', () => {
    const poolPreference = [POOL_B, POOL_A];
    const endpointIds = ['b2', 'b1'];
    config({ poolPreference, endpointPreferences: [{ poolId: POOL_B, endpointIds }] });
    expect(poolPreference).toEqual([POOL_B, POOL_A]);
    expect(endpointIds).toEqual(['b2', 'b1']);
  });

  it('accepts an explicit false for allowCrossPoolFallback', () => {
    expect(config({ allowCrossPoolFallback: false }).allowCrossPoolFallback).toBe(false);
  });

  it('accepts a pool without an endpoint preference', () => {
    expect(config().endpointPreferences).toEqual([]);
  });

  it('rejects an invalid context', () => {
    expect(
      expectRejection(
        createSellerFallbackConfig({
          offerId: OFFER,
          poolPreference: [POOL_A],
          context: null as never,
        }),
      ),
    ).toBe('ambiguous_context');
    expect(
      expectRejection(
        createSellerFallbackConfig({
          offerId: OFFER,
          poolPreference: [POOL_A],
          context: { offerId: OFFER, pools: 'nope' as never },
        }),
      ),
    ).toBe('ambiguous_context');
    expect(
      expectRejection(
        createSellerFallbackConfig({
          offerId: OFFER,
          poolPreference: [POOL_A],
          context: { offerId: OFFER, pools: [{ bad: true } as unknown as EndpointPool] },
        }),
      ),
    ).toBe('invalid_endpoint_pool');
  });

  it('rejects a context pool belonging to another offer', () => {
    const foreign = expectOk(
      createEndpointPool({ id: POOL_B, offerId: createModelOfferId('offer-2'), createdAt: AT }),
    );
    expect(
      expectRejection(
        createSellerFallbackConfig({
          offerId: OFFER,
          poolPreference: [POOL_B],
          context: { offerId: OFFER, pools: [foreign] },
        }),
      ),
    ).toBe('pool_offer_mismatch');
  });

  it('rejects an offerId that does not match the context', () => {
    expect(
      expectRejection(
        createSellerFallbackConfig({
          offerId: 'offer-2',
          poolPreference: [POOL_A],
          context: { offerId: OFFER, pools },
        }),
      ),
    ).toBe('inconsistent_context');
    expect(
      expectRejection(
        createSellerFallbackConfig({
          offerId: 42,
          poolPreference: [POOL_A],
          context: { offerId: OFFER, pools },
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects an empty, non-array or invalid poolPreference', () => {
    expect(expectRejection(configResult({ poolPreference: [] }))).toBe('invalid_fallback_config');
    expect(expectRejection(configResult({ poolPreference: 'pool-a' }))).toBe(
      'invalid_fallback_config',
    );
    expect(expectRejection(configResult({ poolPreference: [POOL_A, ' bad'] }))).toBe(
      'invalid_fallback_config',
    );
  });

  it('rejects a duplicated pool in the preference', () => {
    expect(expectRejection(configResult({ poolPreference: [POOL_A, POOL_A] }))).toBe(
      'duplicate_fallback_entry',
    );
  });

  it('rejects a pool that does not belong to the offer', () => {
    expect(
      expectRejection(configResult({ poolPreference: [createEndpointPoolId('pool-ghost')] })),
    ).toBe('fallback_pool_not_in_offer');
  });

  it('rejects an endpoint preference for a pool outside the preference list', () => {
    expect(
      expectRejection(
        configResult({
          poolPreference: [POOL_A],
          endpointPreferences: [{ poolId: POOL_B, endpointIds: ['b1'] }],
        }),
      ),
    ).toBe('fallback_pool_not_in_offer');
  });

  it('rejects a duplicated endpoint preference entry', () => {
    expect(
      expectRejection(
        configResult({
          endpointPreferences: [
            { poolId: POOL_A, endpointIds: ['a1'] },
            { poolId: POOL_A, endpointIds: ['a2'] },
          ],
        }),
      ),
    ).toBe('duplicate_fallback_entry');
  });

  it('rejects duplicated endpoint ids inside one preference', () => {
    expect(
      expectRejection(
        configResult({ endpointPreferences: [{ poolId: POOL_A, endpointIds: ['a1', 'a1'] }] }),
      ),
    ).toBe('duplicate_fallback_entry');
  });

  it('rejects an empty endpoint id list', () => {
    expect(
      expectRejection(configResult({ endpointPreferences: [{ poolId: POOL_A, endpointIds: [] }] })),
    ).toBe('invalid_fallback_config');
  });

  it('rejects an invalid endpoint id', () => {
    expect(
      expectRejection(
        configResult({ endpointPreferences: [{ poolId: POOL_A, endpointIds: [''] }] }),
      ),
    ).toBe('invalid_upstream_endpoint_id');
  });

  it('rejects an endpoint that is not in the referenced pool', () => {
    expect(
      expectRejection(
        configResult({ endpointPreferences: [{ poolId: POOL_A, endpointIds: ['b1'] }] }),
      ),
    ).toBe('fallback_endpoint_not_in_pool');
  });

  it('rejects a non-object endpoint preference or a non-boolean flag', () => {
    expect(expectRejection(configResult({ endpointPreferences: [null] }))).toBe(
      'invalid_fallback_config',
    );
    expect(expectRejection(configResult({ endpointPreferences: 'nope' }))).toBe(
      'invalid_fallback_config',
    );
    expect(expectRejection(configResult({ allowCrossPoolFallback: 'yes' }))).toBe(
      'invalid_fallback_config',
    );
  });
});

describe('isSellerFallbackConfig', () => {
  it('accepts a created config', () => {
    expect(isSellerFallbackConfig(config())).toBe(true);
  });

  it('rejects broken shapes', () => {
    const created = config({ endpointPreferences: [{ poolId: POOL_A, endpointIds: ['a1'] }] });
    expect(isSellerFallbackConfig(null)).toBe(false);
    expect(isSellerFallbackConfig({ ...created, offerId: '' })).toBe(false);
    expect(isSellerFallbackConfig({ ...created, allowCrossPoolFallback: 'yes' })).toBe(false);
    expect(isSellerFallbackConfig({ ...created, poolPreference: [] })).toBe(false);
    expect(isSellerFallbackConfig({ ...created, poolPreference: [POOL_A, POOL_A] })).toBe(false);
    expect(isSellerFallbackConfig({ ...created, poolPreference: [' bad'] })).toBe(false);
    expect(isSellerFallbackConfig({ ...created, endpointPreferences: 'nope' })).toBe(false);
    expect(
      isSellerFallbackConfig({
        ...created,
        endpointPreferences: [{ poolId: createEndpointPoolId('pool-x'), endpointIds: ['b1'] }],
      }),
    ).toBe(false);
    expect(isSellerFallbackConfig({ ...created, endpointPreferences: [null] })).toBe(false);
    expect(
      isSellerFallbackConfig({
        ...created,
        endpointPreferences: [{ poolId: POOL_A, endpointIds: [] }],
      }),
    ).toBe(false);
    expect(
      isSellerFallbackConfig({
        ...created,
        endpointPreferences: [{ poolId: POOL_A, endpointIds: ['a1', 'a1'] }],
      }),
    ).toBe(false);
    expect(
      isSellerFallbackConfig({
        ...created,
        endpointPreferences: [
          { poolId: POOL_A, endpointIds: ['a1'] },
          { poolId: POOL_A, endpointIds: ['a2'] },
        ],
      }),
    ).toBe(false);
  });
});

describe('orderEndpointCandidates', () => {
  it('orders pools by preference, preferred endpoints first, then canonical order', () => {
    const ordered = expectOk(
      orderEndpointCandidates({
        config: config({ endpointPreferences: [{ poolId: POOL_B, endpointIds: ['b2'] }] }),
        pools,
      }),
    );
    expect(ordered.map((candidate) => candidate.endpoint.id)).toEqual([
      'b2',
      'b1',
      'a1',
      'a2',
      'a3',
    ]);
    expect(ordered.map((candidate) => candidate.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(ordered[0].poolId).toBe(POOL_B);
    expect(Object.isFrozen(ordered)).toBe(true);
    expect(Object.isFrozen(ordered[0])).toBe(true);
  });

  it('excludes endpoints whose health is down', () => {
    const unhealthy = [
      pool(POOL_A, [
        { id: 'a1', health: 'down' },
        { id: 'a2', health: 'degraded' },
      ]),
      pool(POOL_B, [{ id: 'b1', health: 'down' }]),
    ];
    const ordered = expectOk(orderEndpointCandidates({ config: config(), pools: unhealthy }));
    expect(ordered.map((candidate) => candidate.endpoint.id)).toEqual(['a2']);
  });

  it('returns an empty list when every endpoint is down', () => {
    const down = [
      pool(POOL_A, [{ id: 'a1', health: 'down' }]),
      pool(POOL_B, [{ id: 'b1', health: 'down' }]),
    ];
    const ordered = expectOk(orderEndpointCandidates({ config: config(), pools: down }));
    expect(ordered).toEqual([]);
  });

  it('keeps only the first non-empty pool when cross-pool fallback is disabled', () => {
    const downFirst = [
      pool(POOL_A, [{ id: 'a1', health: 'down' }]),
      pool(POOL_B, [{ id: 'b1' }, { id: 'b2' }]),
    ];
    const ordered = expectOk(
      orderEndpointCandidates({
        config: config({ allowCrossPoolFallback: false }),
        pools: downFirst,
      }),
    );
    expect(ordered.map((candidate) => candidate.endpoint.id)).toEqual(['b1', 'b2']);
    expect(ordered.every((candidate) => candidate.poolId === POOL_B)).toBe(true);
  });

  it('rejects a broken config or pool list', () => {
    expect(
      expectRejection(orderEndpointCandidates({ config: { bad: true } as never, pools })),
    ).toBe('invalid_fallback_config');
    expect(
      expectRejection(orderEndpointCandidates({ config: config(), pools: 'nope' as never })),
    ).toBe('invalid_endpoint_pool');
    expect(
      expectRejection(
        orderEndpointCandidates({
          config: config(),
          pools: [{ bad: true } as unknown as EndpointPool],
        }),
      ),
    ).toBe('invalid_endpoint_pool');
  });

  it('rejects a pool list of another offer', () => {
    const foreign = expectOk(
      createEndpointPool({ id: POOL_A, offerId: createModelOfferId('offer-2'), createdAt: AT }),
    );
    expect(expectRejection(orderEndpointCandidates({ config: config(), pools: [foreign] }))).toBe(
      'pool_offer_mismatch',
    );
  });

  it('rejects a config referencing a pool absent from the supplied list', () => {
    expect(
      expectRejection(
        orderEndpointCandidates({ config: config(), pools: [pool(POOL_A, [{ id: 'a1' }])] }),
      ),
    ).toBe('fallback_pool_not_in_offer');
  });

  it('rejects a config whose preferred endpoint disappeared from its pool', () => {
    // Config hợp lệ về shape nhưng trỏ tới endpoint đã bị bỏ khỏi pool: guard
    // closed-world của lần đọc không thay thế được kiểm tra tại thời điểm dùng.
    const stale: SellerFallbackConfig = {
      ...config(),
      endpointPreferences: [{ poolId: POOL_A, endpointIds: [createUpstreamEndpointId('a9')] }],
    };
    expect(isSellerFallbackConfig(stale)).toBe(true);
    expect(expectRejection(orderEndpointCandidates({ config: stale, pools }))).toBe(
      'fallback_endpoint_not_in_pool',
    );
  });
});
