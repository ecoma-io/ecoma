/**
 * Pact routes — port từ upstream `src/routes/pacts.ts` (ADAPT: DO → PG repo).
 * HTTP status giữ nguyên: PUT pact 201 mới / 200 đã có; GET 200; for-
 * verification GET/POST 200 hal+json.
 *
 * body-limit per-route 1 MiB: body-limit middleware tổng thể của main.ts là
 * 5 MiB cho mọi route; publish pact bị siết riêng như upstream.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import {
  HalBuilder,
  branchSchema,
  getBaseUrl,
  nameSchema,
  shaSchema,
  tagSchema,
  versionSchema,
} from '@ecoma-io/pact-broker-api-domain';
import { validatePactStructure } from '@ecoma-io/pact-broker-api-application';
import { readJsonBodyWithLimit, validateParam } from '../middleware/validate';
import { PgPactRepo, PgVersionRepo } from '@ecoma-io/pact-broker-api-infrastructure';
import type { PactContent, PactFull } from '@ecoma-io/pact-broker-api-infrastructure';

// 1 MB per-route cap trên PUT /pacts/... — cao hơn nhiều so với pact thực tế
// (~100 KB) mà vẫn là trần có ý nghĩa chống lạm dụng token lộ.
const PACT_PUBLISH_MAX_BYTES = 1 * 1024 * 1024;
/** Trần số consumerVersionSelectors mỗi request for-verification (chống query amplification). */
const MAX_CONSUMER_SELECTORS = 50;

/** Dựng pact response HAL — port buildPactResponse upstream. */
function buildPactResponse(
  hal: HalBuilder,
  pact: { content: unknown; contentSha: string; createdAt: string },
  consumer: { name: string },
  provider: { name: string },
  version: { number: string },
): Record<string, unknown> {
  // `pacts.content` là JSONB: driver `pg` trả về object đã parse. Chuỗi JSON
  // thô (migration cũ/test fixture) cũng được chấp nhận. Pact lưu hỏng không
  // được làm mọi GET kế tiếp chết: fallback interactions rỗng + log
  // server-side. KHÔNG log nội dung pact — chỉ sha.
  let content: { interactions?: unknown[]; metadata?: Record<string, unknown> };
  if (typeof pact.content === 'string') {
    try {
      content = JSON.parse(pact.content) as {
        interactions?: unknown[];
        metadata?: Record<string, unknown>;
      };
    } catch (err) {
      // oxlint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'buildPactResponse: failed to parse stored pact content',
          contentSha: pact.contentSha,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      content = { interactions: [], metadata: {} };
    }
  } else if (pact.content !== null && typeof pact.content === 'object') {
    content = pact.content as { interactions?: unknown[]; metadata?: Record<string, unknown> };
  } else {
    content = { interactions: [], metadata: {} };
  }

  return {
    consumer: { name: consumer.name },
    provider: { name: provider.name },
    _embedded: {
      consumer: {
        name: consumer.name,
        _embedded: { version: { number: version.number } },
      },
      provider: { name: provider.name },
    },
    consumerVersion: version.number,
    contentSha: pact.contentSha,
    createdAt: pact.createdAt,
    interactions: content.interactions,
    metadata: content.metadata,
    _links: hal.pact(provider.name, consumer.name, version.number, pact.contentSha),
  };
}

