/**
 * Signed internal delivery client của `transactional-mailer-job`.
 *
 * Client gọi private delivery interface của `transactional-mail` qua **Service Binding**
 * (dependency injection), không dùng hostname công khai và không đọc D1:
 * - `GET  /internal/deliveries/:delivery_id`
 * - `POST /internal/deliveries/:delivery_id/outcome`
 *
 * ## Giao thức ký
 *
 * Client **không** tự dựng canonical string, không tự băm thân và không tự định dạng chữ
 * ký: cả ba việc đó thuộc `signRequest`/`verifyRequest` trong `@ecoma-io/internal-auth-contracts`
 * — bản canonical của giao thức, không qua facade nào. Việc chép lại
 * bất kỳ tầng nào trong ba tầng đó là tạo ra một giao thức thứ hai lệch phiên bản — đúng thứ
 * PR hợp nhất envelope đã dẹp.
 *
 * Header chỉ gồm đúng ba header mà `signRequest` trả về, gắn **nguyên văn** từ kết quả đó:
 * `x-ecoma-internal-timestamp`, `x-ecoma-internal-nonce`, `x-ecoma-internal-signature`.
 * Client **không** tự thêm `X-ECOMA-PRINCIPAL`/`X-ECOMA-APP` — đó là định danh do caller tự
 * khai, không phải thứ trình xác thực; định danh phía nhận phải suy ra từ credential đã
 * xác thực.
 *
 * ## Byte trên dây
 *
 * Thân POST được serialize **đúng một lần**, encode thành `Uint8Array`, rồi **cùng một mảng
 * đó** được đưa vào `signRequest` và đưa vào `Request`. Không có hai bản JSON độc lập: nếu
 * có, người nhận băm byte thứ hai trong khi phía gọi ký byte thứ nhất, và mọi request có
 * thân đều thành `bad_signature`.
 *
 * Canonical path lấy từ **URL cuối cùng của request** (chỉ `pathname` — receiver từ chối
 * query string, xem `#send`), không từ một chuỗi được chuẩn hoá riêng — hai thứ phải là
 * một, và `Request`/URL chính là thứ quyết định byte nào thật sự đi trên dây.
 *
 * ## Ranh giới trách nhiệm
 *
 * - Client **không retry**, **không phân loại lỗi mạng**, **không chuyển mã trạng thái** của
 *   phía nhận thành kết quả gửi mail. `401`/`403` từ private interface là chuyện credential
 *   nội bộ, `404` là chuyện delivery không tồn tại — cả hai đều không phải kết quả provider.
 *   Tầng gọi (W4/W5) quyết định `ack()`/`retry()`/terminal trên D1.
 * - Client **không log** secret, header `authorization`, chữ ký hay thân request: thân outcome
 *   là dữ liệu vận hành của hệ thống mail, và chữ ký là thứ có thể dùng để dựng lại envelope.
 *   Lỗi cấu hình nêu **tên** biến chứ không nêu giá trị.
 * - Client **không có** kho nonce: nonce store thuộc phía nhận
 *   (`transactional-mail`, D1 `mail`). Không có `scheduled()`/prune nào ở đây.
 */

import { signRequest, type InternalAuthHeaders } from '@ecoma-io/internal-auth-contracts';
import {
  validatePostDeliveryOutcomeRequest,
  type PostDeliveryOutcomeRequest,
} from '@ecoma-io/transactional-mail-contracts';

/**
 * `TextEncoder` khai **module-scope** thay vì dùng global từ `@cloudflare/workers-types`:
 * `encode()` của bản ambient trả `Uint8Array` (tức `Uint8Array<ArrayBufferLike>`), còn chữ
 * ký `#send` của client đòi đúng `Uint8Array<ArrayBuffer>` — kiểu mà `BodyInit` chấp nhận
 * mà không cần bản sao (xem docblock `#send`). Bản của Node lib khai trả
 * `Uint8Array<ArrayBuffer>`, nên shadow đúng kiểu đó ở đây; byte encode ra là như nhau,
 * chỉ có type là chính xác hơn. Cùng kỹ thuật `declare` module-scope với Resend/Cloudflare
 * adapter của lib này.
 */
