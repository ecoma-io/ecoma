/**
 * Adapter provider thật: Resend HTTP API (`POST {endpoint}`), đứng sau
 * {@link MailProviderPort} — seam duy nhất mà worker core dùng để giao một delivery
 * ra provider (`docs/applications/transactional-mailer-job/01-architecture.md` §11.1).
 *
 * Đây là **chỗ duy nhất** chứa chi tiết vendor: wire protocol của Resend không rò
 * lên trên port, và port không biết Resend tồn tại (§11.2).
 *
 * ## Vì sao khai Web API bằng `declare` ở **module scope**
 *
 * `fetch`, `AbortController`, `setTimeout` của global là bộ signature **tối thiểu** mà
 * adapter dùng, không phải toàn bộ surface của `fetch` hay `AbortController` thật. Khai
 * **module-scope** (`declare const fetch: …`) để chỉ áp trong file này: bề mặt global của
 * consumer **không** bị đổi, và global `fetch`/`AbortController` thật vẫn gán được vào các
 * kiểu ở đây (compile ở `resend-mail-provider.spec.ts` là bằng chứng). Shape subset khai
 * cục bộ cùng một lý do với `d1-database-like.ts` — lib là `runtime:edge`, muốn bề mặt
 * type của adapter hẹp đúng những gì nó dùng; ambient Workers API thừa
 * (`DurableObjectNamespace`, `caches.default`…) không được để compile xanh rồi chết lúc chạy.
 *
 * (Trước issue #333, tsconfig của lib đặt `types: []` nên các global này không tồn tại với
 * typechecker và phải khai đầy đủ; signed client chuyển về lib này dùng global
 * `Request`/`Response` thật, nên lib chuyển sang `types: ["@cloudflare/workers-types"]` —
 * các `declare` subset ở dưới vẫn giữ nguyên, vì chúng vẫn là bản ghi chính xác nhất của
 * mức hẹp mà adapter gọi.)
 *
 * `AbortSignal` là ngoại lệ **duy nhất**, và không phải vì hời hợt — xem docblock ngay
 * trên `declare global` bên dưới: nó là thứ khiến `fetch` thật gán được vào
 * {@link ProviderFetch}, nên phải là global chung chứ không phải một interface riêng.
 *
 * ## Ranh giới bảo mật (không thỏa hiệp)
 *
 * - **Không có một lệnh log nào** trong file này: token, endpoint, recipient, subject,
 *   body và raw provider response **không** bao giờ chạm log hay metric (§13, §11.2).
 * - **Resolve, không reject**: mọi outcome nghiệp vụ — kể cả `retryable` — đi qua
 *   {@link MailProviderSendResult}; `send` chỉ ném khi chính adapter có bug.
 * - **Không retry nội bại**: một lần gọi port là **một** attempt của **một** execution đã
 *   claim, và slot ngân sách **B** đã bị tiêu đúng một lần ở claim (§9.2.1 (a)).
 * - **Không follow redirect**: `redirect: 'manual'` là bắt buộc — một redirect sẽ mang
 *   credential và nội dung thư tới host không nằm trong trusted config (§11.2).
 * - **Không log exception/stack nguyên văn**: exception của HTTP client là bề mặt rò rỉ
 *   tiếp theo (URL đầy đủ kèm header); chỉ `errorCode` đã sanitize đi ra ngoài.
 *
 * ## `providerMessageId` KHÔNG phải bằng chứng thư đã tới inbox
 *
 * `2xx` chỉ chứng minh provider **đã chấp nhận** request (§9.3). Adapter không bịa id và
 * không suy ra nó từ `deliveryId`/`recipient`: chỉ đọc `id` khi response của provider thật
 * sự trả về một chuỗi khác rỗng và không chỉ whitespace.
 */

