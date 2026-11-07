/**
 * Client của private delivery runtime API của `push-notification` — hiện thực
 * {@link DeliveryRuntimePort} trên Service Binding.
 *
 * ⚠️ **Ranh giới trách nhiệm, giống `libs/transactional-mailer-job-infrastructure/src/internal-delivery-client.ts`:**
 * client **không** retry, **không** phân loại lỗi mạng thành hành động, **không** chuyển một
 * `5xx` của control plane thành một kết quả gửi. Nó chỉ làm ba việc: dựng request có xác thực,
 * đọc status, và **validate body bằng chính validator canonical của `@ecoma-io/push-notification-contracts`**.
 * Tầng gọi (`delivery-pipeline.ts`) là nơi quyết định `ack()`/`retry()`/terminal trên D1.
 *
 * ⚠️ **Vì sao validate bằng validator của contracts chứ không tự kiểm `status`.** Peer lệch
 * phiên bản là một chẩn đoán vận hành riêng ("control plane đang trả vocabulary khác"), và nó
 * phải đi vào `RuntimeContractError` → bounded retry → DLQ, **không** được rơi vào một nhánh mà
 * pipeline đọc là "thua claim rồi ACK". Validator là nguồn duy nhất của cái được phép là claim,
 * nên một body lệch vocabulary không thể lọt qua bằng một `if (status === 200)`.
 *
 * ⚠️ **Secret được resolve lại ở MỖI request, không cache ở constructor.** Cấu hình thiếu là
 * {@link RuntimeAuthResolutionError} — một lỗi cần đi qua `runtime_resolution_errors` + bounded
 * retry → DLQ. Nếu throw lúc dựng Worker thì không có metric nào được ghi và một deploy thiếu
 * secret chết ở tầng compose thay vì ở tầng message. Nhưng **không** có đường nào gửi request
 * khi thiếu secret: `resolveRuntimeSharedSecret` ném **trước** khi `fetch` được gọi.
 *
 * ⚠️ **Fail-closed trước mọi byte.** Thiếu/rỗng/khoảng trắng-thuần → ném, không gửi. Secret hợp
 * lệ được giữ **nguyên văn** (không `trim`), vì `trim()` sẽ biến secret gõ thừa một dấu cách
 * thành secret khác và mọi request sau đó đều là `401` với lý do không ai đoán được.
 *
 * ⚠️ **Không log** secret, header authorization, endpoint hay payload ở bất kỳ đâu trong file
 * này. Lỗi cấu hình chỉ nêu **tên** biến.
 */

import {
  validateClaimRejection,
  validateDeliveryClaim,
  validateInvalidateAck,
  validateLeaseFencedRejection,
  validateOutcomeAck,
  validateReleaseAck,
  type ClaimRejection,
  type DeliveryClaim,
  type DeliveryOutcomeValue,
} from '@ecoma-io/push-notification-contracts';
import {
  RuntimeAuthResolutionError,
  RuntimeContractError,
  RuntimeTransportError,
  type ClaimPortResult,
  type ClaimRejectionPort,
  type DeliveryRuntimePort,
  type FencedWritePortResult,
} from '@ecoma-io/web-push-notification-job-application';

/**
 * Tên Worker Secret dùng để gọi private delivery runtime API.
 *
 * ⚠️ Docs `push-notification/01-architecture.md` §8.1 ghi secret trong header `Authorization`
 * (không có scheme `Bearer`) và control plane đang chạy đọc đúng header đó
 * (`RUNTIME_SHARED_SECRET_HEADER` trong `main.ts`). Từng có giai đoạn client gửi cả
 * `x-ecoma-shared-secret` để tương thích hai chiều với một mâu thuẫn docs ↔ code, nhưng control
 * plane không bao giờ đọc header đó — nó là một kênh truyền secret vô ích nên đã bỏ; chỉ còn
 * `authorization`.
 */
export const RUNTIME_API_SHARED_SECRET_ENV = 'RUNTIME_API_SHARED_SECRET';

/**
 * Principal mà delivery worker tự khai khi gọi private API.
 *
 * ⚠️ Control plane **không** tin giá trị này ( nó chỉ dùng nó để so với principal gắn với
 * credential); `docs/applications/push-notification/01-architecture.md` §8.1 và §11 yêu cầu đúng
 * chuỗi này. Nếu operator cấu hình `RUNTIME_API_EXPECTED_PRINCIPAL` ở control plane khác, mọi
 * request trả `401` — và đó là một lỗi cấu hình hiển thị được, không phải một lỗi âm thầm.
 */
export const RUNTIME_CALLER_PRINCIPAL = 'svc.web-push-notification-job';

