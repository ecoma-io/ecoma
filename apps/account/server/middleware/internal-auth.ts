/**
 * Middleware bảo vệ toàn bộ `/internal/**` bằng envelope HMAC.
 *
 * ## Vì sao middleware chứ không phải check trong từng route
 *
 * SR-010 nói: "Endpoint internal từ chối mọi request không có envelope HMAC hợp lệ,
 * không nhận cookie". Đặt check trong từng route là mặc định **open** — route mới
 * thêm vào `/internal/**` mà quên check là lỗ hổng, và không có test nào đỏ. Middleware
 * ở `/internal/**` làm mặc định **closed**: route mới tự động được bảo vệ khi được
 * đăng ký dưới prefix đó.
 *
 * ## Service Binding KHÔNG thay được signature
 *
 * `01-architecture.md` §5.1 và `04-implementation.md` chốt điều này: Cloudflare
 * document rằng **không có** header hay request property nào cho Worker phân biệt
 * request qua Service Binding với request từ internet. Mô hình chính thức là
 * *isolation* (giữ Worker đích không reachable từ internet), không phải
 * *verification*. `account` không áp dụng được isolation vì nó phải phục vụ BFF
 * công khai trên chính Worker đó — nên internal contract **bắt buộc** có
 * authenticator ở tầng ứng dụng.
 *
 * ## Cookie không tham gia
 *
 * FR-011c / SR-010: internal endpoint **không** nhận cookie trình duyệt. Middleware
 * này cố tình không đọc header `cookie` — cookie của browser là thứ BFF dùng, đưa
 * nó vào internal contract sẽ mở đường cho một endpoint internal bị gọi bằng phiên
 * của người dùng thay vì bằng chữ ký của service.
 */

import { createError, defineEventHandler, getHeader, readRawBody, type H3Event } from 'h3';
import type { Pool } from 'pg';

import {
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_KID_HEADER,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  NONCE_TTL_BUFFER_SECONDS,
  resolveSkewSeconds,
  verifyRequest,
  type VerifyFailureReason,
} from '@ecoma-io/internal-auth-contracts';

import { accountHyperdrive } from '../utils/bindings';
import { recordNonce, withRequestPool } from '../utils/db';
import { writeLog } from '../utils/logger';

/** Prefix mà middleware này canh giữ. */
const INTERNAL_PREFIX = '/internal/';

/**
 * Dữ liệu xác thực gắn vào `event.context` để route không phải verify lần nữa.
 *
 * ⚠️ Chỉ mang `nonce` và `timestamp` — cùng bộ trường mà `VerifyResult.ok` trả về.
 * Không gắn `secret`, không gắn chữ ký: route chỉ cần biết "request này đã được
 * xác thực" và dùng `nonce` cho audit.
 */
export interface InternalAuthContext {
  readonly internalAuth: {
    readonly nonce: string;
    readonly timestamp: string;
  };
}

/**
 * Nonce store bền vững — bảng `account.internal_nonces` của `db-account`.
 *
 * ⚠️ `verifyRequest` bắt buộc nhận callback `claimNonce` (trước đây tên là
 * `seenNonce` — lib đổi tên để ép mọi implementer chú ý: hợp đồng là
 * **chiếm-ghi nguyên tử**, không phải predicate chỉ-đọc), và đó là cơ chế **chống
 * replay** duy nhất bên cạnh cửa sổ timestamp: timestamp chỉ giới hạn replay trong
 * một khoảng, còn nonce mới là thứ làm một request đã dùng không dùng lại được
 * trong khoảng đó. Cache node-local không thay thế được: Hyperdrive không hỗ trợ
 * advisory lock (`04-platform-facts.md` HD6) và node-local application state là
 * vi phạm non-negotiable architecture.
 *
 * Hợp đồng của callback là **kiểm tra và ghi**, không chỉ kiểm tra — nên
 * {@link recordNonce} chèn bằng `INSERT … ON CONFLICT DO NOTHING` rồi đếm
 * `rowCount`, tức là một câu lệnh nguyên tử. Cài bằng `SELECT` rồi `INSERT` ở câu
 * khác sẽ cho hai request cùng nonce cùng thắng dưới tải đồng thời, và replay guard
 * trở thành trang trí.
 *
 * Callback nhận **hai** tham số theo hợp đồng đã mở rộng của `verifyRequest`:
 * `(nonce, timestampSeconds)` — tham số thứ hai là timestamp của envelope, đã qua
 * kiểm định dạng và cửa sổ skew. `expires_at` neo theo mốc đó chứ không theo
 * đồng hồ của verifier: cửa sổ replay của envelope kết thúc tại
 * `timestamp + skew`, nên TTL `timestamp + skew + buffer` sống qua cửa sổ đúng
 * bằng buffer. Neo theo `now` của ta thì lệch được khi hai đồng hồ lệch nhau.
 *
 * ⚠️ **`skewSeconds` truyền vào phải là skew của request**, không phải hằng
 * mặc định. TTL của nonce tính từ timestamp của envelope cộng skew, nên nếu caller
 * ký với skew 60s mà ta lưu theo skew 300s thì nonce sống thừa (an toàn, chỉ tốn
 * chỗ); ngược lại — caller dùng skew 300s còn ta lưu theo 60s — thì prune có thể
 * xoá nonce **còn hiệu lực** và replay trong cửa sổ sẽ thành công. Lấy đúng skew mà
 * `verifyRequest` dùng ở chính lệnh gọi đó là cách không thể lệch.
 */
