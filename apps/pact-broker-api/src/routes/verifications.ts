/**
 * Verification routes — port từ upstream `src/routes/verifications.ts`
 * (ADAPT). Status giữ nguyên: POST 201, GET 200, thiếu → 404.
 *
 * id là uuid ở schema PG (upstream SQLite integer autoincrement): URL giữ
 * uuid; HAL self link ghim uuid thật thay vì số thứ tự.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import { HalBuilder, getBaseUrl, nameSchema, shaSchema } from '@ecoma-io/pact-broker-api-domain';
import { readJsonBodyWithLimit, validateParam } from '../middleware/validate';
import { PgVerificationRepo } from '@ecoma-io/pact-broker-api-infrastructure';

/** UUID format — id của verification ở schema PG. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function verificationRoutes(writeAuth: () => MiddlewareHandler<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Get a specific verification result
  app.get(
    '/provider/:provider/consumer/:consumer/pact-version/:sha/verification-results/:id',
    writeAuth(),
    async (c) => {
      const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
      if (!providerResult.valid) return providerResult.errorResponse;
      const providerName = providerResult.value;

      const consumerResult = validateParam(c, nameSchema, c.req.param('consumer'), 'consumer');
      if (!consumerResult.valid) return consumerResult.errorResponse;
      const consumerName = consumerResult.value;

      const shaResult = validateParam(c, shaSchema, c.req.param('sha'), 'sha');
      if (!shaResult.valid) return shaResult.errorResponse;
      const pactSha = shaResult.value;

      const idParam = c.req.param('id');
      if (!UUID_RE.test(idParam)) {
        return c.json({ error: 'Not Found', message: 'Verification not found' }, 404);
      }

      const repo = new PgVerificationRepo(c.get('pool'));
      const result = await repo.getVerificationById(currentTenantId(c), idParam, pactSha);
      if (result === null) {
        return c.json({ error: 'Not Found', message: 'Verification not found' }, 404);
      }

      const hal = new HalBuilder(getBaseUrl(c.req.raw));
      return c.json({
        success: result.verification.success,
        providerApplicationVersion: result.providerVersionNumber,
        buildUrl: result.verification.buildUrl,
        verifiedAt: result.verification.verifiedAt,
        _links: hal.verification(providerName, consumerName, pactSha, idParam),
      });
    },
  );

  // Publish verification results
  app.post(
    '/provider/:provider/consumer/:consumer/pact-version/:sha/verification-results',
    writeAuth(),
    async (c) => {
      const providerResult = validateParam(c, nameSchema, c.req.param('provider'), 'provider');
      if (!providerResult.valid) return providerResult.errorResponse;
      const providerName = providerResult.value;

      const consumerResult = validateParam(c, nameSchema, c.req.param('consumer'), 'consumer');
      if (!consumerResult.valid) return consumerResult.errorResponse;
      const consumerName = consumerResult.value;

      const shaResult = validateParam(c, shaSchema, c.req.param('sha'), 'sha');
      if (!shaResult.valid) return shaResult.errorResponse;
      const pactSha = shaResult.value;

      const bodyResult = await readJsonBodyWithLimit(c, 64 * 1024, 'Verification body');
      if (!bodyResult.ok) return bodyResult.errorResponse;
      if (bodyResult.value === undefined) {
        return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
      }
      const body = bodyResult.value as {
        success?: unknown;
        providerApplicationVersion?: unknown;
        buildUrl?: unknown;
      };

      if (typeof body.success !== 'boolean') {
        return c.json(
          { error: 'Bad Request', message: 'success field is required and must be boolean' },
          400,
        );
      }

      if (!body.providerApplicationVersion) {
        return c.json(
          { error: 'Bad Request', message: 'providerApplicationVersion is required' },
          400,
        );
      }
      const versionResult = validateParam(
        c,
        nameSchema,
        typeof body.providerApplicationVersion === 'string'
          ? body.providerApplicationVersion
          : undefined,
        'providerApplicationVersion',
      );
      if (!versionResult.valid) return versionResult.errorResponse;

      const repo = new PgVerificationRepo(c.get('pool'));
      const verification = await repo.publishVerification(
        currentTenantId(c),
        providerName,
        consumerName,
        pactSha,
        versionResult.value,
        body.success,
        typeof body.buildUrl === 'string' ? body.buildUrl : undefined,
      );

      if (verification === null) {
        // Pact không thuộc tenant (hoặc không tồn tại) — 404 đồng nhất.
        return c.json({ error: 'Not Found', message: 'Pact not found' }, 404);
      }

      // Webhook outbound TẮT (SR-006) — không dispatch.

      const hal = new HalBuilder(getBaseUrl(c.req.raw));
      return c.json(
        {
          success: verification.success,
          providerApplicationVersion: versionResult.value,
          buildUrl: verification.buildUrl,
          verifiedAt: verification.verifiedAt,
          _links: hal.verification(providerName, consumerName, pactSha, verification.id),
        },
        201,
      );
    },
  );

  return app;
}
