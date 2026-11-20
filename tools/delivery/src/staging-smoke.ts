/**
 * Smoke HTTP staging tái dụng cho lane Continuous Staging (issue #353; hợp
 * đồng `02-delivery.md` §7.4 "Smoke test HTTP thật sau deploy", §7.5 mục 9).
 *
 * Pattern mirror của `system-tests/local-smoke/src/local-smoke.mjs` — cùng
 * phân lớp lỗi và cùng hợp đồng output — nhưng chạy bằng `fetch` với
 * `redirect: 'manual'` và TLS công khai của staging (không CA local):
 *
 * - Kiểm khai theo KHẢ NĂNG của app qua cờ CLI, không áp dụng thì bị bỏ qua
 *   chứ không thành pass giả; mỗi kiểm là một assertion tường minh (§7.5
 *   mục 9: bỏ assertion theo khả năng app, không bỏ vì app đang hỏng):
 *   - `--redirect <from>=<to>`: GET `<origin><from>` phải trả ĐÚNG 302 với
 *     `location` bằng đúng `<to>` (home: `/` → `/en`).
 *   - `--health <path>`: GET phải 2xx — liveness của unit.
 *   - `--noindex <path>`: GET phải 2xx kèm header `X-Robots-Tag: noindex` —
 *     staging PHẢI noindex; một bề mặt staging không noindex là khiếm khuyết
 *     thật và báo đỏ là đúng (§7.5 mục 9 `root-noindex`).
 * - `redirect: 'manual'`: smoke khẳng định đúng bề mặt được hỏi, không bám
 *   theo redirect — một `/health` bị chuyển sang trang khác KHÔNG được đếm
 *   là 2xx của `/health`.
 * - Retry CHỈ dành cho chữ ký "chưa sẵn sàng": 404/502/503/504, connection
 *   refused/reset, timeout. Mọi thứ khác — TLS sai, 4xx, 500, 3xx bất ngờ,
 *   sai location, thiếu header — fail tức thời: retry chỉ che bug thật.
 * - Hợp đồng output: `staging smoke OK` CHỈ được in khi toàn bộ kiểm pass;
 *   mọi đường fail ném lỗi với `staging smoke FAILED` trong message và
 *   KHÔNG in OK — log vừa FAILED vừa OK là log nói dối đúng lúc người đọc
 *   cần tin nhất.
 *
 * Origin là tham số (pattern tái dụng được): lần chạy thật đầu tiên của home
 * trỏ apex `ecoma.io.vn` và chờ dependency thật của #350 (zone DNS) +
 * #350/#362 (Router non-production) — module này không suy hostname từ config.
 */

/** Budget retry tổng — mặc định đo từ local lane: cold start trong ít phút. */
export const SMOKE_BUDGET_MS_DEFAULT = 90_000;
/** Timeout mỗi request — không chờ vô hạn một origin câm. */
export const SMOKE_REQUEST_TIMEOUT_MS_DEFAULT = 10_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

// 502/503/504 là "chưa sẵn sàng" (router/upstream chưa thấy deployment); 500
// là lỗi SSR thật — fail tức thời. 404 retry trong cửa sổ hẹp deployment đổi
// route (cùng lý do với local-smoke: app không bao giờ trả 404 cho bề mặt
// được hỏi, kẹt 404 vẫn fail đúng khi hết budget).
const RETRYABLE_STATUSES = new Set([404, 502, 503, 504]);
// Lỗi transport "chưa sẵn sàng" của undici/fetch. CỐ ĐỊNH không thêm chữ ký
// khác: ngoài danh sách này là fail-closed, không đoán thêm.
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

/** Shape tối thiểu của response mà module đọc — không ràng buộc fetch toàn phần.
 *  `headers.get` phải insensitive hoa/thường như WHATWG `Headers` (tên header
 *  HTTP insensitive): production dùng `fetch` thật nên tự đảm bảo; fetchImpl
 *  tùy chỉnh (spec) phải tuân cùng hợp đồng. */
export interface SmokeResponse {
  status: number;
  headers: { get(name: string): string | null };
}

/** Deps inject để spec chạy không cần mạng thật. */
export interface StagingSmokeDeps {
  fetchImpl: (
    url: string,
    init: { redirect: 'manual'; signal: AbortSignal },
  ) => Promise<SmokeResponse>;
  sleepFn: (ms: number) => Promise<void>;
  out: { write(text: string): void };
}

const defaultDeps: StagingSmokeDeps = {
  fetchImpl: (url, init) => fetch(url, init),
  sleepFn: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  out: process.stdout,
};