import type {
  MailProviderErrorClass,
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from '@ecoma-io/transactional-mailer-job-application';

/* -------------------------------------------------------------------------------------------- */
/* Web API tối thiểu — chỉ đúng phần adapter dùng (xem docblock module-scope ở trên).              */
/* -------------------------------------------------------------------------------------------- */

/**
 * Global `AbortSignal`, mở rộng chứ không định nghĩa lại.
 *
 * ## Vì sao adapter phải đụng tới global scope
 *
 * `ProviderFetch` nhận `ProviderRequestInit` ở **vị trí tham số**, và tham số của một
 * hàm được so sánh **bất biến phụ thuộc** (contravariant). Nên nếu
 * `ProviderRequestInit.signal` là một interface **riêng** của lib này — kể cả một bản
 * sao cấu trúc "đúng từng chữ ký" của `AbortSignal` — thì nó **không phải** `AbortSignal`
 * của lib `dom`, và global `fetch` thật không gán được vào `ProviderFetch`.
 *
 * Đó không phải lỗi hình thức: composition root (`apps/transactional-mailer-job`) truyền
 * thẳng global `fetch` vào `deps.fetchImpl` — đó là cách dùng được tài liệu hoá. Với một
 * interface riêng, chỗ duy nhất đỏ là composition root, còn adapter và toàn bộ lib này vẫn
 * xanh hoàn toàn.
 *
 * ## Vì sao mở rộng chứ không khai `declare global` trần
 *
 * Khai một interface trùng tên sẽ **ghi đè** `AbortSignal` của môi trường ở mọi consumer
 * đọc declaration của lib — gồm cả composition root — và làm hỏng chính những chỗ dùng
 * `AbortSignal` thật. Khai rỗng (`interface AbortSignal {}`) thì hợp nhất với khai báo
 * sẵn có bằng **declaration merging**: consumer có `AbortSignal` đầy đủ (lib `dom`,
 * workers-types, Node types) thì thấy bản đầy đủ; nếu một consumer nào không có sẵn thì
 * vẫn có interface tối thiểu để adapter tự dựng được một `AbortController` với signal hợp
 * lệ qua {@link ProviderAbortController} bên dưới.
 */
declare global {
  // oxlint-disable-next-line typescript/no-empty-object-type, typescript/no-empty-interface
  interface AbortSignal {}
}

/**
 * `signal` mà {@link ProviderRequestInit} mang — **chính là** global `AbortSignal`.
 *
 * Ghi lại bằng alias để điểm nhạy cảm của thiết kế (xem docblock `declare global` ngay
 * trên) có một tên gọi, và để typecheck của chính file này bắt được nếu ai đó đổi nó thành
 * một interface riêng — lúc đó `fetch` thật sẽ không còn gán được.
 */
type ProviderSignal = AbortSignal;

/** `AbortController` tối thiểu: một signal + một cách huỷ. */
export interface ProviderAbortController {
  readonly signal: ProviderSignal;
  abort(): void;
}

/** Header của response — chỉ `get`, và chỉ header `Retry-After`. */
export interface ProviderResponseHeaders {
  get(name: string): string | null;
}

/** Response của provider — chỉ `status`, `headers` và `json()` (đọc **đúng một lần**). */
export interface ProviderResponse {
  readonly status: number;
  readonly headers: ProviderResponseHeaders;
  json(): Promise<unknown>;
}

/** Init của một lần POST tới provider. */
export interface ProviderRequestInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: ProviderSignal;
  /** Luôn `'manual'`: adapter MUST NOT follow redirect (§11.2). */
  readonly redirect: 'manual';
}

/**
 * `fetch` ở đúng mức adapter dùng: một endpoint từ trusted config, một init tĩnh.
 *
 * Global `fetch` của cả Cloudflare Workers lẫn Node ≥ 18 gán được vào kiểu này, nên
 * composition root truyền thẳng global `fetch` vào `deps.fetchImpl` được — không cần
 * adapter trung gian.
 */
export interface ProviderFetch {
  (input: string, init: ProviderRequestInit): Promise<ProviderResponse>;
}

