/**
 * Runtime của isolate: config + Provider + Node bridge + CONFIG postgres, dựng LƯỜI.
 *
 * ## Chọn bridge nào — và vì sao
 *
 * Mission cho hai phương án: `httpServerHandler` hoặc `handleAsNodeRequest`. Chọn
 * **`handleAsNodeRequest(port, request, env, ctx)`**:
 *
 * - Hono giữ `/health`, `/.well-known/*` và `/internal/*` — những route KHÔNG cần
 *   Koa: envelope HMAC đọc header/body Web-native, response là JSON thuần. Cho
 *   chúng qua Node là một tầng chuyển đổi không cần thiết.
 * - Còn lại (`/auth`, `/auth/:uid` resume, `/token`, `/jwks.json`, `/revocation`,
 *   `/session/end`) là toàn bộ pipeline Koa của provider — cookies, redirect,
 *   form_post, error rendering. Viết lại chúng trên Hono là tự duy trì một bản
 *   sao của provider.
 * - `httpServerHandler` biến TOÀN BỘ Worker thành một server Node duy nhất
 *   (ExportedHandler thay thế fetch handler), tức Hono phải sống BÊN TRONG Node
 *   request — đảo ngược đúng thứ bậc ta cần: Hono là đường chính, provider là
 *   khách mời trên một tập route hẹp.
 * - `handleAsNodeRequest` cho phép một server Node shared, port cố định trong
 *   isolate, và mỗi request Worker nào cần provider thì cầu qua đó. Không có
 *   socket thật — workerd nội bộ hoá cả vòng đời.
 *
 * ## Vòng đời
 *
 * Provider + Node bridge sống theo isolate: `AuthEnv` không đổi trong vòng đời
 * isolate nên dựng một lần là đúng (cùng luật với `cachedConfigPromise` của
 * `main.ts` trước đây). ⚠️ Cache theo PROMISE và KHÔNG cache lỗi — một lần dựng
 * thất bại (secret sai, DB không kết nối được lúc load clients) phải được phép
 * thử lại ở request sau, không được biến thành vĩnh viễn.
 *
 * ⚠️⚠️ **Client postgres KHÔNG sống theo isolate — chỉ CONFIG (giá trị thuần) được
 * cache.** Bài học của issue #289: postgres.js trên workerd mở TCP socket qua
 * polyfill `cloudflare:sockets`, và socket gắn với request context của request
 * đã tạo nó. Một client cache theo isolate biến mọi request sau thành người dùng
 * chéo-request của socket đó — xen kẽ 500/302 trên `/authorize`, `/auth` chết
 * qua `renderError`, đúng pattern đã tái lập trong #289. Vì vậy:
 *
 * - `postgresClientConfig` (một object thuần: binding + timeout, KHÔNG giữ
 *   socket/pool/state nào của driver) được dựng MỘT lần theo isolate và truyền
 *   cho provider + gate. Các component mở client từ config đúng lúc cần thao tác
 *   DB, qua {@link withPostgresClient} — client sống đúng một thao tác (hoặc một
 *   transaction) rồi `end()` trong `finally`, không bao giờ qua ranh giới request.
 * - Adapter của provider (`createAdapterFactory`) mở client cho MỖI thao tác;
 *   mọi method của adapter là single-statement, không có khối transaction nào
 *   trong adapter.
 * - Static clients được load MỘT lần lúc dựng runtime qua MỘT client tạm
 *   (`withPostgresClient`), client đó đóng ngay khi factory xong.
 * - Đường glue của `main.ts` (`/authorize`, `/internal/*`) không đi qua runtime:
 *   mỗi request tự mở client riêng qua `withPostgresClient`.
 *
 * `loadStaticClients` per isolate vẫn đúng chi phí cũ (một query per isolate,
 * không per request); thứ thay đổi chỉ là client đó không còn sống sau boot.
 *
 * ⚠️ **Không node-local state có ý nghĩa phục hồi**: mọi trạng thái protocol nằm
 * trong `db-auth` (`oidc_state` + `authorization_transactions`), còn server Node
 * chỉ là một bộ máy stateless — isolate chết thì request sau dựng lại từ DB,
 * đúng mô hình recovery của `01-architecture.md`.
 */

import { type AuthConfig, type AuthEnv, loadAuthConfig } from '../config';
import { type PostgresClientConfig, withPostgresClient } from '@ecoma-io/auth-infrastructure';
import { AccountClient } from '../account-client';