declare const TextEncoder: {
  new (): {
    encode(input?: string): Uint8Array<ArrayBuffer>;
  };
};

/** Tên Worker Secret chứa HMAC secret dùng để ký request nội bộ. */
export const INTERNAL_AUTH_SECRET_ENV = 'TRANSACTIONAL_MAIL_INTERNAL_AUTH_SECRET';

/**
 * Origin giả của private interface.
 *
 * Chỉ dùng để dựng một URL *tương đối* hợp lệ cho `Request`/`URL`; request đi qua Service
 * Binding nên hostname này **không bao giờ** được phân giải trên DNS. Nó đặt đúng tên Worker
 * của control plane để lỗi ở tầng trên (log, `wrangler tail`) không đọc nhầm thành lời gọi
 * ra internet.
 */
const INTERNAL_ORIGIN = 'https://transactional-mail.internal';

/** Prefix path của private delivery interface — `delivery_id` phải nằm ngay sau nó. */
const DELIVERIES_PATH_PREFIX = '/internal/deliveries/';

/** Suffix path của endpoint báo kết quả gửi. */
const OUTCOME_PATH_SUFFIX = '/outcome';

const CONTENT_TYPE_JSON = 'application/json';

/** Lỗi cấu hình: thiếu hoặc rỗng Worker Secret. Lỗi này chặn request, không gửi gì. */
export class InternalDeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalDeliveryConfigError';
  }
}

/**
 * Lỗi request: thân không hợp lệ theo contract, hoặc `delivery_id` không dựng được đúng
 * route. Lỗi này phát sinh **trước** khi có byte nào được gửi.
 */
export class InternalDeliveryRequestError extends Error {
  readonly reason: string;
  readonly detail?: string;