declare const fetch: ProviderFetch;
declare function setTimeout(handler: () => void, timeout: number): number;
declare function clearTimeout(handle: number): void;
declare const AbortController: {
  new (): ProviderAbortController;
};

/* -------------------------------------------------------------------------------------------- */
/* Config và deps                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Cấu hình provider — **mirror cấu trúc** của `ResendProviderConfig` ở
 * `apps/transactional-mailer-job/src/config.ts`.
 *
 * Khai trùng thay vì import là bắt buộc, không phải lựa chọn: composition root là một
 * **deploy unit khác**, và import chéo project bị chặn ở hai lớp — `tsc` (`TS6059`/`TS6307`:
 * file ngoài `rootDir`) lẫn `@nx/enforce-module-boundaries` của oxlint. Port vẫn là nguồn
 * duy nhất cho *shape request/result*; đây chỉ là config của adapter.
 *
 * Hai khai báo phải giữ **giống nhau từng field**: spec đọc thẳng file config của
 * composition root từ đĩa và ghim tập tên field, nên đổi tên ở một phía là đỏ ngay ở phía
 * kia thay vì hỏng im lặng lúc chạy trên Worker.
 */
export interface ResendProviderConfig {
  /** Worker Secret `MAIL_PROVIDER_ENDPOINT` — endpoint từ trusted config, không bao giờ từ request. */
  readonly endpoint: string;
  /** Worker Secret `MAIL_PROVIDER_TOKEN` — bearer credential; không bao giờ log (§13). */
  readonly token: string;
  /** Worker Secret/var `MAIL_PROVIDER_FROM` — sender identity thuộc trusted config (§11.1). */
  readonly from: string;
  /** Trần chờ của **một** request provider (milliseconds). */
  readonly timeoutMs: number;
}

/** Dependency inject được — để test không chạm network và không phụ thuộc đồng hồ thật. */
export type ResendMailProviderDeps = {
  /** Mặc định global `fetch`. */
  readonly fetchImpl?: ProviderFetch;
  /** Mặc định `Date.now`. Inject để mọi ca deadline xác định. */
  readonly nowMs?: () => number;
};

/* -------------------------------------------------------------------------------------------- */
/* Hằng đã sanitize                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * Token `errorCode`/`warningCode` — kebab-case, đúng quy tắc của `sanitizeErrorToken`.
 *
 * `http-3xx` và `timeout` là hai token §11.1/FR-005 nêu nguyên văn; các token còn lại đặt
 * theo cùng hình dạng (prefix `provider-` + sự kiện) để phân biệt được nhánh trong
 * `last_error` và metric mà không mang dữ liệu của request.
 */
const ERROR_CODES = {
  /** Deadline đã qua, hoặc không xác định được — §11.1. */
  timeout: 'timeout',
  /** Network error, hoặc request bị huỷ ngoài trần chờ đã đặt. */
  network: 'provider-network-error',
  /** `2xx` nhưng không xác định được provider message id. */
  unparseableId: 'provider-id-unparseable',
  /** `401`/`403` của **provider** — credential-class, không phải lỗi của private API. */
  authRejected: 'provider-auth-rejected',
  /** `4xx` khác — permanent. */
  requestRejected: 'provider-request-rejected',
  /** `429` — retryable, có `retryAfterMs` nếu provider gửi header. */
  rateLimited: 'provider-rate-limited',
  /** `5xx`, `1xx` hoặc status lạ — retryable. */
  serverError: 'provider-server-error',
  /** `3xx` — lỗi cấu hình endpoint (§11.1, FR-005 nêu nguyên văn). */
  redirect: 'http-3xx',
} as const;

/** Một giây tính bằng milliseconds. */
const MS_PER_SECOND = 1_000;

