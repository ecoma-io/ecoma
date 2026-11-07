/**
 * Smoke HTTPS cho luồng local deployment — Node thuần, không dependency ngoài.
 *
 * Việc cần làm: xác minh chuỗi redirect THẬT của home qua Traefik, không chỉ
 * "server còn sống": (1) TLS bắt tay THÀNH CÔNG với certificate local của repo
 * (không tắt verification — smoke mà bỏ kiểm TLS là smoke nói dối), (2) `GET /`
 * với header `Accept: text/html` trả đúng 302 với `location: /en`, (3) `GET
 * /en` trả 2xx HTML chứa `<title>Ecoma.io`. Không gửi `Accept: text/html` thì
 * app trả 404 cho `/` (middleware prerendered content từ chối negotiator
 * không-HTML) — thiếu header là smoke đo chẳng thấy gì.
 *
 * Certificate trust ở đây là TƯỜNG MINH và scoped: `ca` của riêng agent HTTPS
 * này trỏ vào `deploys/platform-deploy/local-certs/fbi.com.crt` — chỉ request
 * của smoke test này tin certificate đó, không đụng trust store toàn cục của
 * hệ điều hành, không biến môi trường NODE_TLS_REJECT_UNAUTHORIZED nào bị đặt.
 *
 * Retry CHỈ dành cho chữ ký "chưa sẵn sàng": ngay sau `pulumi up`, container
 * home (`startPeriod: 30s`) và router Traefik cần thời gian lên — connection
 * refused, connection reset trước khi có response, request timeout và
 * 502/503/504 được thử lại với backoff trong budget. Mọi thứ khác — lỗi
 * TLS/certificate, 4xx, 500, 3xx bất ngờ, sai location, thiếu title — fail tức
 * thời: retry những lỗi đó chỉ che bug thật.
 *
 * Hợp đồng output: `smoke OK` CHỈ được in ngay sau khi `verifyChain()` thành
 * công (ngay trong khối try); mọi đường fail in `smoke FAILED` ra stderr với
 * exit code != 0 và KHÔNG in `smoke OK`. Log vừa báo FAILED vừa báo OK là log
 * nói dối đúng lúc người đọc cần tin nhất.
 *
 * Cách chạy: `node system-tests/local-smoke/src/local-smoke.mjs fbi.com:<port>` — input là giá
 * trị ROOT_HOST đã sinh từ Pulumi outputs, không phải port đoán trước. Cờ tùy
 * chọn: `--connect <host:port>` dial địa chỉ đó thay vì resolve DNS của
 * hostname (hook cho test — SNI/`Host` vẫn dùng hostname của positional),
 * `--budget-ms <n>` tổng budget retry (mặc định 90000), `--request-timeout-ms
 * <n>` timeout mỗi request (mặc định 10000).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import https from 'node:https';

const BUDGET_MS_DEFAULT = 90_000;
const REQUEST_TIMEOUT_MS_DEFAULT = 10_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

// Chuỗi header bắt buộc của bước 1: app chỉ 302 `/` khi negotiator nhận HTML.
const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const REDIRECT_PATH = '/en';
// Đánh dấu ổn định của trang /en — đủ để khẳng định đúng trang home mà không
// khoá smoke vào toàn bộ nội dung document.
const TITLE_MARKER = '<title>Ecoma.io';

// 502/503/504 là "chưa sẵn sàng" (Traefik chưa thấy router/upstream); 500 là
// lỗi SSR thật — fail tức thời.
//
// 404 cũng là "chưa sẵn sàng" ở một cửa sổ hẹp: khi home container bị RECREATE
// (image đổi), có khoảng giữa lúc router cũ bị gỡ và router mới đăng ký với
// Traefik — request đi vào lúc đó không còn router nào khớp `Host(...)` và
// Traefik trả 404. Trạng thái này tự hết trong ít giây. 404 "app trả thật"
// (không retry) là kịch bản middleware chả về 404 khi thiếu `Accept: text/html`
// — smoke luôn gửi header đó, nên 404 giữa chừng gần như chắc chắn là cửa sổ
// registration; kẹt 404 vĩnh viễn vẫn fail đúng khi hết budget.
const RETRYABLE_STATUSES = new Set([404, 502, 503, 504]);
// Lỗi transport "chưa sẵn sàng". CỐ ĐỊNH không thêm chữ ký khác (ví dụ
// ENOTFOUND): ngoài danh sách này là fail-closed, không đoán thêm.
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
// Lỗi TLS/certificate: xác minh bị vi phạm — không bao giờ retry, không nuốt.
const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_INVALID_CERTIFICATE',
]);

/** Lỗi retry-được: có khả năng tự hết khi cold start kết thúc. */
class RetryableError extends Error {}
/** Lỗi chốt: routing/app/TLS thực sự sai — retry chỉ che lỗi. */
class VerificationFailure extends Error {}

const USAGE =
  'Usage: node system-tests/local-smoke/src/local-smoke.mjs <rootHost> [--connect <host:port>] [--budget-ms <n>] [--request-timeout-ms <n>]   # vd: fbi.com:32768';

