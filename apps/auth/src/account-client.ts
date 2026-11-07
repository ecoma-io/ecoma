import {
  type AccountStatusResponse,
  type AccountStatusResponseValue,
  isAccountStatusResponseValue,
} from '@ecoma-io/account-contracts';
import {
  type SessionVerifiedRequest,
  type SessionVerifiedResponse,
  type VerifyFailureReason,
  NONCE_TTL_BUFFER_SECONDS,
  createNonce,
  resolveSkewSeconds,
  signRequest,
  verifyRequest,
} from '@ecoma-io/auth-contracts';
import { createPostgresClient, recordNonce } from '@ecoma-io/auth-infrastructure';

/**
 * Client gọi ngược `account` qua contract nội bộ `auth → account`.
 *
 * ⚠️ **Fail-closed là điều kiện sống còn, không phải tinh chỉnh.** Hai hàm dưới
 * đây NÉM khi Account không trả lời hoặc trả lời sai hợp đồng. Chúng không bao
 * giờ trả một giá trị mặc định "không rõ" — vì tầng trên sẽ đọc nó như một câu
 * trả lời, và "coi như khoẻ" là một lỗ hổng do một sự cố hạ tầng.
 *
 * ⚠️ **Service Binding KHÔNG phải một authenticator.** Đo được: binding không
 * mang header nào và không mang `cf`. Nên mọi request này đều ký HMAC với
 * `AUTH_INTERNAL_SECRET`.
 *
 * ⚠️ **Thứ tự kiểm của `verifyRequest` là timestamp (định dạng + skew) TRƯỚC chữ ký** — xem
 * thứ tự trong `libs/internal-auth-contracts/src/internal-auth.ts`. Comment ở đây từng ghi ngược
 * lại ("kiểm chữ ký trước cả kiểm skew"), đúng với bản `auth` cũ nhưng sai với bản hợp nhất.
 * Ai đọc comment đó rồi suy ra thứ tự của `reason` sẽ suy sai: một envelope quá cũ trả
 * `bad_timestamp` mà **không** chạm tới bước kiểm chữ ký, nên log sẽ không bao giờ thấy
 * `bad_signature` cho envelope hết hạn.
 */

/**
 * Fetch của Service Binding.
 *
 * ⚠️ Khai đúng chữ ký `fetch(input, init)` của Cloudflare. Thu hẹp thành
 * `fetch(request)` sẽ khiến không nơi nào truyền được `init.signal` — và
 * không có signal thì không có timeout, tức là một Account unreachable treo
 * request tới hết thời hạn Worker.
 */