/**
 * Header mang shared secret — đúng **một** tên, khớp cả docs lẫn control plane.
 *
 * ⚠️ `authorization` mang **giá trị nguyên văn** (không `Bearer `) — `requireRuntime` của control
 * plane cố ý không bóc scheme (xem `main.ts`). Danh sách nằm ở đây, không rải ở call site, để
 * nếu một ngày bên đọc đổi tên header thì chỉ có một chỗ phải sửa.
 */
export const RUNTIME_AUTH_HEADERS: readonly string[] = ['authorization'];

/** Header principal tự khai. */
export const RUNTIME_PRINCIPAL_HEADER = 'x-ecoma-principal';

/**
 * Origin giả của private API.
 *
 * Chỉ dùng để dựng một URL *tương đối* hợp lệ cho `Request`/`URL`; request đi qua Service Binding
 * nên hostname này **không bao giờ** được phân giải trên DNS (architecture `01` §6). Đặt đúng tên
 * Worker của control plane để `wrangler tail` không đọc nhầm thành lời gọi ra Internet.
 */
const RUNTIME_ORIGIN = 'https://ecoma-push-notification.internal';

const DELIVERIES_PATH_PREFIX = '/internal/deliveries/';
const SUBSCRIPTIONS_PATH_PREFIX = '/internal/subscriptions/';
const CLAIM_SUFFIX = '/claim';
const RELEASE_SUFFIX = '/release';
const OUTCOME_SUFFIX = '/outcome';
const INVALIDATE_SUFFIX = '/invalidate';
const CONTENT_TYPE_JSON = 'application/json';

/**
 * Service Binding `PUSH_NOTIFICATION_SERVICE` — hẹp nhất có thể: chỉ `fetch`.
 *
 * ⚠️ Một binding thật còn có `connect`, `dispose`… nhưng client không dùng chúng, và khai thêm
 * nghĩa là có dấu hiệu test cần chúng.
 */
export interface RuntimeServiceBinding {
  fetch: (input: Request) => Promise<Response>;
}

export interface RuntimeControlPlaneOptions {
  /** Service Binding `PUSH_NOTIFICATION_SERVICE` — không phải hostname công khai. */
  readonly binding: RuntimeServiceBinding;
  /**
   * `env` của Worker (mọi key đều `unknown`), giữ lại để resolve secret **ở mỗi request**.
   *
   * ⚠️ Không nhận `secret: string` như client của `transactional-mailer-job`: ở đây secret phải
   * là một **lỗi có metric** (thiếu cấu hình ở production là incident), không phải một lỗi
   * compose-time không ai thấy.
   */
  readonly env: Readonly<Record<string, unknown>>;
}

/**
 * Đọc `RUNTIME_API_SHARED_SECRET` — fail-closed **trước** khi có byte nào được gửi.
 *
 * ⚠️ Không có đường nào trả `undefined` để call site tự quyết định: quyết định "không có secret
 * thì gửi không xác thực" chính là lỗ hổng cần chặn.
 *
 * @throws {RuntimeAuthResolutionError} Khi thiếu, sai kiểu, rỗng hoặc chỉ gồm khoảng trắng.
 */
export function resolveRuntimeSharedSecret(env: Readonly<Record<string, unknown>>): string {
  const value = env[RUNTIME_API_SHARED_SECRET_ENV];
  if (value === undefined) {
    throw new RuntimeAuthResolutionError(
      `Thieu Worker Secret ${RUNTIME_API_SHARED_SECRET_ENV}. Khong goi private delivery runtime API.`,
    );
  }
  if (typeof value !== 'string') {
    throw new RuntimeAuthResolutionError(
      `${RUNTIME_API_SHARED_SECRET_ENV} phai la chuoi, nhan duoc ${typeof value}.`,
    );
  }
  assertUsableSecret(value);
  return value;
}

function assertUsableSecret(secret: string): void {
  if (secret.length === 0) {
    throw new RuntimeAuthResolutionError(`Worker Secret ${RUNTIME_API_SHARED_SECRET_ENV} rong.`);
  }
  if (secret.trim().length === 0) {
    throw new RuntimeAuthResolutionError(
      `Worker Secret ${RUNTIME_API_SHARED_SECRET_ENV} chi chua khoang trang.`,
    );
  }
}

/** Dựng một phân đoạn path an toàn từ một định danh của control plane. */
function idSegment(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeContractError(`${label} rong hoac khong phai chuoi.`, 'invalid_identifier');
  }
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    // `encodeURIComponent` ném `URIError` với surrogate lẻ — input hỏng, không phải lỗi hệ thống.
    throw new RuntimeContractError(
      `${label} khong ma hoa duoc thanh mot phan doan path.`,
      'invalid_identifier',
    );
  }
  return encoded;
}