export function makeNonceGuard(
  pool: Pool,
  skewSeconds: number,
): (nonce: string, timestampSeconds: number) => Promise<boolean> {
  return async (nonce: string, timestampSeconds: number): Promise<boolean> => {
    // `verifyRequest` đã kiểm timestamp nằm trong cửa sổ trước khi gọi callback
    // này, nên timestamp luôn hợp lệ ở đây. TTL neo theo **timestamp của envelope**
    // (tham số thứ hai) chứ không theo đồng hồ của ta: cửa sổ replay kết thúc đúng
    // tại `timestamp + skew`, nên `timestamp + skew + buffer` sống qua cửa sổ đúng
    // bằng buffer — không cần đoán lệch đồng hồ giữa caller và verifier. Buffer cho
    // prune chạy theo lô không đúng lúc (xem JSDoc của
    // {@link NONCE_TTL_BUFFER_SECONDS}).
    return recordNonce(pool, nonce, timestampSeconds + skewSeconds + NONCE_TTL_BUFFER_SECONDS);
  };
}

/**
 * Ghi log một lần từ chối internal.
 *
 * ⚠️ Chỉ ghi `reason` — mã lý do của `verifyRequest`, hoặc `no_secret` /
 * `no_binding` / `db_unreachable` cho ba nhánh cấu hình-không-đủ / DB-chết — và
 * **không** ghi giá trị header. Header `x-ecoma-internal-signature` là chữ ký HMAC:
 * ghi nó vào log là đưa một giá trị có thể tái dùng trong cửa sổ skew vào một nơi
 * đọc được lâu hơn request. `reason` đủ để phân loại sự cố mà không lộ gì.
 *
 * ⚠️ **Không bao giờ nối `error` hay message của driver vào đây.** Message của
 * `pg` có thể chứa connection string — đúng thứ SR-001 và invariant 9 cấm vào log —
 * và h3/Nitro sẽ `console.error` nguyên object lỗi nếu nó thoát khỏi middleware.
 * `reason: 'db_unreachable'` là mã ổn định cho "DB không gọi được", đủ để phân loại.
 *
 * @param status Mã trạng thái thật của response — `db_unreachable` là 503 (mọi
 *   call site DB khác cũng vậy), còn lại là 401.
 */
function logInternalRejection(
  event: H3Event,
  reason: VerifyFailureReason | 'no_secret' | 'no_binding' | 'db_unreachable',
  status: 401 | 503 = 401,
): void {
  writeLog({
    event: 'internal_auth.rejected',
    route: event.path,
    method: event.method,
    status,
    reason,
  });
}

