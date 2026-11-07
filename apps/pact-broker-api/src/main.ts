/**
 * Composition root của Pact Broker API Worker.
 *
 * Middleware chain (thứ tự cố ý):
 *   1. request-id        — id duy nhất mỗi request, gắn vào log + error body
 *   2. security-headers  — headers an toàn mặc định mọi response
 *   3. body-limit        — chặn request body quá lớn trước khi parse
 *   4. cors (tuỳ chọn)   — CHỈ khi cấu hình dashboard origin; API machine
 *                          protocol không cần CORS (CLI không preflight)
 *   5. auth per-route    — `requireMachineToken` gắn ở từng route group, KHÔNG
 *                          global: `/health` và index discovery phải đạt được
 *                          không credential (Pact CLI đọc index trước khi
 *                          biết token không? — CLI gắn token từ lệnh đầu,
 *                          nhưng health probe của infra thì không)
 *
 * KHÔNG rate-limit (SR: origin Cloudflare đã có), KHÔNG public-read (mọi
 * Pact data theo tenant, không endpoint đọc public nào).
 */
import { Hono } from 'hono';
import type { ExecutionContext, MiddlewareHandler } from 'hono';
import type { Pool } from 'pg';
import type { AppEnv } from './types';
import {
  loadPactBrokerConfig,
  PactBrokerConfigurationError,
  type PactBrokerConfig,
} from './config';
import {
  PgTokenRepo,
  createPool,
  isConnectionTerminatedError,
} from '@ecoma-io/pact-broker-api-infrastructure';
import { requireMachineToken } from './auth/token-auth';
import type { TokenRepo } from '@ecoma-io/pact-broker-api-application';
import { indexRoutes } from './routes';
import { pacticipantRoutes } from './routes/pacticipants';
import { pactRoutes } from './routes/pacts';
import { verificationRoutes } from './routes/verifications';
import { matrixRoutes } from './routes/matrix';
import { environmentRoutes } from './routes/environments';
import { contractsRoutes } from './routes/contracts';
import { webhookRoutes } from './routes/webhooks';
import { adminRoutes } from './routes/admin';
import { entitlementQueueBatch } from './entitlement-consumer';

/** Giới hạn body: publish contract có thể lớn nhưng không vô hạn. 5 MiB. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Auth middleware factory — trả handler đọc pool từ context lúc chạy. Hào
 * phòng: middleware này PHẢI chạy sau middleware config (đã set pool), nên
 * mount order trong buildApp là quan trọng.
 */
function requireMachineTokenFactory(
  required: 'read' | 'write' | 'admin',
): MiddlewareHandler<AppEnv> {
  // Không annotate tường minh: kiểu trả về của `MiddlewareHandler` (Hono) —
  // `Promise<Response | void>` — là kiểu ngữ cảnh; annotation `| undefined`
  // sai (`void` không assignable vào `undefined`), còn `Promise<Response | void>`
  // viết ra thì vi phạm rule lint `no-invalid-void-type` của repo.
  return async (c, next) => {
    const repo: TokenRepo = new PgTokenRepo(c.get('pool'));
    // Response khi deny (401/403) PHẢI được trả ra — vứt nó là "Context is
    // not finalized". Khi allow, hàm đã gọi `next()` và trả undefined.
    return requireMachineToken(repo, required)(c, next);
  };
}

/**
 * Binder cho route groups — mỗi lần gọi trả handler của scope đã chọn. Handler
 * tạo MỘT lần mỗi buildApp (cùng instance được gắn vào mọi route của group),
 * trong khi `pool` vẫn được đọc từ context lúc request.
 */
function authBinder(required: 'read' | 'write' | 'admin'): () => MiddlewareHandler<AppEnv> {
  const handler = requireMachineTokenFactory(required);
  return () => handler;
}

/**
 * Config + Pool cached theo isolate: load một lần, KHÔNG cache lỗi — isolate
 * sau request lỗi được cơ hội nạp lại khi binding đã được gán (cùng luật với
 * auth: `cachedConfigPromise`).
 */
let cachedConfig: PactBrokerConfig | null = null;
let cachedPool: Pool | null = null;

/**
 * Đóng Pool cache — chỉ test dùng (trước khi testcontainer dừng, để pg không
 * ném unhandled 'terminating connection due to administrator command'). Worker
 * thật không bao giờ gọi: isolate chết thì socket chết cùng, đó là thiết kế.
 */
