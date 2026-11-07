/**
 * `auth` là API-only Worker của bounded context `identity`.
 *
 * Kiến trúc route (xem `oidc/runtime.ts` về việc chia hai lanes):
 *   - **Hono** giữ `/health`, `/.well-known/*`, `/authorize`, `/authorize/confirm`,
 *     `/internal/*` — những route KHÔNG cần pipeline Koa của provider.
 *   - **Provider (qua bridge Node)** giữ `/auth`, `/auth/:uid` (resume), `/token`,
 *     `/jwks.json`, `/revocation`, `/session/end` — `PROVIDER_ROUTES` là bảng
 *     chuyển tiếp duy nhất.
 *
 * ⚠️ Endpoint nào chưa được implement thì **KHÔNG trả 200 với body rỗng hay
 * "sẽ có sau"**. Thiếu route thì Hono trả 404, và 404 là sự thật.
 */

import { Hono } from 'hono';

import { INTERNAL_BODY_LIMIT_BYTES, type VerifyFailureReason } from '@ecoma-io/auth-contracts';
import {
  createAuthorizationStore,
  createPostgresClient,
  withPostgresClient,
} from '@ecoma-io/auth-infrastructure';
import {
  AccountClient,
  AccountDependencyError,
  isAuthenticatedInternalRequest,
} from './account-client';
import { type AuthConfig, type AuthEnv, loadAuthConfig, resolveInternalSecret } from './config';
import { PROVIDER_ROUTES } from './oidc/provider';
import { dispatchToNode, getRuntime } from './oidc/runtime';
import { handleAuthorize, handleAuthorizeConfirm } from './browser-handlers';
import { runSessionVerified } from './session-verified-handler';
import { runConsentContext, runConsentDecide } from './consent-handler';
import {
  runConnectedApplicationRevoke,
  runConnectedApplicationsList,
} from './connected-applications-handler';

const app = new Hono();

/**
 * `Retry-After` cho nhánh `503` khi kho nonce/DB không gọi được — đơn vị **giây**.
 *
 * `docs/architecture/03-operations.md` §3.2 chốt "DB không lấy được connection ⇒ 503 +
 * `Retry-After`", nên header này là phần của hợp đồng trạng thái, không phải tuỳ chọn
 * hiển thị.
 */
const INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS = '5';

/**
 * Khoảng chờ **mở connection** của pool probe readiness (giây) — cùng ngân sách
 * với `NONCE_CLAIM_CONNECT_TIMEOUT_SECONDS` (2s) của replay guard.
 *
 * ⚠️ Đây là hằng của **một** probe, không phải tham số vận hành: một origin kết
 * nối không được trong vài giây là origin không thể phục vụ **request thật** —
 * readiness trả 200 thì request kế tiếp cũng chết sau đó. Giá trị ngắn làm lỗi
 * hạ tầng hiện là `db_unreachable` ⇒ 503 nhanh, thay vì giữ request treo tới
 * hết hạn Worker.
 *
 * ⚠️ Phạm vi giống `connect_timeout` của driver: chỉ pha mở connection. Một
 * origin tiếp nhận TCP nhanh nhưng câu SELECT chậm là dữ liệu khác — probe vẫn
 * có thể vượt 3s; nhánh đó là `db_unreachable` từ thời gian chạy, không phải
 * từ giá trị hằng này.
 */
const READY_PROBE_CONNECT_TIMEOUT_SECONDS = 3;

/**
 * Ngân sách thời gian của probe ACCOUNT_SERVICE trong readiness (mili-giây).
 *
 * Cùng triết lý với `READY_PROBE_CONNECT_TIMEOUT_SECONDS`: một dependency không
 * trả lời trong vài giây là dependency không phục vụ được request thật — readiness
 * trả 200 thì request kế tiếp cũng chết sau đó. Fetch qua service binding là
 * in-process hop (không TCP handshake thật), nên ngân sách ngắn hơn probe DB là
 * đủ; timeout vẫn cần vì binding chết có thể treo ở tầng runtime.
 */
const READY_ACCOUNT_PROBE_TIMEOUT_MS = 3_000;

/**
 * Cấu hình đã nạp, cache theo isolate.
 *
 * ⚠️ Không cache thì mỗi request sẽ import lại PKCS#8 và tạo handle khoá mới —
 * thao tác đắt trên đường phục vụ. ⚠️ Cache theo PROMISE và KHÔNG cache lỗi —
 * một `loadAuthConfig` thất bại phải thử lại ở request sau.
 */