export interface AccountServiceBinding {
  fetch: (input: Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Timeout cho một lần gọi Account.
 *
 * ⚠️ Không có timeout thì một request treo giữ chân Worker tới hết thời hạn
 * của isolate. Có timeout thì lỗi là "không gọi được" — vẫn fail-closed, và
 * fail nhanh hơn.
 */
const ACCOUNT_TIMEOUT_MS = 3_000;

/**
 * Timeout connect (giây) cho pool dùng trong `makeNonceGuard`.
 *
 * Pool này chỉ dùng cho **một câu** `recordNonce` rồi `end()` ngay — không tái dùng. Một
 * `connect_timeout` dài (mặc định 30s của driver) giữ request treo tới hết thời hạn Worker
 * khi origin không kết nối được, còn timeout ngắn (2s) làm fail nhanh thành
 * `db_unreachable` ⇒ 503, đúng tinh thần fail-closed nhưng không làm chậm vô ích.
 *
 * ## Vì sao vẫn là hằng số 2 giây, không phải config
 *
 * ⚠️ Đây là quyết định **giữ nguyên**, có lý do, không phải một con số bị bỏ quên:
 *
 * - Nó nằm dưới mọi mốc thời gian của nền tảng đang áp cho đường này: HD10 (initial connect
 *   timeout 15s) và `ACCOUNT_TIMEOUT_MS` (3s) của chính file này. Vượt 3s là vô nghĩa — request
 *   đã bị cắt trước khi một connect 3s kịp hoàn tất, nên không có ngân sách nào để tăng.
 * - Nó là hằng của **một** đường (replay guard), không phải tham số vận hành: không có tình
 *   huống production nào cần chỉnh riêng nó mà không chỉnh cả `ACCOUNT_TIMEOUT_MS`. Thêm một
 *   biến môi trường nữa là thêm một cách cấu hình sai mà không thêm khả năng nào.
 * - Bootstrap Hyperdrive sau khi `warm` là hàng chục mili giây, không phải hàng giây; 2s là
 *   biên rộng cho một lần kết nối *đã được thiết lập sẵn* ở phía Hyperdrive.
 *
 * `export` để test khoá được bất biến "dương và dưới ngân sách request" — một hằng số không
 * ai kiểm là một hằng số sẽ bị sửa.
 */
export const NONCE_CLAIM_CONNECT_TIMEOUT_SECONDS = 2;

/**
 * Ký một request nội bộ theo canonical envelope.
 *
 * ⚠️ Canonical string phải khớp CHÍNH XÁC thứ mà phía nhận dựng lại, kể cả query string
 * và cả body. Vì vậy `path` phải là pathname + search, và `body` phải là **đúng mảng byte
 * sẽ gửi** — không phải chuỗi mà người gọi *định* gửi.
 *
 * ⚠️ **Trả về cả `headers` lẫn `body` để hai thứ đó không thể lệch nhau.** Đây là lý do
 * hàm không chỉ trả `Headers`: nếu call site tự encode lại body sau khi ký, nó có cơ hội
 * gửi một mảng byte khác với mảng đã băm (`TextEncoder` là hàm thuần nên hai lần encode
 * cùng một chuỗi cho cùng kết quả — nhưng chỉ khi call site thực sự encode *cùng chuỗi
 * đó*, và không có gì trong kiểu buộc điều ấy). Trả cả hai thì "ký byte nào, gửi byte ấy"
 * là một sự thật của cấu trúc, không phải một quy ước phải nhớ.
 *
 * ⚠️ Timestamp là **epoch giây** (theo `libs/auth-contracts`), không phải ms như
 * version cũ của file này — hai bên đã từng dùng hai đơn vị và back-channel không bao
 * giờ nào verify được nhau.
 */
export async function signInternalRequest(params: {
  secret: string;
  /** `kid` của khoá đang ký — tuỳ chọn (transition: sender chưa bật `kid`). */
  kid?: string;
  method: string;
  path: string;
  body: Uint8Array;
  nowMs: number;
}): Promise<{ headers: Headers; body: Uint8Array }> {
  const timestamp = String(Math.floor(params.nowMs / 1000));
  const nonce = createNonce();

  const headers = await signRequest({
    method: params.method,
    path: params.path,
    body: params.body,
    secret: params.secret,
    kid: params.kid,
    timestamp,
    nonce,
  });

  return {
    headers: new Headers({
      'content-type': 'application/json',
      ...headers,
    }),
    body: params.body,
  };
}

/**
 * Xác thực một request nội bộ đi vào.
 *
 * ⚠️ Đây là hàng phòng thủ DUY NHẤT cho các endpoint nội bộ. Mọi nhánh trả `false` đều
 * là từ chối — không có "thiếu header thì cho qua để dev test".
 *
 * ⚠️ **`hyperdrive` là bắt buộc, không có giá trị `null`.** Trước đây tham số này nhận
 * `{...} | null` và nhánh `null` truyền cho `verifyRequest` một callback `() => false` —
 * tức là "coi như nonce chưa từng thấy" cho mọi request. Đó không phải fail-closed mà là
 * một cửa sổ replay vô hạn, và nó **bỏ qua** yêu cầu của giao thức: khi không thực hiện
 * được chống replay bền thì phải từ chối request, không được đi vòng qua guard.
 *
 * Nhánh đó cũng không bao giờ chạy trong thực tế: `loadAuthConfig` ném khi binding
 * Hyperdrive thiếu (`apps/auth/src/config.ts`), và `main.ts` truyền thẳng
 * `config.hyperdrive`. Tức là type khai một khả năng mà đường chạy thật không có, đổi lại
 * là một lỗ hổng chờ được kích hoạt bởi người gọi tiếp theo. Bỏ hẳn nhánh đó đi thì
 * "không có kho nonce" trở thành **lỗi type**, không còn là hành vi lúc chạy.
 * ⚠️ **`body` là byte thô, không phải chuỗi.** Call site đọc body từ dây và truyền thẳng mảng
 * byte đó xuống; hàm này không decode (và không có đường nào để nó decode — xem
 * `libs/internal-auth-contracts/src/internal-auth.ts`). Decode ở đây là biến chữ ký thành chữ ký
 * của một ảnh chiếu mất thông tin của payload, đúng lỗi mà PR này sửa.
 */
export async function isAuthenticatedInternalRequest(params: {
  secret: string;
  /**
   * Resolver secret theo `kid` — tuỳ chọn, dùng để nhận envelope có `kid` trong transition.
   *
   * ⚠️ Cast map kid → secret: không có `kid` trên wire ⇒ dùng `params.secret` (secret
   * hiện hành); có `kid` mà resolver từ chối ⇒ `bad_signature` từ lib.
   */
  secretByKid?: (kid: string) => Promise<string>;
  request: Request;
  body: Uint8Array;
  nowMs: number;
  hyperdrive: { connectionString: string };
  skewSeconds?: number;
}): Promise<
  { ok: true; nonce: string } | { ok: false; reason: VerifyFailureReason | 'db_unreachable' }
> {
  const url = new URL(params.request.url);
  // ⚠️ **Chuẩn hoá skew MỘT LẦN, rồi dùng đúng con số đó cho cả hai chỗ.**
  //
  // Cửa sổ timestamp do `verifyRequest` quyết định, còn TTL của nonce do `makeNonceGuard`
  // ghi vào DB (`timestamp + skew + buffer`). Hai chỗ phải nhận cùng một skew, nếu không
  // thì chiều lệch nguy hiểm là TTL **ngắn hơn** cửa sổ replay: nonce đã hết hạn trong khi
  // envelope vẫn phát lại được, và prune xoá nó — mở lại đúng cửa sổ mà kho nonce sinh ra
  // để đóng. `verifyRequest` tự chuẩn hoá `NaN`/`Infinity`/skew âm về `DEFAULT_SKEW_SECONDS`
  // ở bên trong, nên truyền thẳng giá trị thô vào `makeNonceGuard` là hai luật khác nhau
  // cho cùng một hằng số. `resolveSkewSeconds` là **đúng hàm** lib dùng, nên hai bên không
  // thể lệch.
  const skewSeconds = resolveSkewSeconds(params.skewSeconds);
  // `verifyRequest` nhận object thuần, không nhận `Headers`: kiểu của hợp đồng là
  // `Readonly<Record<string, string | null | undefined>>` để adapter nào cũng truyền được,
  // mà `Headers` thì không gán được vào đó. Duyệt một lần — không đưa thẳng object DOM vào.
  const headers: Record<string, string | null> = {};
  params.request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  try {
    const result = await verifyRequest({
      method: params.request.method,
      path: url.pathname + url.search,
      body: params.body,
      headers,
      secret: params.secret,
      secretByKid: params.secretByKid,
      now: String(Math.floor(params.nowMs / 1000)),
      skewSeconds,
      claimNonce: makeNonceGuard(params.hyperdrive, skewSeconds),
    });

    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, nonce: result.nonce };
  } catch {
    // ⚠️ **DB unreachable ⇒ 503, không bao giờ 401.** `claimNonce` là đường duy nhất
    // vào kho nonce; nếu nó ném (Hyperdrive fail, pool timeout, connection error) thì
    // `verifyRequest` không thể khẳng định "nonce chưa từng thấy" — và khẳng định điều
    // đó bằng `false` sẽ mở cửa sổ replay vĩnh viễn. Fail-closed nghĩa là **từ chối**,
    // không phải "coi như chưa thấy".
    //
    // Không ràng buộc biến lỗi: không có discriminator nào phân biệt được "lỗi đến từ
    // kho nonce" với lỗi khác, nên mọi nhánh đều là `db_unreachable`. Giữ một binding
    // không dùng chỉ tạo cảm giác đã phân loại.
    //
    // Lỗi DB ở đây không được nối vào response body: message driver có thể chứa
    // connection string (SR-001). Mã `db_unreachable` là đủ để phân loại.
    return { ok: false, reason: 'db_unreachable' } as const;
  }
}

/**
 * Nonce store durable cho `auth` — bảng `auth.internal_nonces` của `db-auth`.
 *
 * ⚠️ `verifyRequest` bắt buộc nhận callback `claimNonce` (trước đây tên là `seenNonce` — lib
 * đổi tên để ép mọi implementer chú ý: hợp đồng là **chiếm-ghi nguyên tử**, không phải
 * predicate chỉ-đọc), và đó là cơ chế **chống replay** duy nhất bên cạnh cửa sổ timestamp:
 * timestamp chỉ giới hạn replay trong một khoảng, còn nonce mới là thứ làm một request đã
 * dùng không dùng lại được trong khoảng đó. Cache node-local không thay thế được: Hyperdrive
 * không hỗ trợ advisory lock (`04-platform-facts.md` HD6) và node-local application state là
 * vi phạm non-negotiable architecture.
 *
 * Hợp đồng của callback là **kiểm tra và ghi**, không chỉ kiểm tra — nên {@link recordNonce}
 * chèn bằng `INSERT … ON CONFLICT DO NOTHING` rồi đếm số hàng trả về, tức là một câu lệnh
 * nguyên tử. Cài bằng `SELECT` rồi `INSERT` ở câu khác sẽ cho hai request cùng nonce cùng
 * thắng dưới tải đồng thời, và replay guard trở thành trang trí.
 *
 * Callback nhận **hai** tham số theo hợp đồng đã mở rộng của `verifyRequest`:
 * `(nonce, timestampSeconds)` — tham số thứ hai là timestamp của envelope, đã qua kiểm
 * định dạng và cửa sổ skew. `expires_at` neo theo mốc đó chứ không theo đồng hồ của verifier:
 * cửa sổ replay của envelope kết thúc tại `timestamp + skew`, nên TTL `timestamp + skew +
 * buffer` sống qua cửa sổ đúng bằng buffer. Neo theo `now` của ta thì lệch được khi hai
 * đồng hồ lệch nhau.
 *
 * ⚠️ **Pool không được dùng lại giữa các lần gọi, và không được dựng trước.** `auth`
 * không có `withRequestPool` (đó là pattern của Nitro app `account`); Worker của `auth` là
 * Hono trên Cloudflare, và `createPostgresClient` của `libs/auth-infrastructure`
 * tạo pool `max: 3` với `prepare: false` (HD6). Guard này **tạo một pool cho mỗi lần
 * callback được gọi** và `end()` nó ngay trong `finally` — xem giải thích trong thân hàm.
 * Không giữ pool ở module scope (runtime:edge cấm node-local state).
 */
export function makeNonceGuard(
  hyperdrive: { connectionString: string },
  skewSeconds: number,
): (nonce: string, timestampSeconds: number) => Promise<boolean> {
  // ⚠️ **Pool được dựng LƯỜI, trong lần gọi đầu, và `end()` ngay trong `finally` của
  // chính lần gọi đó.** Hai lý do, và cả hai đều là lỗi đã có ở bản dựng pool ngay
  // trong factory:
  //
  //   1. **Không còn pool nào sống sót qua lần gọi.** `verifyRequest` chỉ gọi
  //      callback này ở nhánh **chữ ký hợp lệ** (xem JSDoc của `claimNonce`), nên một
  //      envelope giả không bao giờ chạm tới đây. Dựng pool trong factory thì mỗi
  //      request bị từ chối vì chữ ký vẫn mở một pool rồi đóng — đúng thứ một kẻ tấn
  //      công muốn: đốt connection của ta bằng request rẻ tiền. Hyperdrive soft-limit
  //      ~20 origin connection (HD9), nên đó là đường từ chối dịch vụ.
  //   2. **Callback gọi lần thứ hai không còn là một cái bẫy.** Bản cũ trả về một
  //      closure đóng `pool`; `finally` của lần gọi đầu `end()` pool đó, nên lần gọi
  //      thứ hai chạy trên pool đã đóng và **luôn ném** — mà ném ở đây bị
  //      `isAuthenticatedInternalRequest` dịch thành `db_unreachable` ⇒ 503. Một
  //      callback "chỉ dùng được một lần" là hợp đồng `claimNonce` bị phá một cách im
  //      lặng. Giờ mỗi lần gọi một pool, và không lần gọi nào phụ thuộc lần trước.
  //
  // Không giữ pool ở module scope: node-local state có ý nghĩa bảo mật là vi phạm
  // non-negotiable architecture (`runtime:edge`).
  return async (nonce: string, timestampSeconds: number): Promise<boolean> => {
    const pool = createPostgresClient(hyperdrive, {
      connectTimeoutSeconds: NONCE_CLAIM_CONNECT_TIMEOUT_SECONDS,
    });
    try {
      // `verifyRequest` đã kiểm timestamp nằm trong cửa sổ trước khi gọi callback này, nên
      // timestamp luôn hợp lệ ở đây. TTL neo theo **timestamp của envelope** (tham số thứ hai)
      // chứ không theo đồng hồ của ta: cửa sổ replay kết thúc đúng tại `timestamp + skew`, nên
      // `timestamp + skew + buffer` sống qua cửa sổ đúng bằng buffer — không cần đoán lệch
      // đồng hồ giữa caller và verifier. Buffer cho prune chạy theo lô không đúng lúc.
      return await recordNonce(
        pool,
        nonce,
        timestampSeconds + skewSeconds + NONCE_TTL_BUFFER_SECONDS,
      );
    } finally {
      await pool.end();
    }
  };
}

/**
 * Lỗi hạ tầng khi gọi `account` (binding chết, timeout, HTTP non-OK, body sai hợp đồng).
 *
 * Dùng class riêng để `isInfrastructureError` ở `main.ts` không phải đoán theo
 * `Error.name === 'PostgresError'` (chỉ đúng cho driver postgres.js) hay theo
 * nội dung message — đây là dependency adapter khác, không tạo `PostgresError`.
 */
export class AccountDependencyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AccountDependencyError';
  }
}