export function pactRoutes(
  readAuth: () => MiddlewareHandler<AppEnv>,
  writeAuth: () => MiddlewareHandler<AppEnv>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Publish a pact
  app.put('/provider/:provider/consumer/:consumer/version/:version', writeAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const consumerResult = validateParam(c, nameSchema, c.req.param('consumer'), 'consumer');
    if (!consumerResult.valid) return consumerResult.errorResponse;
    const consumerName = consumerResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const consumerVersion = versionResult.value;

    // Validate optional branch query param
    const branchParam = c.req.query('branch');
    if (branchParam) {
      const branchResult = validateParam(c, branchSchema, branchParam, 'branch');
      if (!branchResult.valid) return branchResult.errorResponse;
    }

    // Per-route body cap — đếm byte TRÊN STREAM (readJsonBodyWithLimit),
    // không tin Content-Length: request chunked không có header đó và bỏ qua
    // mọi check dựa trên header.
    const bodyResult = await readJsonBodyWithLimit(c, PACT_PUBLISH_MAX_BYTES, 'Pact body');
    if (!bodyResult.ok) return bodyResult.errorResponse;
    if (bodyResult.value === undefined) {
      return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
    }
    const body = bodyResult.value as PactContent;

    // Structural check thuộc use case publish — route chỉ dịch rejection
    // thành 400 với message nguyên văn của use case.
    const structural = validatePactStructure(body);
    if (structural.outcome === 'rejected') {
      return c.json({ error: 'Bad Request', message: structural.message }, 400);
    }

    const repo = new PgPactRepo(c.get('pool'));
    const branch = c.req.query('branch') ?? undefined;

    const { created } = await repo.publishPact(
      currentTenantId(c),
      consumerName,
      consumerVersion,
      providerName,
      body,
      branch,
    );

    // Webhook outbound TẮT (SR-006): không dispatch. Schema webhook giữ
    // CRUD để cấu hình sẵn, nhưng không execution nào chạy cho tới khi có
    // SSRF guard — docs/applications/pact-broker/01-architecture.md §6.

    const result = await repo.getPact(
      currentTenantId(c),
      providerName,
      consumerName,
      consumerVersion,
    );
    if (result === null) {
      return c.json({ error: 'Internal Error', message: 'Failed to retrieve published pact' }, 500);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    const response = buildPactResponse(
      hal,
      result.pact,
      result.consumer,
      result.provider,
      result.version,
    );

    return c.json(response, created ? 201 : 200);
  });

  // Get a specific pact version
  app.get('/provider/:provider/consumer/:consumer/version/:version', readAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const consumerResult = validateParam(c, nameSchema, c.req.param('consumer'), 'consumer');
    if (!consumerResult.valid) return consumerResult.errorResponse;
    const consumerName = consumerResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const consumerVersion = versionResult.value;

    const repo = new PgPactRepo(c.get('pool'));
    const result = await repo.getPact(
      currentTenantId(c),
      providerName,
      consumerName,
      consumerVersion,
    );
    if (result === null) {
      return c.json({ error: 'Not Found', message: 'Pact not found' }, 404);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      buildPactResponse(hal, result.pact, result.consumer, result.provider, result.version),
    );
  });

  // Get pact by content SHA (verifier fetch từ for-verification links)
  app.get('/provider/:provider/consumer/:consumer/pact-version/:sha', readAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const consumerResult = validateParam(c, nameSchema, c.req.param('consumer'), 'consumer');
    if (!consumerResult.valid) return consumerResult.errorResponse;
    const consumerName = consumerResult.value;

    const shaResult = validateParam(c, shaSchema, c.req.param('sha'), 'sha');
    if (!shaResult.valid) return shaResult.errorResponse;
    const sha = shaResult.value;

    const repo = new PgPactRepo(c.get('pool'));
    const result = await repo.getPactByContentShaFull(
      currentTenantId(c),
      providerName,
      consumerName,
      sha,
    );
    if (result === null) {
      return c.json({ error: 'Not Found', message: 'Pact not found' }, 404);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      buildPactResponse(hal, result.pact, result.consumer, result.provider, result.version),
      200,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  // Get latest pact (optionally by tag)
  app.get('/provider/:provider/consumer/:consumer/latest/:tag?', readAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const consumerResult = validateParam(c, nameSchema, c.req.param('consumer'), 'consumer');
    if (!consumerResult.valid) return consumerResult.errorResponse;
    const consumerName = consumerResult.value;

    // Validate optional tag
    const tagParam = c.req.param('tag');
    let tag: string | undefined;
    if (tagParam) {
      const tagResult = validateParam(c, tagSchema, tagParam, 'tag');
      if (!tagResult.valid) return tagResult.errorResponse;
      tag = tagResult.value;
    }

    const repo = new PgPactRepo(c.get('pool'));
    const result = await repo.getLatestPact(currentTenantId(c), providerName, consumerName, tag);
    if (result === null) {
      return c.json({ error: 'Not Found', message: 'Pact not found' }, 404);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      buildPactResponse(hal, result.pact, result.consumer, result.provider, result.version),
    );
  });

  // Get all latest pacts for a provider
  app.get('/provider/:provider/latest', readAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const repo = new PgPactRepo(c.get('pool'));
    const pacts = await repo.getLatestPactsForProvider(currentTenantId(c), providerName);
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      _links: {
        self: hal.link(`/pacts/provider/${encodeURIComponent(providerName)}/latest`),
        provider: hal.link(`/pacticipants/${encodeURIComponent(providerName)}`),
        'pb:pacts': pacts.map((p) => ({
          href: `${hal.baseUrl}/pacts/provider/${encodeURIComponent(providerName)}/consumer/${encodeURIComponent(p.consumer.name)}/latest`,
          title: `Latest pact between ${p.consumer.name} and ${providerName}`,
          name: p.consumer.name,
        })),
      },
      _embedded: {
        pacts: pacts.map((p) => buildPactResponse(hal, p.pact, p.consumer, p.provider, p.version)),
      },
    });
  });

  // Get all latest pacts
  app.get('/latest', readAuth(), async (c) => {
    const repo = new PgPactRepo(c.get('pool'));
    const tenantId = currentTenantId(c);
    const allPacts: PactFull[] = [];
    const providers = await new PgVersionRepo(c.get('pool')).getAllPacticipants(tenantId);
    for (const p of providers) {
      const pacts = await repo.getLatestPactsForProvider(tenantId, p.name);
      allPacts.push(...pacts);
    }
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    const builtPacts = allPacts.map((p) =>
      buildPactResponse(hal, p.pact, p.consumer, p.provider, p.version),
    );
    return c.json({
      _links: {
        self: hal.link('/pacts/latest'),
        'pb:pacts': allPacts.map((p) => ({
          href: `${hal.baseUrl}/pacts/provider/${encodeURIComponent(p.provider.name)}/consumer/${encodeURIComponent(p.consumer.name)}/latest`,
          title: `Latest pact between ${p.consumer.name} and ${p.provider.name}`,
          name: p.consumer.name,
        })),
      },
      pacts: builtPacts,
      _embedded: { pacts: builtPacts },
    });
  });

  // Pacts for verification - GET deprecated nhưng vẫn có client dùng
  app.get('/provider/:provider/for-verification', readAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const repo = new PgPactRepo(c.get('pool'));
    // GET dùng default selectors (latest pacts)
    const selectors = [{ latest: true }];
    const results = await repo.getPactsForVerification(currentTenantId(c), providerName, selectors);

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        _embedded: { pacts: toForVerification(results, hal, providerName) },
        _links: hal.pactsForVerification(providerName),
      },
      200,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  // POST cho phép custom selectors
  app.post('/provider/:provider/for-verification', readAuth(), async (c) => {
    const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
    if (!providerResult.valid) return providerResult.errorResponse;
    const providerName = providerResult.value;

    const bodyResult = await readJsonBodyWithLimit(
      c,
      1 * 1024 * 1024,
      'Pact for-verification body',
    );
    let body: { consumerVersionSelectors?: Array<Record<string, unknown>> } = {};
    if (bodyResult.ok) {
      body = (bodyResult.value ?? {}) as typeof body;
    } else if (bodyResult.errorResponse.status === 413) {
      return bodyResult.errorResponse;
    }
    // Invalid JSON or empty body: keep default (latest pacts)

    const repo = new PgPactRepo(c.get('pool'));
    const rawSelectors = body.consumerVersionSelectors;
    // Cap số selector: mỗi selector constrained nhân số query tag/deployed
    // tra per-candidate — hàng nghìn selector từ token read là query
    // amplification pin isolate + pool Hyperdrive (max 5). Upstream không cap
    // nhưng single-tenant; multi-tenant thì read token phát rộng nên phải cap.
    if (Array.isArray(rawSelectors) && rawSelectors.length > MAX_CONSUMER_SELECTORS) {
      return c.json(
        {
          error: 'Bad Request',
          message: `consumerVersionSelectors exceeds maximum of ${MAX_CONSUMER_SELECTORS}`,
        },
        400,
      );
    }
    const selectors =
      rawSelectors === undefined || !Array.isArray(rawSelectors)
        ? [{ latest: true }]
        : rawSelectors.map((s) => ({
            consumer: typeof s.consumer === 'string' ? s.consumer : undefined,
            tag: typeof s.tag === 'string' ? s.tag : undefined,
            branch: typeof s.branch === 'string' ? s.branch : undefined,
            mainBranch: s.mainBranch === true,
            latest: s.latest === true,
            deployed: s.deployed === true,
            environment: typeof s.environment === 'string' ? s.environment : undefined,
          }));

    const results = await repo.getPactsForVerification(currentTenantId(c), providerName, selectors);

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        _embedded: { pacts: toForVerification(results, hal, providerName) },
        _links: hal.pactsForVerification(providerName),
      },
      200,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  return app;
}

/** Shape PactForVerification — giữ nguyên cấu trúc HAL upstream. */
function toForVerification(
  results: Awaited<ReturnType<PgPactRepo['getPactsForVerification']>>,
  hal: HalBuilder,
  providerName: string,
): Array<Record<string, unknown>> {
  return results.map(({ pact, consumer, version, notices }) => ({
    shortDescription: `Pact between ${consumer.name} (${version.number}) and ${providerName}`,
    verificationProperties: {
      notices: notices.map((text) => ({
        text: `This pact is being verified because ${text}`,
        when: 'before_verification',
      })),
      pending: false,
    },
    _links: {
      self: {
        href: `${hal.baseUrl}/pacts/provider/${encodeURIComponent(providerName)}/consumer/${encodeURIComponent(consumer.name)}/pact-version/${pact.contentSha}`,
        name: `Pact between ${consumer.name} (${version.number}) and ${providerName}`,
      },
    },
  }));
}