/** Lỗi retry-được: có khả năng tự hết khi cold start kết thúc. */
class SmokeRetryableError extends Error {}
/** Lỗi chốt: routing/app/TLS thực sự sai — retry chỉ che lỗi. */
export class SmokeFailure extends Error {}

/** Tham số smoke đã validate — đầu vào của `runStagingSmoke`. */
export interface StagingSmokeOptions {
  origin: string;
  redirects: Array<{ from: string; to: string }>;
  healthPaths: string[];
  noindexPaths: string[];
  budgetMs: number;
  requestTimeoutMs: number;
}

/**
 * Origin phải là bare HTTPS origin: staging public surface là TLS công khai,
 * cho phép `http://` là cho smoke xác minh một downgrade; path/query/hash trên
 * origin là input hỏng — mọi path kiểm đi qua cờ riêng.
 */
export function validateSmokeOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`smoke origin "${origin}" is not a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`smoke origin must be https:// — staging is a TLS public surface: "${origin}"`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `smoke origin must be a bare origin without path, query or hash: "${origin}" — ` +
        'check paths go through their own flags',
    );
  }
  return url;
}

/**
 * Path kiểm hợp lệ: bắt đầu bằng `/`, không khoảng trắng hay ký tự điều khiển
 * — giá trị được nối thẳng vào URL nên dữ liệu lạ là lỗi usage, không phải
 * dữ liệu cần escape.
 */
export function validateCheckPath(path: string, flag: string): string {
  // Ký tự điều khiển (< 0x20) kiểm bằng code point — regex control-class là
  // lỗi lint no-control-regex, và vòng.some trên vài ký tự path là đủ rẻ.
  const hasControlChar = [...path].some((char) => {
    const code = char.codePointAt(0);
    return code !== undefined && code < 0x20;
  });
  if (!path.startsWith('/') || hasControlChar || /\s/u.test(path)) {
    throw new Error(`${flag} value must be an absolute path without whitespace: "${path}"`);
  }
  return path;
}

