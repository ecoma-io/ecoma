/**
 * Entry của Worker `ecoma-llm-api` — data plane LLM trên Cloudflare Workers,
 * runtime TypeScript (Hono + `pg` qua Hyperdrive), bundle esbuild ra
 * `build/index.js` (Nx target `build`).
 *
 * Hợp đồng HTTP đóng băng (Issue #22, review PR #113; body `/v1/models` ĐÃ
 * được Issue #23 thay bằng catalogue thật, các quy tắc còn lại giữ nguyên):
 * - `GET /health` → 200 liveness `ok` (`text/plain; charset=utf-8`), KHÔNG
 *   chạm database.
 * - `GET /ready` → 200 `ready` khi cả ba Hyperdrive binding `SELECT 1`
 *   thành công; 503 fail-closed `not ready` khi một binding thiếu/lỗi/timeout.
 * - `GET /v1/models` và `GET /llm/v1/models` → cùng handler: readiness gate
 *   trước, rồi catalogue model `active`; 503 fail-closed khi DB chưa ready,
 *   catalogue lỗi, hay một offer không ánh xạ được owner.
 * - Method không phải GET trên một path đã định nghĩa (`/health`, `/ready`,
 *   `/v1/models`, `/llm/v1/models`) → 405 kèm header `allow: GET` — HEAD và
 *   OPTIONS cũng thuộc nhánh 405, không bao giờ biến thành response thành công.
 * - Path khác → 404 `not found`, bất kể method; không có route `/llm/*` nào
 *   khác (`/llm/health`, `/llm/ready` vẫn 404).
 *
 * Bất biến platform: KHÔNG BAO GIỜ log prompt/response body, connection string
 * hay credential. Log chỉ cấu trúc tối thiểu, chuỗi runtime tiếng Anh.
 */
import { Hono } from 'hono';
import type { Context, ExecutionContext } from 'hono';
import type { LlmApiEnv } from './env';
import { BINDING_STATUS_LABELS, failures, isReady, probeReadiness } from './readiness';
import { modelsListBody, servingCatalogue } from './models';

/** Hono env của app — bindings là ba Hyperdrive binding, không variables. */
export type AppEnv = {
  Bindings: LlmApiEnv;
};

