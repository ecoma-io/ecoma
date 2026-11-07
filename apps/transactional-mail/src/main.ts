import { Hono } from 'hono';

import { INTERNAL_BODY_LIMIT_BYTES } from '@ecoma-io/internal-auth-contracts';
import {
  MAIL_CONTENT_TYPE,
  validateGetDeliveryResponse,
  validatePostDeliveryOutcomeRequest,
  validatePostMessagesRequest,
  type PostMessagesResponse,
} from '@ecoma-io/transactional-mail-contracts';
import {
  MAIL_DEFAULT_LOCALE,
  createMailMessage,
  isTemplateAuthorized,
  publishOutboxBatch,
  runNoncePrune,
  runOutboxReconciler,
  runRetentionCycle,
  type MailSendCommandPayload,
} from '@ecoma-io/transactional-mail-application';
import {
  createD1MailPersistence,
  type D1SubsetDatabase,
} from '@ecoma-io/transactional-mail-infrastructure';

import { authenticateInternalRequest, logInternalRejection } from './internal-auth';
import {
  PERMISSION_DELIVERY_OUTCOME,
  PERMISSION_DELIVERY_READ,
  PERMISSION_MESSAGE_CREATE,
  type AuthenticatedPrincipal,
} from './principal';
import {
  loadTransactionalMailConfig,
  type TransactionalMailConfig,
  type TransactionalMailEnv,
} from './config';

/**
 * `transactional-mail` — control plane của mail bounded context.
 *
 * Endpoint thật (mọi route khác → Hono 404, không stub 200):
 *   - `POST /v1/messages` — tạo message + outbox (idempotent theo principal + key).
 *   - `GET /internal/deliveries/:delivery_id` — runtime material cho delivery worker.
 *   - `POST /internal/deliveries/:delivery_id/outcome` — nhận outcome worker báo.
 *
 * Route **không** implement (đã chốt, không phải "chưa kịp"): redrive/repair/
 * `POST /internal/outbox/publish`/DLQ replay — caller và permission chưa được định nghĩa
 * (`01-architecture.md` §10, §7.5); `GET /v1/messages/:id` — contract chưa chốt.
 *
 * `scheduled` (cron) chạy bốn việc theo thứ tự có chủ đích: publish outbox → reconciler →
 * prune nonce → retention. Publish trước để command mới ra queue sớm nhất; reconciler sau
 * publish để candidate còn lại là thứ publish vừa chứng minh không tự chạy tiếp được.
 */

/** Cấu hình đã nạp, cache theo promise của isolate (xem `config.ts` — cache lỗi KHÔNG). */
let cachedConfigPromise: Promise<TransactionalMailConfig> | undefined;

async function getConfig(env: TransactionalMailEnv): Promise<TransactionalMailConfig> {
  cachedConfigPromise ??= loadTransactionalMailConfig(env).catch((error: unknown) => {
    cachedConfigPromise = undefined;
    throw error;
  });
  return await cachedConfigPromise;
}

/**
 * Đọc body theo stream với hạn mức tích lũy — precedent `apps/auth/src/main.ts`.
 *
 * `arrayBuffer()` nạp hết payload rồi mới so `byteLength`: request chunked chiếm toàn bộ
 * heap trước khi bị từ chối. Đọc từng chunk rồi dừng giữa chừng khi vượt hạn mức là chốt
 * chặn thật cho cả hai dạng framing.
 */
async function readBodyLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        // Từ chối NGAY, không đọc nốt: mỗi byte đã đọc là bộ nhớ đã cấp phát.
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Mã lỗi public của `POST /v1/messages` — closed set của contract (FR-001). */
type PostMessagesErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'invalid_recipient'
  | 'invalid_locale'
  | 'idempotency_key_conflict'
  | 'rate_limited'
  | 'template_not_found'
  | 'payload_too_large'
  | 'internal_error'
  | 'service_unavailable';

/** Body lỗi chuẩn `{error: {code, message}}` — message không bao giờ mang dữ liệu request. */
function errorBody(
  code: PostMessagesErrorCode,
  message: string,
): { error: { code: PostMessagesErrorCode; message: string } } {
  return { error: { code, message } };
}

/** Ghi một dòng alert JSON — token đã sanitize, không recipient/content/raw error. */
function logAlert(event: Record<string, unknown>): void {
  try {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify(event));
  } catch {
    // Cố tình im lặng — observability không được nằm trên serving path.
  }
}