/** Request MỘT path với phân lớp lỗi — mirror `classifyRequestError` của local-smoke. */
async function requestStep(
  options: StagingSmokeOptions,
  pathname: string,
  deps: StagingSmokeDeps,
): Promise<SmokeResponse> {
  const url = `${options.origin}${pathname}`;
  let response: SmokeResponse;
  try {
    response = await deps.fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    const code = (error as { code?: string }).code ?? cause?.code;
    // AbortSignal.timeout hủy request: Node báo TimeoutError/AbortError —
    // đây là request timeout của ta, không phải lỗi server.
    if (
      (error instanceof Error && error.name === 'TimeoutError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new SmokeRetryableError(
        `GET ${pathname}: timeout ${options.requestTimeoutMs}ms — origin did not respond`,
      );
    }
    if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
      throw new SmokeRetryableError(
        `GET ${pathname}: ${code} — origin not listening/not ready yet`,
      );
    }
    // Mọi lỗi ngoài danh sách retry (TLS sai, DNS vĩnh viễn, ...) là fail-closed.
    throw new SmokeFailure(
      `GET ${pathname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // fetchImpl vi phạm hợp đồng SmokeResponse là lỗi lớp smoke, không phải lỗi
  // origin — SmokeFailure fail-closed, KHÔNG retry (retry chỉ dành cho origin
  // chưa sẵn sàng), và không để TypeError thoát ra ngoài phân lớp.
  if (
    response === null ||
    response === undefined ||
    typeof response.status !== 'number' ||
    typeof response.headers?.get !== 'function'
  ) {
    throw new SmokeFailure(
      `GET ${pathname}: malformed response object — the smoke response contract is violated`,
    );
  }
  return response;
}

/** Một kết quả kiểm đã pass — log line cho job đọc. */
export interface SmokeCheckResult {
  name: string;
  detail: string;
}

/**
 * Phân lớp một status sai spec: 404/502/503/504 là "chưa sẵn sàng" (cold start,
 * router chưa thấy deployment) — retry-được; mọi status khác sai spec là lỗi
 * thật của app, fail tức thời. Mỗi đường kiểm dùng chung hàm này.
 */
function expectStatus(
  path: string,
  response: SmokeResponse,
  expected: string,
  satisfied: boolean,
): void {
  if (satisfied) return;
  if (RETRYABLE_STATUSES.has(response.status)) {
    throw new SmokeRetryableError(
      `GET ${path}: status ${response.status} while expecting ${expected} — origin not ready yet`,
    );
  }
  throw new SmokeFailure(`GET ${path}: expected ${expected}, got ${response.status}`);
}

/** Chạy một lượt TOÀN BỘ kiểm — throw SmokeRetryableError/SmokeFailure đúng lớp. */
async function verifyOnce(
  options: StagingSmokeOptions,
  deps: StagingSmokeDeps,
): Promise<SmokeCheckResult[]> {
  const results: SmokeCheckResult[] = [];
  for (const redirect of options.redirects) {
    const response = await requestStep(options, redirect.from, deps);
    expectStatus(redirect.from, response, 'status 302', response.status === 302);
    const location = response.headers.get('location');
    if (location !== redirect.to) {
      throw new SmokeFailure(
        `GET ${redirect.from}: expected location '${redirect.to}', got ${JSON.stringify(location)}`,
      );
    }
    results.push({ name: 'redirect', detail: `${redirect.from} → ${location}` });
  }
  for (const path of options.healthPaths) {
    const response = await requestStep(options, path, deps);
    expectStatus(path, response, '2xx', response.status >= 200 && response.status < 300);
    results.push({ name: 'health', detail: `${path} → ${response.status}` });
  }
  for (const path of options.noindexPaths) {
    const response = await requestStep(options, path, deps);
    expectStatus(path, response, '2xx', response.status >= 200 && response.status < 300);
    const robotsTag = response.headers.get('x-robots-tag');
    if (robotsTag === null || !robotsTag.toLowerCase().includes('noindex')) {
      throw new SmokeFailure(
        `GET ${path}: expected an X-Robots-Tag containing "noindex", got ${JSON.stringify(robotsTag)}` +
          ' — a staging surface without noindex is a real defect (§7.5 item 9)',
      );
    }
    results.push({ name: 'noindex', detail: `${path} → noindex` });
  }
  return results;
}

/**
 * Chạy smoke với retry budget. In từng kiểm pass ra `out` NGAY khi pass;
 * in `staging smoke OK` duy nhất MỘT lần chỉ khi toàn bộ pass; mọi đường
 * fail ném lỗi với message `staging smoke FAILED after <ms>ms: <lý do>`.
 */
export async function runStagingSmoke(
  options: StagingSmokeOptions,
  deps: StagingSmokeDeps = defaultDeps,
): Promise<SmokeCheckResult[]> {
  validateSmokeOrigin(options.origin);
  // Validate mọi path TRƯỚC vòng retry: path được nối thẳng vào URL, dữ liệu
  // lạ là lỗi usage — dừng trước cả request đầu tiên kể cả khi options dựng
  // trực tiếp mà không qua CLI.
  for (const redirect of options.redirects) {
    validateCheckPath(redirect.from, '--redirect from');
  }
  for (const path of options.healthPaths) {
    validateCheckPath(path, '--health');
  }
  for (const path of options.noindexPaths) {
    validateCheckPath(path, '--noindex');
  }
  const totalChecks =
    options.redirects.length + options.healthPaths.length + options.noindexPaths.length;
  if (totalChecks === 0) {
    throw new Error(
      'staging smoke received no checks — pass at least one of --redirect/--health/--noindex; ' +
        'an empty check list is a misconfiguration, not a pass',
    );
  }
  const startedAt = Date.now();
  let backoffMs = BACKOFF_INITIAL_MS;
  let lastRetryable: Error | undefined;
  // Luôn chạy ít nhất một lần; các lần sau chỉ khi lỗi retry-được và còn budget.
  for (;;) {
    let results: SmokeCheckResult[] | undefined;
    try {
      results = await verifyOnce(options, deps);
    } catch (error) {
      if (!(error instanceof SmokeRetryableError)) throw error;
      lastRetryable = error;
    }
    if (results !== undefined) {
      for (const result of results) {
        deps.out.write(`staging smoke ${result.name} OK: ${result.detail}\n`);
      }
      deps.out.write(
        `staging smoke OK: ${results.length} check(s) passed in ${Date.now() - startedAt}ms — ${options.origin}\n`,
      );
      return results;
    }
    const remainingMs = options.budgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(
        `staging smoke FAILED after ${Date.now() - startedAt}ms ` +
          `(budget exhausted ${options.budgetMs}ms): ${lastRetryable?.message ?? 'unknown reason'}`,
      );
    }
    // Ngủ KHÔNG vượt phần budget còn lại — deadline đã tuyên bố với caller
    // phải đứng, dù một lượt verify có thể đã ăn gần hết budget.
    const sleepMs = Math.min(backoffMs, remainingMs);
    deps.out.write(
      `staging smoke RETRY after ${Date.now() - startedAt}ms: ${lastRetryable?.message} — retrying in ${sleepMs}ms\n`,
    );
    await deps.sleepFn(sleepMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }
}