/**
 * Dựng route của private API từ `id`.
 *
 * ⚠️ `encodeURIComponent` chặn `id` chèn phân đoạn path / `?` / `#` / userinfo, nhưng **không**
 * mã hoá `.` và `..` mà URL parser lại bỏ dot-segment — `..` sẽ cắt `/internal/deliveries/` khỏi
 * path và gửi request tới một route khác. Vì vậy route còn được kiểm lại ở {@link RuntimeControlPlaneClient.#send}
 * sau khi URL đã chuẩn hoá: fail-closed thay vì gửi tới một route không phải của mình.
 */
function deliveryRoute(deliveryId: string, suffix: string): string {
  return `${DELIVERIES_PATH_PREFIX}${idSegment(deliveryId, 'delivery_id')}${suffix}`;
}

function subscriptionRoute(subscriptionId: string): string {
  return `${SUBSCRIPTIONS_PATH_PREFIX}${idSegment(subscriptionId, 'subscription_id')}${INVALIDATE_SUFFIX}`;
}

/** Client gọi private delivery runtime API — bốn operation, không có operation thứ năm. */
export class RuntimeControlPlaneClient implements DeliveryRuntimePort {
  readonly #binding: RuntimeServiceBinding;
  readonly #env: Readonly<Record<string, unknown>>;

  constructor(options: RuntimeControlPlaneOptions) {
    this.#binding = options.binding;
    this.#env = options.env;
  }

  /**
   * `POST /internal/deliveries/:delivery_id/claim` — thân **rỗng**.
   *
   * @throws {RuntimeAuthResolutionError} Thiếu/rỗng secret, hoặc control plane trả `401`/`403`.
   * @throws {RuntimeTransportError} Binding không tới được, response không đọc được, `5xx`.
   * @throws {RuntimeContractError} Status ngoài `200`/`409`, hoặc body không qua validator.
   */
  async claim(deliveryId: string): Promise<ClaimPortResult> {
    const response = await this.#send('POST', deliveryRoute(deliveryId, CLAIM_SUFFIX), null);
    const status = response.status;

    if (status === 200) {
      const body = await readJson(response, 'claim 200');
      const validated = validateDeliveryClaim(body);
      if (!validated.ok) {
        throw new RuntimeContractError(
          `Claim 200 khong qua validator (${validated.reason}): ${validated.detail}`,
          validated.reason,
        );
      }
      // Đối chiếu định danh: một `200` cho `delivery_id` khác là material sai delivery, và gửi
      // payload của A tới endpoint của B là vi phạm SR-002 (recipient sai). Ở tầng này nó là
      // contract violation — không phải một claim hợp lệ.
      if (validated.claim.delivery_id !== deliveryId) {
        throw new RuntimeContractError(
          'Claim 200 tra delivery_id khac voi delivery_id da claim.',
          'identity_mismatch',
        );
      }
      return { kind: 'won', claim: validated.claim as DeliveryClaim };
    }

    if (status === 409) {
      const body = await readJson(response, 'claim 409');
      const validated = validateClaimRejection(body);
      if (!validated.ok) {
        // `unknown_reason` ở đây **không** phải một no-op: đó là peer lệch vocabulary, và
        // nhánh cần hành động là bounded retry → DLQ chứ không phải ACK mù.
        throw new RuntimeContractError(
          `Claim 409 khong qua validator (${validated.reason}): ${validated.detail}`,
          validated.reason,
        );
      }
      return { kind: 'lost', rejection: toClaimRejectionPort(validated.rejection) };
    }

    throw statusToError(status, 'claim');
  }

  /** `POST /internal/deliveries/:delivery_id/release` — trả lease về `queued`. */
  async release(deliveryId: string, dispatchGeneration: number): Promise<FencedWritePortResult> {
    const body = { dispatch_generation: dispatchGeneration };
    const response = await this.#send('POST', deliveryRoute(deliveryId, RELEASE_SUFFIX), body);
    const status = response.status;

    if (status === 200) {
      const payload = await readJson(response, 'release 200');
      const validated = validateReleaseAck(payload);
      if (!validated.ok) {
        throw new RuntimeContractError(
          `Release 200 khong qua validator (${validated.reason}): ${validated.detail}`,
          validated.reason,
        );
      }
      return { kind: 'applied' };
    }

    if (status === 409) {
      return toFencedWrite(await readJson(response, 'release 409'));
    }

    throw statusToError(status, 'release');
  }