let cachedConfigPromise: Promise<AuthConfig> | undefined;

async function getConfig(env: AuthEnv): Promise<AuthConfig> {
  cachedConfigPromise ??= loadAuthConfig(env).catch((error: unknown) => {
    cachedConfigPromise = undefined;
    throw error;
  });
  return await cachedConfigPromise;
}

/**
 * Phân loại lỗi hạ tầng cho back-channel: lỗi đến từ pool/Postgres hoặc từ
 * `AccountClient` (service binding) là "dependency unavailable" ⇒ 503; còn lại
 * là bug nội bộ ⇒ 500. KHÔNG bao giờ đổi một lỗi hạ tầng thành một kết quả
 * nghiệp vụ (fail-closed).
 */
function isInfrastructureError(error: unknown): boolean {
  if (error instanceof Error) {
    // postgres.js ném `PostgresError`; AccountClient ném `AccountDependencyError`
    // cho mọi lỗi hạ tầng của dependency account (binding chết, timeout, HTTP
    // non-OK, body sai hợp đồng). Kiểm theo **class**, không theo message hay
    // `Error.name` — vì `AccountClient` trước đây chỉ ném `Error` thường, tên
    // class là `Error` thì không phân biệt được với bug nội bộ.
    if (error.name === 'PostgresError' || error instanceof AccountDependencyError) {
      return true;
    }
  }
  return false;
}

app.get('/health', (c) =>
  c.json({
    service: 'auth',
    status: 'ok',
    time: new Date().toISOString(),
  }),
);

/**
 * `GET /ready` — readiness, **có** kiểm phụ thuộc. Mirror của
 * `apps/account/server/routes/ready.get.ts` (cùng bảng phân biệt `/health` vs
 * `/ready`), đọc bằng đại diện của `auth`:
 *
 * | Route     | Hỏi gì                                        | Hỏi DB không | Khi hỏng thì ai hành xử    |
 * | --------- | --------------------------------------------- | ------------ | -------------------------- |
 * | `/health` | Worker có sống không                           | **Không**    | Orchestrator restart Worker |
 * | `/ready`  | Worker có phục vụ **request thật** được không   | **Có**       | Orchestrator ngừng traffic  |
 *
 * ⚠️ **Vì sao `/health` không query DB** — restart-loop vô ích: DB chết ⇒
 * `/health` lỗi ⇒ restart ⇒ isolate mới lại hỏi DB vẫn chết, tăng tải lên
 * database đang chết và che mất nguyên nhân thật (`db-auth` hỏng, không phải
 * Worker hỏng). `/health` chỉ chứng minh isolate sống.
 *
 * ⚠️ **Vì sao `/ready` fail closed.** Thiếu `HYPERDRIVE` hay `ACCOUNT_SERVICE`
 * (cùng một nguyên nhân mà `loadAuthConfig` ném ở request đầu) hoặc `db-auth`
 * không trả lời được thì **không phát hành** token nào — hợp đồng của `auth`
 * không có degraded path (control point fail-closed lúc phát hành,
 * `docs/applications/auth/01-architecture.md` §6.0; system invariant 30 trong
 * `docs/architecture/01-architecture.md`). Một readiness trả 200 trong khi
 * dependency chết là đẩy failure xuống thành lỗi 503 rải rác ở từng request
 * thật. Readiness **không** log chi tiết lỗi DB vào response: response đi qua
 * mạng công cộng; nguyên nhân nằm ở log với mã ổn định — như `ready.get.ts`
 * của account, chỉ `reason` trong log, không message của driver.
 */