/**
 * Id sinh cho message/outbox/delivery — UUIDv4 với tiền tố theo §4.2/§4.3.
 *
 * ⚠️ ID strategy (UUIDv7 vs compact) còn là quyết định mở của overview §10; UUIDv4 qua
 * `crypto.randomUUID()` là hình sẵn có trên cả Workers lẫn Node, không node-local state,
 * và prefix là phần hợp đồng với wire. Đổi strategy là một thay đổi có chủ đích, không
 * phải sửa im lặng ở đây.
 */
function prefixedId(prefix: string): string {
  return `${prefix}${crypto.randomUUID()}`;
}

/**
 * `app` suy từ principal đã xác thực — `svc.<service>` → `<service>`.
 *
 * Ví dụ docs (`02-requirements.md` FR-001): `app` trong response là `account`. Principal
 * là server-controlled nên phép suy này không tin dữ liệu caller; principal không khớp
 * pattern `svc.<service>` (không thể xảy ra với registry hiện tại) rơi về chính nó — chuỗi
 * nguyên vẹn thay vì một value bịa ra.
 */
function appForPrincipal(principal: string): string {
  if (principal.startsWith('svc.')) {
    return principal.slice('svc.'.length);
  }
  return principal;
}

/** 128 ký tự — ceiling của `Idempotency-Key` (FR-001 bước 3), kiểm ở tầng route. */
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * Đường publish/reconciler cần `queueSend` serialize command đúng một lần thành string.
 *
 * ⚠️ `version` lấy từ **type của command** (`MailSendCommandPayload['version']`), không khai
 * literal `1` rời rạc: một literal cục bộ tự gán giá trị của nó sẽ vẫn compile sau khi
 * `MAIL_COMMAND_VERSION` ở contracts được bump, trong khi consumer đã chờ version mới — kết
 * quả là mọi command bị consumer quarantine `unsupported-version` và không mail nào gửi được.
 * Gán qua type means một bump mà publisher không theo là đỏ compile ngay tại đây.
 */
function queueSendCommand(
  queue: QueueLike,
  command: Pick<MailSendCommandPayload, 'version' | 'delivery_id'>,
): Promise<void> {
  const version: MailSendCommandPayload['version'] = command.version;
  const payload: {
    readonly version: MailSendCommandPayload['version'];
    readonly delivery_id: string;
  } = {
    version,
    delivery_id: command.delivery_id,
  };
  // `QUEUE.send` throw khi Queue không gọi được — failure của publisher là throw,
  // không "trả false rồi bỏ qua" (port `queueSend` ghi rõ).
  return queue.send(JSON.stringify(payload));
}

/** Subset của Cloudflare Queue producer mà worker này dùng — chỉ `send` với string. */
interface QueueLike {
  send(message: string): Promise<void>;
}

/**
 * D1 `mail` binding ở đúng subset mà factory nhận.
 *
 * ⚠️ Cast tường minh qua `unknown` là **cố ý**: binding thật của Workers có surface rộng
 * hơn subset nhiều, và TS không chứng minh được `D1Database` assignable cho `D1SubsetDatabase`
 * ở call site (suite `mail-d1.spec.ts` của app này, dưới `tests/integrations/`, là nơi ghim
 * tương thích đó bằng compile-time assert).
 * Một helper duy nhất ở đây là chỗ duy nhất cần cast; mọi call site khác gọi qua nó.
 */
function mailDb(env: TransactionalMailEnv): D1SubsetDatabase {
  return env['mail'] as unknown as D1SubsetDatabase;
}

/** Queue producer binding — cast cùng lý do với {@link mailDb}. */
function mailQueue(env: TransactionalMailEnv): QueueLike {
  return env['QUEUE'] as unknown as QueueLike;
}

const app = new Hono<{ Bindings: TransactionalMailEnv }>();

/**
 * `GET /health` — smoke check sau deploy (`03-operations.md` §1.1): không auth, **không chạm
 * D1** (observability không được thành serving-path dependency), chỉ trả service name +
 * status + time. Không chạy config loader: một biến vận hành thiếu là lỗi boot của Worker,
 * nhưng health endpoint vẫn phải trả được để runbook phân biệt "không boot" với "còn sống".
 */
app.get('/health', (c) =>
  c.json({ service: 'transactional-mail', status: 'ok', time: new Date().toISOString() }),
);

/* -------------------------------------------------------------------------------------------- */
/* POST /v1/messages — FR-001                                                                    */
/* -------------------------------------------------------------------------------------------- */