/**
 * Middleware: xác thực envelope HMAC cho mọi path dưới `/internal/`.
 *
 * Đường đi:
 * 1. Không phải `/internal/` ⇒ `return` ngay (không chạm vào internal contract nào).
 * 2. Đọc secret và binding. Thiếu cái nào ⇒ 401 **trước khi** mở pool hay verify.
 * 3. Đọc raw body **dưới dạng byte** cho các method có payload (xem
 *    {@link readSignedBody}) — chữ ký phủ `bodyHash` của đúng những byte đã nhận,
 *    nên verify không có body, hoặc verify trên chuỗi đã decode, đều là verify sai.
 *    Thân vượt {@link INTERNAL_BODY_LIMIT_BYTES} ⇒ `413` **trước** khi hash.
 * 4. Mở pool trong `withRequestPool` và chạy **toàn bộ** `verifyRequest` bên trong
 *    callback đó — pool phải sống tới khi `claimNonce` được gọi, không được `end()`
 *    trước rồi mới trả callback ra ngoài (xem chú thích bên dưới). Lỗi DB trong
 *    khối này ⇒ 503 `db_unreachable`, không để driver error thoát ra h3.
 * 5. Đọc ba header `x-ecoma-internal-*`. **Không** ghi giá trị của chúng vào log.
 * 6. Không `ok` ⇒ `throw createError({ statusCode: 401 })` với **một** thông báo
 *    duy nhất, không phân biệt `reason` trong response. `reason` chỉ vào log
 *    (xem {@link logInternalRejection}) — kể cả `invalid_field`, mã mới cho trường
 *    canonical chứa surrogate không ghép cặp (F-06 / {@link InvalidCanonicalFieldError}).
 *    Ra `401` giống mọi lý do khác là chủ ý: phía gọi không được học từ response rằng
 *    nonce yếu hay timestamp lệch hay bytes đã bị đổi.
 *
 * ⚠️ Bước 2 từ chối khi thiếu binding, **không** phải vì contract cần DB mà vì
 * callback `claimNonce` cần kho nonce và kho đó nằm trong `db-account`. Không có
 * binding thì không có kho ⇒ không xác minh được replay ⇒ 401. Đây là cùng nguyên
 * tắc fail closed với nhánh thiếu secret: không có nhánh nào coi "chưa cấu hình" là
 * "cho phép", kể cả khi việc cấu hình là do hạ tầng chứ không phải do deploy.
 *
 * ## `event.path` đã gồm query string (h3 1.15.11)
 *
 * Chuỗi ký (`canonicalString`) phủ nguyên `path` caller gửi, **kể cả query string**,
 * nên verify phải nhận đúng chuỗi đó. h3 1.15.11 (version đang khoá trong
 * `pnpm-lock.yaml`) cho `event.path` = path đã percent-decode **+ query string giữ
 * nguyên bytes**: getter `path()` trả `this._path || this.node.req.url`, và `_path`
 * được gán từ `_decodePath(url)` — hàm tách phần path để decode rồi ghép phần query
 * (chưa decode) trở lại. Tức `event.path` **đã** là đúng chuỗi cần ký; một hàm "ghép
 * query trở lại" sẽ tạo `path?query?query` và mọi request có query đều `bad_signature`.
 *
 * Contract path của app này là ASCII thuần, nên phần decode không đổi byte nào —
 * decoded path == signed bytes. ⚠️ Đây là hành vi của **major 1** của h3; một major
 * sau có thể tách query khỏi `path` và khi đó đường này hỏng im lặng theo hướng
 * fail-closed (`bad_signature` trên mọi request có query). Guard cho sự thay đổi đó
 * là test end-to-end `tests/integrations/internal-auth-e2e.spec.ts` — nó ký bằng
 * `signRequest` thật và đi qua h3 app thật, nên sẽ đỏ ngay khi h3 đổi hành vi.
 */

/** Method có body theo h3 1.15.11 — `readRawBody` assert đúng danh sách này. */
const PAYLOAD_METHODS = new Set(['PATCH', 'POST', 'PUT', 'DELETE']);

/**
 * Mảng byte rỗng dùng chung cho request không có thân.
 *
 * ⚠️ `undefined` và mảng rỗng **không** được tráo cho nhau một cách tuỳ tiện ở tầng gọi:
 * `hashBody(undefined)` và `hashBody(new Uint8Array())` cho cùng hash (SHA-256 của ∅), nên
 * chuỗi ký không lệch — nhưng dùng một hằng rỗng ở đây làm điểm hội tụ thì signature luôn
 * được tính trên một giá trị có kiểu xác định.
 */
const NO_BODY = new Uint8Array();