function usageError(message) {
  console.error(message);
  process.exit(2);
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    usageError(`${flag} must be a positive integer: ${value}`);
  }
  return parsed;
}

// Định dạng đã chốt: `fbi.com:<port>` — hostname KHÔNG chứa port, router
// Traefik match `Host: fbi.com`; port chỉ thuộc URL phía client.
function parseHostPort(value, label) {
  const separator = value.lastIndexOf(':');
  if (separator === -1 || separator === 0) {
    usageError(`${label} must be in <hostname>:<port> form: ${value}`);
  }
  const hostname = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    usageError(`invalid port in ${label}: ${value}`);
  }
  return { hostname, port };
}

// ---- Phân tích CLI: positional đầu là rootHost, các cờ nhận giá trị kế tiếp
// hoặc dạng `--flag=<value>`; positional thứ hai trở đi là lỗi usage. ----
const args = process.argv.slice(2);
let rootHostArg;
let connectArg;
let budgetMs = BUDGET_MS_DEFAULT;
let requestTimeoutMs = REQUEST_TIMEOUT_MS_DEFAULT;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const eq = arg.indexOf('=');
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
  const takeValue = () => {
    if (inlineValue !== undefined) return inlineValue;
    if (i + 1 >= args.length) usageError(`${flag} requires a value`);
    i += 1;
    return args[i];
  };
  switch (flag) {
    case '--connect':
      connectArg = takeValue();
      break;
    case '--budget-ms':
      budgetMs = parsePositiveInt(takeValue(), flag);
      break;
    case '--request-timeout-ms':
      requestTimeoutMs = parsePositiveInt(takeValue(), flag);
      break;
    default:
      if (flag.startsWith('--')) usageError(`unsupported flag: ${flag}`);
      if (rootHostArg !== undefined) usageError(`unexpected argument: ${flag}`);
      rootHostArg = flag;
  }
}

if (rootHostArg === undefined || rootHostArg.length === 0) {
  usageError(USAGE);
}

const { hostname, port } = parseHostPort(rootHostArg, 'rootHost');
const connect = connectArg === undefined ? undefined : parseHostPort(connectArg, '--connect');

// `import.meta.url` là …/system-tests/local-smoke/src/local-smoke.mjs — ba
// mức `../` về repo root, rồi vào deploys/platform-deploy. Thiếu một mức là
// path sai và smoke fail với ENOENT trước khi kịp thử HTTPS nào.
const certPath = join(
  fileURLToPath(
    new URL('../../../deploys/platform-deploy/local-certs/fbi.com.crt', import.meta.url),
  ),
);
const ca = readFileSync(certPath, 'utf8');

function classifyRequestError(error, pathname) {
  const code = error?.code;
  if (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || TLS_ERROR_CODES.has(code))
  ) {
    return new VerificationFailure(`GET ${pathname}: invalid TLS/certificate — ${error.message}`);
  }
  // AbortSignal.timeout hủy request: Node báo AbortError/ABORT_ERR với cause
  // TimeoutError — đây là request timeout của ta, không phải lỗi server.
  if (error.name === 'TimeoutError' || error.code === 'ABORT_ERR' || error.name === 'AbortError') {
    return new RetryableError(
      `GET ${pathname}: timeout ${requestTimeoutMs}ms — server did not respond`,
    );
  }
  if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
    return new RetryableError(`GET ${pathname}: ${code} — server not listening/not ready yet`);
  }
  // Mọi lỗi ngoài danh sách retry là fail-closed — không đoán thêm chữ ký nào.
  return new VerificationFailure(`GET ${pathname}: ${error.message}`);
}

