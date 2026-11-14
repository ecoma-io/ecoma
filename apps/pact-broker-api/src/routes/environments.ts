/**
 * Environments routes — port từ upstream `src/routes/environments.ts`
 * (ADAPT: DO → PG repo, thêm tenant scope). HTTP status giữ nguyên: POST 201
 * application/hal+json, PUT luôn 201 application/json, GET 200.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import { HalBuilder, environmentNameSchema, getBaseUrl } from '@ecoma-io/pact-broker-api-domain';
import { readJsonBodyWithLimit, validateParam } from '../middleware/validate';
import { PgEnvironmentRepo, insertAuditEvent } from '@ecoma-io/pact-broker-api-infrastructure';
import type { EnvironmentRecord } from '@ecoma-io/pact-broker-api-infrastructure';

export function environmentRoutes(
  readAuth: () => MiddlewareHandler<AppEnv>,
  writeAuth: () => MiddlewareHandler<AppEnv>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List — `pact-broker-client` tìm environment theo link `name`
  // (record_release.rb#environment_exists?), không phải _embedded.
  app.get('/', readAuth(), async (c) => {
    const repo = new PgEnvironmentRepo(c.get('pool'));
    const envs = await repo.getAllEnvironments(currentTenantId(c));
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      _links: {
        self: hal.link('/environments'),
        'pb:environments': envs.map((e) => ({
          ...hal.link(`/environments/${encodeURIComponent(e.name)}`, e.displayName ?? e.name),
          name: e.name,
        })),
      },
      _embedded: {
        environments: envs.map((e) => ({
          uuid: e.uuid,
          name: e.name,
          displayName: e.displayName,
          production: e.production,
          createdAt: e.createdAt,
          _links: hal.environment(e.name),
        })),
      },
    });
  });

  // Create — `pact-broker create-environment` POSTs collection.
  app.post('/', writeAuth(), async (c) => {
    const bodyResult = await readJsonBodyWithLimit(c, 1 * 1024 * 1024, 'Environment body');
    if (!bodyResult.ok) return bodyResult.errorResponse;
    if (bodyResult.value === undefined) {
      return c.json({ error: 'Bad Request', message: 'Invalid JSON body' }, 400);
    }
    const body = bodyResult.value as {
      name?: unknown;
      displayName?: unknown;
      production?: unknown;
    };

    const nameResult = validateParam(
      c,
      environmentNameSchema,
      typeof body.name === 'string' ? body.name : undefined,
      'name',
    );
    if (!nameResult.valid) return nameResult.errorResponse;

    const tenantId = currentTenantId(c);
    const callerTokenId = c.get('tokenId') ?? null;
    const repo = new PgEnvironmentRepo(c.get('pool'));
    const { environment, created } = await repo.getOrCreate(
      tenantId,
      nameResult.value,
      typeof body.displayName === 'string' ? body.displayName : undefined,
      typeof body.production === 'boolean' ? body.production : undefined,
    );

    const auditClient = await c.get('pool').connect();
    try {
      await auditClient.query('BEGIN');
      await insertAuditEvent(auditClient, {
        tenantId,
        actorSub: null,
        actorTokenId: callerTokenId,
        action: created ? 'environment.create' : 'environment.update',
        outcome: 'success',
        detail: { name: environment.name },
      });
      await auditClient.query('COMMIT');
    } catch (error) {
      await auditClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      auditClient.release();
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        uuid: environment.uuid,
        name: environment.name,
        displayName: environment.displayName,
        production: environment.production,
        createdAt: environment.createdAt,
        _links: hal.environment(environment.name),
      },
      201,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  // Get một environment.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

  app.get('/:id', readAuth(), async (c) => {
    const raw = c.req.param('id');
    const repo = new PgEnvironmentRepo(c.get('pool'));
    const tenantId = currentTenantId(c);
    const environment = UUID_RE.test(raw)
      ? await repo.getEnvironmentByUuid(tenantId, raw)
      : await (async (): Promise<EnvironmentRecord | null> => {
          const r = validateParam(c, environmentNameSchema, raw, 'name');
          if (!r.valid) return null;
          return repo.getEnvironment(tenantId, r.value);
        })();
    if (environment === null) {
      return c.json({ error: 'Not Found', message: 'Environment not found' }, 404);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      uuid: environment.uuid,
      name: environment.name,
      displayName: environment.displayName,
      production: environment.production,
      createdAt: environment.createdAt,
      _links: hal.environment(environment.name),
    });
  });

  // Create or update — upstream PUT luôn 201, body rỗng hợp lệ.
  app.put('/:id', writeAuth(), async (c) => {
    const raw = c.req.param('id');
    const bodyResult = await readJsonBodyWithLimit(c, 1 * 1024 * 1024, 'Environment body');
    let body: { displayName?: unknown; production?: unknown; name?: unknown } = {};
    if (bodyResult.ok) {
      body = (bodyResult.value ?? {}) as typeof body;
    } else if (bodyResult.errorResponse.status === 413) {
      return bodyResult.errorResponse;
    }

    const tenantId = currentTenantId(c);
    const callerTokenId = c.get('tokenId') ?? null;
    const repo = new PgEnvironmentRepo(c.get('pool'));

    let targetName: string;
    if (UUID_RE.test(raw)) {
      const existing = await repo.getEnvironmentByUuid(tenantId, raw);
      if (existing === null) {
        return c.json({ error: 'Not Found', message: 'Environment not found' }, 404);
      }
      targetName = existing.name;
    } else {
      const nameResult = validateParam(c, environmentNameSchema, raw, 'name');
      if (!nameResult.valid) return nameResult.errorResponse;
      targetName = nameResult.value;
    }

    const { environment, created } = await repo.getOrCreate(
      tenantId,
      targetName,
      typeof body.displayName === 'string' ? body.displayName : undefined,
      typeof body.production === 'boolean' ? body.production : undefined,
    );

    const auditClient = await c.get('pool').connect();
    try {
      await auditClient.query('BEGIN');
      await insertAuditEvent(auditClient, {
        tenantId,
        actorSub: null,
        actorTokenId: callerTokenId,
        action: created ? 'environment.create' : 'environment.update',
        outcome: 'success',
        detail: { name: environment.name },
      });
      await auditClient.query('COMMIT');
    } catch (error) {
      await auditClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      auditClient.release();
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        uuid: environment.uuid,
        name: environment.name,
        displayName: environment.displayName,
        production: environment.production,
        createdAt: environment.createdAt,
        _links: hal.environment(environment.name),
      },
      201,
    );
  });

  // DELETE environment — Pact CLI `delete-environment`. Audit `environment.delete`
  // (ADR-0032: coverage của #206) — cùng pattern create/update: mutation qua
  // repo (pool), audit ghi trong transaction riêng (client); audit lỗi thì
  // error propagate (fail-closed, request 500) chứ không nuốt.
  app.delete('/:id', writeAuth(), async (c) => {
    const raw = c.req.param('id');
    const repo = new PgEnvironmentRepo(c.get('pool'));
    const tenantId = currentTenantId(c);
    const callerTokenId = c.get('tokenId') ?? null;
    let ok: boolean;
    let deletedName: string;
    if (UUID_RE.test(raw)) {
      // Tên đọc TRƯỚC khi delete — sau delete row đã biến, không tra lại được.
      const existing = await repo.getEnvironmentByUuid(tenantId, raw);
      if (existing === null) {
        return c.json({ error: 'Not Found', message: 'Environment not found' }, 404);
      }
      deletedName = existing.name;
      ok = await repo.deleteEnvironment(tenantId, raw, true);
    } else {
      const nameResult = validateParam(c, environmentNameSchema, raw, 'name');
      if (!nameResult.valid) return nameResult.errorResponse;
      deletedName = nameResult.value;
      ok = await repo.deleteEnvironment(tenantId, nameResult.value, false);
    }
    if (!ok) {
      return c.json({ error: 'Not Found', message: 'Environment not found' }, 404);
    }

    const auditClient = await c.get('pool').connect();
    try {
      await auditClient.query('BEGIN');
      await insertAuditEvent(auditClient, {
        tenantId,
        actorSub: null,
        actorTokenId: callerTokenId,
        action: 'environment.delete',
        outcome: 'success',
        detail: { name: deletedName },
      });
      await auditClient.query('COMMIT');
    } catch (error) {
      await auditClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      auditClient.release();
    }
    return c.body(null, 204);
  });

  return app;
}