app.post('/v1/messages', async (c) => {
  const env = c.env as TransactionalMailEnv;
  const config = await getConfig(env);

  // Bước 1 — AUTHENTICATE trước mọi xử lý nghiệp vụ. Body đọc theo stream có hạn mức
  // TRƯỚC, và byte thô đi thẳng vào verify (không decode) — cùng precedent `apps/auth`.
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > INTERNAL_BODY_LIMIT_BYTES) {
    return c.json(errorBody('payload_too_large', 'Request body exceeds the size limit'), 413);
  }
  const raw =
    c.req.raw.body === null
      ? new Uint8Array()
      : await readBodyLimited(c.req.raw.body, INTERNAL_BODY_LIMIT_BYTES);
  if (raw === null) {
    return c.json(errorBody('payload_too_large', 'Request body exceeds the size limit'), 413);
  }

  const auth = await authenticateInternalRequest(
    { config, nonces: createD1MailPersistence(mailDb(env)).nonces, nowMs: Date.now() },
    c.req.raw,
    raw,
  );
  if (auth.kind === 'rejected') {
    logInternalRejection(auth.reason);
    if (auth.status === 503) {
      return c.json(errorBody('service_unavailable', 'Nonce store unavailable'), 503, {
        'Retry-After': '5',
      });
    }
    if (auth.status === 413) {
      return c.json(errorBody('payload_too_large', 'Request body exceeds the size limit'), 413);
    }
    // 401 chung cho mọi lý do — response không thành oracle dò chữ ký.
    return c.json(errorBody('unauthorized', 'Unauthorized'), 401, {
      'WWW-Authenticate': 'HMAC realm="ecoma-internal"',
    });
  }

  // Bước 2 — AUTHORIZE (default-deny): authentication không thay thế authorization.
  const principal: AuthenticatedPrincipal = auth.principal;
  if (!principal.permissions.includes(PERMISSION_MESSAGE_CREATE)) {
    return c.json(errorBody('forbidden', 'Principal is not allowed to create messages'), 403);
  }

  // Bước 3 — VALIDATE SHAPE. `Idempotency-Key` bắt buộc, ≤ 128 ký tự; body phải là JSON
  // qua contract validator. Một body JSON dị dạng là `400 invalid_request` — chữ ký của
  // nó vẫn verify được vì verify ký đúng byte, nhưng shape sai thì request dừng ở bước 3.
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (idempotencyKey === undefined || idempotencyKey.length === 0) {
    return c.json(errorBody('invalid_request', 'Idempotency-Key header is required'), 400);
  }
  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return c.json(
      errorBody('invalid_request', 'Idempotency-Key must be at most 128 characters'),
      400,
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json(errorBody('invalid_request', 'Request body must be valid JSON'), 400);
  }
  const validated = validatePostMessagesRequestForRoute(parsedBody);
  if (!validated.ok) {
    return c.json(errorBody('invalid_request', validated.message), 400);
  }

  // Bước 3b — AUTHORIZE THEO TEMPLATE (SR-001): verdict do use case
  // `isTemplateAuthorized` ở application layer quyết định (allowlist boot-time, default-
  // deny, không merge từ payload — semantics đầy đủ ở đó). Route chỉ làm HTTP mapping: vị
  // trí của bước này là một phần của verdict — sau validate shape và **trước** mọi
  // persistence lẫn idempotency lookup, nên một principal bị revoke template không được
  // tiếp tục nhận `200` replay của request cũ; và `403` giữ chung một message hằng, không
  // phân biệt hai trường hợp deny — sự phân biệt đó là oracle liệt kê catalog template.
  const authorization = isTemplateAuthorized({
    principalId: principal.principal,
    template: validated.request.template,
    templatesByPrincipal: config.templatesByPrincipal,
  });
  if (!authorization.allowed) {
    return c.json(errorBody('forbidden', 'Principal is not allowed to use this template'), 403);
  }

  // Bước 4–7 — use case chạy đúng thứ tự FR-001 (lookup → rate limit → template → persist).
  const persistence = createD1MailPersistence(mailDb(env));
  const nowMs = Date.now();
  const result = await createMailMessage(
    {
      templates: persistence.templates,
      messages: persistence.messages,
      rateLimits: persistence.rateLimits,
      logAlert: (event) => logAlert(event),
    },
    {
      rateLimitPrincipal: config.rateLimits.principal,
      rateLimitSystem: config.rateLimits.system,
      rateLimitIdempotencyKey: config.rateLimits.idempotencyKey,
      urlAllowlist: config.templateUrlAllowedHosts,
      fingerprintKeyring: {
        currentProfile: config.fingerprintKeyring.currentProfile,
        keysByProfileHex: new Map(
          [...config.fingerprintKeyring.keys.entries()].map(([profile, keyBytes]) => [
            profile,
            toHex(keyBytes),
          ]),
        ),
      },
      defaultLocale: MAIL_DEFAULT_LOCALE,
      maxRenderBytes: config.render.maxRenderBytes,
      nowMs,
      messageId: prefixedId('msg_'),
      outboxId: prefixedId('obx_'),
      deliveryId: prefixedId('dlv_'),
      principal: { id: principal.principal, app: appForPrincipal(principal.principal) },
      idempotencyKey,
      request: validated.request,
    },
  );

  switch (result.kind) {
    case 'created':
    case 'replay': {
      const created = result.kind === 'created';
      const body = postMessagesResponseOf(result.message, created);
      return c.json(body, created ? 201 : 200);
    }
    case 'conflict':
      return c.json(
        errorBody(
          'idempotency_key_conflict',
          'Idempotency-Key was already used with a different request',
        ),
        409,
      );
    case 'rate-limited':
      return c.json(errorBody('rate_limited', 'Rate limit exceeded'), 429, {
        'Retry-After': Math.ceil(result.retryAfterMs / 1000).toString(),
      });
    case 'template-not-found':
      return c.json(
        errorBody('template_not_found', 'No active template version for the requested template'),
        404,
      );
    case 'invalid':
      // Mỗi field một message hằng — không có byte nào của request đi vào message.
      if (result.field === 'recipient') {
        return c.json(errorBody('invalid_recipient', 'Recipient is not a valid address'), 400);
      }
      if (result.field === 'locale') {
        return c.json(errorBody('invalid_locale', 'Locale is not supported'), 400);
      }
      if (result.field === 'variables') {
        return c.json(
          errorBody('invalid_request', 'Variables do not match the template schema'),
          400,
        );
      }
      return c.json(errorBody('invalid_request', 'Idempotency-Key is not acceptable'), 400);
    case 'broken-schema':
      return c.json(errorBody('internal_error', 'Template schema is invalid'), 500);
    case 'unrenderable':
      return c.json(errorBody('internal_error', 'Template could not be rendered'), 500);
    case 'allowlist-unconfigured':
      return c.json(errorBody('service_unavailable', 'URL allowlist is not configured'), 503);
    case 'payload-too-large':
      return c.json(errorBody('payload_too_large', 'Rendered content exceeds the size limit'), 413);
    case 'service-unavailable':
      return c.json(
        errorBody('service_unavailable', 'Stored fingerprint could not be verified'),
        503,
      );
  }
});

