/**
 * Control-plane routes cua Worker `remote-cache` — skeleton P4.1 (issue
 * #442, ADR-0015).
 *
 * Pham vi skeleton (KHONG mo rong):
 * - `POST /projects` — tao project trong tenant cua key goi, kem API key
 *   mac dinh (scopes do request chon; token tra mot lan, show-once).
 * - `GET /projects` — list project cua tenant do, phan trang cursor keyset.
 *
 * Nguon shape:
 * - Wire shape theo `@ecoma-io/remote-cache-contracts` — response DUNG qua
 *   validator cua contract de khong co duong ghep field bang tay.
 * - SQL la ban chep cua schema qua cac repository cua
 *   `@ecoma-io/remote-cache-infrastructure`.
 *
 * ⚠️ **API key auth skeleton** (issue #442): xac thuc token bang lookup
 * hash-only (`token_hash` UNIQUE); token gon khong bao gio cham DB hay log.
 * Phan quyen chi `read`/`write` (R2) — hardening (rate limit, timing-safe
 * compare, token format prefix) thuoc P4.4; skeleton KHONG quang cao an toan
 * hon dang chot.
 *
 * ⚠️ **Quota KHONG co o skeleton** (P4.3 pin semantics truoc khi implement —
 * ADR-0015; mot request khong bao gio cham logic quota nao).
 */
import { Hono } from 'hono';
import {
  validateCreateRemoteCacheProjectRequest,
  validateRemoteCacheProjectListRequest,
  validateRemoteCacheProject,
  type RemoteCacheProject,
} from '@ecoma-io/remote-cache-contracts';
import {
  getApiKeyByTokenHash,
  getProjectById,
  getProjectByTenantAndName,
  insertApiKey,
  insertProject,
  listProjectsByTenant,
  withRemoteCacheClient,
  type RemoteCacheClient,
} from '@ecoma-io/remote-cache-infrastructure';
import type { RemoteCacheApiKeyScope } from '@ecoma-io/remote-cache-domain';
import { isRemoteCacheDomainError } from '@ecoma-io/remote-cache-domain';
import { enforceTenantLifecycle } from './lifecycle';
import type { AppEnv } from './types';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor';

/** Loi http chuan cua route — body JSON khong leak noi bo. */
interface HttpError {
  readonly status: 400 | 401 | 403 | 409;
  readonly body: { error: string; message: string };
}

/** 400 payload bat ki — message khong neu gia tri caller gui. */
function badRequest(message: string): HttpError {
  return { status: 400, body: { error: 'Bad Request', message } };
}

/** 401 — sai/teu credential; message khong phan biet ton tai hay khong. */
function unauthorized(): HttpError {
  return { status: 401, body: { error: 'Unauthorized', message: 'A valid API key is required.' } };
}

/** 403 — key hop le nhung khong du scope. */
function forbidden(message: string): HttpError {
  return { status: 403, body: { error: 'Forbidden', message } };
}

/**
 * Ket qua xac thuc API key cua mot request control plane: tenant cua key la
 * tenant cua PROJECT ma key thuoc — ranh gioi R2 ("key chi cham project
 * trong tenant cua no"). Skeleton P4.1 chi tao key kem project nen hai cap
 * tenant—project doc tu bang projects.
 */
interface AuthenticatedKey {
  readonly projectId: string;
  readonly tenantId: string;
  readonly scopes: readonly RemoteCacheApiKeyScope[];
  /** Key con hieu luc (revoked_at IS NULL) duoc kiem o duong auth. */
  readonly active: true;
  /** true neu key la credential CI tin cahy (duoc phep ghi neu co scope write). */
  readonly trustedCi: boolean;
}

/**
 * Hash SHA-256 mot chuoi thanh hex chu thuong — ham chuan doc token API key
 * o duong xac thuc. Token gon khong bao gio duoc truyen qua duong khac.
 */
async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Kiem header Authorization Bearer va tra key da xac thuc (kem tenant/project
 * tu bang projects), hoac HttpError. Key revoked thi 401 giong key khong ton
 * tai — khong phan biet cho caller.
 */
async function requireApiKey(
  db: RemoteCacheClient,
  authorizationHeader: string | undefined,
): Promise<AuthenticatedKey | HttpError> {
  const bearerPrefix = 'Bearer ';
  if (
    typeof authorizationHeader !== 'string' ||
    !authorizationHeader.startsWith(bearerPrefix) ||
    authorizationHeader.slice(bearerPrefix.length).trim() === ''
  ) {
    return unauthorized();
  }
  const token = authorizationHeader.slice(bearerPrefix.length).trim();
  const tokenHash = await sha256Hex(token);
  const row = await getApiKeyByTokenHash(db, tokenHash);
  if (row === null || row.revoked_at !== null) {
    return unauthorized();
  }
  const project = await getProjectById(db, row.project_id);
  if (project === null) {
    // Key ma khong ton tai project cha la trang thai khong the xay ra theo
    // schema (FK) — coi nhu sai credential thay vi 500.
    return unauthorized();
  }
  return {
    projectId: project.id,
    tenantId: project.tenant_id,
    scopes: row.scopes.split(' ') as RemoteCacheApiKeyScope[],
    active: true,
    trustedCi: row.trusted_ci,
  };
}