import { createProvider } from './provider';
import { createIssuanceGateFromDeps } from './issuance-gate';
import type { Provider } from 'oidc-provider';

import type { NodeStyleServer } from 'cloudflare:node';

/**
 * Config postgres thuần từ config isolate — giá trị DUY NHẤT về postgres được
 * cache theo isolate.
 *
 * ⚠️ An toàn để cache vì config không giữ gì của driver (xem JSDoc của
 * {@link PostgresClientConfig}); client thì NGƯỢC LẠI — không client nào được
 * dựng ở đây, mọi component tự mở qua `withPostgresClient` khi thao tác.
 */
function postgresClientConfigOf(config: AuthConfig): PostgresClientConfig {
  return { hyperdrive: config.hyperdrive };
}

/**
 * Runtime đã dựng cho một isolate.
 *
 * `nodeServer` + `nodePort`: server `node:http` bọc `provider.callback()`, đã
 * `listen(0)` — port ephemeral do runtime Worker cấp, dùng cho mọi lời gọi
 * `handleAsNodeRequest` sau đó.
 */
export interface AuthRuntime {
  readonly config: AuthConfig;
  /** Config postgres thuần — KHÔNG phải client sống; xem JSDoc ở đầu file. */
  readonly postgresClientConfig: PostgresClientConfig;
  readonly provider: Provider;
  readonly nodeServer: NodeStyleServer;
  readonly nodePort: number;
}

/**
 * Composition của gate cấp phát production (SR-015/FR-020): nối các phần phụ
 * thuộc THẬT của isolate vào factory thuần `createIssuanceGateFromDeps` (toàn bộ
 * logic kiểm — account status, revocation, grant status, audit — nằm ở
 * `issuance-gate.ts`, một đường duy nhất dùng chung với testcontainers; bản
 * inline cũ bị xoá để không còn dual path drift).
 *
 * Vị trí bám là `adapter.upsert` — `base_model.js:77-89` của oidc-provider 9.12.2
 * đưa MỌI issuance (authorization code lúc resume, refresh token lúc rotation)
 * qua `adapter.upsert(jti, payload, ttl)`, với payload luôn mang `accountId` +
 * `clientId` (+ `grantId`). Một điểm nghẽn, mọi đường phát.
 *
 * ⚠️ Fail-closed bằng THROW, không phải boolean: adapter chỉ hiểu "ném = chặn",
 * và một lỗi infrastructure (Account unreachable, postgres chết) phải lan lên
 * thành lỗi 5xx của request đó — không được nuốt thành "cho phép".
 */
export function createIssuanceGate(
  env: AuthEnv,
  config: AuthConfig,
  postgresClientConfig: PostgresClientConfig,
): ReturnType<typeof createIssuanceGateFromDeps> {
  const account = new AccountClient({
    binding: env.ACCOUNT_SERVICE as {
      fetch: (request: Request) => Promise<Response>;
    },
    secret: config.internalSecret,
  });
  return createIssuanceGateFromDeps({
    postgresClientConfig,
    // `nowMs` được ghi ở runtime thật (mỗi lần hỏi là một mốc hiện hành), cùng
    // cách wiring mà `main.ts` dùng cho đường session/verified.
    checkStatus: (accountId) => account.checkStatus({ accountId, nowMs: Date.now() }),
  });
}

let cachedRuntimePromise: Promise<AuthRuntime> | undefined;

/**
 * Dựng (hoặc trả lại) runtime của isolate.
 *
 * ⚠️ Thứ tự dựng: config trước (validate secret), provider trước server Node —
 * nếu provider ném thì không để lại listener mồ côi. Static clients của provider
 * load qua MỘT client tạm (`withPostgresClient`) — client đóng ngay khi factory
 * xong, không sống qua request đã tạo nó. `listen(0)` + `address().port` là cặp
 * lệnh chuẩn của `node:http` và mirror declaration của `cloudflare:node`
 * (`NodeStyleServer.address()`).
 */