/** Client `auth → account`. */
export class AccountClient {
  readonly #binding: AccountServiceBinding;
  readonly #secret: string;
  /** `kid` gắn trên mọi envelope đi ra — `undefined` khi transition chưa bật `kid`. */
  readonly #kid: string | undefined;

  constructor(params: { binding: AccountServiceBinding; secret: string; kid?: string }) {
    this.#binding = params.binding;
    this.#secret = params.secret;
    this.#kid = params.kid;
  }

  /**
   * `POST /internal/session/verified` — `account` báo identity đã xác minh.
   *
   * ⚠️ Hợp đồng này CHƯA được `account` (PR #173) cài đặt, nên hàm này chưa có
   * đường chạy thật. Nó được viết và kiểm thử theo shape trong contracts, và
   * PR ghi rõ là chưa đối chiếu được với phía nhận. Xem PR body §Blockers.
   */
  async announceSessionVerified(params: {
    request: SessionVerifiedRequest;
    nowMs: number;
  }): Promise<SessionVerifiedResponse> {
    return this.#post('/internal/session/verified', params.request, params.nowMs);
  }

  /**
   * `GET /internal/account/status` — control point fail-closed lúc phát hành.
   *
   * ⚠️ Ném khi Account không trả lời, trả lỗi, hoặc trả body không đúng hợp
   * đồng. Mọi nhánh đều thành "không phát hành", không bao giờ thành "khoẻ".
   *
   * ⚠️ **Tham số trên wire là `sub`, không phải `account_id`.** `accountId` chỉ
   * là tên nội bộ của `auth` cho **chính subject đó** — `authorization-service`
   * gán thẳng `claims.sub = accountId` khi phát token, và `account.users.sub`
   * là PRIMARY KEY mà `account` tra cứu (`SELECT status FROM account.users
   * WHERE sub = $1`). Hai tên này ứng với hai việc khác nhau: đổi `accountId`
   * ở đây là đổi tên biến, còn đổi tham số URL là đổi hợp đồng với provider.
   *
   * Không nhận thêm `account_id` ở phía provider: hai tên cho một hợp đồng là
   * hai đường để chúng lệch nhau lần nữa (#208).
   */
  async checkStatus(params: {
    accountId: string;
    nowMs: number;
  }): Promise<AccountStatusResponseValue> {
    const body: AccountStatusResponse = await this.#get(
      `/internal/account/status?sub=${encodeURIComponent(params.accountId)}`,
      params.nowMs,
    );

