/**
 * Composition root cua Worker `remote-cache-api` (P4.1, issue #442, ADR-0015).
 *
 * Boot fail-closed tu Hyperdrive binding `DB_REMOTE_CACHE`, `/health` khong
 * credential (infra probe khong duoc phu thuoc DB), request-id + security
 * headers, control-plane skeleton (`src/routes.ts` — create/list project qua
 * API key) mount SAU middleware config de loi cau hinh khong lo qua mot
 * route nghiep vu.
 *
 * KHONG co data plane, quota, hay hardening o Worker nay (P4.2/P4.3/P4.4).
 */
import { Hono } from 'hono';
import type { ExecutionContext } from 'hono';
import type { AppEnv } from './types';
import { loadRemoteCacheConfig, type RemoteCacheConfig, type RemoteCacheEnv } from './config';
import { isRemoteCacheDomainError } from '@ecoma-io/remote-cache-domain';
import { remoteCacheRoutes } from './routes';
import { portalRoutes } from './portal-routes';
import { remoteCacheDataRoutes } from './cache-routes';
import { withRemoteCacheClient } from '@ecoma-io/remote-cache-infrastructure';

/** Config cache theo isolate: load mot lan, KHONG cache loi — isolate sau
 * request loi duoc co hoi nap lai khi binding da duoc gan. */
let cachedConfig: RemoteCacheConfig | null = null;

/** Xoa config cache — chi test dung. Config khong giu socket nen reset an toan. */
export function resetCachedConfig(): void {
  cachedConfig = null;
}

function getConfig(env: RemoteCacheEnv | null | undefined): RemoteCacheConfig {
  if (cachedConfig === null) {
    cachedConfig = loadRemoteCacheConfig(env);
  }
  return cachedConfig;
}

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 1. Request id — sinh neu chua co (Cloudflare da gui x-request-id).
  app.use('*', async (c, next): Promise<void> => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming ?? crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
  });

  // 2. Security headers — moi response, ke ca loi.
  app.use('*', async (c, next): Promise<void> => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
  });

  // /health — khong credential, khong DB (infra probe khong duoc phu thuoc DB).
  app.get('/health', (c) => c.json({ status: 'ok', service: 'remote-cache-api' }));

  // Toan bo phan con lai can config. Loi cau hinh -> 503 fail-closed.
  app.use('*', async (c, next) => {
    try {
      c.set('config', getConfig(c.env));
    } catch (error) {
      if (error instanceof Error && error.name === 'RemoteCacheAppConfigurationError') {
        return c.json({ error: 'Service Unavailable', message: 'Service is not configured' }, 503);
      }
      throw error;
    }
    await next();
    return undefined;
  });

  // /ready — kiem tra DB connectivity + storage config (Phase A). Khac /health
  // (khong credential, khong DB), /ready phu thuoc config + DB.
  app.get('/ready', async (c) => {
    const config = c.get('config');
    let dbStatus: 'ok' | 'error';
    try {
      await withRemoteCacheClient(config, async (db) => {
        await db.unsafe('SELECT 1');
      });
      dbStatus = 'ok';
    } catch {
      dbStatus = 'error';
    }
    const storageStatus = config.storage === null ? 'missing' : 'configured';
    if (dbStatus !== 'ok') {
      return c.json(
        {
          status: 'not_ready',
          service: 'remote-cache-api',
          database: dbStatus,
          storage: storageStatus,
        },
        503,
      );
    }
    return c.json({
      status: 'ready',
      service: 'remote-cache-api',
      database: dbStatus,
      storage: storageStatus,
    });
  });

  // Control-plane skeleton — mount SAU middleware config: moi handler doc
  // `config` da kiem san, loi binding khong bao gio lo qua mot route nghiep vu.
  app.route('/', remoteCacheRoutes());

  // Portal control plane (issue #202) — human principal qua envelope HMAC noi
  // bo + membership resolve tu DB. Mount cung SAU middleware config; thieu
  // secret portal thi tung route fail-closed 503 theo request, machine routes
  // + data plane khong anh huong.
  app.route('/', portalRoutes());

  // Data plane (P4.2) — mount sau control plane, cung middleware config.
  app.route('/', remoteCacheDataRoutes());

  // 404 dong nhat (khong leak route ton tai hay khong).
  app.notFound((c) =>
    c.json({ error: 'Not Found', message: 'The requested resource does not exist' }, 404),
  );

  // Error handler: log thong diep dang JSON mot dong, tra 500 khong leak noi
  // bo. KHONG BAO GIO log token API key hay token_hash (observability rule).
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    if (isRemoteCacheDomainError(error)) {
      // Domain error: map ma -> HTTP status. Khong log gia tri token.
      const code = error.code;
      const status = code.endsWith('_not_found')
        ? 404
        : code === 'tenant_suspended' ||
            code === 'tenant_deleted' ||
            code === 'invalid_transition' ||
            code === 'api_key_revoked'
          ? 409
          : 400;
      const errorLabel = status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Request';
      // oxlint-disable-next-line no-console
      console.error(
        JSON.stringify({ level: 'warn', requestId, errorCode: code, errorMessage: error.message }),
      );
      return c.json({ error: errorLabel, message: error.message }, status);
    }
    // Nhanh khong phai domain: log CHI errorName + requestId. Raw error.message
    // cua postgres/Hyperdrive co the mang chi tiet binding/connection — khong
    // dua vao log.
    // oxlint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        requestId,
        errorName: error instanceof Error ? error.name : String(error),
      }),
    );
    return c.json({ error: 'Internal Server Error', requestId }, 500);
  });

  return app;
}

/** App day du — dung boi Worker fetch va boi test (`app.request()`). */
export function buildApp(): Hono<AppEnv> {
  return createApp();
}

const app = buildApp();

// Default export cho Cloudflare Workers: env/ctx PHAI duoc truyen vao Hono,
// neu khong c.env se undefined va config middleware 503 moi request.
// ExecutionContext lay tu `hono` (cung ghi chu voi apps/staff-access/src/main.ts).
export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
