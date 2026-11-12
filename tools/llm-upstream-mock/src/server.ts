/**
 * HTTP server của mock upstream — chỉ dựng trên node:http, không dependency.
 *
 * Tách đôi để test được: `createUpstreamMockServer` trả handle thuần (không
 * listen), `startMockServer` listen trên loopback port ephemeral và trả
 * `close()` dọn sạch — including socket đang treo cố ý của scenario `timeout`
 * (không destroy thì server.close() không hoàn tất và tiến trình vitest còn
 * sống vì timer pending giữ event loop).
 *
 * Ràng buộc observability: log CHỈ metadata (method, path, scenario, status,
 * duration) — không bao giờ log prompt/response body (invariant repo).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  DEFAULT_PORT,
  SCENARIO_HEADER,
  parseScenario,
  type MockConfig,
  type Scenario,
} from './config.js';
import {
  MALFORMED_BODY,
  buildChatCompletion,
  buildErrorEnvelope,
  buildModelList,
  buildSseEvents,
  nextCompletionId,
} from './shapes.js';

/** Một entry socket treo cố ý (scenario `timeout`) — timer phải clear khi shutdown. */
interface HungSocketEntry {
  readonly timer: NodeJS.Timeout;
  readonly socket: import('node:net').Socket;
}

/** Handle của server chưa listen — tách khỏi listen để test tạo instance tự do. */
export interface MockServerHandle {
  readonly server: Server;
  /** Destroy mọi socket đang bị treo cố ý và clear timer của chúng. */
  destroyPendingSockets(): void;
}

/** Server đã listen trên loopback; `close()` an toàn kể cả khi có socket treo. */
export interface RunningMockServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Ngữ cảnh một request đang xử lý — handler mutate để log đúng ở cuối. */
interface RequestContext {
  readonly method: string;
  readonly path: string;
  scenario: Scenario | 'invalid';
  status: number | 'no-response';
  auth: 'ok' | 'rejected' | 'disabled';
}

/** Một dòng log per request — CHỈ metadata, tuyệt đối không có body. */
function logRequest(ctx: RequestContext, durationMs: number): void {
  const authSuffix = ctx.auth === 'disabled' ? '' : ` auth=${ctx.auth}`;
  console.log(
    `mock-upstream ${ctx.method} ${ctx.path} scenario=${ctx.scenario} status=${String(ctx.status)} duration_ms=${durationMs}${authSuffix}`,
  );
}
/**
 * Kiểm `Authorization` khi cấu hình bật (test-only): so sánh timing-safe qua
 * digest SHA-256 của hai phía. Thiếu header hoặc sai giá trị → `rejected`;
 * không cấu hình → `disabled` (giữ nguyên hợp đồng mặc định của PR #137).
 * Giá trị header KHÔNG BAO GIỜ đi vào log — chỉ verdict một-bit đi vào log.
 */
function checkAuthorization(
  req: IncomingMessage,
  config: MockConfig,
): 'ok' | 'rejected' | 'disabled' {
  if (config.expectedAuthorization === undefined) {
    return 'disabled';
  }
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const headerDigest = createHash('sha256').update(header).digest();
  const matched = config.expectedAuthorization.some((expected) => {
    if (expected.length !== header.length) {
      return false;
    }
    return timingSafeEqual(createHash('sha256').update(expected).digest(), headerDigest);
  });
  return matched ? 'ok' : 'rejected';
}