    if (!isAccountStatusResponseValue(body.status)) {
      throw new Error('Account tra ve status khong thuoc allowlist cua contract');
    }
    return body.status;
  }

  async #get<T>(path: string, nowMs: number): Promise<T> {
    const signed = await signInternalRequest({
      secret: this.#secret,
      kid: this.#kid,
      method: 'GET',
      path,
      body: new Uint8Array(),
      nowMs,
    });
    return this.#send<T>(path, { method: 'GET', headers: signed.headers });
  }

  async #post<T>(path: string, payload: unknown, nowMs: number): Promise<T> {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const signed = await signInternalRequest({
      secret: this.#secret,
      kid: this.#kid,
      method: 'POST',
      path,
      body,
      nowMs,
    });
    return this.#send<T>(path, { method: 'POST', headers: signed.headers, body: signed.body });
  }

  /**
   * Gửi và đọc JSON, với timeout.
   *
   * ⚠️ `AbortSignal.timeout` là lý do ta cần `nodejs_compat`/platform timers ở
   * đây — và lý do timeout KHÔNG được bỏ: một Account unreachable sẽ treo
   * request cho tới khi hết thời hạn Worker, và fail-closed lúc đó thành "chậm"
   * thay vì "dừng".
   */
  async #send<T>(
    path: string,
    init: { method: string; headers: Headers; body?: Uint8Array },
  ): Promise<T> {
    // ⚠️ `init.body` là `Uint8Array` trần, nên kiểu của nó là `Uint8Array<ArrayBufferLike>` —
    // và `BodyInit` của lib DOM chỉ nhận view gắn đúng `ArrayBuffer`. Sao chép sang một view
    // như vậy là cách đúng cho mọi backing buffer (kể cả `SharedArrayBuffer`), không cần một
    // khẳng định kiểu nào có thể sai, và **byte gửi đi vẫn đúng bằng byte đã ký** vì đây là
    // phép sao chép nguyên byte. Thân request nội bộ là JSON nhỏ, nên chi phí này không đáng kể.
    const request = new Request(`https://account.internal${path}`, {
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : new Uint8Array(init.body),
    });
    let response: Response;
    try {
      response = await this.#binding.fetch(
        request,
        // ⚠️ Timeout phải đi qua `init.signal`: Service Binding không có socket
        // timeout mặc định, nên đây là giới hạn duy nhất. Không có nó thì một
        // Account unreachable treo request tới hết thời hạn Worker, và
        // fail-closed lúc đó thành "chậm" thay vì "dừng".
        { signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS) },
      );
    } catch (error) {
      // Binding chết / timeout / mạng — fail-closed, nhưng là hạ tầng, không phải bug.
      const cause = error instanceof Error ? error : undefined;
      throw new AccountDependencyError(
        `Account khong goi duoc cho ${path}: ${cause?.message ?? String(error)}`,
        cause !== undefined ? { cause } : undefined,
      );
    }

    if (!response.ok) {
      throw new AccountDependencyError(
        `Account tra ve ${response.status} cho ${path}; auth fail-closed khong phat hanh token`,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new AccountDependencyError(
        `Account tra ve body khong phai JSON cho ${path}; auth fail-closed`,
        cause !== undefined ? { cause } : undefined,
      );
    }
  }
}