/**
 * Trần 24 giờ cho `Retry-After` (`docs/architecture/04-platform-facts.md` QU8, §11.1).
 *
 * `retryAfterMs` là **sàn** cho lần thử kế tiếp: sàn vượt retention của Queue thì retry
 * bị xoá trước khi chạy và delivery rơi vào đường reconciler tốn slot ngân sách A. Clamp
 * ở đây không thay thế clamp theo retention của Queue — việc đó thuộc worker
 * (`mail-provider-port.ts`: "việc clamp … theo retention của Queue là của worker").
 */
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * MS_PER_SECOND;

/** Tiền tố của `Idempotency-Key` — namespace của worker, không phải dữ liệu của delivery. */
const IDEMPOTENCY_KEY_PREFIX = 'mailjob_';

/* -------------------------------------------------------------------------------------------- */
/* Phân loại                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** Dựng nhánh `rejected` — `retryAfterMs` mặc định `null` khi provider không gửi header. */
function rejected(
  errorClass: MailProviderErrorClass,
  errorCode: string,
  retryAfterMs: number | null = null,
): MailProviderSendResult {
  return { kind: 'rejected', errorClass, errorCode, retryAfterMs };
}

/** `delay-seconds` của RFC 9110: một hay nhiều chữ số, không có dấu và không có phần thập. */
const DELAY_SECONDS_PATTERN = /^\d+$/u;

/**
 * HTTP-date theo RFC 9110: cả ba dạng lịch sử (`IMF-fixdate`, `rfc850`, `asctime`) đều
 * chứa **chữ cái** — tháng bằng tên (`Jan`) và múi giờ bằng `GMT`.
 *
 * Điều kiện này không phải thừa: `Date.parse` rất dễ dãi và parse **cả** `-5` và `1.5`
 * thành một instant hợp lệ (năm 2001). Không có nó, `Retry-After: -5` thành một sàn
 * `0` — tức retry liên tục — thay vì giá trị trung thực `null`.
 */
const HTTP_DATE_PATTERN = /[A-Za-z]/u;

/**
 * Đọc `Retry-After` thành **độ trễ tương đối** theo milliseconds.
 *
 * Cả hai dạng RFC 9110 đều được nhận: `delay-seconds` và HTTP-date. Giá trị không đọc
 * được (thiếu header, rỗng, sai cú pháp) trả `null` — đó là giá trị trung thực,
 * **không phải** `0`: sàn `0` biến một header hỏng thành retry liên tục. Kết quả luôn
 * là số giây nguyên và không vượt 24 giờ (§11.1).
 */
function parseRetryAfterMs(headers: ProviderResponseHeaders, nowMs: number): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (DELAY_SECONDS_PATTERN.test(trimmed)) {
    return Math.min(RETRY_AFTER_MAX_MS, Number(trimmed) * MS_PER_SECOND);
  }

  if (!HTTP_DATE_PATTERN.test(trimmed)) {
    return null;
  }

  const asInstant = Date.parse(trimmed);
  if (Number.isNaN(asInstant)) {
    return null;
  }

  const elapsedSeconds = Math.floor((asInstant - nowMs) / MS_PER_SECOND);

  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, elapsedSeconds) * MS_PER_SECOND);
}

/**
 * Đọc `id` của provider **một lần duy nhất**, hoặc `null` khi không xác định được chuỗi
 * đáng tin cậy.
 *
 * `null` khi: body không parse được JSON, body không phải object, thiếu field `id`,
 * `id` không phải string, hoặc `id` rỗng/chỉ whitespace — §11.1 coi ba trường hợp sau
 * là "không có message id".
 *
 * Raw body của provider là dữ liệu **untrusted** và không bao giờ được ghi ra log hay đưa
 * vào `errorCode` (§13): hàm này chỉ trả về chuỗi id hoặc `null`, không trả về lý do.
 */
async function readProviderMessageId(response: ProviderResponse): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const id = (payload as { readonly id?: unknown }).id;

  if (typeof id !== 'string' || id.trim().length === 0) {
    return null;
  }

  return id;
}

