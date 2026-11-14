/**
 * Portal routes cua control plane (issue #202 — Internal Developer Portal,
 * quyet dinh pham vi #177).
 *
 * Surface nay phuc vu **human principal**: portal BFF (#180) xac thuc
 * developer qua Ecoma Account phia server roi goi qua envelope HMAC noi bo
 * mang actor sub da verify (`src/portal-auth.ts`). Quyen resolve TU DATABASE
 * trong mot request: membership tren `remote_cache.tenant_members` cua tenant
 * tren duong dan (R17) — khong co duong nao tin danh tinh browser cung cap.
 *
 * Sau workflows (R19):
 * - `GET    /tenants/:tenantName/projects`                          — list project
 * - `POST   /tenants/:tenantName/projects`                          — tao project + key dau tien (show-once)
 * - `GET    /tenants/:tenantName/projects/:projectName`             — chi tiet project
 * - `POST   /tenants/:tenantName/projects/:projectName/api-keys`    — tao them key (show-once)
 * - `GET    /tenants/:tenantName/projects/:projectName/api-keys`    — list metadata key (khong lo secret)
 * - `POST   /tenants/:tenantName/projects/:projectName/api-keys/:keyId/revoke` — revoke ngay lap tuc
 *
 * R20: moi key portal-cap la **developer credential** — `trusted_ci = false`
 * dinh, chi scope `read`; khong co request nao chon duoc `write` hay trusted.
 * Trusted CI write semantics cua data plane khong doi.
 *
 * R15: moi mutation qua portal ghi audit entry (actor `user:<sub>`, action,
 * target, outcome) TRONG CUNG transaction voi mutation — audit insert loi la
 * rollback, khong co mutation khong co audit. Attempt bi tu choi
 * (lifecycle/conflict) ghi outcome `denied`.
 *
 * ⚠️ Onboarding khong doi key may co truoc (R18): tao project + key dau tien
 * chi cam envelope cua member — khong bao gio doi API key. Duong may
 * (`src/routes.ts`) giu nguyen semantics trusted_ci.
 *
 * ⚠️ **Outcome union cua moi route co KIEU TRA VE TUONG MINH** (vi du
 * `PortalCreateProjectOutcome`): narrowing `'authFailure' in outcome` tren mot
 * generic T SUA TU callback inline khong loai duoc remnant (TS them
 * `authFailure?: undefined` vao moi member va giu no sau khi narrow) — voi
 * return type khai bao minh, narrowing hoat dong va khong con cast nao o
 * cho map response.
 */
import { Hono } from 'hono';
import {
  validateRemoteCacheProject,
  validateRemoteCacheProjectListRequest,
  type RemoteCacheApiKeyScope,
  type RemoteCacheProject,
} from '@ecoma-io/remote-cache-contracts';
import {
  getProjectByTenantAndName,
  insertApiKey,
  insertProject,
  listProjectsByTenant,
  revokeApiKey,
  withRemoteCacheClient,
  type ProjectRow,
  type RemoteCacheClient,
  type RemoteCacheQueryable,
} from '@ecoma-io/remote-cache-infrastructure';
import { isRemoteCacheDomainError } from '@ecoma-io/remote-cache-domain';
import { enforceTenantLifecycle } from './lifecycle';
import type { RemoteCacheConfig } from './config';
import { readBodyBytes, verifyPortalIdentity, type PortalAuthFailure } from './portal-auth';
import {
  portalCredentialClassOf,
  validatePortalApiKeyMetadata,
  validatePortalCreateApiKeyRequest,
  validatePortalCreateProjectRequest,
  PORTAL_API_KEY_SCOPES,
  type PortalApiKeyCreated,
  type PortalApiKeyMetadata,
} from './portal-contract';
import type { AppEnv } from './types';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor';
import { generateApiToken, sha256Hex, toIsoCreatedAt } from './routes';

/** Loi http chuan cua portal route — body JSON khong leak noi bo. */
interface PortalHttpError {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  readonly body: { error: string; message: string };
  readonly headers?: Readonly<Record<string, string>>;
}

function portalBadRequest(message: string): PortalHttpError {
  return { status: 400, body: { error: 'Bad Request', message } };
}

function portalForbidden(message: string): PortalHttpError {
  return { status: 403, body: { error: 'Forbidden', message } };
}