export async function closeCachedPool(): Promise<void> {
  if (cachedPool !== null) {
    await cachedPool.end();
    cachedPool = null;
  }
}

/**
 * Xoá config cache — chỉ test dùng, để một test có thể nạp env khác (ví dụ
 * bật `PACT_BROKER_DASHBOARD_ORIGIN`) trong cùng isolate. Config không giữ
 * socket nên reset an toàn bất cứ lúc nào.
 */
export function resetCachedConfig(): void {
  cachedConfig = null;
}

function getConfig(env: unknown): PactBrokerConfig {
  if (cachedConfig === null) {
    cachedConfig = loadPactBrokerConfig(env as never);
  }
  return cachedConfig;
}

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 1. Request id — sinh nếu chưa có (Cloudflare đã gửi x-request-id).
  app.use('*', async (c, next): Promise<void> => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming ?? crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
  });

  // 2. Security headers — mọi response, kể cả lỗi.
  app.use('*', async (c, next): Promise<void> => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
  });

  // Body limit — đọc Content-Length trước khi buffer body. Không annotate
  // tường minh: `Promise<Response | void>` viết ra vi phạm
  // `no-invalid-void-type`, còn ngữ cảnh của `app.use` đã đặt kiểu đúng.
  // Body limit — đếm byte THẬT trên stream, không tin `Content-Length` (request
  // chunked không có header đó và bypass mọi check dựa trên header). Đọc từng
  // chunk, dừng NGAY khi vượt trần; buffer lại body để downstream (route) vẫn
  // đọc được qua `c.req.raw.body`.
  app.use('*', async (c, next) => {
    const body = c.req.raw.body;
    if (body !== null) {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return c.json(
            { error: 'Payload Too Large', message: `Body exceeds ${MAX_BODY_BYTES} bytes` },
            413,
          );
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const original = c.req.raw;
      const headers = new Headers(original.headers);
      headers.delete('transfer-encoding');
      c.req.raw = new Request(original.url, {
        method: original.method,
        headers,
        body: total === 0 ? null : merged,
      });
    }
    await next();
    return undefined;
  });

  // 2b. CORS — CHỈ khi `PACT_BROKER_DASHBOARD_ORIGIN` được cấu hình; mặc định
  // (thiếu var) không ACAO nào được phát, browser chặn đọc chéo-origin
  // (SR-005). Middleware phải nằm SAU config middleware để đọc
  // `config.dashboardOrigin`, nên nó chỉ thêm header vào response đi qua;
  // preflight (OPTIONS) được trả ngay tại đây.
  app.use('*', async (c, next) => {
    let dashboardOrigin: string | null = null;
    try {
      dashboardOrigin = getConfig(c.env).dashboardOrigin;
    } catch {
      // Config lỗi: middleware config sẽ 503 fail-closed; CORS không thêm gì.
    }
    const requestOrigin = c.req.header('origin');
    const corsOrigin =
      dashboardOrigin !== null && requestOrigin !== undefined && requestOrigin === dashboardOrigin
        ? dashboardOrigin
        : null;

    if (corsOrigin !== null) {
      // `c.header()` bị Hono giới hạn union `ResponseHeader` ở type-level với
      // literal chuẩn; Headers API thuần không ràng buộc tên nên dùng nó cho
      // các header CORS (cùng hiệu ứng, và Header đích vẫn là response).
      c.res.headers.set('access-control-allow-origin', corsOrigin);
      c.res.headers.set('vary', 'Origin');
      c.res.headers.set('access-control-allow-headers', 'authorization, content-type');
      c.res.headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      c.res.headers.set('access-control-max-age', '86400');
    }

    // Preflight: trả ngay, không chạm auth/DB.
    if (c.req.method === 'OPTIONS' && requestOrigin !== undefined) {
      return new Response(null, { status: corsOrigin !== null ? 204 : 403 });
    }
    await next();
    return undefined;
  });

  // /health — không credential, không DB (infra probe không được phụ thuộc DB).
  app.get('/health', (c) => c.json({ status: 'ok', service: 'pact-broker-api' }));

  // Toàn bộ phần còn lại cần config + DB. Lỗi cấu hình → 503 fail-closed.
  app.use('*', async (c, next) => {
    let config: PactBrokerConfig;
    try {
      config = getConfig(c.env);
    } catch (error) {
      if (error instanceof PactBrokerConfigurationError) {
        return c.json({ error: 'Service Unavailable', message: 'Broker is not configured' }, 503);
      }
      throw error;
    }

    // Một Pool mỗi isolate (module-level var sống cùng isolate, không phải
    // cùng request — Hono per-request `c.set` sẽ tạo Pool mới mỗi request).
    // PERF-06: wrap `createPool` trong try để không cache trạng thái hỏng;
    // connection-terminated error reset `cachedPool = null` (lazy re-create).
    if (cachedPool === null) {
      try {
        const pool = createPool(config.hyperdrive.connectionString);
        // Reset lazy khi connection bị chấm dứt — listener riêng, không đụng
        // listener log của `createPool`.
        pool.on('error', (error: unknown) => {
          if (isConnectionTerminatedError(error)) {
            cachedPool = null;
            // oxlint-disable-next-line promise/no-promise-in-callback
            void pool.end().catch(() => undefined);
          }
        });
        cachedPool = pool;
      } catch (error) {
        cachedPool = null;
        throw error;
      }
    }
    c.set('pool', cachedPool);

    c.set('config', config);
    await next();
    return undefined;
  });

  return app;
}

