/**
 * Matrix + can-i-deploy routes — port từ upstream `src/routes/matrix.ts`
 * (ADAPT: DO → PG repo). Semantics query param giữ nguyên: reference client
 * gửi `q[][pacticipant]`, `q[][version]`, `q[][environment]` (hoặc `tag`) —
 * cả hai format array và đơn đều nhận.
 *
 * DOM-02/03/13: `/matrix` áp fail-closed empty-result override (giống
 * `/can-i-deploy`), parse raw query để thu toàn bộ selector (`q[]` lặp),
 * và honor `?environment=` / `q[][environment]` cho --to-environment.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { currentTenantId } from '../middleware/tenant-context';
import {
  HalBuilder,
  branchSchema,
  decorateMatrixRow,
  getBaseUrl,
  nameSchema,
  summarizeMatrix,
  toSummaryRows,
  versionSchema,
} from '@ecoma-io/pact-broker-api-domain';
import type { MatrixRowData } from '@ecoma-io/pact-broker-api-domain';
import { evaluateCanIDeploy } from '@ecoma-io/pact-broker-api-application';
import { validateParam, validateOptionalQuery } from '../middleware/validate';
import { PgMatrixRepo, PgVersionRepo } from '@ecoma-io/pact-broker-api-infrastructure';

interface Selector {
  pacticipant: string;
  version?: string;
  latest: boolean;
  environment?: string;
  resolvedVersion?: string;
}

export function matrixRoutes(readAuth: () => MiddlewareHandler<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Query the matrix
  app.get('/matrix', readAuth(), async (c) => {
    const queries = c.req.queries();

    const pickAll = (keys: string[]): string[] => {
      for (const key of keys) {
        const vals = queries[key];
        if (Array.isArray(vals) && vals.length > 0) return vals;
      }
      return [];
    };

    const pacticipantVals = pickAll(['q[][pacticipant]', 'q[pacticipant]', 'pacticipant']);
    const versionVals = pickAll(['q[][version]', 'q[version]', 'version']);
    const latestVals = pickAll(['q[][latest]', 'q[latest]', 'latest']);
    const selectorEnvVals = pickAll(['q[][environment]', 'q[environment]']);

    if (pacticipantVals.length === 0) {
      return c.json(
        { error: 'Bad Request', message: 'pacticipant query parameter is required' },
        400,
      );
    }

    const latestBroadcast = latestVals.length === 1 && pacticipantVals.length > 1;

    const selectors: Selector[] = pacticipantVals.map((p, i) => ({
      pacticipant: p,
      version:
        versionVals.length === 1 && pacticipantVals.length > 1 ? versionVals[0] : versionVals[i],
      latest:
        latestVals.length === 0
          ? false
          : latestBroadcast
            ? latestVals[0] === 'true'
            : latestVals[i] === 'true',
      environment: selectorEnvVals.length === 1 ? selectorEnvVals[0] : selectorEnvVals[i],
    }));

    // Validate pacticipant names.
    for (const sel of selectors) {
      const r = validateParam(c, nameSchema, sel.pacticipant, 'pacticipant');
      if (!r.valid) return r.errorResponse;
      sel.pacticipant = r.value;
    }
    // Validate versions when present.
    for (const sel of selectors) {
      if (sel.version !== undefined && sel.version !== '') {
        const r = validateOptionalQuery(c, versionSchema, sel.version, 'version');
        if (!r.valid) return r.errorResponse;
        sel.version = r.value;
      } else {
        sel.version = undefined;
      }
    }

    // Target resolution (environment → tag), giữ nguyên semantics cũ.
    const envGlobal = pickAll(['environment']);
    const environmentRaw =
      (envGlobal.length > 0 ? envGlobal[0] : undefined) ??
      (selectorEnvVals.length > 0 ? selectorEnvVals[0] : undefined);
    const targetRaw =
      environmentRaw ??
      ((): string | undefined => {
        const tagVals = pickAll(['q[][tag]', 'q[tag]', 'tag']);
        return tagVals.length > 0 ? tagVals[0] : undefined;
      })();
    const targetKind = environmentRaw ? ('environment' as const) : ('tag' as const);

    const targetResult = validateOptionalQuery(c, branchSchema, targetRaw, 'tag');
    if (!targetResult.valid) return targetResult.errorResponse;

    const tenantId = currentTenantId(c);
    const repo = new PgMatrixRepo(c.get('pool'));
    const versionRepo = new PgVersionRepo(c.get('pool'));

    // Resolve `latest=true` thành version number cụ thể.
    for (const sel of selectors) {
      if (sel.version === undefined && sel.latest) {
        const versions = await versionRepo.getVersionsByPacticipant(tenantId, sel.pacticipant);
        sel.resolvedVersion = versions[0]?.number;
      } else {
        sel.resolvedVersion = sel.version;
      }
    }

    const seen = new Set<string>();
    const allRows: MatrixRowData[] = [];
    for (const sel of selectors) {
      const { rows } = await repo.getMatrix(
        tenantId,
        sel.pacticipant,
        sel.resolvedVersion,
        targetResult.value,
        targetKind,
      );
      for (const row of rows) {
        const key = `${row.consumer.name}|${row.consumer.version.number}|${row.provider.name}|${row.pact.sha}`;
        if (!seen.has(key)) {
          seen.add(key);
          allRows.push(row);
        }
      }
    }

    const hasVersion = selectors.some((s) => s.resolvedVersion !== undefined);

    let anyExists = false;
    for (const sel of selectors) {
      if (await repo.selectorExists(tenantId, sel.pacticipant, sel.resolvedVersion)) {
        anyExists = true;
      }
    }

    const reasonSelector = selectors.find((s) => s.resolvedVersion !== undefined) ?? selectors[0];

    // Cùng verdict fail-closed của use case can-i-deploy, áp cho /matrix khi
    // selector mang version: matrix rỗng lúc đó là fail-OPEN nếu để qua
    // summarizeMatrix([]) — ép null kèm reason tường minh (DOM-02). Khi
    // selector KHÔNG có version, giữ semantics upstream: matrix rỗng đi qua
    // summarizeMatrix([]) → deployable true ("no missing dependencies").
    const { summary, notices } =
      hasVersion && allRows.length === 0
        ? evaluateCanIDeploy({
            rows: allRows,
            pacticipant: reasonSelector.pacticipant,
            // `hasVersion` đúng đảm bảo reasonSelector.resolvedVersion khác
            // undefined; fallback chỉ để types chặt.
            version: reasonSelector.resolvedVersion ?? reasonSelector.pacticipant,
            consumerVersionExists: anyExists,
          })
        : summarizeMatrix(toSummaryRows(allRows));

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      summary,
      notices,
      matrix: allRows.map((row) => decorateMatrixRow(hal, row)),
      _links: hal.matrix(),
    });
  });

  // Can I Deploy — fail-closed tri-state qua summarizeMatrix (deployable
  // false khi có failed, null khi có unknown, true chỉ khi mọi cái pass).
  app.get('/can-i-deploy', readAuth(), async (c) => {
    const pacticipantRaw = c.req.query('pacticipant');
    const versionRaw = c.req.query('version');
    const toRaw = c.req.query('to') ?? c.req.query('toTag');
    const environmentRaw = c.req.query('environment');

    const toEffective = environmentRaw ?? toRaw;
    const targetKind = environmentRaw ? ('environment' as const) : undefined;

    if (!pacticipantRaw || !versionRaw) {
      return c.json(
        { error: 'Bad Request', message: 'pacticipant and version query parameters are required' },
        400,
      );
    }

    const pacticipantResult = validateParam(c, nameSchema, pacticipantRaw, 'pacticipant');
    if (!pacticipantResult.valid) return pacticipantResult.errorResponse;

    const versionResult = validateParam(c, versionSchema, versionRaw, 'version');
    if (!versionResult.valid) return versionResult.errorResponse;

    // 'to' là environment, tag hoặc branch — không biết cái nào cho tới khi
    // resolve, nên validate theo schema nới nhất trong ba. environmentNameSchema
    // sẽ từ chối thẳng `release/1.2` và `1.0.0-rc`.
    const toResult = validateOptionalQuery(c, branchSchema, toEffective, 'to');
    if (!toResult.valid) return toResult.errorResponse;

    const repo = new PgMatrixRepo(c.get('pool'));
    const { rows, consumerVersionExists } = await repo.canIDeploy(
      currentTenantId(c),
      pacticipantResult.value,
      versionResult.value,
      toResult.value,
      targetKind,
    );

    // Verdict fail-closed (DOM-02) thuộc use case — route chỉ map ra HAL.
    const { summary, notices } = evaluateCanIDeploy({
      rows,
      pacticipant: pacticipantResult.value,
      version: versionResult.value,
      consumerVersionExists,
    });

    const hal = new HalBuilder(getBaseUrl(c.req.raw));
    return c.json({
      summary,
      notices,
      matrix: rows.map((row) => decorateMatrixRow(hal, row)),
      _links: hal.canIDeploy(),
    });
  });

  return app;
}