  /** `POST /internal/deliveries/:delivery_id/outcome` — kết cục `delivered`/`failed`. */
  async writeOutcome(
    deliveryId: string,
    dispatchGeneration: number,
    outcome: DeliveryOutcomeValue,
  ): Promise<FencedWritePortResult> {
    const body = { dispatch_generation: dispatchGeneration, outcome };
    const response = await this.#send('POST', deliveryRoute(deliveryId, OUTCOME_SUFFIX), body);
    const status = response.status;

    if (status === 200) {
      const payload = await readJson(response, 'outcome 200');
      const validated = validateOutcomeAck(payload);
      if (!validated.ok) {
        throw new RuntimeContractError(
          `Outcome 200 khong qua validator (${validated.reason}): ${validated.detail}`,
          validated.reason,
        );
      }
      // `OutcomeAck` có `status` chứ không phải `outcome` (docs §8.1: `200 → { "status":
      // "delivered" | "failed", … }`), nên so bằng `status` — đọc `ack.outcome` là `undefined`
      // và mọi outcome `delivered` sẽ bị từ chối oan.
      if (validated.ack.delivery_id !== deliveryId || validated.ack.status !== outcome) {
        throw new RuntimeContractError(
          'Outcome 200 tra delivery_id hoac outcome khac voi request.',
          'identity_mismatch',
        );
      }
      return { kind: 'applied' };
    }

    if (status === 409) {
      return toFencedWrite(await readJson(response, 'outcome 409'));
    }

    throw statusToError(status, 'outcome');
  }

  /**
   * `POST /internal/subscriptions/:subscription_id/invalidate` — thân **rỗng**.
   *
   * ⚠️ `404` ở đây là **subscription không tồn tại** (`no_op`), **không** phải thiếu xác thực:
   * control plane trả `401` ở `guard` **trước** lookup, nên một `404` tới đây đã là một caller đã
   * xác thực mà subscription không tồn tại — và "không có gì để disable" là `no_op`, không phải
   * lỗi credential. Đọc sai hai thứ đó là một lỗi phân loại khiến operator đi tìm secret sai.
   */
  async invalidateSubscription(
    subscriptionId: string,
  ): Promise<'disabled' | 'no_op' | 'auth_rejected'> {
    const response = await this.#send('POST', subscriptionRoute(subscriptionId), null);
    const status = response.status;

    if (status === 200) {
      const payload = await readJson(response, 'invalidate 200');
      const validated = validateInvalidateAck(payload);
      if (!validated.ok) {
        throw new RuntimeContractError(
          `Invalidate 200 khong qua validator (${validated.reason}): ${validated.detail}`,
          validated.reason,
        );
      }
      if (validated.ack.subscription_id !== subscriptionId) {
        throw new RuntimeContractError(
          'Invalidate 200 tra subscription_id khac voi subscription_id da yeu cau.',
          'identity_mismatch',
        );
      }
      return 'disabled';
    }

    if (status === 404) {
      return 'no_op';
    }

    const error = statusToError(status, 'invalidate');
    if (error instanceof RuntimeAuthResolutionError) {
      return 'auth_rejected';
    }
    throw error;
  }

  /**
   * Dựng request có xác thực rồi gửi qua Service Binding.
   *
   * ⚠️ **Thứ tự**: resolve secret **trước** khi dựng `Request` — không có đường nào tới
   * `binding.fetch` mà chưa qua {@link resolveRuntimeSharedSecret}.
   *
   * ⚠️ Thân serialize **một lần** và đưa **cùng một** chuỗi đó vào `Request`. `release`/`outcome`
   * không ký thân (không HMAC ở đây), nhưng vẫn chỉ có một nguồn byte để một test khẳng định thân
   * đúng trên dây.
   */
  async #send(
    method: 'POST',
    route: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    const secret = resolveRuntimeSharedSecret(this.#env);

    const url = new URL(route, RUNTIME_ORIGIN);
    const request = new Request(url, {
      method,
      ...(body === null
        ? {}
        : { headers: { 'content-type': CONTENT_TYPE_JSON }, body: JSON.stringify(body) }),
    });

    // Canonical path lấy từ URL cuối cùng của chính request này, không từ `route`: `Request`/URL
    // mới là thứ quyết định byte nào thực sự đi trên dây.
    const requestUrl = new URL(request.url);
    if (`${requestUrl.pathname}${requestUrl.search}` !== route) {
      // Dot-segment đã bị URL parser bỏ → route trên dây khác route dự kiến. Fail-closed.
      throw new RuntimeContractError(
        'Dinh danh lam doi cau truc route cua private delivery runtime API.',
        'invalid_identifier',
      );
    }

    for (const header of RUNTIME_AUTH_HEADERS) {
      request.headers.set(header, secret);
    }
    request.headers.set(RUNTIME_PRINCIPAL_HEADER, RUNTIME_CALLER_PRINCIPAL);

    try {
      return await this.#binding.fetch(request);
    } catch (error) {
      // Binding không tới được (control plane deploy lại, Service Binding hỏng). Đây là
      // `RuntimeTransportError` — transient, **không** phải contract: không có byte trả về để
      // validate, và retry là hành vi đúng (FR-017).
      const detail = error instanceof Error ? error.name : typeof error;
      throw new RuntimeTransportError(
        `Khong goi duoc private delivery runtime API qua Service Binding (${detail}).`,
      );
    }
  }
}

