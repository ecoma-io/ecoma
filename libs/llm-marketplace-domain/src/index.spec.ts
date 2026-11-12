import { describe, expect, it } from 'vitest';

import {
  LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES,
  activateModelOffer,
  addEndpointToPool,
  assertCredentialProvider,
  assignPublicAlias,
  createCapabilitySet,
  createEndpointPool,
  createEndpointPoolId,
  createModelOffer,
  createModelOfferId,
  createNormalizedModelIdentity,
  createProviderCredential,
  createProviderCredentialId,
  createSellerActorId,
  createSellerFallbackConfig,
  createSellerTenantId,
  createUpstreamEndpoint,
  createUpstreamEndpointId,
  deactivateModelOffer,
  deriveEndpointPoolHealth,
  evaluateActivationEligibility,
  evaluateOfferEndpointHealth,
  isModelOffer,
  isModelOfferServing,
  llmMarketplaceOk,
  mapProviderModelToNormalizedIdentity,
  normalizeModelId,
  orderEndpointCandidates,
  recordEndpointHealth,
  replaceEndpointInPool,
  revokeProviderCredential,
  toPublicProviderCredential,
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

const AT = 1_700_000_000_000;
const TENANT = createSellerTenantId('tenant-1');
const OTHER_TENANT = createSellerTenantId('tenant-2');
const OFFER_ID = createModelOfferId('offer-1');
const POOL_ID = createEndpointPoolId('pool-1');

describe('index public API surface', () => {
  it('exports the domain operations and guards', () => {
    for (const exported of [
      createModelOffer,
      assignPublicAlias,
      activateModelOffer,
      deactivateModelOffer,
      createEndpointPool,
      addEndpointToPool,
      createUpstreamEndpoint,
      recordEndpointHealth,
      createSellerFallbackConfig,
      orderEndpointCandidates,
      createProviderCredential,
      revokeProviderCredential,
      assertCredentialProvider,
      createNormalizedModelIdentity,
      createCapabilitySet,
      evaluateOfferEndpointHealth,
      deriveEndpointPoolHealth,
      evaluateActivationEligibility,
      isModelOffer,
      isModelOfferServing,
      llmMarketplaceOk,
    ]) {
      expect(typeof exported).toBe('function');
    }
    expect(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES.credential_revoked).toBe(
      'The provider credential is revoked.',
    );
  });
});

function fullOffer() {
  const identity = expectOk(
    createNormalizedModelIdentity('gpt-4o', [
      { provider: 'openai', model: 'gpt-4o' },
      { provider: 'azure', model: 'gpt-4o-2024-08-06' },
    ]),
  );
  const normalizedModelId = expectOk(normalizeModelId(identity.normalizedModelId));
  const draft = expectOk(
    createModelOffer({
      id: OFFER_ID,
      sellerTenantId: TENANT,
      normalizedModelId,
      capabilities: ['text_generation', 'vision'],
      createdAt: AT,
    }),
  );
  const named = expectOk(
    assignPublicAlias({ offer: draft, publicAlias: normalizedModelId, assignedAt: AT + 1 }),
  );
  const pool = expectOk(createEndpointPool({ id: POOL_ID, offerId: named.id, createdAt: AT + 2 }));
  const endpoint = expectOk(
    createUpstreamEndpoint({
      id: createUpstreamEndpointId('ep-1'),
      endpointPoolId: pool.id,
      url: 'https://api.provider.example/v1/chat',
      protocol: 'openai_chat',
      createdAt: AT + 3,
    }),
  );
  const healthy = expectOk(
    recordEndpointHealth({ endpoint, health: 'healthy', recordedAt: AT + 4 }),
  );
  const withEndpoint = expectOk(addEndpointToPool({ pool, endpoint: healthy, addedAt: AT + 5 }));
  return { identity, offer: named, pool: withEndpoint };
}

describe('cross-operation lifecycle (regression)', () => {
  it('draft → assign alias → healthy pool → activate → serve → deactivate', () => {
    const { identity, offer, pool } = fullOffer();

    expect(identity.normalizedModelId).toBe('gpt-4o');
    expect(offer.status).toBe('draft');
    expect(isModelOfferServing(offer, [pool])).toBe(false);

    const eligibility: SellerOperationalEligibility = {
      tenantId: TENANT,
      eligible: true,
      blockers: [],
      assessedAt: AT,
    };
    const assessment = evaluateActivationEligibility(
      eligibility,
      offer.sellerTenantId,
      offer.createdAt,
    );
    expect(assessment.eligible).toBe(true);

    const active = expectOk(
      activateModelOffer({ offer, eligibility, pools: [pool], activatedAt: AT + 6 }),
    );
    expect(active.status).toBe('active');
    expect(isModelOfferServing(active, [pool])).toBe(true);

    const inactive = expectOk(deactivateModelOffer({ offer: active, deactivatedAt: AT + 7 }));
    expect(inactive.status).toBe('inactive');
    expect(isModelOfferServing(inactive, [pool])).toBe(false);
  });

  it('maps a provider spelling to the offer normalized identity', () => {
    const { identity, offer } = fullOffer();
    const mapped = expectOk(
      mapProviderModelToNormalizedIdentity([identity], 'azure', 'gpt-4o-2024-08-06'),
    );
    expect(mapped.normalizedModelId).toBe(offer.normalizedModelId);
  });

  it('health degradation propagates to offer serving without changing offer state', () => {
    const { offer, pool } = fullOffer();
    const eligibility: SellerOperationalEligibility = {
      tenantId: TENANT,
      eligible: true,
      blockers: [],
      assessedAt: AT,
    };
    const active = expectOk(
      activateModelOffer({ offer, eligibility, pools: [pool], activatedAt: AT + 6 }),
    );
    const endpoint = pool.endpoints[0];
    const down = expectOk(recordEndpointHealth({ endpoint, health: 'down', recordedAt: AT + 7 }));
    const degradedPool = expectOk(
      replaceEndpointInPool({ pool, endpoint: down, replacedAt: AT + 8 }),
    );

    expect(deriveEndpointPoolHealth(degradedPool).status).toBe('down');
    expect(expectOk(evaluateOfferEndpointHealth(active.id, [degradedPool])).serving).toBe(false);
    expect(isModelOfferServing(active, [degradedPool])).toBe(false);
    expect(active.status).toBe('active');
  });

  it('fallback config orders the same pool collection that activation checked', () => {
    const { offer, pool } = fullOffer();
    const config = expectOk(
      createSellerFallbackConfig({
        offerId: offer.id,
        poolPreference: [pool.id],
        endpointPreferences: [{ poolId: pool.id, endpointIds: [pool.endpoints[0].id] }],
        context: { offerId: offer.id, pools: [pool] },
      }),
    );
    const candidates = expectOk(orderEndpointCandidates({ config, pools: [pool] }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].rank).toBe(1);
    expect(candidates[0].endpoint.id).toBe('ep-1');
  });

  it('a revoked credential cannot be used for a later endpoint binding', () => {
    const created = expectOk(
      createProviderCredential({
        id: createProviderCredentialId('cred-1'),
        provider: 'openai',
        sellerTenantId: TENANT,
        credentialHash: 'sha256:deadbeef',
        plaintext: 'sk-once',
        createdBy: createSellerActorId('sub-1'),
        createdAt: AT,
      }),
    );
    expect(expectOk(assertCredentialProvider(created.credential, 'openai', TENANT)).id).toBe(
      'cred-1',
    );
    expect(toPublicProviderCredential(created.credential)).not.toHaveProperty('credentialHash');

    const revoked = expectOk(
      revokeProviderCredential({
        credential: created.credential,
        revokedBy: createSellerActorId('sub-1'),
        revokedAt: AT + 1,
      }),
    );
    const reuse = assertCredentialProvider(revoked, 'openai', TENANT);
    expect(reuse.ok).toBe(false);
    if (reuse.ok) {
      throw new Error('expected a failure branch');
    }
    expect(reuse.error.code).toBe('credential_revoked');
  });

  it('a credential of another Seller tenant is rejected on cross-tenant use', () => {
    const created = expectOk(
      createProviderCredential({
        id: createProviderCredentialId('cred-1'),
        provider: 'openai',
        sellerTenantId: TENANT,
        credentialHash: 'sha256:deadbeef',
        plaintext: 'sk-once',
        createdBy: createSellerActorId('sub-1'),
        createdAt: AT,
      }),
    );
    const foreign = assertCredentialProvider(created.credential, 'openai', OTHER_TENANT);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) {
      throw new Error('expected a failure branch');
    }
    expect(foreign.error.code).toBe('credential_tenant_mismatch');
  });
});