function portalNotFound(message: string): PortalHttpError {
  return { status: 404, body: { error: 'Not Found', message } };
}

function portalConflict(message: string): PortalHttpError {
  return { status: 409, body: { error: 'Conflict', message } };
}

function bodyTooLargeError(): PortalHttpError {
  return {
    status: 413,
    body: { error: 'Payload Too Large', message: 'Request body exceeds the limit.' },
  };
}

/** Tap hop tenant + membership da resolve — nguon quyen cua mot request. */
interface PortalTenantContext {
  readonly tenantId: string;
  readonly tenantName: string;
}

/** Mot hang api key nhu query list metadata tra ve (khong bao gio token_hash). */
interface PortalApiKeyRow {
  readonly id: string;
  readonly scopes: string;
  readonly trusted_ci: boolean;
  readonly revoked_at: Date | string | null;
  readonly created_at: Date | string;
}

/** Outcome union cua tung route — kieu tra ve TUONG MINH cua callback. */
type PortalListProjectsOutcome =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError }
  | { readonly projectRows: readonly ProjectRow[] };

type PortalCreateProjectOutcome =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError }
  | {
      readonly projectId: string;
      readonly apiKeyId: string;
      readonly token: string;
      /**
       * Payload DA validate contract, doc-lai TRONG transaction nhu tren cung
       * client. Validation that bai la rollback, khong phai 500 cho du lieu
       * da commit (xem comment trong `db.begin`).
       */
      readonly project: RemoteCacheProject;
    };

type PortalProjectDetailOutcome =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError }
  | { readonly project: ProjectRow };

type PortalCreateApiKeyOutcome =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError }
  | { readonly projectId: string; readonly apiKeyId: string; readonly token: string };

type PortalListApiKeysOutcome =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError }
  | { readonly project: ProjectRow; readonly keyRows: readonly PortalApiKeyRow[] };

type PortalRevokeApiKeyOutcome =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError }
  | { readonly keyId: string; readonly revokedAt: string };

/** Action audit cho mutation portal — tap con thu nhat cung vocabulary 0008. */
type PortalAuditAction = 'project_created' | 'api_key_created' | 'api_key_revoked';

/**
 * Ghi mot audit entry (R15). Ngoai tap action cua repository dung chung
 * (`insertAuditLog` typed dong tren 4 action quota/cache), nen insert
 * app-local cung shape — khi vien repository sang lib thi bo ban nay.
 */
