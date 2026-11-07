/**
 * Webhook routes — port từ upstream `src/routes/webhooks.ts` (ADAPT).
 *
 * ⚠️ Outbound execution: config `webhooksEnabled` là false CỨNG (SR-006,
 * config.ts chặn true lúc boot khi chưa có SSRF guard). POST /:id/execute
 * vẫn nhận request (202) để giữ HAL surface cho client, nhưng KHÔNG mở kết
 * nối nào: nó ghi một execution `succeeded = false` ghi rõ delivery disabled.
 * Tương tự CRUD giữ nguyên để cấu hình sẵn trước khi guard có mặt.
 */
import { Hono, type MiddlewareHandler } from 'hono';
// Named imports, chủ ý — xem ghi chú trong src/domain/validation.ts.
import { array, boolean, enum as zEnum, object, record, string } from 'zod';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import { HalBuilder, getBaseUrl } from '@ecoma-io/pact-broker-api-domain';
import { PgWebhookRepo } from '@ecoma-io/pact-broker-api-infrastructure';
import { readJsonBodyWithLimit } from '../middleware/validate';

const webhookCreateSchema = object({
  events: array(zEnum(['contract_published', 'provider_verification_published'])).min(
    1,
    'events must contain at least one event',
  ),
  url: string()
    .url('url must be a valid URL')
    .refine((u) => u.startsWith('https://'), {
      message: 'url must use https',
    }),
  headers: record(string(), string()).optional(),
  consumer: string()
    .regex(/^[a-zA-Z0-9._-]+$/u)
    .nullable()
    .optional(),
  provider: string()
    .regex(/^[a-zA-Z0-9._-]+$/u)
    .nullable()
    .optional(),
  enabled: boolean().optional(),
});

const webhookUpdateSchema = webhookCreateSchema.partial();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function serialiseWebhook(
  hal: HalBuilder,
  w: {
    id: string;
    events: string[];
    url: string;
    headers: Record<string, string> | null;
    consumerName: string | null;
    providerName: string | null;
    enabled: boolean;
    createdAt: string;
  },
): Record<string, unknown> {
  return {
    id: w.id,
    events: w.events,
    url: w.url,
    headersSet: Object.keys(w.headers ?? {}).toSorted(),
    consumer: w.consumerName,
    provider: w.providerName,
    enabled: w.enabled,
    createdAt: w.createdAt,
    _links: {
      self: hal.link(`/webhooks/${w.id}`),
      'pb:executions': hal.link(`/webhooks/${w.id}/executions`, 'Delivery log'),
      'pb:execute': hal.link(`/webhooks/${w.id}/execute`, 'Fire manually'),
    },
  };
}