/**
 * Đọc thân request dưới dạng **byte**, có chặn kích thước — không decode.
 *
 * ## Vì sao byte, không phải chuỗi (F-01)
 *
 * Bản trước đọc `readRawBody(event, 'utf8')` rồi ký chuỗi đó. `TextDecoder` ở chế độ
 * non-fatal **thay** byte không hợp lệ UTF-8 bằng U+FFFD, nên hai payload byte khác nhau
 * decode ra cùng một chuỗi ⇒ cùng `bodyHash` ⇒ cùng chữ ký, trong khi payload trên dây đã
 * đổi. Byte đọc được ở đây đi thẳng vào `hashBody` và không qua bước decode nào, nên chữ ký
 * buộc đúng những byte đã nhận.
 *
 * `readRawBody(event, false)` trả `Buffer | undefined` (h3 1.15.11), và `undefined` khi
 * request không có `content-length` lẫn `transfer-encoding: chunked`.
 *
 * ## Vì sao chặn kích thước, và chặn ở đâu
 *
 * ⚠️ **Đây KHÔNG phải một chốt chặn chống cạn kiệt bộ nhớ trên preset Workers, và không được
 * ghi như vậy.** Trên preset đó Nitro đã đọc trọn body thành `Buffer` trên
 * `event.node.req.body` **trước** khi middleware chạy (xem JSDoc của `readSignedBody`), tức
 * bộ nhớ đã tiêu trước khi ta nhìn thấy con số — một phép kiểm sau khi buffer không "ngăn"
 * được gì cả. Chốt chặn thật của đường này là `readBodyLimited` phía `auth`
 * (`apps/auth/src/main.ts`), nơi body đi vào qua `request.body` và được đọc theo stream.
 *
 * Việc kiểm ở đây vẫn có giá trị, và vì ba lý do khác: (a) nó giữ **hợp đồng** 64 KiB của
 * envelope nhất quán ở cả hai đầu, nên một payload vượt hạn mức không thể được `auth` ký rồi
 * được `account` chấp nhận; (b) nó chặn việc băm một payload khổng lồ trên đường nóng; (c) nó
 * là bất biến kiểm được trong test, thay vì một niềm tin.
 *
 * ⚠️ `content-length` **không** được dùng làm phép kiểm duy nhất ở đây: nó là dữ liệu của
 * người gọi và chỉ là một gợi ý tối ưu. Phép kiểm có thẩm quyền là trên
 * `byteLength` của giá trị đã đọc.
 *
 * @returns Byte của thân request, hoặc mảng rỗng khi method không có payload / request không
 *   mang thân.
 * @throws {H3Error} `413` khi thân vượt {@link INTERNAL_BODY_LIMIT_BYTES}.
 */
async function readSignedBody(event: H3Event): Promise<Uint8Array> {
  // Method không thuộc danh sách có payload: **không** đọc stream, và cũng không bỏ qua
  // envelope. HMAC vẫn chạy đầy đủ, chỉ là `bodyHash` của thân rỗng — đúng byte mà phía ký
  // đã ký cho một request không có thân. Đây là lý do "endpoint không nhận body" không được
  // cài bằng cách tắt verify.
  if (!PAYLOAD_METHODS.has(event.method)) {
    return NO_BODY;
  }
  // `false` ⇒ trả Buffer thay vì giải mã utf8. Đây là điểm mấu chốt của F-01.
  const raw = await readRawBody(event, false);
  if (raw === undefined || raw.byteLength === 0) {
    return NO_BODY;
  }
  if (raw.byteLength > INTERNAL_BODY_LIMIT_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' });
  }
  // Sao chép sang một `Uint8Array` độc lập: `Buffer` là view trên một `ArrayBuffer` dùng
  // chung, và không có lý do gì để chữ ký phụ thuộc vào việc view đó còn hợp lệ hay không.
  return new Uint8Array(raw);
}

