/**
 * Composition root cua Worker `staff-access` (P1.4, issue #428).
 *
 * Boot fail-closed tu Hyperdrive binding `DB_STAFF_ACCESS`, `/health` khong
 * credential (infra probe khong duoc phu thuoc DB), request-id + security
 * headers, management API (`src/routes.ts` — staff/role/permission read,
 * assignment create/revoke, audit query, entitlement read) mount SAU
 * middleware config de loi cau hinh khong lo qua mot route nghiep vu.
 */
import { Hono } from 'hono';
import type { ExecutionContext } from 'hono';
import {
  INTERNAL_BODY_LIMIT_BYTES,
  NONCE_TTL_BUFFER_SECONDS,
  verifyRequest,
  type VerifyResult,
} from '@ecoma-io/internal-auth-contracts';
import { getStaffBySub, withStaffAccessClient } from '@ecoma-io/staff-access-infrastructure';
import type { AppEnv } from './types';
import {
  loadStaffAccessConfig,
  resolveInternalSecret,
  type StaffAccessConfig,
  type StaffAccessEnv,
} from './config';
import { isStaffAccessDomainError } from '@ecoma-io/staff-access-domain';
import { staffAccessRoutes } from './routes';

/** Config + cached theo isolate: load mot lan, KHONG cache loi — isolate sau
 * request loi duoc co hoi nap lai khi binding da duoc gan. */
let cachedConfig: StaffAccessConfig | null = null;

/**
 * Tran mo connection cua probe readiness (giay) — cung ngan sach voi
 * `apps/auth/src/main.ts`. Mot origin khong mo duoc connection phai hoa thanh
 * loi nhanh (`db_unreachable`) thay vi giu probe toi het thoi han Worker.
 */
const READY_PROBE_CONNECT_TIMEOUT_SECONDS = 3;

/** `Retry-After` cua response 503 readiness — co dinh, khong tiet lo chi tiet. */
const READY_RETRY_AFTER_SECONDS = '5';

/** Route khong credential va khong chay qua envelope HMAC (probe infra). */
const UNAUTHENTICATED_PATHS: ReadonlySet<string> = new Set(['/health', '/ready']);

/** Xoa config cache — chi test dung. Config khong giu socket nen reset an toan. */
export function resetCachedConfig(): void {
  cachedConfig = null;
}