  constructor(message: string, reason: string, detail?: string) {
    super(message);
    this.name = 'InternalDeliveryRequestError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Service Binding tới `transactional-mail`.
 *
 * Hẹp nhất có thể: chỉ `fetch`. Một binding thật còn có `connect`, `dispose`… nhưng client
 * không dùng chúng, và khai thêm nghĩa là có dấu hiệu test cần chúng.
 */
export interface InternalDeliveryBinding {
  fetch: (input: Request) => Promise<Response>;
}

export interface InternalDeliveryClientOptions {
  /** Service Binding `TRANSACTIONAL_MAIL_SERVICE` — không phải hostname công khai. */
  readonly binding: InternalDeliveryBinding;
  /** HMAC secret đọc từ Worker Secret, truyền vào qua dependency injection. */
  readonly secret: string;
  /** Đồng hồ epoch **mili** giây. Inject để test không phụ thuộc đồng hồ thật. */
  readonly now?: () => number;
}

/**
 * Đọc Worker Secret từ `env` của Worker.
 *
 * Fail closed **trước** khi gửi: thiếu, không phải chuỗi, hoặc rỗng đều ném
 * {@link InternalDeliveryConfigError}. Không có đường nào trả `undefined` để call site tự
 * quyết định, vì quyết định "không có secret thì gửi không ký" chính là lỗ hổng cần chặn.
 *
 * @param env `env` của Worker (record thường, mọi key đều `unknown`).
 * @returns Secret **nguyên văn**.
 * @throws {InternalDeliveryConfigError} Khi thiếu, sai kiểu hoặc rỗng.
 */
export function resolveInternalAuthSecret(env: Readonly<Record<string, unknown>>): string {
  const value = env[INTERNAL_AUTH_SECRET_ENV];
  if (value === undefined) {
    throw new InternalDeliveryConfigError(
      `Thieu Worker Secret ${INTERNAL_AUTH_SECRET_ENV}. Chua the nao goi private delivery interface.`,
    );
  }
  if (typeof value !== 'string') {
    throw new InternalDeliveryConfigError(
      `${INTERNAL_AUTH_SECRET_ENV} phai la chuoi, nhan duoc ${typeof value}.`,
    );
  }
  assertUsableSecret(value);
  return value;
}

/**
 * Kiểm secret dùng được; ném lỗi cấu hình nếu không. **Không** trả lại giá trị.
 *
 * ⚠️ Secret chỉ hợp lệ khi **không rỗng** và **không chỉ gồm khoảng trắng**. Secret hợp lệ
 * được giữ **nguyên văn** — không `trim`, không chuẩn hoá: `trim()` sẽ âm thầm biến secret
 * gõ thừa một dấu cách ở cuối thành secret khác, và mọi request sau đó đều là
 * `bad_signature` với lý do không ai đoán được. Chỉ dùng `trim()` để **kiểm tra**, không
 * dùng để **lưu**.
 *
 * ⚠️ **Giới hạn đã biết, cố ý không xử lý ở đây.** Secret chứa surrogate lẻ (`"\uD800"`) bị
 * `TextEncoder` thay bằng U+FFFD khi `signRequest` dùng nó làm HMAC key, nên hai secret khác
 * nhau về chuỗi nhưng cùng ảnh qua phép mã hoá đó cho ra **cùng một** key. Đây không phải
 * vector tấn công — cả hai giá trị đều do operator cấu hình — mà là một cái bẫy gõ sai hiếm;
 * `internal-auth.ts` từ chối surrogate lẻ cho các trường *của envelope* vì ở đó nó phá tính
 * đơn ánh của canonical string, còn ở đây hậu quả chỉ là hai cấu hình khác nhau trùng key.
 * Không thêm luật riêng ở tầng này để không mở một bản sao phép kiểm thứ hai.
 *
 * ⚠️ Hàm **cố ý** trả `void` thay vì trả lại secret đã kiểm. Một hàm tên `assert*` chỉ có
 * một việc là ném lỗi khi bất biến sai, nên "trả lại chính thứ vừa kiểm" là một API thừa:
 * call site nào cần giá trị thì đã có nó trong tay (xem {@link resolveInternalAuthSecret}).
 * Đổi hình dạng trả về cũng là cách đúng để tránh false positive của rule semgrep
 * `security-sensitive-value-in-http-response`: rule đó bắt mọi `return $VALUE` mà tên biến
 * khớp danh sách nhạy cảm, không phân biệt được `return` trong HTTP handler với `return`
 * của một hàm kiểm tra cấu hình nội bộ, và repo đã chọn sửa hình dạng thay vì `nosemgrep`
 * (vì `nosemgrep` không xoá result khỏi SARIF, còn code scanning thì không tôn trọng
 * suppressions).
 *
 * @throws {InternalDeliveryConfigError} Nêu **tên** biến, không nêu giá trị.
 */
function assertUsableSecret(secret: string): void {
  if (secret.length === 0) {
    throw new InternalDeliveryConfigError(`Worker Secret ${INTERNAL_AUTH_SECRET_ENV} rong.`);
  }
  if (secret.trim().length === 0) {
    throw new InternalDeliveryConfigError(
      `Worker Secret ${INTERNAL_AUTH_SECRET_ENV} chi chua khoang trang, khong phai gia tri hop le.`,
    );
  }
  if (containsLoneSurrogate(secret)) {
    throw new InternalDeliveryConfigError(
      `Worker Secret ${INTERNAL_AUTH_SECRET_ENV} chua lone surrogate, khong phai gia tri hop le.`,
    );
  }
}

/**
 * True khi chuỗi chứa **lone surrogate** — code unit U+D800..U+DFFF không nằm trong một cặp
 * hợp lệ. Hai chuỗi khác nhau về lone surrogate (`"\uD800"` vs `"\uFFFD"`) là hai chuỗi
 * theo `===` của JS, nhưng `TextEncoder` encode **cùng byte** (U+FFFD) — cùng key material
 * HMAC ở sender và receiver chỉ vì hai giá trị secret trông "khác nhau". Fail-closed lúc
 * boot, đồng bộ với `requireCredentialSecret` của control plane (cùng lớp lỗi, cùng hành vi).
 */
function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // High surrogate: chỉ hợp lệ khi ngay sau nó là một low surrogate.
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      // Low surrogate không có high đứng trước.
      return true;
    }
  }
  return false;
}