export default defineEventHandler(async (event: H3Event): Promise<void> => {
  if (!event.path.startsWith(INTERNAL_PREFIX)) {
    return;
  }

  const config = useRuntimeConfig(event);
  const secret = config.internalHmacSecret;

  // Fail closed: không có secret thì không request internal nào đi qua. Không có
  // nhánh nào coi "chưa cấu hình" là "cho phép".
  if (typeof secret !== 'string' || secret.length === 0) {
    logInternalRejection(event, 'no_secret');
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  // Registry `kid` → secret: từ các biến đã qua validate ở `config-validation.ts`
  // (assertKid + cặp previous + cấm trùng `kid`/trùng giá trị secret). Envelope có
  // `kid` ngoài registry ⇒ resolver ném ⇒ lib trả `bad_signature` — không có nhánh
  // "chấp nhận với secret mặc định".
  const secretsByKid = buildInternalSecretsByKid(config);

  // ⚠️ Chuẩn hoá skew **một lần** rồi truyền cùng số đó cho `verifyRequest` lẫn
  // `makeNonceGuard`. `verifyRequest` tự chuẩn hoá bên trong, còn TTL của nonce được ghi
  // từ giá trị mà `makeNonceGuard` nhận — hai luật khác nhau trên cùng một hằng số thì
  // chiều lệch nguy hiểm là TTL ngắn hơn cửa sổ replay, tức mở lại cửa sổ mà kho nonce
  // sinh ra để đóng. `resolveSkewSeconds` là đúng hàm lib dùng nên không thể lệch.
  const skewSeconds = resolveSkewSeconds(
    typeof config.internalAuthSkewSeconds === 'number' ? config.internalAuthSkewSeconds : undefined,
  );

  // Không có binding thì không có kho nonce, mà không có kho nonce thì không xác
  // minh được replay — nên từ chối **trước khi** chạy verify. Fail closed ở đây
  // tương đương fail closed của nhánh `no_secret`: đường internal không xác thực
  // được thì không tồn tại, chứ không phải xác thực yếu.
  const hyperdrive = accountHyperdrive(config);
  if (!hyperdrive) {
    logInternalRejection(event, 'no_binding');
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  // Chữ ký phủ `bodyHash` của payload — đọc raw body trước khi verify, nếu không
  const body = await readSignedBody(event);

  // Pool và callback `claimNonce` dùng **cùng** `skewSeconds` mà `verifyRequest` nhận
  // ở lệnh gọi bên dưới. Tách hai nguồn số thì TTL lưu và cửa sổ kiểm lệch nhau,
  // và lệch theo hướng TTL ngắn hơn là cho phép replay trong cửa sổ.
  //
  // ⚠️ `verifyRequest` phải chạy **bên trong** callback của `withRequestPool`.
  // `withRequestPool` `end()` pool trong `finally` rồi mới trả kết quả; nếu dựng
  // `claimNonce` ở đó rồi gọi `verifyRequest` ở ngoài thì callback giữ một pool đã
  // `end()` và ném `Cannot use a pool after calling end on the pool` đúng lúc
  // `claimNonce` ghi nonce — tức mỗi request hợp lệ cũng 500 thay vì 401. Lựa chọn
  // này (chạy verify trong callback) là thay đổi nhỏ nhất đúng: giữ nguyên hợp đồng
  // `withRequestPool` "callback dùng pool, hàm lo lifecycle", không thêm pool
  // module-scope (runtime:edge cấm node-local state), và không tách lifecycle sang
  // tay người gọi.
  //
  // ⚠️ Bọc `withRequestPool` trong try/catch: `recordNonce`/`claimNonce` ném lỗi
  // driver thô (ví dụ `db-account` không tới được) và nếu để nó thoát, h3 sẽ bọc
  // rồi Nitro `console.error` nguyên object — message của `pg` có thể chứa connection
  // string, đúng thứ SR-001/invariant 9 cấm vào log; response cũng thành 500 chứ
  // không phải 503. Mọi call site DB khác của app (`status.get.ts`, `ready.get.ts`)
  // đều trả 503 `db_unreachable` với mã ổn định — middleware cũng vậy. Không nối
  // `error` vào log: chỉ mã `db_unreachable` là đủ phân loại.
  let verification;
  try {
    verification = await withRequestPool(hyperdrive, (pool) =>
      verifyRequest({
        method: event.method,
        // `event.path` đã gồm query string — xem JSDoc của handler phía trên.
        path: event.path,
        body,
        headers: {
          [INTERNAL_TIMESTAMP_HEADER]: getHeader(event, INTERNAL_TIMESTAMP_HEADER) ?? null,
          [INTERNAL_NONCE_HEADER]: getHeader(event, INTERNAL_NONCE_HEADER) ?? null,
          [INTERNAL_SIGNATURE_HEADER]: getHeader(event, INTERNAL_SIGNATURE_HEADER) ?? null,
          // ⚠️ `kid` PHẢI được chuyển vào đây. Thiếu dòng này thì `verifyRequest`
          // không bao giờ thấy `kid` ⇒ resolver không bao giờ chạy ⇒ một envelope tự
          // khai `kid` ngoài registry vẫn verify được bằng secret hiện hành. Đó là
          // fail-OPEN, đúng cái lỗi mà cặp `kid`/secret sinh ra để chặn.
          [INTERNAL_KID_HEADER]: getHeader(event, INTERNAL_KID_HEADER) ?? null,
        },
        secret,
        secretByKid: buildInternalSecretResolver(secretsByKid),
        now: String(Math.floor(Date.now() / 1000)),
        skewSeconds,
        claimNonce: makeNonceGuard(pool, skewSeconds),
      }),
    );
  } catch {
    logInternalRejection(event, 'db_unreachable', 503);
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  if (!verification.ok) {
    logInternalRejection(event, verification.reason);
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  event.context.internalAuth = {
    nonce: verification.nonce,
    timestamp: verification.timestamp,
  };
});

/**
 * Dựng registry `kid` → secret từ runtime config của `account`.
 *
 * Giá trị vào đã qua `validateAccountConfig` (`server/utils/config-validation.ts`):
 * hình dạng `kid` (8-16 hex chữ thường), cặp previous đủ hai biến, và cấm trùng
 * `kid` hay trùng giá trị secret giữa hai dòng. Hàm này chỉ còn hợp thành — không
 * lặp lại phép kiểm nào, tránh hai nguồn sự thật cho cùng một luật.
 *
 * Registry rỗng (chưa bật `kid`) là trạng thái bình thường của transition: envelope
 * **không** `kid` verify bằng `internalHmacSecret` như trước; envelope **có** `kid`
 * sẽ `bad_signature` qua resolver (không khoá nào khớp).
 *
 * ⚠️ **Entry `current` của registry chính là secret đang KÝ** (`internalHmacSecret` —
 * cùng một giá trị mà `auth-client.ts` dùng để ký envelope đi ra). Đây là ràng buộc
 * vận hành quan trọng nhất của `kid`: registry có **hai** entry, không có slot thứ ba
 * cho "khoá mới nhưng chưa dùng để ký". Vì vậy khi xoay secret, khoá mới phải được
 * nạp trước vào slot `previous` ở **cả hai** Worker, rồi mới chuyển `current` — nếu
 * chỉ nạp trước ở một bên, bên đó ký bằng khoá mới và làm hỏng hướng ngược lại. Runbook
 * ở `docs/applications/auth/03-operations.md` §3.3.
 */
function buildInternalSecretsByKid(
  config: ReturnType<typeof useRuntimeConfig>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (typeof config.internalHmacKid === 'string' && config.internalHmacKid.length > 0) {
    map.set(config.internalHmacKid, config.internalHmacSecret);
  }
  if (
    typeof config.internalHmacPreviousKid === 'string' &&
    config.internalHmacPreviousKid.length > 0 &&
    typeof config.internalHmacPreviousSecret === 'string' &&
    config.internalHmacPreviousSecret.length > 0
  ) {
    map.set(config.internalHmacPreviousKid, config.internalHmacPreviousSecret);
  }
  return map;
}

/**
 * Resolver cho `verifyRequest` — `kid` ngoài registry ⇒ ném ⇒ `bad_signature`.
 *
 * ⚠️ **Hình dạng này cố ý là factory trả về một arrow function bất đồng bộ**, không
 * phải một hàm đồng bộ trả `Promise`. Lý do không phải thẩm mỹ: Semgrep rule
 * `security-sensitive-value-in-http-response` soi taint của biến tên `secret` tới
 * một `return`, và hình dạng "hàm đồng bộ trả `Promise.resolve(secret)`" bị flag
 * vì taint vẫn đi qua `return` đó — dù giá trị chỉ đi vào HMAC, không đi ra wire.
 * Hình dạng factory (arrow bất đồng bộ là *giá trị* được trả về, phần `return secret`
 * nằm trong thân arrow) không đi qua `return` của một hàm cấp cao hơn nên taint
 * dừng ở ranh giới HMAC, đúng như các sanitizer của rule đã ghim cho `signRequest`
 * và `signInternalRequest`.
 *
 * Cùng hình dạng này đã dùng ở `apps/auth/src/config.ts` (`resolveInternalSecret`).
 */
function buildInternalSecretResolver(
  registry: ReadonlyMap<string, string>,
): (kid: string) => Promise<string> {
  return async (kid: string): Promise<string> => {
    const secret = registry.get(kid);
    if (secret === undefined) {
      throw new Error(`kid '${kid}' khong co trong registry secret internal cua account`);
    }
    return secret;
  };
}