/**
 * Phân loại một response **không phải** `2xx` theo ma trận canonical.
 *
 * Thứ tự phải là thứ tự ưu tiên: `3xx` tách riêng **trước** nhóm `4xx` vì nó là lỗi cấu
 * hình endpoint (`credential` → `blocked`), không phải thư bị provider từ chối; và `429`
 * tách riêng vì nó là nhóm `retryable` duy nhất mang `Retry-After`.
 *
 * `401`/`403` của **provider** là credential-class (§3). Lỗi `401`/`403` của private API
 * không bao giờ đi vào đây: nó không phải input của port này (§11.1) — cấu trúc type đã
 * loại nó, không phải quy ước runtime.
 *
 * Tham số là **một options object các vô hướng** (`status`, `retryAfterMs`, `nowMs`) được
 * đọc tại call site, không phải object `response`: kết quả trả về chỉ gồm literal — dữ
 * liệu taint từ request đi ra (token trong `Authorization`) không có đường vào giá trị
 * trả về. Hình dạng "return helper({options})" cũng là ranh giới taint rule
 * `security-sensitive-value-in-http-response` công nhận (cùng lớp với `verifyRequest`);
 * truyền thẳng `response` qua tham số hàm sẽ bị model taint coi như mang token ra ngoài.
 */
function classifyRejectedStatus(options: {
  readonly status: number;
  readonly retryAfterMs: number | null;
}): MailProviderSendResult {
  const { status, retryAfterMs } = options;

  // 3xx: adapter đã tắt redirect-following nên nó thấy 3xx thật. Redirect là lỗi cấu
  // hình endpoint — `credential`, cùng hành động hàng 3 của ma trận (§11.1, FR-005).
  if (status >= 300 && status < 400) {
    return rejected('credential', ERROR_CODES.redirect);
  }

  if (status === 401 || status === 403) {
    return rejected('credential', ERROR_CODES.authRejected);
  }

  if (status === 429) {
    return rejected('retryable', ERROR_CODES.rateLimited, retryAfterMs);
  }

  // `4xx` khác — kể cả `408`, và `409`/`422` idempotency conflict — là `permanent`
  // (§11.1). Canonical không có nhóm transient cho HTTP status phía provider: `429` và
  // `5xx` đã có nhóm riêng rồi, và hazard idempotency conflict được §9.3 ghi nhận tường
  // minh là **không** phải lý do để đổi mapping.
  if (status >= 400 && status < 500) {
    return rejected('permanent', ERROR_CODES.requestRejected);
  }

  // `5xx`, `1xx` (response protocol bất thường) và mọi status ngoài dải — `retryable`.
  return rejected('retryable', ERROR_CODES.serverError);
}

/**
 * Trần chờ thực tế của lần gọi này: `min(timeout cấu hình, phần deadline còn lại)`.
 *
 * §11.1 bắt buộc adapter **không kéo dài** `deadlineMs` — nếu chỉ dùng `timeoutMs` của
 * config thì một lease sắp hết hạn vẫn bị gọi provider thêm vài giây.
 */
function callBudgetMs(configuredTimeoutMs: number, remainingDeadlineMs: number): number {
  const configured = Number.isFinite(configuredTimeoutMs)
    ? Math.max(0, configuredTimeoutMs)
    : remainingDeadlineMs;

  return Math.min(configured, remainingDeadlineMs);
}

/* -------------------------------------------------------------------------------------------- */
/* Adapter                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Dựng adapter Resend cho {@link MailProviderPort}.
 *
 * Một lần gọi `send` tương ứng với **một** attempt của **một** execution đã claim: không
 * retry nội bại, không tăng `attempts` ở call boundary (§11.2, FR-005).
 *
 * @param config Endpoint, credential, sender identity và timeout — tất cả từ trusted
 * config của chính worker; adapter **không** nhận endpoint/URL từ request, runtime
 * material hay Queue.
 * @param deps Dependency inject cho test (`fetchImpl`, `nowMs`).
 */