export function webhookRoutes(
  readAuth: () => MiddlewareHandler<AppEnv>,
  writeAuth: () => MiddlewareHandler<AppEnv>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List webhooks
  app.get('/', readAuth(), async (c) => {
    const repo = new PgWebhookRepo(c.get('pool'));
    const list = await repo.listWebhooks(currentTenantId(c));
    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      _links: { self: hal.link('/webhooks') },
      _embedded: {
        webhooks: list.map((w) => serialiseWebhook(hal, w)),
      },
    });
  });

  // Create webhook
  app.post('/', writeAuth(), async (c) => {
    const bodyResult = await readJsonBodyWithLimit(c, 1 * 1024 * 1024, 'Webhook body');
    if (!bodyResult.ok) return bodyResult.errorResponse;
    if (bodyResult.value === undefined) {
      return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
    }
    const raw = bodyResult.value;
    const parsed = webhookCreateSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return c.json(
        {
          error: 'Bad Request',
          message: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid webhook',
        },
        400,
      );
    }
    const repo = new PgWebhookRepo(c.get('pool'));
    const hook = await repo.createWebhook(currentTenantId(c), {
      events: parsed.data.events,
      url: parsed.data.url,
      headers: parsed.data.headers ?? null,
      consumer: parsed.data.consumer ?? null,
      provider: parsed.data.provider ?? null,
      enabled: parsed.data.enabled,
    });
    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(serialiseWebhook(hal, hook), 201);
  });

  // Get webhook
  app.get('/:id', readAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    }
    const repo = new PgWebhookRepo(c.get('pool'));
    const hook = await repo.getWebhook(currentTenantId(c), id);
    if (hook === null) return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(serialiseWebhook(hal, hook));
  });

  // Update webhook
  app.put('/:id', writeAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    }
    const bodyResult = await readJsonBodyWithLimit(c, 1 * 1024 * 1024, 'Webhook body');
    if (!bodyResult.ok) return bodyResult.errorResponse;
    if (bodyResult.value === undefined) {
      return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
    }
    const raw = bodyResult.value;
    const parsed = webhookUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return c.json(
        {
          error: 'Bad Request',
          message: first ? `${first.path.join('.')}: ${first.message}` : 'Invalid webhook',
        },
        400,
      );
    }
    const repo = new PgWebhookRepo(c.get('pool'));
    const updated = await repo.updateWebhook(currentTenantId(c), id, {
      ...(parsed.data.events !== undefined && { events: parsed.data.events }),
      ...(parsed.data.url !== undefined && { url: parsed.data.url }),
      ...(parsed.data.headers !== undefined && { headers: parsed.data.headers }),
      ...(parsed.data.consumer !== undefined && { consumer: parsed.data.consumer }),
      ...(parsed.data.provider !== undefined && { provider: parsed.data.provider }),
      ...(parsed.data.enabled !== undefined && { enabled: parsed.data.enabled }),
    });
    if (updated === null) return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(serialiseWebhook(hal, updated));
  });

  // Delete webhook
  app.delete('/:id', writeAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    }
    const repo = new PgWebhookRepo(c.get('pool'));
    const ok = await repo.deleteWebhook(currentTenantId(c), id);
    if (!ok) return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    return c.body(null, 204);
  });

  // Fire webhook manually — 202 như upstream, nhưng KHÔNG HTTP ra ngoài khi
  // outbound TẮT: ghi execution disabled là toàn bộ hiệu ứng.
  app.post('/:id/execute', writeAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    }
    const tenantId = currentTenantId(c);
    const repo = new PgWebhookRepo(c.get('pool'));
    const existing = await repo.getWebhook(tenantId, id);
    if (existing === null) return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    if (!existing.enabled) {
      return c.json({ error: 'Bad Request', message: 'webhook is disabled' }, 400);
    }

    // Outbound TẮT (SR-006): log execution thất bại với lý do rõ ràng —
    // audit trail đầy đủ, không request nào tới URL của webhook.
    await repo.recordExecution(tenantId, id, {
      event: existing.events[0] ?? 'contract_published',
      trigger: 'manual',
      succeeded: false,
      responseBody: 'webhook delivery is disabled: no SSRF guard (SR-006)',
    });
    return c.json({ fired: false, disabled: true }, 202);
  });

  // List executions for a webhook
  app.get('/:id/executions', readAuth(), async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    }
    const tenantId = currentTenantId(c);
    const repo = new PgWebhookRepo(c.get('pool'));
    const existing = await repo.getWebhook(tenantId, id);
    if (existing === null) return c.json({ error: 'Not Found', message: 'Webhook not found' }, 404);
    const executions = await repo.getExecutions(tenantId, id);
    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      _links: {
        self: hal.link(`/webhooks/${id}/executions`),
        'pb:webhook': hal.link(`/webhooks/${id}`),
      },
      _embedded: {
        executions: executions.map((e) => ({
          id: e.id,
          event: e.event,
          triggeredBy: e.trigger,
          responseStatus: e.responseStatus,
          responseBody: e.responseBody,
          succeeded: e.succeeded,
          executedAt: e.executedAt,
          _links: {
            self: hal.link(`/webhooks/${id}/executions/${e.id}`),
            'pb:webhook': hal.link(`/webhooks/${id}`),
          },
        })),
      },
    });
  });

  return app;
}