/**
 * Đọc body JSON của một response.
 *
 * ⚠️ Body không đọc được là `RuntimeTransportError` chứ **không** phải `RuntimeContractError`:
 * đây là một response hỏng ở tầng transport (body bị cắt, content-encoding lạ), và chữ ký của nó
 * trong stack là "peer trả về thứ không parse được", không phải "peer trả vocabulary lạ".
 *
 * ⚠️ Nội dung body **không** đưa vào message: nó có thể chứa material của một response hỏng mà
 * ta không nên lưu log (SR-003). Chỉ nêu operation.
 */
async function readJson(response: Response, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new RuntimeTransportError(`Khong doc duoc body cua ${label}.`);
  }
  if (text.length === 0) {
    throw new RuntimeContractError(`${label} co body rong.`, 'invalid_payload');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeContractError(`${label} co body khong phai JSON.`, 'invalid_payload');
  }
}

/**
 * Body `409` của `release`/`outcome` → kết quả fenced write.
 *
 * ⚠️ `validateLeaseFencedRejection` **yêu cầu** `state` khi `reason = 'terminal'` (quy tắc
 * `state` chung với claim contract, `push-notification/01-architecture.md` §8.1). Control plane
 * hiện trả `json({ reason })` không kèm `state`, nên một `409 terminal` sẽ thành
 * `RuntimeContractError` → bounded retry → DLQ. Đó là hành vi **fail-closed có chủ đích**:
 * nuốt thiếu `state` là tạo ra một thứ dialect thứ hai che mất một sai lệch đang tồn tại. Đã báo
 * như một finding; sửa đúng là ở phía control plane.
 */
function toFencedWrite(body: unknown): FencedWritePortResult {
  const validated = validateLeaseFencedRejection(body);
  if (!validated.ok) {
    throw new RuntimeContractError(
      `Write 409 khong qua validator (${validated.reason}): ${validated.detail}`,
      validated.reason,
    );
  }
  return { kind: 'rejected', reason: validated.rejection.reason };
}

/** Cắt `ClaimRejection` của contracts xuống đúng hai field mà port khai. */
function toClaimRejectionPort(rejection: ClaimRejection): ClaimRejectionPort {
  return rejection.state === undefined
    ? { reason: rejection.reason }
    : { reason: rejection.reason, state: rejection.state };
}

/**
 * Phân loại một status **không thuộc tập đã biết** của operation.
 *
 * ⚠️ `401`/`403` → {@link RuntimeAuthResolutionError}: credential của worker bị từ chối là một
 * sự cố cấu hình/secret (secret lệch giữa hai Worker, hoặc đã rotate một bên), và nó phải hiện ở
 * mức `runtime_resolution_errors` + log `error` để operator trả lời được "rotate secret hay
 * control plane chết" — tách nó khỏi `RuntimeTransportError` (`warn`) là chính lý do hai lớp lỗi
 * này tồn tại.
 *
 * ⚠️ `5xx` → {@link RuntimeTransportError}: transient, retry (FR-017). Mọi status còn lại
 * (`400`, `404`, `429`, `3xx`…) → {@link RuntimeContractError}: không có nhánh hành động nào
 * được chốt cho chúng, và coi một status chưa chốt là "transient rồi retry mù" là chọn một
 * hành vi mà docs chưa cho phép.
 */
function statusToError(status: number, operation: string): Error {
  if (status === 401 || status === 403) {
    return new RuntimeAuthResolutionError(
      `Private delivery runtime API tu choi credential cua worker (${operation} → ${status}).`,
    );
  }
  if (status >= 500) {
    return new RuntimeTransportError(
      `Private delivery runtime API tra loi loi phia server (${operation} → ${status}).`,
    );
  }
  return new RuntimeContractError(
    `Private delivery runtime API tra status ngoai tap da bien (${operation} → ${status}).`,
    'unexpected_status',
  );
}
