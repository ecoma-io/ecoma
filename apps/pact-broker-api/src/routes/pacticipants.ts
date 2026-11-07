/**
 * Pacticipant / version / tag / deployment routes — port từ upstream
 * `src/routes/pacticipants.ts` (ADAPT: DO → PG repo, thêm tenant scope).
 * HTTP status giữ nguyên từng route: PUT version 200, PUT tag 201, POST
 * deployed-versions 201, DELETE deployed 204, PUT branch-version 200.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import {
  HalBuilder,
  branchSchema,
  environmentNameSchema,
  getBaseUrl,
  nameSchema,
  tagSchema,
  versionSchema,
} from '@ecoma-io/pact-broker-api-domain';
import { readJsonBodyWithLimit, validateParam } from '../middleware/validate';
import { PgEnvironmentRepo, PgVersionRepo } from '@ecoma-io/pact-broker-api-infrastructure';

export function pacticipantRoutes(
  readAuth: () => MiddlewareHandler<AppEnv>,
  writeAuth: () => MiddlewareHandler<AppEnv>,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List all pacticipants
  app.get('/', readAuth(), async (c) => {
    const repo = new PgVersionRepo(c.get('pool'));
    const pacticipants = await repo.getAllPacticipants(currentTenantId(c));
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      _links: {
        self: hal.link('/pacticipants'),
      },
      _embedded: {
        pacticipants: pacticipants.map((p) => ({
          name: p.name,
          createdAt: p.createdAt,
          _links: hal.pacticipant(p.name),
        })),
      },
    });
  });

  // Get a specific pacticipant
  app.get('/:name', readAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;

    const repo = new PgVersionRepo(c.get('pool'));
    const pacticipant = await repo.getPacticipant(currentTenantId(c), nameResult.value);
    if (pacticipant === null) {
      return c.json({ error: 'Not Found', message: 'Pacticipant not found' }, 404);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      name: pacticipant.name,
      createdAt: pacticipant.createdAt,
      _links: hal.pacticipant(pacticipant.name),
    });
  });

  // List versions for a pacticipant
  app.get('/:name/versions', readAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    const versions = await repo.getVersionsByPacticipant(currentTenantId(c), name);
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      _links: {
        self: hal.link(`/pacticipants/${encodeURIComponent(name)}/versions`),
      },
      _embedded: {
        versions: versions.map((v) => ({
          number: v.number,
          branch: v.branch,
          buildUrl: v.buildUrl,
          createdAt: v.createdAt,
          _links: hal.version(name, v.number),
        })),
      },
    });
  });

  // Get a specific version — kèm pb:record-deployment per environment.
  app.get('/:name/versions/:version', readAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const pool = c.get('pool');
    const tenantId = currentTenantId(c);
    const repo = new PgVersionRepo(pool);
    const version = await repo.getVersion(tenantId, name, versionNumber);
    if (version === null) {
      return c.json({ error: 'Not Found', message: 'Version not found' }, 404);
    }

    const envRepo = new PgEnvironmentRepo(pool);
    const environments = await envRepo.getAllEnvironments(tenantId);

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      number: version.number,
      branch: version.branch,
      buildUrl: version.buildUrl,
      createdAt: version.createdAt,
      _links: {
        ...hal.version(name, version.number),
        'pb:record-deployment': hal.recordDeployment(
          name,
          version.number,
          environments.map((e) => e.name),
        ),
      },
    });
  });

  // Create or update a version. pact-broker-client PUTs đây trần
  // (versions/create.rb#create_version) và, trên publish path cũ, với
  // {branch, buildUrl} (publish_pacts_the_old_way.rb#version_body). Body tuỳ
  // chọn; body không parse được bị bỏ qua thay vì từ chối.
  app.put('/:name/versions/:version', writeAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const bodyResult = await readJsonBodyWithLimit(c, 64 * 1024, 'Pacticipant body');
    let body: { branch?: unknown; buildUrl?: unknown } = {};
    if (bodyResult.ok) {
      body = (bodyResult.value ?? {}) as typeof body;
    } else if (bodyResult.errorResponse.status === 413) {
      return bodyResult.errorResponse;
    } else {
      // Invalid JSON — bare PUT documented case; ignore parse error.
    }

    let branch: string | undefined;
    if (typeof body.branch === 'string' && body.branch !== '') {
      const branchResult = validateParam(c, branchSchema, body.branch, 'branch');
      if (!branchResult.valid) return branchResult.errorResponse;
      branch = branchResult.value;
    }

    const buildUrl =
      typeof body.buildUrl === 'string' && body.buildUrl !== '' ? body.buildUrl : undefined;

    const repo = new PgVersionRepo(c.get('pool'));
    const { version } = await repo.getOrCreateVersion(
      currentTenantId(c),
      name,
      versionNumber,
      branch,
      buildUrl,
    );

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        number: version.number,
        branch: version.branch,
        buildUrl: version.buildUrl,
        createdAt: version.createdAt,
        _links: hal.version(name, version.number),
      },
      200,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  // Record a deployment kiểu pact-broker-client: POST tới per-environment
  // link được quảng cáo trên version resource.
  app.post(
    '/:name/versions/:version/deployed-versions/environment/:environment',
    writeAuth(),
    async (c) => {
      const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
      if (!nameResult.valid) return nameResult.errorResponse;
      const name = nameResult.value;

      const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
      if (!versionResult.valid) return versionResult.errorResponse;
      const versionNumber = versionResult.value;

      const environmentResult = validateParam(
        c,
        environmentNameSchema,
        c.req.param('environment'),
        'environment',
      );
      if (!environmentResult.valid) return environmentResult.errorResponse;
      const environmentName = environmentResult.value;

      const repo = new PgVersionRepo(c.get('pool'));
      const deployment = await repo.recordDeployment(
        currentTenantId(c),
        name,
        versionNumber,
        environmentName,
      );
      if (deployment === null) {
        return c.json({ error: 'Not Found', message: 'Version not found' }, 404);
      }

      const hal = new HalBuilder(getBaseUrl(c.req.raw));
      return c.json(
        {
          environment: deployment.environment,
          deployedAt: deployment.deployedAt,
          undeployedAt: deployment.undeployedAt,
          _links: hal.deployment(name, versionNumber, deployment.environment),
        },
        201,
        { 'Content-Type': 'application/hal+json' },
      );
    },
  );

  // Create or update a version on a branch — pb:branch-version resource.
  //
  // pact-reference PUT "{}" đây trước khi publish verification results, nên
  // body bị bỏ qua chủ ý: đòi JSON hợp lệ sẽ từ chối client đó.
  app.put('/:name/branches/:branch/versions/:version', writeAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const branchResult = validateParam(c, branchSchema, c.req.param('branch'), 'branch');
    if (!branchResult.valid) return branchResult.errorResponse;
    const branch = branchResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    const version = await repo.recordVersionBranch(currentTenantId(c), name, versionNumber, branch);

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        number: version.number,
        branch: version.branch,
        buildUrl: version.buildUrl,
        createdAt: version.createdAt,
        _links: hal.version(name, version.number),
      },
      200,
      { 'Content-Type': 'application/hal+json' },
    );
  });

  // Get tags for a version
  app.get('/:name/versions/:version/tags', readAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    const versionTags = await repo.getTagsForVersion(currentTenantId(c), name, versionNumber);
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      _links: {
        self: hal.link(
          `/pacticipants/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionNumber)}/tags`,
        ),
      },
      _embedded: {
        tags: versionTags.map((t) => ({
          name: t.name,
          createdAt: t.createdAt,
          _links: hal.tag(name, versionNumber, t.name),
        })),
      },
    });
  });

  // Get a specific tag
  app.get('/:name/versions/:version/tags/:tag', readAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const tagResult = validateParam(c, tagSchema, c.req.param('tag'), 'tag');
    if (!tagResult.valid) return tagResult.errorResponse;
    const tagName = tagResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    const tag = await repo.getTag(currentTenantId(c), name, versionNumber, tagName);
    if (tag === null) {
      return c.json({ error: 'Not Found', message: 'Tag not found' }, 404);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      name: tag.name,
      createdAt: tag.createdAt,
      _links: hal.tag(name, versionNumber, tag.name),
    });
  });

  // Create/update a tag — luôn 201 (upstream giữ 201 cả khi tag đã có).
  app.put('/:name/versions/:version/tags/:tag', writeAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const tagResult = validateParam(c, tagSchema, c.req.param('tag'), 'tag');
    if (!tagResult.valid) return tagResult.errorResponse;
    const tagName = tagResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    // Version phải tồn tại trước (upstream kiểm getVersion trước addTag).
    const version = await repo.getVersion(currentTenantId(c), name, versionNumber);
    if (version === null) {
      return c.json({ error: 'Not Found', message: 'Version not found' }, 404);
    }

    const tag = await repo.addTag(currentTenantId(c), name, versionNumber, tagName);
    if (tag === null) {
      return c.json({ error: 'Internal Error', message: 'Failed to create tag' }, 500);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        name: tag.name,
        createdAt: tag.createdAt,
        _links: hal.tag(name, versionNumber, tag.name),
      },
      201,
    );
  });

  // Get deployments for a version
  app.get('/:name/versions/:version/deployed', readAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    const deployments = await repo.getDeploymentsForVersion(
      currentTenantId(c),
      name,
      versionNumber,
    );
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      _links: {
        self: hal.link(
          `/pacticipants/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionNumber)}/deployed`,
        ),
      },
      _embedded: {
        deployments: deployments.map((d) => ({
          environment: d.environment,
          deployedAt: d.deployedAt,
          undeployedAt: d.undeployedAt,
          _links: hal.deployment(name, versionNumber, d.environment),
        })),
      },
    });
  });

  // Record a deployment (PUT legacy path)
  app.put('/:name/versions/:version/deployed/:environment', writeAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const environmentResult = validateParam(
      c,
      environmentNameSchema,
      c.req.param('environment'),
      'environment',
    );
    if (!environmentResult.valid) return environmentResult.errorResponse;
    const environmentName = environmentResult.value;

    const repo = new PgVersionRepo(c.get('pool'));

    // Version phải tồn tại trước (upstream kiểm getVersion trước recordDeployment).
    const version = await repo.getVersion(currentTenantId(c), name, versionNumber);
    if (version === null) {
      return c.json({ error: 'Not Found', message: 'Version not found' }, 404);
    }

    const deployment = await repo.recordDeployment(
      currentTenantId(c),
      name,
      versionNumber,
      environmentName,
    );
    if (deployment === null) {
      return c.json({ error: 'Internal Error', message: 'Failed to record deployment' }, 500);
    }

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json(
      {
        environment: deployment.environment,
        deployedAt: deployment.deployedAt,
        undeployedAt: deployment.undeployedAt,
        _links: hal.deployment(name, versionNumber, deployment.environment),
      },
      201,
    );
  });

  // Record an undeployment
  app.delete('/:name/versions/:version/deployed/:environment', writeAuth(), async (c) => {
    const nameResult = validateParam(c, nameSchema, c.req.param('name'), 'name');
    if (!nameResult.valid) return nameResult.errorResponse;
    const name = nameResult.value;

    const versionResult = validateParam(c, versionSchema, c.req.param('version'), 'version');
    if (!versionResult.valid) return versionResult.errorResponse;
    const versionNumber = versionResult.value;

    const environmentResult = validateParam(
      c,
      environmentNameSchema,
      c.req.param('environment'),
      'environment',
    );
    if (!environmentResult.valid) return environmentResult.errorResponse;
    const environmentName = environmentResult.value;

    const repo = new PgVersionRepo(c.get('pool'));
    const result = await repo.recordUndeployment(
      currentTenantId(c),
      name,
      versionNumber,
      environmentName,
    );
    if (result === null) {
      return c.json({ error: 'Not Found', message: 'No active deployment found' }, 404);
    }

    return c.body(null, 204);
  });

  return app;
}
