import { describe, expect, it } from 'vitest';

import {
  MAX_ENDPOINT_WEIGHT,
  addEndpointToPool,
  createEndpointPool,
  createEndpointPoolId,
  createModelOfferId,
  createUpstreamEndpoint,
  createUpstreamEndpointId,
  deriveEndpointPoolHealth,
  evaluateOfferEndpointHealth,
  isEndpointHealthStatus,
  isEndpointPool,
  isEndpointProtocol,
  isEndpointUrl,
  isEndpointWeight,
  isUpstreamEndpoint,
  recordEndpointHealth,
  removeEndpointFromPool,
  replaceEndpointInPool,
  type EndpointPool,
  type UpstreamEndpoint,
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
const POOL = createEndpointPoolId('pool-1');
const OTHER_POOL = createEndpointPoolId('pool-2');

function endpoint(
  id: string,
  overrides: Partial<Parameters<typeof createUpstreamEndpoint>[0]> = {},
): UpstreamEndpoint {
  return expectOk(
    createUpstreamEndpoint({
      id: createUpstreamEndpointId(id),
      endpointPoolId: POOL,
      url: 'https://api.provider.example/v1/chat',
      protocol: 'openai_chat',
      createdAt: AT,
      ...overrides,
    }),
  );
}

const DEFAULT_POOL_ID = 'pool-1';

function pool(id = DEFAULT_POOL_ID, offerId = OFFER): EndpointPool {
  return expectOk(createEndpointPool({ id: createEndpointPoolId(id), offerId, createdAt: AT }));
}

function poolWith(healths: readonly ('healthy' | 'degraded' | 'down')[]): EndpointPool {
  let created = pool();
  healths.forEach((health, index) => {
    created = expectOk(
      addEndpointToPool({
        pool: created,
        endpoint: endpoint(`ep-${index}`, { health }),
        addedAt: AT + index + 1,
      }),
    );
  });
  return created;
}

describe('isEndpointUrl', () => {
  it('accepts absolute http and https URLs with path, query, port and IPv6 host', () => {
    expect(isEndpointUrl('https://api.provider.example/v1/chat')).toBe(true);
    expect(isEndpointUrl('http://localhost:8080/v1')).toBe(true);
    expect(isEndpointUrl('https://api.provider.example')).toBe(true);
    expect(isEndpointUrl('https://api.provider.example/v1?region=eu')).toBe(true);
    expect(isEndpointUrl('http://[::1]:8787/v1')).toBe(true);
    expect(isEndpointUrl('HTTPS://API.PROVIDER.EXAMPLE/v1')).toBe(true);
  });

  it('rejects relative, credential-bearing, fragment, whitespace and over-limit URLs', () => {
    expect(isEndpointUrl('/v1/chat')).toBe(false);
    expect(isEndpointUrl('api.provider.example')).toBe(false);
    expect(isEndpointUrl('https://user:pass@api.provider.example/v1')).toBe(false);
    expect(isEndpointUrl('https://api.provider.example/v1#frag')).toBe(false);
    expect(isEndpointUrl('https://api.provider.example/v1 x')).toBe(false);
    expect(isEndpointUrl('ftp://api.provider.example/v1')).toBe(false);
    expect(isEndpointUrl(`https://api.provider.example/${'a'.repeat(2048)}`)).toBe(false);
    expect(isEndpointUrl(null)).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(isEndpointUrl('https://api.provider.example:0/v1')).toBe(false);
    expect(isEndpointUrl('https://api.provider.example:65536/v1')).toBe(false);
    expect(isEndpointUrl('https://api.provider.example:65535/v1')).toBe(true);
  });
});

describe('isEndpointProtocol', () => {
  it('accepts lowercase snake_case protocols and rejects other shapes', () => {
    expect(isEndpointProtocol('openai_chat')).toBe(true);
    expect(isEndpointProtocol('anthropic_messages')).toBe(true);
    expect(isEndpointProtocol('OpenAI')).toBe(false);
    expect(isEndpointProtocol('openai-chat')).toBe(false);
    expect(isEndpointProtocol('')).toBe(false);
  });
});

describe('isEndpointWeight', () => {
  it('accepts integers from 1 to the maximum', () => {
    expect(isEndpointWeight(1)).toBe(true);
    expect(isEndpointWeight(MAX_ENDPOINT_WEIGHT)).toBe(true);
  });

  it('rejects zero, negatives, fractions and over-limit values', () => {
    expect(isEndpointWeight(0)).toBe(false);
    expect(isEndpointWeight(-1)).toBe(false);
    expect(isEndpointWeight(1.5)).toBe(false);
    expect(isEndpointWeight(MAX_ENDPOINT_WEIGHT + 1)).toBe(false);
    expect(isEndpointWeight('1')).toBe(false);
  });
});

describe('createUpstreamEndpoint', () => {
  it('defaults health to degraded and weight to 1', () => {
    const created = endpoint('ep-1');
    expect(created.health).toBe('degraded');
    expect(created.weight).toBe(1);
    expect(created.healthRecordedAt).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('never defaults a new endpoint to healthy', () => {
    expect(endpoint('ep-1').health).not.toBe('healthy');
  });

  it('accepts an explicit health and weight', () => {
    const created = endpoint('ep-1', { health: 'healthy', weight: MAX_ENDPOINT_WEIGHT });
    expect(created.health).toBe('healthy');
    expect(created.weight).toBe(MAX_ENDPOINT_WEIGHT);
  });

  it.each([
    [{ id: '' }, 'invalid_upstream_endpoint_id'],
    [{ endpointPoolId: '' }, 'invalid_endpoint_pool_id'],
    [{ url: 'not-a-url' }, 'invalid_endpoint_url'],
    [{ protocol: 'Bad Protocol' }, 'invalid_endpoint_protocol'],
    [{ health: 'ok' }, 'invalid_endpoint_health'],
    [{ weight: 0 }, 'invalid_endpoint_weight'],
    [{ createdAt: 'now' }, 'invalid_timestamp'],
  ] as const)('rejects invalid input %j', (overrides, code) => {
    expect(
      expectRejection(
        createUpstreamEndpoint({
          id: createUpstreamEndpointId('ep-1'),
          endpointPoolId: POOL,
          url: 'https://api.provider.example/v1',
          protocol: 'openai_chat',
          createdAt: AT,
          ...(overrides as object),
        }),
      ),
    ).toBe(code);
  });
});

describe('recordEndpointHealth', () => {
  it('records every explicit transition and stamps the event time', () => {
    const start = endpoint('ep-1', { health: 'healthy' });
    const down = expectOk(
      recordEndpointHealth({ endpoint: start, health: 'down', recordedAt: AT + 1 }),
    );
    expect(down.health).toBe('down');
    expect(down.healthRecordedAt).toBe(AT + 1);
    expect(Object.isFrozen(down)).toBe(true);
    const recovered = expectOk(
      recordEndpointHealth({ endpoint: down, health: 'healthy', recordedAt: AT + 2 }),
    );
    expect(recovered.health).toBe('healthy');
    expect(recovered.healthRecordedAt).toBe(AT + 2);
  });

  it('rejects recording the same health twice', () => {
    const created = endpoint('ep-1', { health: 'degraded' });
    expect(
      expectRejection(
        recordEndpointHealth({ endpoint: created, health: 'degraded', recordedAt: AT + 1 }),
      ),
    ).toBe('endpoint_health_unchanged');
  });

  it('rejects a health regression in time', () => {
    const first = expectOk(
      recordEndpointHealth({ endpoint: endpoint('ep-1'), health: 'healthy', recordedAt: AT + 5 }),
    );
    expect(
      expectRejection(
        recordEndpointHealth({ endpoint: first, health: 'down', recordedAt: AT + 4 }),
      ),
    ).toBe('timestamp_regression');
    expect(
      expectRejection(
        recordEndpointHealth({ endpoint: first, health: 'down', recordedAt: AT - 1 }),
      ),
    ).toBe('timestamp_regression');
  });

  it('rejects invalid health, timestamp and endpoint shapes', () => {
    const created = endpoint('ep-1');
    expect(
      expectRejection(recordEndpointHealth({ endpoint: created, health: 'up', recordedAt: AT })),
    ).toBe('invalid_endpoint_health');
    expect(
      expectRejection(recordEndpointHealth({ endpoint: created, health: 'down', recordedAt: 1.5 })),
    ).toBe('invalid_timestamp');
    expect(
      expectRejection(
        recordEndpointHealth({
          endpoint: { bad: true } as unknown as UpstreamEndpoint,
          health: 'down',
          recordedAt: AT,
        }),
      ),
    ).toBe('invalid_upstream_endpoint');
  });
});

describe('isUpstreamEndpoint / isEndpointHealthStatus', () => {
  it('accepts a created endpoint and rejects broken shapes', () => {
    expect(isUpstreamEndpoint(endpoint('ep-1'))).toBe(true);
    expect(isUpstreamEndpoint({ ...endpoint('ep-1'), health: 'up' })).toBe(false);
    expect(isUpstreamEndpoint({ ...endpoint('ep-1'), weight: 0 })).toBe(false);
    expect(isUpstreamEndpoint({ ...endpoint('ep-1'), healthRecordedAt: AT - 1 })).toBe(false);
    expect(isUpstreamEndpoint(null)).toBe(false);
    expect(isEndpointHealthStatus('healthy')).toBe(true);
    expect(isEndpointHealthStatus('up')).toBe(false);
  });
});

describe('createEndpointPool / isEndpointPool', () => {
  it('creates an empty frozen pool bound to the offer', () => {
    const created = pool();
    expect(created.offerId).toBe(OFFER);
    expect(created.endpoints).toEqual([]);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(Object.isFrozen(created)).toBe(true);

    expect(isEndpointPool(created)).toBe(true);
  });

  it('rejects invalid id, offer or timestamp', () => {
    expect(expectRejection(createEndpointPool({ id: '', offerId: OFFER, createdAt: AT }))).toBe(
      'invalid_endpoint_pool_id',
    );
    expect(expectRejection(createEndpointPool({ id: POOL, offerId: '', createdAt: AT }))).toBe(
      'invalid_model_offer_id',
    );
    expect(expectRejection(createEndpointPool({ id: POOL, offerId: OFFER, createdAt: 1.2 }))).toBe(
      'invalid_timestamp',
    );
  });

  it('rejects a duplicate pool id against existing pools', () => {
    expect(
      expectRejection(
        createEndpointPool({ id: POOL, offerId: OFFER, createdAt: AT, existing: [pool()] }),
      ),
    ).toBe('duplicate_endpoint_pool_id');
  });

  it('allows a second pool for the same offer', () => {
    const second = expectOk(
      createEndpointPool({
        id: OTHER_POOL,
        offerId: OFFER,
        createdAt: AT,
        existing: [pool()],
      }),
    );
    expect(second.id).toBe(OTHER_POOL);
  });

  it('rejects a malformed existing pool list', () => {
    expect(
      expectRejection(
        createEndpointPool({
          id: POOL,
          offerId: OFFER,
          createdAt: AT,
          existing: [{ bad: true }] as unknown as readonly EndpointPool[],
        }),
      ),
    ).toBe('invalid_endpoint_pool');
    expect(
      expectRejection(
        createEndpointPool({
          id: POOL,
          offerId: OFFER,
          createdAt: AT,
          existing: 'nope' as unknown as readonly EndpointPool[],
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects a pool carrying an endpoint of another pool', () => {
    const created = pool();
    const foreign = endpoint('ep-1', { endpointPoolId: OTHER_POOL });
    expect(isEndpointPool({ ...created, endpoints: [foreign] })).toBe(false);
  });

  it('rejects a pool with a duplicated endpoint id', () => {
    const created = pool();
    const ep = endpoint('ep-1');
    expect(isEndpointPool({ ...created, endpoints: [ep, ep] })).toBe(false);
  });

  it('rejects a pool whose updatedAt precedes createdAt', () => {
    expect(isEndpointPool({ ...pool(), updatedAt: AT - 1 })).toBe(false);
  });
});

describe('addEndpointToPool', () => {
  it('adds a matching endpoint, freezes the new list and advances updatedAt', () => {
    const created = pool();
    const ep = endpoint('ep-1');
    const next = expectOk(addEndpointToPool({ pool: created, endpoint: ep, addedAt: AT + 1 }));
    expect(next.endpoints).toHaveLength(1);
    expect(next.endpoints[0]).toBe(ep);
    expect(next.updatedAt).toBe(AT + 1);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.endpoints)).toBe(true);
    expect(created.endpoints).toHaveLength(0);
  });

  it('rejects an endpoint belonging to another pool', () => {
    const ep = endpoint('ep-1', { endpointPoolId: OTHER_POOL });
    expect(
      expectRejection(addEndpointToPool({ pool: pool(), endpoint: ep, addedAt: AT + 1 })),
    ).toBe('endpoint_pool_mismatch');
  });

  it('rejects a duplicate endpoint id', () => {
    const ep = endpoint('ep-1');
    const withOne = expectOk(addEndpointToPool({ pool: pool(), endpoint: ep, addedAt: AT + 1 }));
    expect(
      expectRejection(addEndpointToPool({ pool: withOne, endpoint: ep, addedAt: AT + 2 })),
    ).toBe('duplicate_upstream_endpoint_id');
  });

  it('rejects a regressing addedAt or an endpoint created after addedAt', () => {
    const existing = expectOk(
      addEndpointToPool({ pool: pool(), endpoint: endpoint('ep-0'), addedAt: AT + 5 }),
    );
    expect(
      expectRejection(
        addEndpointToPool({ pool: existing, endpoint: endpoint('ep-1'), addedAt: AT + 4 }),
      ),
    ).toBe('timestamp_regression');
    const late = endpoint('ep-2', { createdAt: AT + 10 });
    expect(
      expectRejection(addEndpointToPool({ pool: existing, endpoint: late, addedAt: AT + 6 })),
    ).toBe('timestamp_regression');
  });
});

describe('replaceEndpointInPool', () => {
  it('replaces an existing endpoint and keeps the pool order', () => {
    let created = pool();
    created = expectOk(
      addEndpointToPool({ pool: created, endpoint: endpoint('ep-1'), addedAt: AT + 1 }),
    );
    created = expectOk(
      addEndpointToPool({ pool: created, endpoint: endpoint('ep-2'), addedAt: AT + 2 }),
    );
    const unhealthy = endpoint('ep-1');
    const healthy = expectOk(
      recordEndpointHealth({ endpoint: unhealthy, health: 'healthy', recordedAt: AT + 3 }),
    );
    const next = expectOk(
      replaceEndpointInPool({ pool: created, endpoint: healthy, replacedAt: AT + 4 }),
    );
    expect(next.endpoints.map((ep) => ep.id)).toEqual(['ep-1', 'ep-2']);
    expect(next.endpoints[0].health).toBe('healthy');
  });

  it('rejects replacing an endpoint that is not in the pool', () => {
    expect(
      expectRejection(
        replaceEndpointInPool({ pool: pool(), endpoint: endpoint('ep-1'), replacedAt: AT + 1 }),
      ),
    ).toBe('endpoint_not_in_pool');
  });

  it('rejects an endpoint of another pool and a regressing timestamp', () => {
    const created = expectOk(
      addEndpointToPool({ pool: pool(), endpoint: endpoint('ep-1'), addedAt: AT + 2 }),
    );
    expect(
      expectRejection(
        replaceEndpointInPool({
          pool: created,
          endpoint: endpoint('ep-1', { endpointPoolId: OTHER_POOL }),
          replacedAt: AT + 3,
        }),
      ),
    ).toBe('endpoint_pool_mismatch');
    expect(
      expectRejection(
        replaceEndpointInPool({ pool: created, endpoint: endpoint('ep-1'), replacedAt: AT + 1 }),
      ),
    ).toBe('timestamp_regression');
  });
});

describe('removeEndpointFromPool', () => {
  it('removes a member and allows removing the last endpoint', () => {
    const withOne = expectOk(
      addEndpointToPool({ pool: pool(), endpoint: endpoint('ep-1'), addedAt: AT + 1 }),
    );
    const empty = expectOk(
      removeEndpointFromPool({
        pool: withOne,
        endpointId: createUpstreamEndpointId('ep-1'),
        removedAt: AT + 2,
      }),
    );
    expect(empty.endpoints).toEqual([]);
  });

  it('rejects a non-member and a regressing timestamp', () => {
    expect(
      expectRejection(
        removeEndpointFromPool({
          pool: pool(),
          endpointId: createUpstreamEndpointId('ep-9'),
          removedAt: AT + 1,
        }),
      ),
    ).toBe('endpoint_not_in_pool');
    const withOne = expectOk(
      addEndpointToPool({ pool: pool(), endpoint: endpoint('ep-1'), addedAt: AT + 3 }),
    );
    expect(
      expectRejection(
        removeEndpointFromPool({
          pool: withOne,
          endpointId: createUpstreamEndpointId('ep-1'),
          removedAt: AT + 2,
        }),
      ),
    ).toBe('timestamp_regression');
  });

  it('rejects an invalid endpoint id or pool', () => {
    expect(
      expectRejection(removeEndpointFromPool({ pool: pool(), endpointId: '', removedAt: AT })),
    ).toBe('invalid_upstream_endpoint_id');
    expect(
      expectRejection(
        removeEndpointFromPool({
          pool: { bad: true } as unknown as EndpointPool,
          endpointId: createUpstreamEndpointId('ep-1'),
          removedAt: AT,
        }),
      ),
    ).toBe('invalid_endpoint_pool');
  });
});

describe('deriveEndpointPoolHealth', () => {
  it('is down for an empty pool', () => {
    const health = deriveEndpointPoolHealth(pool());
    expect(health.status).toBe('down');
    expect(health.serving).toBe(false);
    expect(health.totalCount).toBe(0);
  });

  it('is down when no endpoint is healthy, even with degraded endpoints', () => {
    const health = deriveEndpointPoolHealth(poolWith(['degraded', 'down']));
    expect(health.status).toBe('down');
    expect(health.serving).toBe(false);
  });

  it('is healthy when at least one healthy and none down', () => {
    const health = deriveEndpointPoolHealth(poolWith(['healthy', 'degraded']));
    expect(health.status).toBe('healthy');
    expect(health.serving).toBe(true);
    expect(health.healthyCount).toBe(1);
    expect(health.degradedCount).toBe(1);
  });

  it('is degraded when a healthy endpoint coexists with a down one', () => {
    const health = deriveEndpointPoolHealth(poolWith(['healthy', 'down']));
    expect(health.status).toBe('degraded');
    expect(health.serving).toBe(true);
    expect(health.downCount).toBe(1);
  });

  it('fails closed to down for a malformed pool', () => {
    const health = deriveEndpointPoolHealth({ bad: true } as unknown as EndpointPool);
    expect(health.status).toBe('down');
    expect(health.serving).toBe(false);
  });
});

describe('evaluateOfferEndpointHealth', () => {
  it('reports healthy when any pool is healthy', () => {
    const healthyPool = expectOk(
      addEndpointToPool({
        pool: pool(),
        endpoint: endpoint('ep-1', { health: 'healthy' }),
        addedAt: AT + 1,
      }),
    );
    const downPool = pool('pool-2');
    const health = expectOk(evaluateOfferEndpointHealth(OFFER, [healthyPool, downPool]));
    expect(health.hasHealthyPool).toBe(true);
    expect(health.status).toBe('healthy');
    expect(health.serving).toBe(true);
    expect(health.pools).toHaveLength(2);
    expect(Object.isFrozen(health.pools)).toBe(true);
  });

  it('reports degraded when no pool is healthy but one still serves', () => {
    const degradedPool = expectOk(
      addEndpointToPool({
        pool: expectOk(
          addEndpointToPool({
            pool: pool(),
            endpoint: endpoint('ep-1', { health: 'healthy' }),
            addedAt: AT + 1,
          }),
        ),
        endpoint: endpoint('ep-2', { health: 'down', createdAt: AT + 2 }),
        addedAt: AT + 3,
      }),
    );
    const health = expectOk(evaluateOfferEndpointHealth(OFFER, [degradedPool]));
    expect(health.hasHealthyPool).toBe(false);
    expect(health.status).toBe('degraded');
    expect(health.serving).toBe(true);
  });

  it('reports down when no pool serves', () => {
    const health = expectOk(evaluateOfferEndpointHealth(OFFER, [pool()]));
    expect(health.status).toBe('down');
    expect(health.serving).toBe(false);
  });

  it('rejects an empty pool list', () => {
    expect(expectRejection(evaluateOfferEndpointHealth(OFFER, []))).toBe('endpoint_pool_missing');
  });

  it('rejects a pool of another offer instead of filtering it', () => {
    const other = pool('pool-9', createModelOfferId('offer-2'));
    expect(expectRejection(evaluateOfferEndpointHealth(OFFER, [pool(), other]))).toBe(
      'pool_offer_mismatch',
    );
  });

  it('rejects malformed input', () => {
    expect(expectRejection(evaluateOfferEndpointHealth(OFFER, null))).toBe('ambiguous_context');
    expect(
      expectRejection(
        evaluateOfferEndpointHealth(OFFER, [{ bad: true } as unknown as EndpointPool]),
      ),
    ).toBe('invalid_endpoint_pool');
    expect(expectRejection(evaluateOfferEndpointHealth('' as never, [pool()]))).toBe(
      'invalid_model_offer_id',
    );
  });

  it('rejects duplicated pool ids in the list', () => {
    expect(expectRejection(evaluateOfferEndpointHealth(OFFER, [pool(), pool()]))).toBe(
      'ambiguous_context',
    );
  });
});