async function insertPortalAuditLog(
  db: RemoteCacheQueryable,
  entry: {
    readonly actor: string;
    readonly action: PortalAuditAction;
    readonly target: string;
    readonly outcome: 'allowed' | 'denied';
    /** UUID project khi action da resolve duoc project; null cho attempt bi tu choi som. */
    readonly projectId?: string | null;
    /**
     * Boi canh bo sung khong nam trong `target` (tien le `details` cua cac
     * audit quota/cache trong `cache-routes.ts` — vi du ten project de con
     * truy vet khi target chi mang UUID).
     */
    readonly details?: string | null;
  },
): Promise<void> {
  await db.unsafe(
    `INSERT INTO remote_cache.audit_log (actor, action, target, outcome, details, project_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actor,
      entry.action,
      entry.target,
      entry.outcome,
      entry.details ?? null,
      entry.projectId ?? null,
    ],
  );
}

/**
 * Resolve tenant theo ten + membership cua actor (R17) — QUYEN DOC TU DB
 * trong request, khong tu trang thai login cua portal. Tenant khong ton tai
 * thi 404 (khong reveal membership); ton tai nhung khong la member thi 403.
 */
async function resolveTenantMembership(
  db: RemoteCacheQueryable,
  actorSub: string,
  tenantName: string,
): Promise<PortalTenantContext | PortalHttpError> {
  const tenantRows = await db.unsafe<{ id: string }>(
    'SELECT id FROM remote_cache.tenants WHERE name = $1',
    [tenantName],
  );
  const tenant = tenantRows[0];
  if (tenant === undefined) {
    return portalNotFound('The requested tenant does not exist.');
  }
  const memberRows = await db.unsafe<{ role: string }>(
    'SELECT role FROM remote_cache.tenant_members WHERE tenant_id = $1 AND member_sub = $2',
    [tenant.id, actorSub],
  );
  if (memberRows[0] === undefined) {
    return portalForbidden('Actor is not a member of this tenant.');
  }
  return { tenantId: tenant.id, tenantName };
}

/** Kiem UUID hinh thuc — keyId sai hinh la resource khong the ton tai (404). */
function isUuidShape(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

/** Parse JSON object tu byte da doc (body da verify xong chu ky). */
function parseJsonObject(
  bytes: Uint8Array,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: PortalHttpError } {
  if (bytes.length === 0) {
    return { ok: false, error: portalBadRequest('Request body must be a JSON object.') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false, error: portalBadRequest('Request body must be valid JSON.') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: portalBadRequest('Request body must be a JSON object.') };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Map mot PortalAuthFailure thanh PortalHttpError (401 kem WWW-Authenticate). */
function toHttpError(failure: PortalAuthFailure): PortalHttpError {
  return {
    status: failure.status,
    body: failure.body,
    ...(failure.status === 401 ? { headers: failure.headers } : {}),
  };
}

/** Hai that bai mo dau cua moi route portal — auth hoac membership. */
type PortalContextFailure =
  | { readonly authFailure: PortalAuthFailure }
  | { readonly httpError: PortalHttpError };

/** Boi canh da xac thuc cua mot request portal: actor + tenant resolve tu DB. */
type PortalContext =
  | PortalContextFailure
  | { readonly actorSub: string; readonly ctx: PortalTenantContext };

/**
 * Buoc mo dau DUNG CHUNG cua moi route portal (R16/R17): verify envelope,
 * resolve membership theo tenant tren duong dan. Quy truc authorization doi
 * mot cho thay doi o ca sau route; lifecycle check va audit mapping con lai
 * o tung route vi action/target khac nhau. Caller map that bai bang `'in'`
 * tren kieu union tuong minh (xem chu thich outcome o dau file).
 */
async function resolvePortalContext(
  db: RemoteCacheClient,
  input: {
    readonly request: Request;
    readonly body: Uint8Array | null;
    readonly config: RemoteCacheConfig;
    readonly tenantName: string;
  },
): Promise<PortalContext> {
  const identity = await verifyPortalIdentity({
    request: input.request,
    body: input.body,
    config: input.config,
    db,
    now: String(Math.floor(Date.now() / 1000)),
  });
  if (!('actorSub' in identity)) {
    return { authFailure: identity };
  }
  const ctx = await resolveTenantMembership(db, identity.actorSub, input.tenantName);
  if ('status' in ctx) {
    return { httpError: ctx };
  }
  return { actorSub: identity.actorSub, ctx };
}

/**
 * Kiem lifecycle cho mutation (fail-closed, bo qua cache), tra 409 kem audit
 * `denied` khi tenant khong active — attempt tu choi van duoc ghi nhan.
 *
 * ⚠️ Loi cua CHINH ban ghi audit khong duoc che mat ma 409 da quyet dinh: mot
 * attempt bi tu choi vong doi van phai tra 409 (khong phai 500), va ghi audit
 * la best-effort — mat entry audit khong duoc bien thanh loi khac cua request.
 */
async function checkMutationLifecycle(
  db: RemoteCacheClient,
  ctx: PortalTenantContext,
  actorSub: string,
  auditAction: PortalAuditAction,
  auditTarget: string,
): Promise<PortalHttpError | null> {
  try {
    await enforceTenantLifecycle(db, ctx.tenantId, false);
  } catch (error) {
    if (isRemoteCacheDomainError(error)) {
      try {
        await insertPortalAuditLog(db, {
          actor: `user:${actorSub}`,
          action: auditAction,
          target: auditTarget,
          outcome: 'denied',
        });
      } catch (auditError) {
        // Ghi audit that bai: log de khong mat context, khong nem — ma 409 cua
        // quyet dinh van phai la phan hoi cho caller.
        // oxlint-disable-next-line no-console
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'portal-routes',
            errorName: auditError instanceof Error ? auditError.name : String(auditError),
          }),
        );
      }
      return portalConflict(`Tenant lifecycle rejected: ${error.message}`);
    }
    throw error;
  }
  return null;
}

/**
 * Loi UNIQUE tren `projects_tenant_name_unique` — dau hieu DUY NHAT cho thay
 * mot nguoi tao khac da thang cuoc dua giua pre-check va insert cua request
 * nay.
 *
 * Khop ca `code` LAN ten constraint: chi `23505` thi mot vi pham UNIQUE khac
 * (vi du `token_hash` cua api_keys) cung bi hieu nham la trung ten project.
 * `error` la loi cua driver postgres.js, khong phai loi domain.
 */
function isProjectNameConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly constraint_name?: unknown };
  return candidate.code === '23505' && candidate.constraint_name === 'projects_tenant_name_unique';
}

/**
 * Ghi audit `denied` cho mot lan tao project bi tu choi VI TRUNG TEN.
 *
 * ⚠️ Loi cua CHINH ban ghi audit khong duoc che mat ma 409 da quyet dinh —
 * cung nguyen tac voi `checkMutationLifecycle`: log errorName, khong nem, vi
 * phan hoi cho caller da duoc chot boi su that nghiep vu.
 */
async function recordProjectNameConflictDenied(
  db: RemoteCacheQueryable,
  actorSub: string,
  tenantName: string,
  projectName: string,
): Promise<void> {
  try {
    await insertPortalAuditLog(db, {
      actor: `user:${actorSub}`,
      action: 'project_created',
      target: `tenant:${tenantName}/project:${projectName}`,
      outcome: 'denied',
    });
  } catch (auditError) {
    // oxlint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'portal-routes',
        errorName: auditError instanceof Error ? auditError.name : String(auditError),
      }),
    );
  }
}

/** Dung router portal — mount vao app chinh SAU machine routes. */
export function portalRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ------------------------------------------------- list project (R19) --
  app.get('/tenants/:tenantName/projects', async (c) => {
    const tenantName = c.req.param('tenantName');
    const bodyBytes = await readBodyBytes(c.req.raw);
    if (bodyBytes === null) {
      const failure = bodyTooLargeError();
      return c.json(failure.body, failure.status);
    }
    const query = c.req.query();
    const rawLimit = query['limit'];
    const rawCursor = query['cursor'];
    // Validator chuoi contract tu choi moi gia tri khong phu so nguyen trong
    // [1, MAX] — khong can parse chuoi o route: Number('abc') = NaN cung bi
    // tu choi cung reason `invalid_pagination`.
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    const validated = validateRemoteCacheProjectListRequest({
      limit,
      cursor: rawCursor === undefined || rawCursor === '' ? undefined : rawCursor,
    });
    if (!validated.ok) {
      return c.json(portalBadRequest(validated.detail).body, 400);
    }
    const cursor =
      validated.payload.cursor === null
        ? null
        : decodeKeysetCursor(validated.payload.cursor, 'project-created-at');
    if (validated.payload.cursor !== null && cursor === null) {
      return c.json({ error: 'Bad Request', message: 'cursor is not a valid token.' }, 400);
    }

    const outcome = await withRemoteCacheClient(
      c.get('config'),
      async (db): Promise<PortalListProjectsOutcome> => {
        const opened = await resolvePortalContext(db, {
          request: c.req.raw,
          body: bodyBytes,
          config: c.get('config'),
          tenantName,
        });
        if ('authFailure' in opened) {
          return { authFailure: opened.authFailure };
        }
        if ('httpError' in opened) {
          return { httpError: opened.httpError };
        }
        const projectRows = await listProjectsByTenant(db, {
          tenantId: opened.ctx.tenantId,
          limit: validated.payload.limit + 1,
          ...(cursor === null ? {} : { cursor: { createdAt: cursor.at, id: cursor.id } }),
        });
        return { projectRows };
      },
    );

    if ('authFailure' in outcome) {
      const failure = toHttpError(outcome.authFailure);
      return c.json(failure.body, failure.status, failure.headers);
    }
    if ('httpError' in outcome) {
      return c.json(outcome.httpError.body, outcome.httpError.status);
    }

    const page = outcome.projectRows.slice(0, validated.payload.limit);
    const hasMore = outcome.projectRows.length > validated.payload.limit;
    const projects: RemoteCacheProject[] = page.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      created_at: toIsoCreatedAt(row.created_at),
    }));
    const last = projects[projects.length - 1];
    for (const project of projects) {
      const checked = validateRemoteCacheProject(project);
      if (!checked.ok) {
        throw new Error(`project row failed contract validation: ${checked.reason}`);
      }
    }
    return c.json({
      projects,
      next_cursor:
        hasMore && last !== undefined
          ? encodeKeysetCursor({ axis: 'project-created-at', at: last.created_at, id: last.id })
          : null,
    });
  });

  // ------------------------------- tao project + key dau tien (R18/R19) --
  app.post('/tenants/:tenantName/projects', async (c) => {
    const tenantName = c.req.param('tenantName');
    const bodyBytes = await readBodyBytes(c.req.raw);
    if (bodyBytes === null) {
      const failure = bodyTooLargeError();
      return c.json(failure.body, failure.status);
    }
    const parsed = parseJsonObject(bodyBytes);
    if (!parsed.ok) {
      return c.json(parsed.error.body, parsed.error.status);
    }
    const validated = validatePortalCreateProjectRequest(parsed.body);
    if (!validated.ok) {
      return c.json(portalBadRequest(validated.detail).body, 400);
    }
    const request = validated.payload;

    const outcome = await withRemoteCacheClient(
      c.get('config'),
      async (db): Promise<PortalCreateProjectOutcome> => {
        const opened = await resolvePortalContext(db, {
          request: c.req.raw,
          body: bodyBytes,
          config: c.get('config'),
          tenantName,
        });
        if ('authFailure' in opened) {
          return { authFailure: opened.authFailure };
        }
        if ('httpError' in opened) {
          return { httpError: opened.httpError };
        }
        const { actorSub, ctx } = opened;
        const lifecycleError = await checkMutationLifecycle(
          db,
          ctx,
          actorSub,
          'project_created',
          `tenant:${ctx.tenantName}`,
        );
        if (lifecycleError !== null) {
          return { httpError: lifecycleError };
        }
        const existing = await getProjectByTenantAndName(db, ctx.tenantId, request.name);
        if (existing !== null) {
          await insertPortalAuditLog(db, {
            actor: `user:${actorSub}`,
            action: 'project_created',
            target: `tenant:${ctx.tenantName}/project:${request.name}`,
            outcome: 'denied',
          });
          return {
            httpError: portalConflict('A project with this name already exists in the tenant.'),
          };
        }
        const projectId = crypto.randomUUID();
        const apiKeyId = crypto.randomUUID();
        // Mot transaction: project + key dau tien + audit cung commit — khong
        // ton tai trang thai project khong key, khong co mutation khong audit.
        let committed: { readonly token: string; readonly project: RemoteCacheProject };
        try {
          committed = await db.begin(async (tx) => {
            await insertProject(tx, { id: projectId, tenantId: ctx.tenantId, name: request.name });
            const freshToken = generateApiToken();
            await insertApiKey(tx, {
              id: apiKeyId,
              projectId,
              tokenHash: await sha256Hex(freshToken),
              scopes: PORTAL_API_KEY_SCOPES,
              trusted_ci: false,
            });
            await insertPortalAuditLog(tx, {
              actor: `user:${actorSub}`,
              action: 'project_created',
              target: `tenant:${ctx.tenantName}/project:${projectId}`,
              outcome: 'allowed',
              projectId,
              // Ten project la danh tinh con nguoi duy nhat khong nam trong
              // target (target chi mang UUID sau khi tao).
              details: `project name: ${request.name}`,
            });
            // Doc-lai VA validate TRONG transaction, tren cung mot connection:
            // hang vua ghi tu thay (created_at chi co tren hang da ghi nen
            // read-back van la bat buoc de dung response wire). Validate o day
            // nghia la mot payload khong khop contract se ROLLBACK ca
            // project + key + audit — khong con kha nang tra 500 cho du lieu da
            // commit durably (retry cua client se chay lai sach se, khong gap
            // 409 "ten da ton tai" cho chinh project minh vua tao).
            const createdRow = await getProjectByTenantAndName(tx, ctx.tenantId, request.name);
            if (createdRow === null) {
              throw new Error('project vanished inside its own transaction');
            }
            const project: RemoteCacheProject = {
              id: createdRow.id,
              tenant_id: createdRow.tenant_id,
              name: createdRow.name,
              created_at: toIsoCreatedAt(createdRow.created_at),
            };
            const checked = validateRemoteCacheProject(project);
            if (!checked.ok) {
              throw new Error(`created project failed contract validation: ${checked.reason}`);
            }
            return { token: freshToken, project: checked.payload };
          });
        } catch (error) {
          // Pre-check o tren thay `null` nhung mot request dong thoi da commit
          // truoc do: UNIQUE `(tenant_id, name)` la nguon that (TOCTOU — xem
          // JSDoc `insertProject`), va transaction da rollback nen khong con
          // project nua vo. Cung mot su that nghiep vu voi nhanh pre-check,
          // nen cung 409 + audit `denied` — khong phai 500.
          if (!isProjectNameConflict(error)) throw error;
          await recordProjectNameConflictDenied(db, actorSub, ctx.tenantName, request.name);
          return {
            httpError: portalConflict('A project with this name already exists in the tenant.'),
          };
        }
        return { projectId, apiKeyId, token: committed.token, project: committed.project };
      },
    );

    if ('authFailure' in outcome) {
      const failure = toHttpError(outcome.authFailure);
      return c.json(failure.body, failure.status, failure.headers);
    }
    if ('httpError' in outcome) {
      return c.json(outcome.httpError.body, outcome.httpError.status);
    }
    const apiKey: PortalApiKeyCreated = {
      id: outcome.apiKeyId,
      scopes: PORTAL_API_KEY_SCOPES,
      credential_class: portalCredentialClassOf(false),
      token: outcome.token,
    };
    // `outcome.project` da duoc validate TRUOC commit (ben trong transaction),
    // nen khong con buoc validation nao o day co the bien mot write da commit
    // thanh 500.
    // Show-once: token gon chi xuat hien o response nay; DB chi giu hash.
    return c.json({ project: outcome.project, api_key: apiKey }, 201);
  });

  // ------------------------------------------------ chi tiet project --
  app.get('/tenants/:tenantName/projects/:projectName', async (c) => {
    const tenantName = c.req.param('tenantName');
    const projectName = c.req.param('projectName');
    const bodyBytes = await readBodyBytes(c.req.raw);
    if (bodyBytes === null) {
      const failure = bodyTooLargeError();
      return c.json(failure.body, failure.status);
    }
    const outcome = await withRemoteCacheClient(
      c.get('config'),
      async (db): Promise<PortalProjectDetailOutcome> => {
        const opened = await resolvePortalContext(db, {
          request: c.req.raw,
          body: bodyBytes,
          config: c.get('config'),
          tenantName,
        });
        if ('authFailure' in opened) {
          return { authFailure: opened.authFailure };
        }
        if ('httpError' in opened) {
          return { httpError: opened.httpError };
        }
        const project = await getProjectByTenantAndName(db, opened.ctx.tenantId, projectName);
        if (project === null) {
          return { httpError: portalNotFound('The requested project does not exist.') };
        }
        return { project };
      },
    );

    if ('authFailure' in outcome) {
      const failure = toHttpError(outcome.authFailure);
      return c.json(failure.body, failure.status, failure.headers);
    }
    if ('httpError' in outcome) {
      return c.json(outcome.httpError.body, outcome.httpError.status);
    }
    const project: RemoteCacheProject = {
      id: outcome.project.id,
      tenant_id: outcome.project.tenant_id,
      name: outcome.project.name,
      created_at: toIsoCreatedAt(outcome.project.created_at),
    };
    const checked = validateRemoteCacheProject(project);
    if (!checked.ok) {
      throw new Error(`project row failed contract validation: ${checked.reason}`);
    }
    return c.json({ project: checked.payload });
  });

  // ------------------------------------------ tao them key (show-once) --
  app.post('/tenants/:tenantName/projects/:projectName/api-keys', async (c) => {
    const tenantName = c.req.param('tenantName');
    const projectName = c.req.param('projectName');
    const bodyBytes = await readBodyBytes(c.req.raw);
    if (bodyBytes === null) {
      const failure = bodyTooLargeError();
      return c.json(failure.body, failure.status);
    }
    // Body la tuy chon: rong = hinh dong {}; co noi dung thi phai la JSON
    // object rong — portal khong nhan lua chon scope/phan lop (R20).
    let createKeyBody: Record<string, unknown> = {};
    if (bodyBytes.length > 0) {
      const parsed = parseJsonObject(bodyBytes);
      if (!parsed.ok) {
        return c.json(parsed.error.body, parsed.error.status);
      }
      createKeyBody = parsed.body;
    }
    const validated = validatePortalCreateApiKeyRequest(createKeyBody);
    if (!validated.ok) {
      return c.json(portalBadRequest(validated.detail).body, 400);
    }

    const outcome = await withRemoteCacheClient(
      c.get('config'),
      async (db): Promise<PortalCreateApiKeyOutcome> => {
        const opened = await resolvePortalContext(db, {
          request: c.req.raw,
          body: bodyBytes,
          config: c.get('config'),
          tenantName,
        });
        if ('authFailure' in opened) {
          return { authFailure: opened.authFailure };
        }
        if ('httpError' in opened) {
          return { httpError: opened.httpError };
        }
        const { actorSub, ctx } = opened;
        const lifecycleError = await checkMutationLifecycle(
          db,
          ctx,
          actorSub,
          'api_key_created',
          `tenant:${ctx.tenantName}/project:${projectName}`,
        );
        if (lifecycleError !== null) {
          return { httpError: lifecycleError };
        }
        const project = await getProjectByTenantAndName(db, ctx.tenantId, projectName);
        if (project === null) {
          return { httpError: portalNotFound('The requested project does not exist.') };
        }
        const apiKeyId = crypto.randomUUID();
        const token = await db.begin(async (tx) => {
          const freshToken = generateApiToken();
          await insertApiKey(tx, {
            id: apiKeyId,
            projectId: project.id,
            tokenHash: await sha256Hex(freshToken),
            scopes: PORTAL_API_KEY_SCOPES,
            trusted_ci: false,
          });
          await insertPortalAuditLog(tx, {
            actor: `user:${actorSub}`,
            action: 'api_key_created',
            target: `tenant:${ctx.tenantName}/project:${project.id}/key:${apiKeyId}`,
            outcome: 'allowed',
            projectId: project.id,
            details: `project name: ${project.name}`,
          });
          return freshToken;
        });
        return { projectId: project.id, apiKeyId, token };
      },
    );

    if ('authFailure' in outcome) {
      const failure = toHttpError(outcome.authFailure);
      return c.json(failure.body, failure.status, failure.headers);
    }
    if ('httpError' in outcome) {
      return c.json(outcome.httpError.body, outcome.httpError.status);
    }
    const apiKey: PortalApiKeyCreated = {
      id: outcome.apiKeyId,
      scopes: PORTAL_API_KEY_SCOPES,
      credential_class: portalCredentialClassOf(false),
      token: outcome.token,
    };
    // Show-once: token gon chi o response nay (R19; domain model §2.4).
    return c.json({ api_key: apiKey }, 201);
  });

  // --------------------------- list metadata key (khong lo secret, R19) --
  app.get('/tenants/:tenantName/projects/:projectName/api-keys', async (c) => {
    const tenantName = c.req.param('tenantName');
    const projectName = c.req.param('projectName');
    const bodyBytes = await readBodyBytes(c.req.raw);
    if (bodyBytes === null) {
      const failure = bodyTooLargeError();
      return c.json(failure.body, failure.status);
    }
    const outcome = await withRemoteCacheClient(
      c.get('config'),
      async (db): Promise<PortalListApiKeysOutcome> => {
        const opened = await resolvePortalContext(db, {
          request: c.req.raw,
          body: bodyBytes,
          config: c.get('config'),
          tenantName,
        });
        if ('authFailure' in opened) {
          return { authFailure: opened.authFailure };
        }
        if ('httpError' in opened) {
          return { httpError: opened.httpError };
        }
        const project = await getProjectByTenantAndName(db, opened.ctx.tenantId, projectName);
        if (project === null) {
          return { httpError: portalNotFound('The requested project does not exist.') };
        }
        // Chi cot metadata — token_hash khong bao gio cham query list nay.
        const keyRows = await db.unsafe<PortalApiKeyRow>(
          `SELECT id, scopes, trusted_ci, revoked_at, created_at
           FROM remote_cache.api_keys
          WHERE project_id = $1
          ORDER BY created_at, id`,
          [project.id],
        );
        return { project, keyRows };
      },
    );

    if ('authFailure' in outcome) {
      const failure = toHttpError(outcome.authFailure);
      return c.json(failure.body, failure.status, failure.headers);
    }
    if ('httpError' in outcome) {
      return c.json(outcome.httpError.body, outcome.httpError.status);
    }

    const project: RemoteCacheProject = {
      id: outcome.project.id,
      tenant_id: outcome.project.tenant_id,
      name: outcome.project.name,
      created_at: toIsoCreatedAt(outcome.project.created_at),
    };
    const checkedProject = validateRemoteCacheProject(project);
    if (!checkedProject.ok) {
      throw new Error(`project row failed contract validation: ${checkedProject.reason}`);
    }
    const apiKeys: PortalApiKeyMetadata[] = [];
    for (const row of outcome.keyRows) {
      const metadata: PortalApiKeyMetadata = {
        id: row.id,
        project_id: outcome.project.id,
        scopes: row.scopes.split(' ') as RemoteCacheApiKeyScope[],
        credential_class: portalCredentialClassOf(row.trusted_ci),
        revoked_at: row.revoked_at === null ? null : toIsoCreatedAt(row.revoked_at),
        created_at: toIsoCreatedAt(row.created_at),
      };
      const checked = validatePortalApiKeyMetadata(metadata);
      if (!checked.ok) {
        throw new Error(`api key metadata failed validation: ${checked.reason}`);
      }
      apiKeys.push(checked.payload);
    }
    return c.json({ project: checkedProject.payload, api_keys: apiKeys });
  });

  // ------------------------------------ revoke key (hieu luc ngay lap tuc) --
  app.post('/tenants/:tenantName/projects/:projectName/api-keys/:keyId/revoke', async (c) => {
    const tenantName = c.req.param('tenantName');
    const projectName = c.req.param('projectName');
    const keyId = c.req.param('keyId');
    const bodyBytes = await readBodyBytes(c.req.raw);
    if (bodyBytes === null) {
      const failure = bodyTooLargeError();
      return c.json(failure.body, failure.status);
    }

    const outcome = await withRemoteCacheClient(
      c.get('config'),
      async (db): Promise<PortalRevokeApiKeyOutcome> => {
        const opened = await resolvePortalContext(db, {
          request: c.req.raw,
          body: bodyBytes,
          config: c.get('config'),
          tenantName,
        });
        if ('authFailure' in opened) {
          return { authFailure: opened.authFailure };
        }
        if ('httpError' in opened) {
          return { httpError: opened.httpError };
        }
        const { actorSub, ctx } = opened;
        const lifecycleError = await checkMutationLifecycle(
          db,
          ctx,
          actorSub,
          'api_key_revoked',
          `tenant:${ctx.tenantName}/project:${projectName}/key:${keyId}`,
        );
        if (lifecycleError !== null) {
          return { httpError: lifecycleError };
        }
        const project = await getProjectByTenantAndName(db, ctx.tenantId, projectName);
        if (project === null) {
          return { httpError: portalNotFound('The requested project does not exist.') };
        }
        // keyId sai hinh thi key khong the ton tai — 404, khong cham query
        // (comparing text sai hinh voi cot uuid la loi cast, khong phai 404).
        if (!isUuidShape(keyId)) {
          return { httpError: portalNotFound('The requested API key does not exist.') };
        }
        const keyRows = await db.unsafe<{ id: string }>(
          'SELECT id FROM remote_cache.api_keys WHERE id = $1 AND project_id = $2',
          [keyId, project.id],
        );
        if (keyRows[0] === undefined) {
          // Key cua project khac / tenant khac / khong ton tai — cung mot 404:
          // tenant isolation khong phan biet cho caller (R17, domain model §3.1).
          return { httpError: portalNotFound('The requested API key does not exist.') };
        }
        const revokedAt = new Date().toISOString();
        const revokedCount = await db.begin(async (tx) => {
          const count = await revokeApiKey(tx, keyId, revokedAt);
          await insertPortalAuditLog(tx, {
            actor: `user:${actorSub}`,
            action: 'api_key_revoked',
            target: `tenant:${ctx.tenantName}/project:${project.id}/key:${keyId}`,
            outcome: count === 1 ? 'allowed' : 'denied',
            projectId: project.id,
            details: `project name: ${project.name}`,
          });
          return count;
        });
        if (revokedCount === 0) {
          return { httpError: portalConflict('This API key is already revoked.') };
        }
        return { keyId, revokedAt };
      },
    );

    if ('authFailure' in outcome) {
      const failure = toHttpError(outcome.authFailure);
      return c.json(failure.body, failure.status, failure.headers);
    }
    if ('httpError' in outcome) {
      return c.json(outcome.httpError.body, outcome.httpError.status);
    }
    return c.json({ api_key: { id: outcome.keyId, revoked_at: outcome.revokedAt } });
  });

  return app;
}