/**
 * Dựng path của private delivery interface từ `delivery_id`.
 *
 * `encodeURIComponent` chặn `delivery_id` chèn thêm phân đoạn path, `?`, `#` hay userinfo.
 * Nhưng nó **không** mã hoá `.` và `..`, mà URL parser lại bỏ dot-segment — `..` sẽ cắt
 * `/internal/deliveries/` khỏi path và gửi request tới một route khác. Vì vậy route còn
 * được kiểm lại ở {@link InternalDeliveryClient.#send} sau khi URL đã chuẩn hoá.
 *
 * @throws {InternalDeliveryRequestError} Khi `delivery_id` không dùng được làm một phân đoạn path.
 */
function deliveryRoute(deliveryId: string, suffix: string): string {
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
    throw new InternalDeliveryRequestError(
      'delivery_id rong hoac khong phai chuoi',
      'invalid-delivery-id',
    );
  }
  let encoded: string;
  try {
    encoded = encodeURIComponent(deliveryId);
  } catch {
    // `encodeURIComponent` ném `URIError` với surrogate lẻ (`"\uD800"`). Đó là input hỏng,
    // không phải lỗi hệ thống — cùng một lớp lỗi với `delivery_id` rỗng.
    throw new InternalDeliveryRequestError(
      'delivery_id khong ma hoa duoc thanh mot phan doan path',
      'invalid-delivery-id',
    );
  }
  return `${DELIVERIES_PATH_PREFIX}${encoded}${suffix}`;
}

/**
 * Ký một request nội bộ, trả **đúng ba header** mà `signRequest` sinh ra.
 *
 * Timestamp là epoch **giây** dạng chuỗi chữ số thập phân (`verifyRequest` từ chối mọi thứ
 * khác, kể cả ISO string và epoch mili giây). Nonce do `signRequest` sinh — mỗi request một
 * nonce, không có bộ header đã ký nào được cache lại.
 *
 * @param body Đúng byte sẽ đi trên dây; `null` cho GET (thân rỗng).
 */
async function signDeliveryRequest(params: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array | null;
  readonly nowMs: number;
}): Promise<InternalAuthHeaders> {
  const timestamp = String(Math.floor(params.nowMs / 1000));
  return signRequest({
    method: params.method,
    path: params.path,
    body: params.body,
    secret: params.secret,
    timestamp,
  });
}

/**
 * Client gọi private delivery interface của `transactional-mail`.
 *
 * Mỗi instance gắn với **một** HMAC secret và **một** Service Binding; hai request khác
 * nhau vẫn ký chữ ký/nonce riêng. Client giữ đúng một state: service binding, secret và
 * đồng hồ — không cache bộ header đã ký, không giữ hàng đợi, không giữ D1 handle.
 */
export class InternalDeliveryClient {
  readonly #binding: InternalDeliveryBinding;
  readonly #secret: string;
  readonly #now: () => number;

  constructor(options: InternalDeliveryClientOptions) {
    this.#binding = options.binding;
    this.#now = options.now ?? Date.now;
    assertUsableSecret(options.secret);
    this.#secret = options.secret;
  }

  /**
   * `GET /internal/deliveries/:delivery_id`.
   *
   * Trả **nguyên** `Response` của phía nhận. Tầng gọi tự đọc status và parse body bằng
   * `validateGetDeliveryResponse`; client không chuyển đổi gì.
   *
   * @throws {InternalDeliveryRequestError} Khi `delivery_id` không tạo được route hợp lệ.
   */
  async getDelivery(deliveryId: string): Promise<Response> {
    return this.#send('GET', deliveryRoute(deliveryId, ''), null);
  }