/** Dung router control plane — mount vao app chinh SAU middleware config. */
export function remoteCacheRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // --------------------------------------------------------------- projects --
  app.post('/projects', async (c) => {
    const parsed = await readJsonObject(c);
    if (!parsed.ok) {
      return c.json(parsed.error.body, parsed.error.status);
    }
    const validated = validateCreateRemoteCacheProjectRequest(parsed.body);
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const request = validated.payload;

    const authorization = c.req.header('authorization');
    const outcome = await withRemoteCacheClient(c.get('config'), async (db) => {
      const auth = await requireApiKey(db, authorization);
      if ('status' in auth) {
        return { authError: auth } as const;
      }
      if (!auth.scopes.includes('write')) {
        return { authError: forbidden('This API key does not carry the write scope.') } as const;
      }
      // P4.4: key phai duoc tin cay (trustedCi) moi duoc phep ghi project. Fork/PR key
      // (trustedCi=false) khong bao gia duoc phep ghi, neu ngay ca co scope write.
      if (!auth.trustedCi) {
        return { authError: forbidden('This API key is not trusted for write access.') } as const;
      }
      // P4.4: chi caller da duoc tin cay moi duoc phep tao key trusted_ci. Fork/PR key
      // khong the tao mot key tin cay (trusted_ci=true) qua duong write nay.
      if (request.trusted_ci && !auth.trustedCi) {
        return { authError: forbidden('Only a trusted key can create a trusted CI key.') } as const;
      }
      // P4.4: luon re-check trang thai lifecycle tu DB tren duong ghi (fail-closed,
      // bo qua cache). Neu tenant khong active hoac DB lookup that bai -> 409.
      try {
        await enforceTenantLifecycle(db, auth.tenantId, false);
      } catch (error) {
        if (isRemoteCacheDomainError(error)) {
          return {
            authError: {
              status: 409 as const,
              body: { error: 'Conflict', message: `Tenant lifecycle rejected: ${error.message}` },
            },
          } as const;
        }
        throw error;
      }
      const existing = await getProjectByTenantAndName(db, auth.tenantId, request.name);
      if (existing !== null) {
        return { conflict: true } as const;
      }
      const projectId = crypto.randomUUID();
      const apiKeyId = crypto.randomUUID();
      // Mot transaction: project + key mac dinh cung commit — khong ton tai
      // trang thai project khong co key nao (skeleton P4.1).
      const token = await db.begin(async (tx) => {
        await insertProject(tx, { id: projectId, tenantId: auth.tenantId, name: request.name });
        const freshToken = generateApiToken();
        const tokenHash = await sha256Hex(freshToken);
        await insertApiKey(tx, {
          id: apiKeyId,
          projectId,
          tokenHash,
          scopes: request.api_key_scopes,
          trusted_ci: request.trusted_ci,
        });
        return freshToken;
      });
      return { tenantId: auth.tenantId, projectId, token } as const;
    });

    const okOutcome = 'authError' in outcome ? null : outcome;
    if (okOutcome === null) {
      const { body, status } = outcome.authError as HttpError;
      return c.json(body, status);
    }
    if ('conflict' in okOutcome) {
      return c.json(
        { error: 'Conflict', message: 'A project with this name already exists in the tenant.' },
        409,
      );
    }

    const created = await withRemoteCacheClient(c.get('config'), (db) =>
      getProjectByTenantAndName(db, okOutcome.tenantId, request.name),
    );
    if (created === null) {
      throw new Error('project vanished after commit');
    }
    const project: RemoteCacheProject = {
      id: created.id,
      tenant_id: created.tenant_id,
      name: created.name,
      created_at: created.created_at,
    };
    const checked = validateRemoteCacheProject(project);
    if (!checked.ok) {
      throw new Error(`created project failed contract validation: ${checked.reason}`);
    }
    // Show-once: token gon chi xuat hien o response nay; DB chi giu hash.
    return c.json({ project: checked.payload, api_key: { token: outcome.token } }, 201);
  });

  app.get('/projects', async (c) => {
    const query = c.req.query();
    const rawLimit = query['limit'];
    const rawCursor = query['cursor'];
    const limit =
      rawLimit === undefined
        ? undefined
        : Number.isInteger(Number(rawLimit))
          ? Number(rawLimit)
          : rawLimit;
    const validated = validateRemoteCacheProjectListRequest({
      limit,
      cursor: rawCursor === undefined || rawCursor === '' ? undefined : rawCursor,
    });
    if (!validated.ok) {
      return c.json(badRequest(validated.detail).body, 400);
    }
    const cursor =
      validated.payload.cursor === null
        ? null
        : decodeKeysetCursor(validated.payload.cursor, 'project-created-at');
    if (validated.payload.cursor !== null && cursor === null) {
      return c.json({ error: 'Bad Request', message: 'cursor is not a valid token.' }, 400);
    }

    const outcome = await withRemoteCacheClient(c.get('config'), async (db) => {
      const auth = await requireApiKey(db, c.req.header('authorization'));
      if ('status' in auth) {
        return { authError: auth } as const;
      }
      const projectRows = await listProjectsByTenant(db, {
        tenantId: auth.tenantId,
        limit: validated.payload.limit + 1,
        ...(cursor === null ? {} : { cursor: { createdAt: cursor.at, id: cursor.id } }),
      });
      return { projectRows } as const;
    });
    const okOutcome = 'authError' in outcome ? null : outcome;
    if (okOutcome === null) {
      const { body, status } = outcome.authError as HttpError;
      return c.json(body, status);
    }

    const page = okOutcome.projectRows.slice(0, validated.payload.limit);
    const hasMore = okOutcome.projectRows.length > validated.payload.limit;
    const last = page[page.length - 1];
    const projects: RemoteCacheProject[] = page.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      created_at: row.created_at,
    }));
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

  return app;
}

/** Doc body JSON cua request POST, tra loi 400 khi khong phai object JSON. */
async function readJsonObject(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: HttpError }> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return { ok: false, error: badRequest('Request body must be valid JSON.') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: badRequest('Request body must be a JSON object.') };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Sinh token API key gon — 32 byte ngau nhien base64url. Token gon chi ton
 * tai o bien nay va response show-once; moi duong khac chi giu SHA-256 hex.
 */
function generateApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