function getConfig(env: StaffAccessEnv | null | undefined): StaffAccessConfig {
  if (cachedConfig === null) {
    cachedConfig = loadStaffAccessConfig(env);
  }
  return cachedConfig;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > INTERNAL_BODY_LIMIT_BYTES) return null;
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function headersForVerification(request: Request): Record<string, string | null> {
  const headers: Record<string, string | null> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
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
  app.get('/health', (c) => c.json({ status: 'ok', service: 'staff-access' }));

  // /ready — readiness CO kiem phu thuoc. Phan biet hai route theo cung bang
  // voi `apps/auth/src/main.ts`:
  //
  // | Route     | Hoi gi                                        | Hoi DB khong | Khi hong thi ai hanh xu  |
  // | --------- | --------------------------------------------- | ------------ | ------------------------ |
  // | `/health` | Worker con song khong                         | **Khong**    | Orchestrator restart     |
  // | `/ready`  | Worker phuc vu duoc request that khong        | **Co**       | Orchestrator ngung traffic |
  //
  // `/health` khong query DB vi restart-loop vo ich: DB chet thi isolate moi
  // van gap DB chet, tai database dang chet tang len va nguyen nhan that
  // (`db-staff-access` hong, khong phai Worker hong) bi che.
  //
  // `/ready` fail closed: thieu binding/secret (cung nguyen nhan ma
  // `loadStaffAccessConfig` nem o request dau) hoac DB khong tra loi duoc thi
  // management API KHONG phuc vu duoc request nao — backoffice fail-closed
  // 503 moi route `/api/**` doc staff-access. Mot readiness 200 trong khi
  // dependency chet la day failure xuong thanh loi rac o tung request that.
  //
  // Response khong neu ten binding, loi driver hay connection string: chi ma
  // on dinh trong log de truy nguon.
  app.get('/ready', async (c) => {
    let config: StaffAccessConfig;
    try {
      config = getConfig(c.env);
    } catch {
      // Khong noi `error` vao log: message cua config error neu TEN bien.
      // oxlint-disable-next-line no-console
      console.log(JSON.stringify({ event: 'ready.failed', status: 503, reason: 'config_invalid' }));
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': READY_RETRY_AFTER_SECONDS,
      });
    }

    try {
      await probeDatabase(config);
    } catch {
      // Khong noi `error` vao log: message driver co the chua connection string.
      // oxlint-disable-next-line no-console
      console.log(JSON.stringify({ event: 'ready.failed', status: 503, reason: 'db_unreachable' }));
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': READY_RETRY_AFTER_SECONDS,
      });
    }

    // oxlint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'ready.ok', status: 200 }));
    return c.json({ service: 'staff-access', status: 'ready' });
  });

  // Toan bo phan con lai can config. Loi cau hinh -> 503 fail-closed.
  app.use('*', async (c, next) => {
    try {
      c.set('config', getConfig(c.env));
    } catch (error) {
      if (error instanceof Error && error.name === 'StaffAccessAppConfigurationError') {
        return c.json({ error: 'Service Unavailable', message: 'Service is not configured' }, 503);
      }
      throw error;
    }
    await next();
    return undefined;
  });

  // Every management route requires the canonical internal HMAC envelope. The
  // two probe routes are deliberately credential-free and were handled above.
  app.use('*', async (c, next) => {
    if (UNAUTHENTICATED_PATHS.has(new URL(c.req.raw.url).pathname)) {
      await next();
      return;
    }
    const config = c.get('config');
    const body = await readBody(c.req.raw.clone());
    if (body === null) {
      return c.json({ error: 'Payload Too Large' }, 413);
    }
    let verification: VerifyResult;
    try {
      verification = await verifyRequest({
        method: c.req.raw.method,
        path: new URL(c.req.raw.url).pathname + new URL(c.req.raw.url).search,
        body,
        headers: headersForVerification(c.req.raw),
        secret: config.internalSecret,
        secretByKid: resolveInternalSecret(config),
        now: String(Math.floor(Date.now() / 1000)),
        skewSeconds: config.internalAuthSkewSeconds,
        claimNonce: async (nonce, timestampSeconds) => {
          const expiresAt =
            timestampSeconds + config.internalAuthSkewSeconds + NONCE_TTL_BUFFER_SECONDS;
          const nowSeconds = Math.floor(Date.now() / 1000);
          const rows = await withStaffAccessClient({ hyperdrive: config.hyperdrive }, async (db) =>
            db.unsafe(
              `WITH deleted AS (
               DELETE FROM staff_access.internal_nonces WHERE expires_at <= $3
             )
             INSERT INTO staff_access.internal_nonces (nonce, expires_at)
             VALUES ($1, $2)
             ON CONFLICT (nonce) DO NOTHING
             RETURNING nonce`,
              [nonce, expiresAt, nowSeconds],
            ),
          );
          return rows.length === 0;
        },
      });
    } catch (error) {
      const requestId = c.get('requestId') ?? 'unknown';
      // oxlint-disable-next-line no-console
      console.error(
        JSON.stringify({
          level: 'error',
          requestId,
          errorName: error instanceof Error ? error.name : String(error),
        }),
      );
      return c.json({ error: 'Service Unavailable', message: 'Service is unavailable' }, 503);
    }
    if (!verification.ok) {
      return c.json({ error: 'Unauthorized' }, 401, {
        'WWW-Authenticate': 'HMAC realm="ecoma-internal"',
      });
    }
    const verifiedActorSub = verification.actorSub;
    const actorSubHeader =
      typeof verifiedActorSub === 'string' && verifiedActorSub.length > 0 ? verifiedActorSub : null;
    let actorSub: string | null = null;
    let actorStaffId: string | null = null;
    if (typeof actorSubHeader === 'string' && actorSubHeader.length > 0) {
      actorSub = actorSubHeader;
      let staff;
      try {
        staff = await withStaffAccessClient({ hyperdrive: config.hyperdrive }, async (db) =>
          getStaffBySub(db, actorSub as string),
        );
      } catch (error) {
        const requestId = c.get('requestId') ?? 'unknown';
        // oxlint-disable-next-line no-console
        console.error(
          JSON.stringify({
            level: 'error',
            requestId,
            errorName: error instanceof Error ? error.name : String(error),
          }),
        );
        return c.json({ error: 'Service Unavailable', message: 'Service is unavailable' }, 503);
      }
      if (staff === null || staff.status !== 'active') {
        return c.json({ error: 'Forbidden', message: 'Actor is not an active staff member.' }, 403);
      }
      actorStaffId = staff.id;
    }
    c.set('actorSub', actorSub);
    c.set('actorStaffId', actorStaffId);
    await next();
    return undefined;
  });

  // Management API (Milestone B, issue #428) — mount SAU middleware config:
  // moi handler doc `config` da kiem san, loi binding khong bao gio lo qua
  // mot route nghiep vu.
  app.route('/', staffAccessRoutes());

  // 404 dong nhat (khong leak route ton tai hay khong).
  app.notFound((c) =>
    c.json({ error: 'Not Found', message: 'The requested resource does not exist' }, 404),
  );

  // Error handler: log thong diep dang JSON mot dong, tra 500 khong leak noi
  // bo. KHONG BAO GIO log prompt/response body hay token (non-negotiable
  // observability rule cua repo).
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    if (isStaffAccessDomainError(error)) {
      // Domain error: map ma -> HTTP status. Khong log prompt/response body
      // hay token (non-negotiable observability rule).
      const code = error.code;
      const status = code.endsWith('_not_found')
        ? 404
        : code === 'staff_terminated' ||
            code === 'staff_suspended' ||
            code === 'invalid_transition' ||
            code === 'invalid_assignment_window' ||
            code === 'invalid_entitlement_revision' ||
            code === 'invalid_staff_status'
          ? 409
          : 400;
      const errorLabel = status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Request';
      // oxlint-disable-next-line no-console
      console.error(
        JSON.stringify({ level: 'warn', requestId, errorCode: code, errorMessage: error.message }),
      );
      return c.json({ error: errorLabel, message: error.message }, status);
    }
    // Nhánh khong phai domain: log CHI errorName + requestId. Raw error.message
    // cua postgres/Hyperdrive co the mang chi tiet binding/connection (user,
    // host, TLS) — khong dua vao log (cung nguyen tac khong log prompt/response
    // body hay token).
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