/** Ghi JSON response + đóng connection sau mỗi request (mock không cần keep-alive). */
function sendJson(
  ctx: RequestContext,
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  ctx.status = status;
  res.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** Ghi SSE stream minimal + sentinel `[DONE]` — đủ để client phân biệt stream thành công. */
function sendSse(ctx: RequestContext, res: ServerResponse, body: string): void {
  ctx.status = 200;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(body);
}

/** 405 với header `Allow` — hợp đồng control-path, không chịu scenario nào. */
function sendMethodNotAllowed(ctx: RequestContext, res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  sendJson(ctx, res, 405, buildErrorEnvelope('Method not allowed.', 'invalid_request_error', null));
}

/** Đọc toàn bộ request body vào buffer (mock test-only: không giới hạn kích thước). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', rejectBody);
  });
}

/**
 * Resolve scenario cho request: header `x-mock-scenario` thắng default config.
 * Header có nhưng sai giá trị là lỗi 400 — fail-fast, không âm thầm fallback
 * (test dùng sai tên scenario phải đỏ thay vì nhận nhầm scenario default).
 */
function resolveScenario(req: IncomingMessage, config: MockConfig): Scenario | 'invalid' {
  const raw = req.headers[SCENARIO_HEADER];
  if (raw === undefined) {
    return config.defaultScenario;
  }
  const value = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  return parseScenario(value) ?? 'invalid';
}

/** Lập lịch destroy socket treo có chủ ý sau `timeoutMs` — mô phỏng upstream không phản hồi. */
function scheduleHang(
  hung: Set<HungSocketEntry>,
  socket: import('node:net').Socket,
  timeoutMs: number,
): void {
  const entry: HungSocketEntry = {
    timer: setTimeout(() => {
      hung.delete(entry);
      socket.destroy();
    }, timeoutMs),
    socket,
  };
  hung.add(entry);
}

/**
 * Áp scenario lên một request đã match route thành công. Các scenario lỗi
 * phản hồi ngay KHÔNG đọc body (thứ tự thật của một upstream: auth/rate-limit
 * chặn trước khi parse body); riêng `ok`/`malformed` mới chạy nhánh `onOk`.
 */
async function applyScenario(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  config: MockConfig,
  hung: Set<HungSocketEntry>,
  onOk: () => Promise<void> | void,
): Promise<void> {
  switch (ctx.scenario) {
    case 'ok':
      await onOk();
      return;
    case 'unauthorized':
      sendJson(
        ctx,
        res,
        401,
        buildErrorEnvelope('Invalid API key provided.', 'invalid_request_error', 'invalid_api_key'),
      );
      return;
    case 'rate_limited':
      sendJson(
        ctx,
        res,
        429,
        buildErrorEnvelope(
          'Rate limit reached for requests in the mock upstream.',
          'rate_limit_error',
          'rate_limit_exceeded',
        ),
        { 'retry-after': '1' },
      );
      return;
    case 'server_error':
      sendJson(
        ctx,
        res,
        500,
        buildErrorEnvelope(
          'The mock upstream had an error processing the request.',
          'api_error',
          null,
        ),
      );
      return;
    case 'malformed':
      sendJson(ctx, res, 200, MALFORMED_BODY);
      return;
    case 'timeout':
      ctx.status = 'no-response';
      scheduleHang(hung, req.socket, config.timeoutMs);
      return;
    case 'invalid':
      // Không tới được đây: caller đã xử lý `invalid` trước khi gọi hàm này.
      throw new Error('Unreachable: invalid scenario must be rejected before route dispatch.');
  }
}

/** Handler `POST /v1/chat/completions` — non-stream trả JSON, `"stream": true` trả SSE minimal. */
async function handleChatCompletions(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  config: MockConfig,
  hung: Set<HungSocketEntry>,
): Promise<void> {
  if (ctx.method !== 'POST') {
    sendMethodNotAllowed(ctx, res, 'POST');
    return;
  }
  await applyScenario(ctx, req, res, config, hung, async () => {
    const bodyText = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText) as unknown;
    } catch {
      sendJson(
        ctx,
        res,
        400,
        buildErrorEnvelope('Invalid JSON in request body.', 'invalid_request_error', null),
      );
      return;
    }
    const body =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const requestedModel = body['model'];
    const model =
      typeof requestedModel === 'string' && requestedModel.length > 0
        ? requestedModel
        : (config.models[0] ?? 'mock-chat-model');

    if (body['stream'] === true) {
      const created = Math.floor(Date.now() / 1000);
      sendSse(ctx, res, buildSseEvents(nextCompletionId(), created, model, config.content));
      return;
    }
    sendJson(ctx, res, 200, buildChatCompletion(model, config.content));
  });
}

/** Handler `GET /v1/models` — danh sách model cấu hình, đúng shape list OpenAI. */
function handleModels(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  config: MockConfig,
  hung: Set<HungSocketEntry>,
): void {
  if (ctx.method !== 'GET') {
    sendMethodNotAllowed(ctx, res, 'GET');
    return;
  }
  void applyScenario(ctx, req, res, config, hung, () => {
    sendJson(ctx, res, 200, buildModelList(config.models));
  });
}

/** Tạo server mock (chưa listen) kèm handle dọn socket treo. */
export function createUpstreamMockServer(config: MockConfig): MockServerHandle {
  const hung = new Set<HungSocketEntry>();

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, config, hung);
  });

  return {
    server,
    destroyPendingSockets(): void {
      for (const entry of hung) {
        clearTimeout(entry.timer);
      }
      hung.clear();
      server.closeAllConnections();
    },
  };
}

/** Dispatch một request: resolve scenario, match route, log một dòng metadata. */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: MockConfig,
  hung: Set<HungSocketEntry>,
): Promise<void> {
  const startedAt = Date.now();
  const ctx: RequestContext = {
    method: req.method ?? '',
    path: req.url ?? '/',
    scenario: resolveScenario(req, config),
    status: 0,
    auth: 'disabled',
  };

  try {
    if (ctx.scenario === 'invalid') {
      ctx.status = 400;
      sendJson(
        ctx,
        res,
        400,
        buildErrorEnvelope(
          `Unknown mock scenario in ${SCENARIO_HEADER} header.`,
          'invalid_request_error',
          null,
        ),
      );
      return;
    }

    // Auth gate đứng trước route dispatch — đúng thứ tự một upstream thật
    // (chặn trước khi parse body) và phủ cả control path khi bật.
    ctx.auth = checkAuthorization(req, config);
    if (ctx.auth === 'rejected') {
      sendJson(
        ctx,
        res,
        401,
        buildErrorEnvelope('Invalid API key provided.', 'invalid_request_error', 'invalid_api_key'),
      );
      return;
    }

    if (ctx.path === '/v1/models') {
      handleModels(ctx, req, res, config, hung);
      return;
    }
    if (ctx.path === '/v1/chat/completions') {
      await handleChatCompletions(ctx, req, res, config, hung);
      return;
    }
    sendJson(
      ctx,
      res,
      404,
      buildErrorEnvelope(
        `Route not found: ${ctx.method} ${ctx.path}`,
        'invalid_request_error',
        null,
      ),
    );
  } finally {
    logRequest(ctx, Date.now() - startedAt);
  }
}

/** Listen trên loopback với port từ config (0 = ephemeral, test dùng đường này). */
export async function startMockServer(
  config: MockConfig,
  host = '127.0.0.1',
): Promise<RunningMockServer> {
  const handle = createUpstreamMockServer(config);
  await new Promise<void>((resolveListen, rejectListen) => {
    handle.server.once('error', rejectListen);
    handle.server.listen(config.port, host, () => {
      resolveListen();
    });
  });
  const address = handle.server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : config.port || DEFAULT_PORT;
  return {
    port,
    url: `http://${host}:${port}`,
    close: async () => {
      handle.destroyPendingSockets();
      await new Promise<void>((resolveClose) => {
        handle.server.close(() => {
          resolveClose();
        });
      });
    },
  };
}