  /**
   * `POST /internal/deliveries/:delivery_id/outcome`.
   *
   * `outcome` được validate bằng chính `validatePostDeliveryOutcomeRequest` của contract
   * **trước** khi serialize: client gửi thân đã qua contract, không phải thân tuỳ ý. Thân
   * serialize **một lần** rồi đưa cùng một mảng byte vào chữ ký và vào `Request`.
   *
   * @throws {InternalDeliveryRequestError} Khi `outcome` không hợp lệ theo contract.
   */
  async postDeliveryOutcome(
    deliveryId: string,
    outcome: PostDeliveryOutcomeRequest,
  ): Promise<Response> {
    const validated = validatePostDeliveryOutcomeRequest(outcome);
    if (!validated.ok) {
      const detail = validated.detail;
      throw new InternalDeliveryRequestError(
        `Outcome khong hop le theo contract (${validated.reason}${detail === undefined ? '' : `: ${detail}`})`,
        validated.reason,
        detail,
      );
    }
    const serialized = JSON.stringify(validated.value);
    const body = new TextEncoder().encode(serialized);
    return this.#send('POST', deliveryRoute(deliveryId, OUTCOME_PATH_SUFFIX), body);
  }

  /**
   * Ký rồi gửi, trả nguyên `Response`.
   *
   * @param route Path tuyệt đối đã dựng ở call site.
   * @param body Byte thân (đã ký và gửi là **cùng một** mảng), `null` cho GET.
   *
   * Kiểu `Uint8Array<ArrayBuffer>` (không phải `Uint8Array<ArrayBufferLike>`) là kiểu mà
   * `BodyInit` chấp nhận: `ArrayBufferLike` bao gồm `SharedArrayBuffer`, vốn không phải
   * `BufferSource` của `BodyInit`. Khai đúng ở chữ ký thì không cần `new Uint8Array(body)`
   * ở call site — và chính bản sao đó là thứ khiến mảng được ký khác mảng được gửi.
   */
  async #send(
    method: 'GET' | 'POST',
    route: string,
    body: Uint8Array<ArrayBuffer> | null,
  ): Promise<Response> {
    const url = new URL(route, INTERNAL_ORIGIN);
    const request = new Request(url, {
      method,
      ...(body === null ? {} : { headers: { 'content-type': CONTENT_TYPE_JSON }, body }),
    });

    // Canonical path lấy từ URL cuối cùng của chính request này, không lấy từ `route`:
    // `Request`/URL mới là thứ quyết định byte nào đi trên dây.
    //
    // ⚠️ Chỉ `pathname` — **không** kèm `search`: receiver của control plane từ chối mọi
    // request có query string (`url.search !== ''` → `401`) **trước** khi verify, và không
    // route nào của private delivery interface định nghĩa query param. Ký `+ search` hôm nay
    // là vô hại, nhưng ngày nào đó thêm query param vào interface thì client sẽ ký một
    // canonical mà receiver từ chối trước cả bước verify — mọi internal call hỏng `401` với
    // nguyên nhân hiển thị sai. Ghim một canonical duy nhất ở cả hai phía: test interop
    // (`main.spec.ts` phía control plane) khẳng định một request có query bị từ chối ở cả
    // hai bên với cùng lý do.
    const requestUrl = new URL(request.url);
    const canonicalPath = requestUrl.pathname;

    // URL parser bỏ dot-segment, nên `delivery_id` như `..` sẽ làm `canonicalPath` lệch với
    // route dựng ra. Fail closed thay vì ký một route khác với route dự kiến.
    if (canonicalPath !== route) {
      throw new InternalDeliveryRequestError(
        'delivery_id lam doi cau truc route private delivery interface',
        'invalid-delivery-id',
      );
    }

    const signedHeaders = await signDeliveryRequest({
      secret: this.#secret,
      method,
      path: canonicalPath,
      body,
      nowMs: this.#now(),
    });
    // Lặp trên **kết quả** của `signRequest` chứ không liệt kê lại ba tên header: thêm,
    // bớt hay đổi tên header ở contract thì chỉ có một chỗ phải sửa, và một header mới không
    // thể bị bỏ sót trong im lặng.
    for (const [name, value] of Object.entries<string>(signedHeaders)) {
      request.headers.set(name, value);
    }

    return this.#binding.fetch(request);
  }
}