/** Kiểm shape body `POST /v1/messages` bằng contract validator — trả message hằng khi fail. */
function validatePostMessagesRequestForRoute(
  payload: unknown,
):
  | { readonly ok: true; readonly request: Parameters<typeof createMailMessage>[1]['request'] }
  | { readonly ok: false; readonly message: string } {
  // Wrap validator của contract để route không dính `reason`/`detail` chi tiết:
  // `detail` là tên field do caller kiểm soát, không đưa vào message trả về.
  const result = validatePostMessagesRequest(payload);
  if (!result.ok) {
    return { ok: false, message: 'Request body does not match the required shape' };
  }
  return {
    ok: true,
    request: {
      template: result.request.template,
      recipient: result.request.recipient,
      locale: result.request.locale,
      variables: result.request.variables,
      correlationId: result.request.correlation_id ?? null,
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* GET /internal/deliveries/:delivery_id — §7.2                                                  */
/* -------------------------------------------------------------------------------------------- */

app.get('/internal/deliveries/:deliveryId', async (c) => {
  const env = c.env as TransactionalMailEnv;
  const config = await getConfig(env);

  const auth = await authenticateRoute(c, env, config);
  if ('errorResponse' in auth) {
    return auth.errorResponse;
  }
  const denied = requirePermission(auth.principal, PERMISSION_DELIVERY_READ);
  if (denied !== undefined) {
    return denied;
  }

  const persistence = createD1MailPersistence(mailDb(env));
  const message = await persistence.messages.findByDeliveryId(c.req.param('deliveryId'));
  if (message === null) {
    // 404 không echo `delivery_id` vào message — id là dữ liệu caller kiểm soát.
    return c.json({ error: { code: 'not_found', message: 'Delivery not found' } }, 404);
  }

  // Envelope §7.2 — đúng tám trường trong `message` + `dispatch_generation`.
  // Contract validator của phía worker dùng cùng shape, nên route tự verify envelope của
  // chính mình trước khi trả: một lệch schema ở đây thành lỗi build/test chứ không phải
  // lỗi runtime im lặng ở consumer.
  const envelope = {
    message: {
      delivery_id: message.deliveryId,
      message_id: message.id,
      app: message.app,
      status: message.status,
      recipient: message.recipient,
      subject: message.subjectRendered,
      body: message.bodyRendered,
      content_type: MAIL_CONTENT_TYPE,
    },
    dispatch_generation: message.dispatchGeneration,
  };
  const check = validateGetDeliveryResponse(envelope);
  if (!check.ok) {
    return c.json(
      { error: { code: 'internal_error', message: 'Delivery envelope failed validation' } },
      500,
    );
  }
  return c.json(check.value);
});

/* -------------------------------------------------------------------------------------------- */
/* POST /internal/deliveries/:delivery_id/outcome — §6.2.2                                       */
/* -------------------------------------------------------------------------------------------- */

app.post('/internal/deliveries/:deliveryId/outcome', async (c) => {
  const env = c.env as TransactionalMailEnv;
  const config = await getConfig(env);

  const auth = await authenticateRoute(c, env, config);
  if ('errorResponse' in auth) {
    return auth.errorResponse;
  }
  const denied = requirePermission(auth.principal, PERMISSION_DELIVERY_OUTCOME);
  if (denied !== undefined) {
    return denied;
  }

  // Body đã được đọc một lần trong authenticate — byte thô ở `auth.body`; parse từ đó,
  // KHÔNG đọc lại stream (stream một lần là hết).
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(auth.body ?? new Uint8Array()));
  } catch {
    return c.json(
      { error: { code: 'invalid_request', message: 'Request body must be valid JSON' } },
      400,
    );
  }
  const validated = validatePostDeliveryOutcomeRequest(parsedBody);
  if (!validated.ok) {
    return c.json(
      { error: { code: 'invalid_request', message: 'Outcome does not match the required shape' } },
      400,
    );
  }

  const persistence = createD1MailPersistence(mailDb(env));
  const applied = await persistence.messages.applyDeliveryOutcome({
    deliveryId: c.req.param('deliveryId'),
    outcome: validated.value.outcome,
    dispatchGeneration: validated.value.dispatch_generation,
    errorClass: validated.value.error_class ?? null,
    nowMs: Date.now(),
  });

  if (applied.result === 'stale') {
    return c.json({
      result: 'stale',
      status: applied.status,
      current_dispatch_generation: applied.currentDispatchGeneration,
    });
  }
  if (applied.result === 'not-found') {
    return c.json({ error: { code: 'not_found', message: 'Delivery not found' } }, 404);
  }
  return c.json({ result: applied.result, status: applied.status });
});

/* -------------------------------------------------------------------------------------------- */
/* Internal auth dùng chung hai route /internal/*                                                */
/* -------------------------------------------------------------------------------------------- */

type RouteAuth =
  // ⚠️ Field phải tên `errorResponse`, không phải `response`: rule
  // `security-sensitive-value-in-http-response` nhận diện source theo HÌNH DẠNG tên
  // (`$OWNER.$SENSITIVE`, với `responses?` trong danh sách), nên `return auth.response`
  // vừa trúng source vừa trúng sink `return $VALUE` dù không có secret nào đi qua —
  // một FP thuần hình dạng. `errorResponse` không khớp regex (không mở đầu bằng
  // `response`), và dòng `return` trong route giờ chỉ mang response lỗi tĩnh.
  | { readonly errorResponse: Response }
  | { readonly principal: AuthenticatedPrincipal; readonly body: Uint8Array | null };

/** Context tối thiểu mà {@link authenticateRoute} cần — route Hono thoả cấu trúc này. */
interface RouteContext {
  readonly req: { readonly raw: Request; header(name: string): string | undefined };
  json(payload: unknown, status: 401 | 403 | 413 | 503, headers?: Record<string, string>): Response;
}

/** Authenticate một request /internal/*: đọc body (có hạn mức) rồi verify envelope. */
async function authenticateRoute(
  c: RouteContext,
  env: TransactionalMailEnv,
  config: TransactionalMailConfig,
): Promise<RouteAuth> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > INTERNAL_BODY_LIMIT_BYTES) {
    return {
      errorResponse: c.json(
        { error: { code: 'payload_too_large', message: 'Request body exceeds the size limit' } },
        413,
      ),
    };
  }
  const raw =
    c.req.raw.body === null
      ? new Uint8Array()
      : await readBodyLimited(c.req.raw.body, INTERNAL_BODY_LIMIT_BYTES);
  if (raw === null) {
    return {
      errorResponse: c.json(
        { error: { code: 'payload_too_large', message: 'Request body exceeds the size limit' } },
        413,
      ),
    };
  }
  const nonces = createD1MailPersistence(mailDb(env)).nonces;
  const auth = await authenticateInternalRequest(
    { config, nonces, nowMs: Date.now() },
    c.req.raw,
    raw,
  );
  if (auth.kind === 'rejected') {
    logInternalRejection(auth.reason);
    if (auth.status === 503) {
      return {
        errorResponse: c.json(
          { error: { code: 'service_unavailable', message: 'Nonce store unavailable' } },
          503,
          { 'Retry-After': '5' },
        ),
      };
    }
    if (auth.status === 413) {
      return {
        errorResponse: c.json(
          { error: { code: 'payload_too_large', message: 'Request body exceeds the size limit' } },
          413,
        ),
      };
    }
    // 401 chung cho mọi lý do — response không thành oracle dò chữ ký.
    return {
      errorResponse: c.json({ error: { code: 'unauthorized', message: 'Unauthorized' } }, 401, {
        'WWW-Authenticate': 'HMAC realm="ecoma-internal"',
      }),
    };
  }
  return { principal: auth.principal, body: raw };
}