async function buildRuntime(env: AuthEnv): Promise<AuthRuntime> {
  const config = await loadAuthConfig(env);

  const postgresClientConfig = postgresClientConfigOf(config);
  // Static clients — MỘT query lúc boot, qua client tạm đóng ngay (issue #289:
  // không client nào sống qua request đã tạo nó).
  const provider = await withPostgresClient(
    postgresClientConfig,
    async (temporaryClient) =>
      await createProvider({
        config,
        postgresClientConfig,
        staticClientsLoader: temporaryClient,
        signingPem: config.signingKeyPem,
        // SR-015/FR-020: gate cấp phát là BẮT BUỘC ở runtime production, và là
        // CÙNG MỘT factory với đường testcontainers (`issuance-gate.ts`) — một
        // đường logic duy nhất, không bản inline riêng để trôi lệch. Test không
        // truyền gate là test trình duyệt protocol thuần; acceptance của gate nằm
        // ở (a) adapter upsert-gate + (b) composition này + (c) runtime-gate.spec.
        issuanceGate: createIssuanceGate(env, config, postgresClientConfig),
      }),
  );

  const { createServer } = await import('node:http');
  // `provider.callback()` là `(req, res) => void` theo chữ ký Koa; `createServer`
  // nhận đúng hình dạng đó. Cast qua `NodeStyleServer` của `cloudflare:node` là an
  // toàn: `listen`/`address` là hai method mà cả hai type cùng mô tả.
  const nodeServer = createServer(provider.callback()) as unknown as NodeStyleServer;
  nodeServer.listen(0);
  const address = nodeServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    // Không có port thì không có đường cầu nào — ném để cache giữ nguyên `undefined`
    // và request sau dựng lại, thay vì giữ một runtime không dùng được.
    throw new Error('node server khong cap duoc port ephemeral');
  }

  return { config, postgresClientConfig, provider, nodeServer, nodePort: port };
}

/**
 * Lấy runtime của isolate, dựng nếu chưa có.
 *
 * ⚠️ Cache promise + reset khi lỗi: cùng bộ luật với JSDoc `getConfig` của `main.ts` —
 * gán promise vào biến đồng bộ để N request đồng thời cùng await một lần dựng, và
 * một lỗi phải xoá cache để không thành vĩnh viễn.
 */
export function getRuntime(env: AuthEnv): Promise<AuthRuntime> {
  cachedRuntimePromise ??= buildRuntime(env).catch((error: unknown) => {
    cachedRuntimePromise = undefined;
    throw error;
  });
  return cachedRuntimePromise;
}

/**
 * Ghi đè `X-Forwarded-Proto` từ URL scheme của request Worker.
 *
 * ⚠️ GHI ĐÈ (không fallback-giữ): bridge `cloudflare:node` không có TLS socket
 * nên koa tính protocol từ header này — chỉ khi `provider.proxy = true`
 * (koa/lib/request.js:411-416). Giữ giá trị client gửi là giả mạo protocol
 * (client http gửi `x-forwarded-proto: https` để né secure-cookie). URL scheme
 * của `Request` trong Workers thì ngược lại: nó phản ánh scheme thật mà Cloudflare
 * edge nhận (http hay https do route/redirect của ta quyết định), không phải
 * một header client có thể đặt tùy ý. Provider bật `proxy` cùng lúc — hai nửa
 * của một cơ chế, tách một nửa là sai ngữ nghĩa bảo mật.
 *
 * Export cho acceptance test: server Node cục bộ trong test bọc handler bằng
 * chính transform này để request đi đúng ngữ nghĩa bridge (test http thuần
 * không có header thì provider sẽ chết `secure cookie` y như workerd không vá).
 */
export function withForwardedProto(request: Request): Request {
  const proto = new URL(request.url).protocol.replace(':', '');
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-proto', proto);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // `duplex: 'half'` bắt buộc khi body là stream (Node 18+/undici kiểm);
    // với body null thì không có tác dụng. `RequestInit` của TS DOM lib không
    // khai field này (nó là extension undici) — cast khớp đúng runtime.
    duplex: 'half',
    // `redirect` không mang qua — bridge trả Response Web đã xử lý xong.
  } as RequestInit);
}

/**
 * Cầu một request Web sang server Node của provider.
 *
 * Tách riêng để test được stub — và để `main.ts` không import `cloudflare:node`
 * trực tiếp (module chỉ tồn tại trên workerd; test Node môi trường import sẽ ném).
 */
export async function dispatchToNode(
  runtime: AuthRuntime,
  request: Request,
  env: AuthEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const { handleAsNodeRequest } = await import('cloudflare:node');
  return handleAsNodeRequest(runtime.nodePort, withForwardedProto(request), env, ctx);
}