function requestStep(pathname) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        // `--connect`: dial địa chỉ fixture thay vì DNS, còn hostname thật vẫn
        // đi qua SNI (`servername` — cũng là tên Node dùng để kiểm certificate)
        // và header `Host` — đúng những gì Traefik và certificate check nhìn.
        host: connect?.hostname ?? hostname,
        port: connect?.port ?? port,
        path: pathname,
        ca,
        servername: hostname,
        headers: {
          // `Host` ĐẶT TƯỜNG MINH ở CẢ HAI nhánh và cùng một dạng
          // `hostname:port` — khớp đúng `ROOT_HOST` mà entry up của platform ghi `.env`
          // và đúng rule `Host(\`fbi.com\`)` của Traefik. Nhánh không `--connect`
          // để Node tự sinh thì Host cũng là `hostname:port`, nhưng ghi tường
          // minh giữ đường test (fixture) và đường thật giống hệt nhau — spec
          // chỉ chạy qua `--connect`, thiếu dòng này là test không chạm dạng
          // header production gửi.
          Host: `${hostname}:${port}`,
          // Header bắt buộc: app chỉ 302 `/` khi negotiator nhận HTML.
          Accept: ACCEPT_HTML,
          'Accept-Language': ACCEPT_LANGUAGE,
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
      (response) => {
        const chunks = [];
        // INVARIANT: TLS phải được VERIFY THẬT SỰ, không chỉ "request thành
        // công". Khẳng định trực tiếp trạng thái verify của socket — nếu sau
        // này ai thêm `rejectUnauthorized: false` để "cho smoke chạy được" thì
        // smoke phải ĐỎ ở đây ngay, chứ không im lặng bỏ qua đúng thứ nó sinh
        // ra để kiểm.
        if (response.socket?.authorized !== true) {
          reject(
            new VerificationFailure(
              `GET ${pathname}: TLS not verified — ${
                response.socket?.authorizationError ?? 'socket has no verify status'
              }`,
            ),
          );
          return;
        }
        response.on('data', (chunk) => chunks.push(chunk));
        // Lỗi giữa chừng body (socket bị reset, upstream đóng, hoặc chính
        // AbortSignal hủy sau khi response bắt đầu) phát ra trên response
        // stream — IncomingMessage là EventEmitter, không có listener 'error'
        // thì Node ném uncaught exception và giết tiến trình thay vì đi qua
        // bộ phân loại ở trên.
        response.on('error', (error) => reject(classifyRequestError(error, pathname)));
        response.on('aborted', () => {
          request.destroy();
          reject(
            new RetryableError(
              `GET ${pathname}: response interrupted midway — server not stable yet`,
            ),
          );
        });
        response.on('end', () => {
          const result = {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          };
          if (RETRYABLE_STATUSES.has(result.status)) {
            reject(
              new RetryableError(
                `GET ${pathname}: status ${result.status} — upstream not ready yet`,
              ),
            );
          } else {
            resolve(result);
          }
        });
      },
    );
    request.on('error', (error) => reject(classifyRequestError(error, pathname)));
  });
}

async function verifyChain() {
  // Bước 1 — `/` phải 302 → `/en` đúng literal. Đây kiểm routing và hành vi
  // app cùng lúc: sai status hoặc sai location (vd `/fr`, absolute khác /en)
  // đều là broken và không được nuốt.
  const root = await requestStep('/');
  if (root.status !== 302) {
    throw new VerificationFailure(`GET /: expected status 302, got ${root.status}`);
  }
  if (root.headers.location !== REDIRECT_PATH) {
    throw new VerificationFailure(
      `GET /: expected location '${REDIRECT_PATH}', got ${JSON.stringify(root.headers.location)}`,
    );
  }

  // Bước 2 — `/en` phải là HTML thật, đánh dấu bằng title ổn định của home.
  const en = await requestStep(REDIRECT_PATH);
  if (!(en.status >= 200 && en.status < 300)) {
    throw new VerificationFailure(`GET ${REDIRECT_PATH}: expected 2xx, got ${en.status}`);
  }
  const contentType = en.headers['content-type'] ?? '';
  if (!contentType.includes('text/html')) {
    throw new VerificationFailure(
      `GET ${REDIRECT_PATH}: expected content-type text/html, got '${contentType}'`,
    );
  }
  if (!en.body.includes(TITLE_MARKER)) {
    throw new VerificationFailure(`GET ${REDIRECT_PATH}: body missing '${TITLE_MARKER}'`);
  }
}

const startedAt = Date.now();
let backoffMs = BACKOFF_INITIAL_MS;
// Luôn chạy ít nhất một lần; các lần sau chỉ khi lỗi retry-được và còn budget.
for (;;) {
  let failure;
  try {
    await verifyChain();
    // In NGAY SAU khi chain xanh và trước khi thoát loop — không có đường nào
    // đi qua `smoke FAILED` rồi vẫn kịp in `smoke OK` (exit code != 0 nhưng
    // stdout vẫn khen là bug từng khiến log mâu thuẫn với nhau).
    console.log(
      `smoke OK: 302 → 200 after ${Date.now() - startedAt}ms — TLS valid with the local certificate`,
    );
    break;
  } catch (error) {
    if (!(error instanceof RetryableError)) {
      console.error(`smoke FAILED after ${Date.now() - startedAt}ms: ${error.message}`);
      // `exitCode` + break thay vì `process.exit()`: stderr nối pipe là BẤT
      // ĐỒNG BỘ trên một số nền tảng — `process.exit` ngay sau `console.error`
      // có thể cắt mất chính dòng `smoke FAILED` là lý do duy nhất để chẩn
      // đoán. Đặt exitCode rồi để event loop tự tắt thì message luôn được ghi.
      process.exitCode = 1;
      break;
    }
    failure = error;
  }
  const remainingMs = budgetMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    console.error(
      `smoke FAILED after ${Date.now() - startedAt}ms (budget exhausted ${budgetMs}ms): ${failure.message}`,
    );
    process.exitCode = 1;
    break;
  }
  // Ngủ KHÔNG vượt phần budget còn lại: một lượt verifyChain (2 request tuần
  // tự) có thể đã ăn gần hết budget — backoff đầy đủ lúc đó sẽ vượt deadline
  // đã tuyên bố với caller.
  const sleepMs = Math.min(backoffMs, remainingMs);
  console.error(
    `smoke RETRY after ${Date.now() - startedAt}ms: ${failure.message} — retrying in ${sleepMs}ms`,
  );
  await new Promise((resolve) => {
    setTimeout(resolve, sleepMs);
  });
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
}