/**
 * Probe readiness — **qua credential runtime**, cung pool shape ma moi duong
 * serving dung (`withStaffAccessClient`, `max: 3`, `prepare: false`), nen
 * readiness kiem khong chi "DB song" ma "DB song voi dung credential ma
 * serving path dung".
 *
 * Truy van re nhat van phai cham DB: `SELECT 1 FROM staff_access.staff LIMIT 1`
 * chung minh schema ton tai VA runtime role doc duoc bang (grant 0002). Bang
 * `staff` nam trong migration `0001` — database chua migrate du **phai** lam
 * probe that bai; database nua schema khong phai "san sang".
 *
 * ⚠️ Day la database cua CHINH staff-access, khong phai database khac: probe
 * khong vuot ranh gioi database ownership (invariant 5, 7, 25).
 */
async function probeDatabase(config: StaffAccessConfig): Promise<void> {
  await withStaffAccessClient(
    { hyperdrive: config.hyperdrive, connectTimeoutSeconds: READY_PROBE_CONNECT_TIMEOUT_SECONDS },
    async (db) => {
      await db.unsafe('SELECT 1 FROM staff_access.staff LIMIT 1');
    },
  );
}

/** App day du — dung boi Worker fetch va boi test (`app.request()`). */
export function buildApp(): Hono<AppEnv> {
  return createApp();
}

const app = buildApp();

// Default export cho Cloudflare Workers: env/ctx PHAI duoc truyen vao Hono,
// neu khong c.env se undefined va config middleware 503 moi request.
// ExecutionContext lay tu `hono` (global cua @cloudflare/workers-types doi
// `props` ma runtime khong cap o moi hinh thuc invoke — cung ghi chu voi
// apps/pact-broker-api/src/main.ts).
export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