export function createResendMailProvider(
  config: ResendProviderConfig,
  deps: ResendMailProviderDeps = {},
): MailProviderPort {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.nowMs ?? Date.now;

  return {
    async send(request: MailProviderSendRequest): Promise<MailProviderSendResult> {
      const startedAtMs = now();

      // Deadline trước **mọi** thứ khác: `deadlineMs` là trần cứng tuyệt đối của lần gọi,
      // nên quá hạn thì không tiêu network và không có side effect nào (§11.1).
      //
      // Cả **hai** vế của phép so sánh phải hữu hạn mới kết luận được: nếu chỉ kiểm
      // `deadlineMs`, một đồng hồ `NaN` làm `deadlineMs <= nowMs` luôn `false` và một
      // request đã quá hạn rơi xuống `accepted` — trần cứng bị vô hiệu hoá im lặng. Vì vậy
      // nhánh này fail closed về `timeout` (đã sanitize) thay vì sinh thêm một token mới.
      if (!Number.isFinite(request.deadlineMs) || !Number.isFinite(startedAtMs)) {
        return rejected('retryable', ERROR_CODES.timeout);
      }

      if (request.deadlineMs <= startedAtMs) {
        return rejected('retryable', ERROR_CODES.timeout);
      }

      const controller = new AbortController();
      let abortedByTimeout = false;
      const timer = setTimeout(
        () => {
          abortedByTimeout = true;
          controller.abort();
        },
        callBudgetMs(config.timeoutMs, request.deadlineMs - startedAtMs),
      );

      try {
        const response = await doFetch(config.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
            // `deliveryId` là ứng viên idempotency key (§9.3), giữ nguyên xuyên generation:
            // redrive tăng `dispatch_generation` nhưng key không đổi, đúng như yêu cầu
            // "key không đổi xuyên generation" của §9.3. Adapter cố ý **không** ghép
            // `dispatchGeneration` vào key: port §11.1 cấm mang fencing state của control
            // plane, nên adapter không có generation để ghép, và tự suy ra nó từ dữ liệu
            // khác cũng bị §11.1 cấm.
            'Idempotency-Key': `${IDEMPOTENCY_KEY_PREFIX}${request.deliveryId}`,
          },
          body: JSON.stringify({
            from: config.from,
            to: [request.recipient],
            subject: request.subject,
            html: request.body,
          }),
          signal: controller.signal,
          redirect: 'manual',
        });

        if (response.status < 200 || response.status >= 300) {
          // `status`/`Retry-After` được đọc ngay tại đây — nơi `response` còn thuộc về —
          // và chỉ các vô hướng này đi vào helper (xem JSDoc của nó).
          return classifyRejectedStatus({
            status: response.status,
            retryAfterMs: parseRetryAfterMs(response.headers, startedAtMs),
          });
        }

        const providerMessageId = await readProviderMessageId(response);

        return {
          kind: 'accepted',
          providerMessageId,
          // `2xx` là bằng chứng provider **đã chấp nhận**; body không đọc được id không hạ
          // acceptance xuống thành lỗi — retry sau khi đã accept chỉ có thể gửi trùng
          // (§9.2.2 hàng 9). `warningCode` đi vào provider error metric, **không** vào
          // `last_error` (§11.1).
          warningCode: providerMessageId === null ? ERROR_CODES.unparseableId : null,
        };
      } catch {
        // Network error hoặc request bị huỷ. Exception/stack của HTTP client là bề mặt
        // rò rỉ tiếp theo (URL đầy đủ kèm header, đôi khi cả credential) nên **không**
        // được log nguyên văn; chỉ `errorCode` đã sanitize đi ra ngoài (§11.2).
        return rejected('retryable', abortedByTimeout ? ERROR_CODES.timeout : ERROR_CODES.network);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