/** App đầy đủ — dùng bởi Worker fetch và bởi test (`app.request()`). */
export function buildApp(): Hono<AppEnv> {
  const app = createApp();

  // Auth per route-group — mỗi group scope đòi hỏi riêng:
  //   * đọc HAL/matrix: read
  //   * publish/deploy/webhook CRUD: write
  //   * quản trị (token, membership): admin — gắn trong routes/admin
  // Route groups nhận `() => MiddlewareHandler`: handler thật được tạo LÚC
  // MOUNT (mỗi lần gọi trả cùng một handler của scope đó) nhưng đọc `pool` từ
  // context lúc REQUEST (pool được tạo trong middleware config, sau health-free
  // section) — thứ tự mount vì thế không phụ thuộc lúc nào pool sẵn sàng.
  const readAuth = authBinder('read');
  const writeAuth = authBinder('write');
  const adminAuth = authBinder('admin');

  // Prefix mount phải khớp contract của Pact CLI (đối chiếu upstream
  // src/index.ts): publish/verification-results nằm dưới /pacts, environments
  // và webhooks có prefix riêng — mount nhầm ở '/' làm `/:name` nuốt mọi path
  // một segment và mọi URL CLI nhận 404.
  // Index discovery: auth read — CLI gọi index với token ngay từ đầu.
  app.route('/', indexRoutes(readAuth));
  app.route('/pacticipants', pacticipantRoutes(readAuth, writeAuth));
  app.route('/pacts', pactRoutes(readAuth, writeAuth));
  app.route('/pacts', verificationRoutes(writeAuth));
  app.route('/', matrixRoutes(readAuth));
  app.route('/environments', environmentRoutes(readAuth, writeAuth));
  app.route('/contracts', contractsRoutes(writeAuth));
  app.route('/webhooks', webhookRoutes(readAuth, writeAuth));
  app.route('/admin', adminRoutes(adminAuth));

  // 404 đồng nhất HAL-shaped (không leak route tồn tại hay không).
  app.notFound((c) =>
    c.json({ error: 'Not Found', message: 'The requested resource does not exist' }, 404),
  );

  // Error handler: log thông điệp, trả 500 không leak nội bộ. KHÔNG BAO GIỜ
  // log prompt/response body hay token.
  app.onError((error, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    // oxlint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        requestId,
        errorName: error.name,
        errorMessage: error.message,
      }),
    );
    return c.json({ error: 'Internal Server Error', requestId }, 500);
  });

  return app;
}

const app = buildApp();

// Default export cho Cloudflare Workers: env/ctx PHẢI được truyền vào Hono,
// nếu không c.env sẽ undefined và config middleware 503 mọi request.
// ExecutionContext lấy từ `hono` (global của @cloudflare/workers-types đòi
// `props` mà runtime không cấp ở mọi hình thức invoke).
export default {
  async fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  /**
   * Queue consumer của `ecoma-staff-access-entitlement-events` (P3.2):
   * áp dụng event entitlement vào membership Pact Broker. Có cùng entry
   * module với `fetch` — Worker này vừa phục vụ API vừa consume queue.
   */
  async queue(
    batch: {
      queue: string | undefined;
      messages: readonly {
        id: string;
        body: unknown;
        ack(): Promise<void>;
        retry(): Promise<void>;
      }[];
    },
    env: AppEnv['Bindings'],
  ): Promise<void> {
    await entitlementQueueBatch(batch, env as { HYPERDRIVE?: { connectionString: string } });
  },
};