/** Default-deny 403 khi principal thiếu permission — dùng chung hai route /internal/*. */
function requirePermission(
  principal: AuthenticatedPrincipal,
  permission: string,
): Response | undefined {
  if (!principal.permissions.includes(permission)) {
    return new Response(
      JSON.stringify({
        error: { code: 'forbidden', message: 'Principal lacks the required permission' },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }
  return undefined;
}

/* -------------------------------------------------------------------------------------------- */
/* Scheduled handler — publish loop → reconciler → nonce prune → retention                       */
/* -------------------------------------------------------------------------------------------- */

/** Dựng persistence + deps của scheduled một lần mỗi lần chạy. */
function scheduledDeps(
  env: TransactionalMailEnv,
  config: TransactionalMailConfig,
): { readonly persistence: ReturnType<typeof createD1MailPersistence>; readonly queue: QueueLike } {
  void config;
  return { persistence: createD1MailPersistence(mailDb(env)), queue: mailQueue(env) };
}

export default {
  fetch: app.fetch,

  /**
   * Cron của control plane — bốn việc, mỗi việc tự biên lô.
   *
   * ⚠️ Publish TRƯỚC reconciler: publish chạy trước thì những row còn claim được được
   * enqueue ngay, và candidate mà reconciler nhìn thấy sau đó là thứ publish vừa chứng
   * minh không tự tiến triển được — không phải thứ chỉ mới chưa tới lượt.
   *
   * ⚠️ Mỗi pha bắt lỗi riêng: một pha chết không được cản các pha sau (nonce prune và
   * retention có giá trị bảo mật độc lập với publish). Kết quả chạy chỉ qua log, không
   * qua return value của `waitUntil`.
   */
  async scheduled(
    controller: { readonly cron: string },
    env: TransactionalMailEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void> {
    void controller;
    const config = await getConfig(env);
    const { persistence, queue } = scheduledDeps(env, config);

    // 1 — Publish loop: claim → QUEUE.send (ngoài D1 txn) → markPublished; failure của
    // send là throw, publisher tự recordPublishFailure + backoff.
    try {
      const publishResult = await publishOutboxBatch(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          queueSend: (command) => queueSendCommand(queue, command),
          generateLeaseOwner: () => prefixedId('own_'),
          logAlert: (event) => logAlert(event),
        },
        {
          leaseMs: config.publish.leaseMs,
          batchLimit: config.publish.batchLimit,
          maxPublishAttempts: config.publish.maxAttempts,
          backoffBaseMs: config.publish.backoffBaseMs,
          nowMs: Date.now(),
        },
      );
      logAlert({ event: 'scheduled_publish', ...publishResult });
    } catch {
      logAlert({ event: 'scheduled_publish_unexpected_error' });
    }

    // 2 — Reconciler: quét delivery `accepted`/`queued` quá tuổi, re-dispatch tiêu ngân
    // sách A. Adapter hai statement bên dưới chạy đúng hợp đồng port: statement (1) trả
    // 0 hàng ⇒ dừng, KHÔNG batch statement (2).
    try {
      const reconcilerResult = await runOutboxReconciler(
        {
          outbox: persistence.outbox,
          messages: persistence.messages,
          redispatch: (deliveryId, redispatchNowMs) =>
            redispatchOutbox(env, config, deliveryId, redispatchNowMs),
          listDispatchIncomplete: async ({ updatedBeforeMs, limit }) => {
            const { results } = await mailDb(env)
              .prepare(
                // Đúng câu port chỉ định — index `mail_messages_status_updated_idx` phục vụ nó.
                "SELECT id, delivery_id FROM mail_messages WHERE status IN ('accepted','queued') AND updated_at < ? ORDER BY updated_at, id LIMIT ?",
              )
              .bind(updatedBeforeMs, limit)
              .all<{ id: string; delivery_id: string }>();
            return results.map((row) => ({ messageId: row.id, deliveryId: row.delivery_id }));
          },
          logAlert: (event) => logAlert(event),
        },
        {
          maxAgeMs: config.reconciler.maxAgeMs,
          batchLimit: config.reconciler.batchLimit,
          nowMs: Date.now(),
          leaseMs: config.publish.leaseMs,
          maxPublishAttempts: config.publish.maxAttempts,
          backoffBaseMs: config.publish.backoffBaseMs,
        },
      );
      logAlert({ event: 'scheduled_reconciler', ...reconcilerResult });
    } catch {
      logAlert({ event: 'scheduled_reconciler_unexpected_error' });
    }

    // 3 — Prune nonce hết hạn: bảo trì replay guard, một lô mỗi lần chạy.
    try {
      const pruneResult = await runNoncePrune(
        { nonces: persistence.nonces },
        { batchLimit: config.noncePrune.batchLimit, nowMs: Date.now() },
      );
      logAlert({ event: 'scheduled_nonce_prune', ...pruneResult });
    } catch {
      logAlert({ event: 'scheduled_nonce_prune_unexpected_error' });
    }

    // 4 — Retention: redact content message terminal quá hạn + alert delivery dở quá tuổi.
    try {
      const retentionResult = await runRetentionCycle(
        { retention: persistence.retention, logAlert: (event) => logAlert(event) },
        {
          contentOlderThanMs: config.retention.contentMs,
          staleOlderThanMs: config.retention.staleAlertMs,
          batchLimit: config.publish.batchLimit,
          nowMs: Date.now(),
        },
      );
      logAlert({ event: 'scheduled_retention', ...retentionResult });
    } catch {
      logAlert({ event: 'scheduled_retention_unexpected_error' });
    }

    void ctx;
  },
};

/**
 * Re-dispatch một delivery — adapter của `runOutboxReconciler`, đúng hợp đồng hai
 * statement (`01-architecture.md` §6.5 hàng 12 + `03-operations.md` §5.3):
 *
 * 1. `mail_outbox`: reset row về `pending` cho chu kỳ publish mới.
 * 2. `mail_messages`: tăng `recovery_cycle_count`, giữ status `queued`, **cùng generation**
 *    (re-dispatch của reconciler KHÔNG bump generation — redrive mới bump), guard
 *    `status IN ('accepted','queued') AND recovery_cycle_count < maxRecoveryCycles`.
 *
 * ⚠️ HAI statement chạy trong **một** `db.batch()` (một implicit transaction của D1): hai
 * lần commit riêng là cửa sổ crash — message đã tăng `recovery_cycle_count` nhưng outbox
 * còn `published`, và ngân sách A chỉ tăng nên delivery kẹt vĩnh viễn. Guard của hai
 * statement là **đối xứng** (mỗi cái kiểm điều kiện của bảng kia qua `EXISTS`), nên "cả hai
 * hoặc không cái nào" là thuộc tính của chính SQL, không phụ thuộc thứ tự crash.
 *
 * ⚠️ KHÔNG có `'failed'` trong nguồn của statement (1): outbox `failed` đã kiệt
 * `maxPublishAttempts` trong chu kỳ đó và chỉ được mở lại bởi repair **có authorize**
 * (`03-operations.md` §5.4) — tự reset ở đây là lách cổng authorize đó. Nhánh `failed` của
 * reconciler ở application layer đã phát hiện + alert trước khi tới adapter; guard này là
 * lưới cuối cùng chống race (outbox chuyển `failed` giữa lúc đọc và lúc batch).
 *
 * ⚠️ Guard lease (§5.3, chống recovery loop): chỉ reset khi row **không** đang giữ một lease
 * còn hạn — `(claimed_at IS NULL OR claimed_at <= ?)`. Row `publishing` với lease còn hạn là
 * publisher đang sống: giành quyền với nó sẽ xoá lease của publisher và mở vòng đua
 * publisher ↔ reconciler. Lease quá hạn thì publisher lần sau tự reclaim được; reset ở đây
 * mở chu kỳ publish mới. Statement (2) kiểm cùng điều kiện qua `EXISTS` nên một row còn giữ
 * lease **không** tiêu ngân sách A — tăng `recovery_cycle_count` mà không re-dispatch là
 * đốt ngân sách vô hiệu.
 */
async function redispatchOutbox(
  env: TransactionalMailEnv,
  config: TransactionalMailConfig,
  deliveryId: string,
  nowMs: number,
): Promise<
  | { readonly kind: 'redispatched'; readonly recoveryCycleCount: number }
  | { readonly kind: 'budget-exhausted' }
  | { readonly kind: 'not-eligible' }
> {
  const db = mailDb(env);
  // Lease còn hạn — mốc giống cách `claim` của publisher nhìn reclaim: `claimed_at <= cutoff`
  // là đã hết hạn. Cắt theo `config.publish.leaseMs` vì re-dispatch tái dùng cùng chu kỳ
  // publish mà publisher đang chạy.
  const leaseCutoffMs = nowMs - config.publish.leaseMs;
  // Statement 1 — reset outbox, guard: message còn ở nguồn `accepted`/`queued` VÀ còn ngân
  // sách A (EXISTS), outbox ở nguồn khống `failed`, và không ai đang giữ lease còn hạn.
  const resetOutbox = db
    .prepare(
      "UPDATE mail_outbox SET status = 'pending', publish_attempts = 0, available_at = ?, claimed_at = NULL, " +
        'claimed_by = NULL, published_at = NULL, last_error = NULL, ' +
        'dispatch_generation = (SELECT dispatch_generation FROM mail_messages WHERE delivery_id = ?), updated_at = ? ' +
        "WHERE delivery_id = ? AND status IN ('pending','publishing','published') " +
        'AND (claimed_at IS NULL OR claimed_at <= ?) ' +
        'AND EXISTS (SELECT 1 FROM mail_messages WHERE mail_messages.delivery_id = mail_outbox.delivery_id ' +
        "AND mail_messages.status IN ('accepted','queued') AND mail_messages.recovery_cycle_count < ?)",
    )
    .bind(nowMs, deliveryId, nowMs, deliveryId, leaseCutoffMs, config.reconciler.maxRecoveryCycles);
  // Statement 2 — tăng ngân sách A, guard đối xứng: outbox vừa được statement 1 reset
  // (`pending`, không lease) — chạy SAU statement 1 trong cùng batch nên thấy đúng state
  // post-reset; row còn giữ lease hoặc sai nguồn thì EXISTS sai và **không** tiêu ngân sách.
  const bumpBudget = db
    .prepare(
      "UPDATE mail_messages SET recovery_cycle_count = recovery_cycle_count + 1, status = 'queued', updated_at = ? " +
        "WHERE delivery_id = ? AND status IN ('accepted','queued') AND recovery_cycle_count < ? " +
        'AND EXISTS (SELECT 1 FROM mail_outbox WHERE mail_outbox.delivery_id = mail_messages.delivery_id ' +
        "AND mail_outbox.status = 'pending' AND mail_outbox.claimed_at IS NULL) " +
        'RETURNING recovery_cycle_count',
    )
    .bind(nowMs, deliveryId, config.reconciler.maxRecoveryCycles);

  const [, bumpedRows] = await db.batch<{ readonly recovery_cycle_count: number }>([
    resetOutbox,
    bumpBudget,
  ]);
  const incremented = bumpedRows.results[0];
  if (incremented === undefined) {
    // 0 hàng: hết ngân sách A, row không còn ở nguồn guard, hoặc lease còn giữ — các nguyên
    // nhân không phân biệt được từ một statement; việc phân biệt là việc của operator đọc alert.
    return { kind: 'budget-exhausted' };
  }
  return { kind: 'redispatched', recoveryCycleCount: incremented.recovery_cycle_count };
}

/* -------------------------------------------------------------------------------------------- */
/* Helpers                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** Byte thô → hex chữ thường — keyring config giữ byte, use case nhận hex. */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Dựng response 8 trường từ record — `created` phản ánh tạo mới hay replay (FR-001). */
function postMessagesResponseOf(
  message: {
    readonly id: string;
    readonly deliveryId: string;
    readonly app: string;
    readonly templateName: string;
    readonly templateVersion: number;
    readonly status: string;
    readonly createdAtMs: number;
  },
  created: boolean,
): PostMessagesResponse {
  return {
    id: message.id,
    delivery_id: message.deliveryId,
    app: message.app,
    template: message.templateName,
    template_version: message.templateVersion,
    status: message.status as PostMessagesResponse['status'],
    created,
    created_at: new Date(message.createdAtMs).toISOString(),
  };
}