/** 200 text thuần — worker-rs `Response::ok` ghim cứng content-type này. */
function okText(body: string): Response {
  return new Response(bytes(body), {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Encode body thành BYTES trước khi đưa vào `Response`: workerd tự thêm
 * `Content-Type: text/plain;charset=UTF-8` cho body kiểu string (đo trực tiếp
 * — 33 assertion content-type vỡ khi port đầu tiên dùng string), còn runtime
 * Rust đưa byte thô qua `fixed()` nên KHÔNG có header nào được thêm. Byte
 * body là điều kiện của byte-compat, không phải chi tiết thẩm mỹ.
 */
function bytes(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

/** Lỗi 4xx/5xx text thuần KHÔNG kèm content-type — đo trực tiếp trên runtime
 * Rust (`Response::error` chỉ đặt status + body, không đặt header nào). */
function errorText(body: string, status: 404 | 405 | 503): Response {
  return new Response(bytes(body), { status });
}

/** 405 kèm `allow: GET` — khai đúng method duy nhất hợp đồng chấp nhận. */
function methodNotAllowed(): Response {
  return new Response(bytes('method not allowed'), { status: 405, headers: { allow: 'GET' } });
}

/** Log cấu trúc tối thiểu — chỉ route/outcome/tên binding, tiếng Anh. */
function log(message: string): void {
  // oxlint-disable-next-line no-console
  console.log(`[llm-api] ${message}`);
}

/**
 * Đăng ký một path GET-only: GET đi vào handler thật; mọi method khác (bao
 * gồm HEAD và OPTIONS) → 405. ⚠️ KHÔNG dùng `app.get`: Hono tự map HEAD vào
 * handler GET (đo trực tiếp trên Hono 4.13), tức HEAD /ready sẽ chạy probe
 * database — vi phạm hợp đồng 405 cho HEAD. `app.all` + gate method bên trong
 * là hình duy nhất giữ byte-compat với dispatch của runtime Rust.
 */
function getOnly(
  app: Hono<AppEnv>,
  path: string,
  handler: (c: Context<AppEnv>) => Response | Promise<Response>,
): void {
  app.all(path, (c) => (c.req.method === 'GET' ? handler(c) : methodNotAllowed()));
}

/** App đầy đủ — dùng bởi Worker fetch và bởi test (`app.request()`). */
export function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Liveness thuần: không probe database — route này phải trả lời cả khi mọi
  // binding xuống, để orchestrator phân biệt được "process sống" với "phụ thuộc
  // sẵn sàng".
  getOnly(app, '/health', () => okText('ok'));

  // Readiness fail-closed: chỉ 200 khi cả ba binding đều Ready (deadline
  // per-binding 3s nằm ở `readiness`). Nhãn per-binding chỉ đi vào log,
  // không bao giờ vào body.
  getOnly(app, '/ready', async (c): Promise<Response> => {
    const report = await probeReadiness(c.env);
    if (isReady(report)) {
      log('/ready ok');
      return okText('ready');
    }
    const failureLine = failures(report)
      .map(([binding, status]) => `${binding}=${BINDING_STATUS_LABELS[status]}`)
      .join(',');
    log(`/ready not ready: ${failureLine}`);
    return errorText('not ready', 503);
  });

  // `/v1/models` cùng điều kiện readiness với `/ready`, rồi đọc catalogue thật
  // (Issue #23): offer `active` từ marketplace, owner là tên tenant từ gateway.
  // Fail-closed: DB chưa ready, catalogue lỗi hay owner không ánh xạ được đều
  // là 503 — không bao giờ trả danh sách rỗng giả tạo hay model mù chủ sở hữu.
  const modelsHandler = async (c: Context<AppEnv>): Promise<Response> => {
    const report = await probeReadiness(c.env);
    if (!isReady(report)) {
      log('/v1/models not ready: db bindings failing');
      return errorText('service unavailable', 503);
    }
    try {
      const catalogue = await servingCatalogue(c.env);
      log(`/v1/models ok: ${catalogue.length} model(s)`);
      return new Response(bytes(modelsListBody(catalogue)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      // Chi tiết lỗi catalogue không bao giờ đi vào log (chống lộ connection
      // string/credential qua thông báo lỗi) — chỉ outcome, đúng như runtime Rust.
      log('/v1/models catalogue failed');
      return errorText('service unavailable', 503);
    }
  };
  getOnly(app, '/v1/models', modelsHandler);
  // Public path `/llm/v1/models` dùng cùng handler với `/v1/models`: base path
  // `/llm` là public contract (docs/architecture/01, bảng domain; A13 ranh
  // giới routing), production giữ nguyên tiền tố khi forward vào Worker.
  getOnly(app, '/llm/v1/models', modelsHandler);

  // Path lạ → 404 bất kể method. Không thêm route `/llm/*` khác: `/health` và
  // `/ready` là deployment-internal, probe trên đường mạng container, không qua
  // domain công khai, nên `/llm/health` và `/llm/ready` vẫn 404.
  app.notFound(() => errorText('not found', 404));

  return app;
}

const app = buildApp();

// Default export cho Cloudflare Workers: env/ctx PHẢI được truyền vào Hono,
// nếu không `c.env` sẽ undefined và mọi probe readiness đều `missing` 503.
// ExecutionContext lấy từ `hono` (global của @cloudflare/workers-types đòi
// `props` mà runtime không cấp ở mọi hình thức invoke) — cùng chú thích
// `apps/pact-broker-api/src/main.ts`.
export default {
  fetch(request: Request, env: LlmApiEnv, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