app.get('/ready', async (c) => {
  const env = c.env as AuthEnv;

  // Hai binding bắt buộc của `auth` (config.ts ném khi thiếu). Kiểm cả hai ở đây
  // để readiness nói đúng điều nó kiểm: thiếu MỘT trong hai là app không phục vụ
  // được request nào, chứ không phải "chạy được một phần".
  //
  // ⚠️ KHÔNG nêu tên binding thiếu trong response: response công khai; tên binding
  // là thông tin cấu hình. Mã ổn định đủ để truy nguồn từ log.
  if (env.HYPERDRIVE === undefined || typeof env.HYPERDRIVE.connectionString !== 'string') {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'ready.failed', status: 503, reason: 'binding_missing' }));
    return c.json({ error: 'service_unavailable' }, 503, {
      'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }
  if (env.ACCOUNT_SERVICE === undefined) {
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'ready.failed', status: 503, reason: 'binding_missing' }));
    return c.json({ error: 'service_unavailable' }, 503, {
      'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  // Signing config — `loadAuthConfig` là ĐƯỜNG NẠP duy nhất và fail-closed với
  // mọi secret thiếu/sai shape (PKCS#8 không parse được, kid rỗng, cookie keys
  // rỗng...). Thử nạp ở đây biến "signing config có thể dùng để phát hành" thành
  // điều kiện readiness: một Worker không ký được token thì không phục vụ được
  // request nào, bất kể binding và DB có xanh. KHÔNG cache aside ngoài
  // `getConfig` — cache promise của nó đã xử lý dùng lại + không cache lỗi.
  try {
    await getConfig(env);
  } catch {
    // KHÔNG nối `error` vào log: message của `AuthConfigurationError` nêu TÊN
    // biến thiếu — tên cấu hình không thuộc response công khai cũng như log của
    // readiness (log cấu hình là việc của boot, không phải của probe).
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'ready.failed', status: 503, reason: 'config_invalid' }));
    return c.json({ error: 'service_unavailable' }, 503, {
      'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  try {
    await probeDatabase(env.HYPERDRIVE);
  } catch {
    // KHÔNG nối `error` vào log: message của driver có thể chứa connection string.
    // Chỉ ghi mã ổn định, đủ để phân loại sự cố.
    // oxlint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'ready.failed', status: 503, reason: 'db_unreachable' }));
    return c.json({ error: 'service_unavailable' }, 503, {
      'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  // Account contract — probe reachability QUA BINDING (đúng đường mà mọi request
  // thật đi): GET `/ready` của account không cần envelope HMAC và tự probe
  // db-account của nó, nên một 2xx ở đây chứng minh chuỗi
  // auth → ACCOUNT_SERVICE → account → db-account sống.
  //
  // ⚠️ "Reachable" nghĩa là CÓ RESPONSE — status nào cũng tính: account đỏ
  // (503 vì db-account chết) vẫn là account SỐNG và trả lời đúng hợp đồng; readiness
  // chi tiết của account là việc của account, không phải probe này đếm hộ. Chỉ
  // "không trả lời được" (throw: binding chết, timeout) là fail-closed.
  try {
    await env.ACCOUNT_SERVICE.fetch(new Request('https://account-service.internal/ready'), {
      signal: AbortSignal.timeout(READY_ACCOUNT_PROBE_TIMEOUT_MS),
    });
  } catch {
    // oxlint-disable-next-line no-console
    console.log(
      JSON.stringify({ event: 'ready.failed', status: 503, reason: 'account_unreachable' }),
    );
    return c.json({ error: 'service_unavailable' }, 503, {
      'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }

  // oxlint-disable-next-line no-console
  console.log(JSON.stringify({ event: 'ready.ok', status: 200 }));
  return c.json({ service: 'auth', status: 'ready' });
});

/**
 * Pool dùng cho **một** lần kiểm readiness — không giữ state module-scope
 * (`runtime:edge` cấm node-local state), không giữ pool qua request.
 *
 * Truy vấn rẻ nhất vẫn phải chạm DB: probe chỉ cần chứng minh schema tồn tại và
 * đọc được bằng credential runtime. `auth.oauth_clients` chọn vì: `SELECT
 * client_id` đọc một cột nhỏ của bảng cấu hình, không chạm dòng dữ liệu người
 * dùng, và bảng nằm trong `0001` — bảng đầu tiên của schema, nên một database
 * chưa migrate đủ **phải** làm probe thất bại (database nửa schema không phải
 * "sẵn sàng"). Giá trị kết nối ngắn để một origin không kết nối được hoá thành
 * lỗi nhanh ⇒ `db_unreachable`, thay vì giữ request tới hết thời hạn Worker.
 *
 * ⚠️ Probe **qua credential runtime** — cùng pool shape mà mọi đường serving
 * dùng (`max: 3`, `prepare: false` từ `createPostgresClient`), nên readiness
 * kiểm không chỉ "DB sống" mà "DB sống với đúng credential mà serving path
 * dùng".
 */
async function probeDatabase(hyperdrive: { connectionString: string }): Promise<void> {
  const client = createPostgresClient(hyperdrive, {
    connectTimeoutSeconds: READY_PROBE_CONNECT_TIMEOUT_SECONDS,
  });
  try {
    await client.unsafe('SELECT client_id FROM auth.oauth_clients LIMIT 1');
  } finally {
    await client.end({ timeout: 1 });
  }
}

/**
 * Route PUBLIC của bước authorization — cửa ngõ DUY NHẤT mà client được gọi.
 *
 * ⚠️ Đây là route của GLUE (Hono), KHÔNG phải route của provider. Provider có
 * route authorization riêng (`PROVIDER_ROUTES.authorizationRoute` = `/auth`) —
 * route nội bộ mà `handleAuthorize` 302 tới sau khi đã mint transaction + browser
 * binding. `/auth` không tạo transaction, nên một client gọi thẳng nó sẽ không
 * bao giờ có được cái glue tạo ra.
 *
 * ⚠️ Discovery quảng bá `/authorize` (route này), KHÔNG phải `/auth` — xem
 * {@link discoveryDocument} và issue #122.
 */
const PUBLIC_AUTHORIZATION_ROUTE = '/authorize';

/**
 * Discovery — SHADOW cả hai well-known của OIDC Core §4 và OAuth 2.0 AF §5.
 *
 * ⚠️ Dựng từ `PROVIDER_ROUTES` + `config.issuer`, KHÔNG hardcode path: provider
 * là nguồn sự thật của chính routes nó mount, và ghi lại chúng hai nơi là hai
 * chỗ để lệch. Cùng lý do, `jwks_uri` trỏ `/jwks.json` của provider — bản
 * hand-rolled JWKS đã bỏ, một JWKS duy nhất từ chính bộ máy cấp token.
 *
 * ⚠️ Một ngoại lệ CÓ CHỦ Ý: `authorization_endpoint` trỏ `/authorize` (glue),
 * không phải `/auth` (provider). Đây là divergent duy nhất so với document mà
 * chính provider render — và nó là divergent SỰ ĐÚNG: client đọc metadata rồi
 * gọi đúng endpoint được quảng bá thì luồng phải chạy được, còn gọi `/auth`
 * (route provider) thì không có transaction ⇒ không hoàn tất được.
 *
 * ⚠️ "Trung thực" nghĩa là: chỉ quảng bá endpoint provider thực sự mount.
 * `revocation_endpoint` được mount (RFC 7009 bật) và `end_session_endpoint`
 * được mount (RP-initiated logout bật) ⇒ cả hai được khai; `introspection`
 * và `userinfo` tắt ⇒ không xuất hiện trong document này. Client đọc sai một
 * endpoint không có là đi vào 404 — và NGƯỢC LẠI cũng sai: quảng bá thiếu một
 * endpoint đang sống là giấu năng lực logout mà provider thật có.
 *
 * ⚠️ Chính provider cũng serve một discovery riêng ở cùng đường (initialize
 * mounts `/.well-known/*` vô điều kiện) — nhưng nó KHÔNG qua adapter TÙY CHỈNH
 * đúng nghĩa khi clients của nó nạp động, và mọi giá trị (scopes_supported,
 * claims_supported) phải khớp cấu hình ECOMA. Shadow của Hono trả TRƯỚC bridge
 * (route Hono khớp trước khi rơi xuống provider), và trả cùng hình dạng —
 * nhưng có kiểm.
 */
function discoveryDocument(config: AuthConfig): Record<string, unknown> {
  const issuer = config.issuer;
  return {
    issuer,
    // Entrypoint PUBLIC — xem `PUBLIC_AUTHORIZATION_ROUTE` ở trên.
    authorization_endpoint: `${issuer}${PUBLIC_AUTHORIZATION_ROUTE}`,
    token_endpoint: `${issuer}${PROVIDER_ROUTES.tokenRoute}`,
    revocation_endpoint: `${issuer}${PROVIDER_ROUTES.revocation}`,
    jwks_uri: `${issuer}${PROVIDER_ROUTES.jwks}`,
    // RP-initiated logout ĐÃ bật trong provider (`features.rpInitiatedLogout`,
    // provider.ts) và route được bridge chuyển tiếp (app.all dưới đây) —
    // discovery provider thật cũng khai (`discovery.js` chỉ render key này khi
    // feature bật). Bỏ khai trong khi endpoint sống là quanh client
    // RP-initiated logout không biết có nó; khai mà không bảo sống là hướng
    // client vào 404.
    end_session_endpoint: `${issuer}${PROVIDER_ROUTES.end_session}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    scopes_supported: ['openid', 'offline_access', 'profile'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    // Khớp `CLAIMS` của provider (`oidc/provider.ts`): `openid` ⇒ `sub`, `acr`,
    // `auth_time`. Provider tự gộp thêm `sid`/`iss` vào `claimsSupported` do
    // default của nó, nhưng `sid` không bao giờ được phát trong ID token của
    // `auth` (không backchannel logout, claims param tắt) và `iss` là claim
    // payload của JWT, không phải claim theo scope. Quảng bá chúng là quảng bá
    // contract mà implementation không cung cấp.
    claims_supported: ['sub', 'acr', 'auth_time'],
    // Các field dưới đây provider thật render (discovery.js) với cấu hình hiện
    // hành — shadow phải khớp để client không lệch. `claims_parameter` tắt ⇒
    // `false`; `iss` được provider gắn vào authorization response (respond.js);
    // `request_uri` không được hỗ trợ; `claim_types` mặc định `normal`.
    claims_parameter_supported: false,
    authorization_response_iss_parameter_supported: true,
    request_uri_parameter_supported: false,
    claim_types_supported: ['normal'],
    // ⚠️ CHỈ `query`: glue chép tham số authorize sang provider qua allowlist
    // `AUTHORIZED_FORWARD_PARAMS` (`browser-handlers.ts`) — `response_mode` KHÔNG
    // có trong đó, nên provider luôn thấy mặc định của mình: `query` cho
    // `response_type=code` (`resolve_response_mode.js`). Provider đăng ký cả
    // `form_post`/`fragment` (discovery.js render đúng ba giá trị đó), nhưng
    // quảng bá chúng ở đây là hứa một contract mà entrypoint public không
    // chuyển tiếp được — client sẽ xin `form_post` và nhận `query`.
    response_modes_supported: ['query'],
  };
}

app.get('/.well-known/openid-configuration', async (c) => {
  const config = await getConfig(c.env as AuthEnv);
  return c.json(discoveryDocument(config));
});

// RFC 8414 metadata — cùng một document, provider mount cả hai well-known
// (initialize_app.js), nên shadow phải shadow cả hai.
app.get('/.well-known/oauth-authorization-server', async (c) => {
  const config = await getConfig(c.env as AuthEnv);
  return c.json(discoveryDocument(config));
});

/**
 * `GET /authorize` — bước 1 của §5.1.2: mint transaction + cookie browser +
 * 302 vào route authorization của provider (`/auth`).
 *
 * Lỗi nghiệp vụ đã được `handleAuthorize` dịch xong thành JSON/redirect;
 * lỗi hạ tầng (DB chết) VẪN NÉM ra ngoài — Worker runtime trả 500, cùng cách
 * mọi dependency chết được xử lý, và log của platform giữ stack.
 */
app.get('/authorize', async (c) => {
  const config = await getConfig(c.env as AuthEnv);
  // Client postgres sống đúng request này (issue #289) — `withPostgresClient`
  // `end()` trong `finally`, kể cả khi handler ném. Cùng hình dạng lifecycle với
  // `probeDatabase` ở trên.
  return await withPostgresClient({ hyperdrive: config.hyperdrive }, async (client) => {
    return await handleAuthorize({
      config,
      store: createAuthorizationStore({ client }),
      query: c.req.query(),
      cookieHeader: c.req.header('cookie'),
      now: new Date(),
    });
  });
});

/**
 * `GET /authorize/confirm?handle=X` — bước 2 của §5.1.2: đối chiếu cookie
 * browser binding rồi CAS `pending_browser → browser_confirmed`, rồi 302 về
 * login-continue của `account`.
 */
app.get('/authorize/confirm', async (c) => {
  const config = await getConfig(c.env as AuthEnv);
  return await withPostgresClient({ hyperdrive: config.hyperdrive }, async (client) => {
    return await handleAuthorizeConfirm({
      store: createAuthorizationStore({ client }),
      query: c.req.query(),
      cookieHeader: c.req.header('cookie'),
      accountBaseUrl: config.accountBaseUrl,
      now: new Date(),
    });
  });
});

/**
 * Đọc body theo stream với hạn mức tích lũy — KHÔNG dùng `arrayBuffer()`.
 *
 * `arrayBuffer()` nạp hết payload vào heap rồi mới so `byteLength`, nên request
 * chunked (không khai `Content-Length`) vẫn chiếm toàn bộ bộ nhớ trước khi bị
 * từ chối. Heap isolate của Workers ~128 MB, vài request song song là đủ OOM
 * isolate và làm chết mọi endpoint (kể cả `/health`). Đọc từng chunk rồi dừng
 * giữa chừng khi vượt hạn mức là chốt chặn thật cho cả hai dạng framing.
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

/** Route nội bộ — dùng cho cả đăng ký route lẫn dòng log từ chối. */
const INTERNAL_VERIFIED_ROUTE = '/internal/session/verified';
const INTERNAL_CONSENT_CONTEXT_ROUTE = '/internal/consent/context';
const INTERNAL_CONSENT_DECIDE_ROUTE = '/internal/consent/decide';
const INTERNAL_CONNECTED_APPLICATIONS_ROUTE = '/internal/connected-applications';
const INTERNAL_CONNECTED_APPLICATION_REVOKE_ROUTE = '/internal/connected-applications/revoke';

/**
 * Ghi MỘT dòng log cho một lần từ chối internal.
 *
 * Hợp đồng log: chỉ `reason` cùng `event`, `route`, `method`, `status` —
 * **không** giá trị header, **không** message của driver, **không** byte nào
 * từ request. Logger này là chỗ duy nhất thực hiện hợp đồng đó.
 *
 * ⚠️ `no-console` của `.oxlintrc.json` bị tắt ở đúng một dòng dưới đây: Workers
 * không có sink nào khác, log chỉ đi qua `console.*`.
 *
 * ⚠️ **Nuốt mọi lỗi** (NFR-004): observability không được nằm trên serving path,
 * nên một lần ghi log thất bại không được làm request đổi trạng thái.
 */
function logInternalRejection(
  route: string,
  reason: VerifyFailureReason | 'db_unreachable',
  status: 401 | 503,
): void {
  try {
    // oxlint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'internal_auth.rejected',
        route,
        method: 'POST',
        status,
        reason,
      }),
    );
  } catch {
    // Cố tình im lặng — xem JSDoc ở trên.
  }
}

/**
 * Middleware chung cho cả ba route nội bộ: 413 → streaming read → envelope
 * HMAC verify trên RAW bytes → 503/401 phân loại.
 *
 * Trả `{ ok: true, raw, config }` khi envelope hợp lệ — handler nghiệp vụ tiếp
 * tục với body ĐÃ xác thực; trả `Response` khi từ chối.
 *
 * ⚠️ **`raw` đi thẳng vào verify — KHÔNG decode** (chi tiết đầy đủ ở lịch sử
 * file): decode non-fatal biến hai payload byte khác nhau thành cùng chuỗi ⇒
 * cùng bodyHash ⇒ chữ ký nói "tôi đã thấy chuỗi này" trong khi thứ được xác
 * thực là một ảnh chiếu mất thông tin. Không decode, không parse: một body JSON
 * dị dạng bị từ chối vì **chữ ký không khớp**, không vì parse lỗi.
 */
async function verifyInternalEnvelope(
  c: {
    readonly env: unknown;
    readonly req: {
      readonly raw: Request;
      readonly header: (name: string) => string | undefined;
    };
    json: (body: unknown, status: number, headers?: Record<string, string>) => Response;
  },
  route: string,
): Promise<
  | { readonly ok: true; readonly raw: Uint8Array; readonly config: AuthConfig }
  | { readonly ok: false; readonly errorResponse: Response }
> {
  const config = await getConfig(c.env as AuthEnv);

  // Từ chối NGAY khi `Content-Length` đã nói quá lớn — không cần đọc một byte
  // nào. Bước kiểm kích thước thật bên dưới vẫn là chốt chặn (chunked).
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > INTERNAL_BODY_LIMIT_BYTES) {
    return { ok: false, errorResponse: c.json({ error: 'payload_too_large' }, 413) };
  }

  const raw =
    c.req.raw.body === null
      ? new Uint8Array()
      : await readBodyLimited(c.req.raw.body, INTERNAL_BODY_LIMIT_BYTES);
  if (raw === null) {
    return { ok: false, errorResponse: c.json({ error: 'payload_too_large' }, 413) };
  }

  const auth = await isAuthenticatedInternalRequest({
    secret: config.internalSecret,
    secretByKid: resolveInternalSecret(config),
    request: c.req.raw,
    body: raw,
    nowMs: Date.now(),
    hyperdrive: config.hyperdrive,
    skewSeconds: config.internalAuthSkewSeconds,
  });

  if (!auth.ok) {
    // ⚠️ 401 + `WWW-Authenticate`, không nêu lý do cụ thể: nêu "signature_mismatch"
    // là biến response thành oracle dò chữ ký.
    //
    // ⚠️ `db_unreachable` là 503, không phải 401: khi DB chết ta KHÔNG THỂ khẳng
    // định nonce chưa từng thấy — fail-closed.
    if (auth.reason === 'db_unreachable') {
      logInternalRejection(route, auth.reason, 503);
      return {
        ok: false,
        errorResponse: c.json({ error: 'service_unavailable' }, 503, {
          'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
        }),
      };
    }
    logInternalRejection(route, auth.reason, 401);
    return {
      ok: false,
      errorResponse: c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'HMAC realm="ecoma-internal"',
      }),
    };
  }

  return { ok: true, raw, config };
}

/**
 * `POST /internal/session/verified` — `account` báo identity đã xác minh.
 *
 * Sau envelope: `runSessionVerified` chạy toàn bộ bước 10-11 của §5.1.2 (CAS
 * consume X + bind → fail-closed account status → consent/grant branch →
 * continue_url). Lỗi hạ tầng NÉM qua handler và được phân loại dưới đây.
 */
app.post(INTERNAL_VERIFIED_ROUTE, async (c) => {
  const verified = await verifyInternalEnvelope(c, INTERNAL_VERIFIED_ROUTE);
  if (!verified.ok) {
    return verified.errorResponse;
  }
  const { raw, config } = verified;

  try {
    const runtime = await getRuntime(c.env as AuthEnv);
    const account = new AccountClient({
      binding: (c.env as AuthEnv).ACCOUNT_SERVICE as {
        fetch: (request: Request) => Promise<Response>;
      },
      secret: config.internalSecret,
      kid: config.internalKid,
    });
    // Client postgres sống đúng request này (issue #289). Toàn bộ đường nghiệp vụ
    // — kể cả các câu gọi HTTP tới account ở giữa — nằm trong phạm vi MỘT client:
    // khối chỉ kết thúc khi handler trả, nên client không sống qua ranh giới
    // request nào. `withPostgresClient` `end()` trong `finally`.
    const result = await withPostgresClient({ hyperdrive: config.hyperdrive }, async (client) => {
      return await runSessionVerified({
        provider: runtime.provider,
        postgresClient: client,
        store: createAuthorizationStore({ client }),
        handleKey: config.handleKey,
        accountBaseUrl: config.accountBaseUrl,
        now: new Date(),
        checkStatus: (accountId) => account.checkStatus({ accountId, nowMs: Date.now() }),
        rawBody: raw,
      });
    });
    return c.json(result.body, result.status);
  } catch (error) {
    if (isInfrastructureError(error)) {
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
});

/**
 * `POST /internal/consent/context` — đọc-only context cho consent UI của
 * account (hàng 6 của §5.1.2).
 */
app.post(INTERNAL_CONSENT_CONTEXT_ROUTE, async (c) => {
  const verified = await verifyInternalEnvelope(c, INTERNAL_CONSENT_CONTEXT_ROUTE);
  if (!verified.ok) {
    return verified.errorResponse;
  }

  try {
    // Body ĐÃ verify chữ ký — parse ở đây, một lần.
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(verified.raw)) as unknown;
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    // Client postgres sống đúng request này (issue #289) — xem `/authorize`.
    const result = await withPostgresClient(
      { hyperdrive: verified.config.hyperdrive },
      async (client) => {
        return await runConsentContext({
          postgresClient: client,
          payload,
          now: new Date(),
        });
      },
    );
    return c.json(result.body, result.status);
  } catch (error) {
    if (isInfrastructureError(error)) {
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
});

/**
 * `POST /internal/consent/decide` — quyết định consent (hàng 7/8 của §5.1.2):
 * advance + consume Y + decision trong MỘT transaction db-auth, rồi result
 * gắn vào Interaction của provider.
 */
app.post(INTERNAL_CONSENT_DECIDE_ROUTE, async (c) => {
  const verified = await verifyInternalEnvelope(c, INTERNAL_CONSENT_DECIDE_ROUTE);
  if (!verified.ok) {
    return verified.errorResponse;
  }

  try {
    const runtime = await getRuntime(c.env as AuthEnv);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(verified.raw)) as unknown;
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    // Client postgres sống đúng request này (issue #289). Khối transaction
    // `client.begin(...)` của decide nằm TRONG phạm vi client này — một
    // transaction = một client (xem JSDoc `withPostgresClient`).
    const result = await withPostgresClient(
      { hyperdrive: verified.config.hyperdrive },
      async (client) => {
        return await runConsentDecide({
          provider: runtime.provider,
          postgresClient: client,
          payload,
          handleKey: verified.config.handleKey,
          now: new Date(),
        });
      },
    );
    return c.json(result.body, result.status);
  } catch (error) {
    if (isInfrastructureError(error)) {
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
});

/**
 * `POST /internal/connected-applications` — danh sách grant hiện hành của
 * một subject (FR-009 Connected applications, hướng `account → auth`).
 */
app.post(INTERNAL_CONNECTED_APPLICATIONS_ROUTE, async (c) => {
  const verified = await verifyInternalEnvelope(c, INTERNAL_CONNECTED_APPLICATIONS_ROUTE);
  if (!verified.ok) {
    return verified.errorResponse;
  }

  try {
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(verified.raw)) as unknown;
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    // Client postgres sống đúng request này (issue #289) — xem `/authorize`.
    const result = await withPostgresClient(
      { hyperdrive: verified.config.hyperdrive },
      async (client) => {
        return await runConnectedApplicationsList({
          postgresClient: client,
          payload,
        });
      },
    );
    return c.json(result.body, result.status);
  } catch (error) {
    if (isInfrastructureError(error)) {
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
});

/**
 * `POST /internal/connected-applications/revoke` — thu hồi một grant: CAS +
 * control plane + audit trong MỘT transaction db-auth.
 */
app.post(INTERNAL_CONNECTED_APPLICATION_REVOKE_ROUTE, async (c) => {
  const verified = await verifyInternalEnvelope(c, INTERNAL_CONNECTED_APPLICATION_REVOKE_ROUTE);
  if (!verified.ok) {
    return verified.errorResponse;
  }

  try {
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(verified.raw)) as unknown;
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    // Client postgres sống đúng request này (issue #289). Khối transaction
    // `client.begin(...)` của revoke nằm TRONG phạm vi client này.
    const result = await withPostgresClient(
      { hyperdrive: verified.config.hyperdrive },
      async (client) => {
        return await runConnectedApplicationRevoke({
          postgresClient: client,
          payload,
          now: new Date(),
        });
      },
    );
    return c.json(result.body, result.status);
  } catch (error) {
    if (isInfrastructureError(error)) {
      return c.json({ error: 'service_unavailable' }, 503, {
        'Retry-After': INTERNAL_DB_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    }
    throw error;
  }
});

/**
 * Mọi route còn lại trong `PROVIDER_ROUTES` (bao gồm `/auth/:uid` resume —
 * prefix `/auth` khớp cả hai) rơi xuống bridge Node của provider.
 *
 * ⚠️ Route Hono KHÔNG khớp ở đây (đã đăng ký ở trên) thì không bao giờ tới
 * bridge — tức bridge chỉ thấy đúng những route provider sở hữu.
 */
app.all(`${PROVIDER_ROUTES.authorizationRoute}/*`, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});
app.all(PROVIDER_ROUTES.authorizationRoute, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});
app.all(PROVIDER_ROUTES.tokenRoute, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});
app.all(PROVIDER_ROUTES.jwks, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});
app.all(PROVIDER_ROUTES.revocation, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});
app.all(PROVIDER_ROUTES.end_session, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});
// ⚠️ `rpInitiatedLogout` bật là provider mount BA route (`initialize_app.js`):
// `GET /session/end` (init), `POST /session/end/confirm` (confirm form_post) và
// `GET /session/end/success` (trang kết). Hono KHÔNG tự match subpath của một
// route tĩnh — thiếu pattern `/*` là confirm POST và success GET 404, tức
// RP-initiated logout render form nhưng KHÔNG BAO GIỜ hoàn tất được. Đã có bài
// học `/auth` + `/auth/*` ở trên; `/session/end` chỉ có bản bare là sót lại.
app.all(`${PROVIDER_ROUTES.end_session}/*`, async (c) => {
  const runtime = await getRuntime(c.env as AuthEnv);
  return await dispatchToNode(runtime, c.req.raw, c.env as AuthEnv, c.executionCtx);
});

export default app;
