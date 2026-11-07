/**
 * Định danh giao thức, đứng ngay sau `method` trong canonical string.
 *
 * Đây là hằng **neo**: nhờ nó, chữ ký tính cho giao thức này không dùng lại được cho giao
 * thức khác, và nó cũng là thứ giữ tính đơn ánh ở vị trí của `method` — trường đó không có
 * length prefix (xem JSDoc của {@link canonicalString}). Xuất ra để test golden vector và
 * tài liệu tham chiếu cùng một giá trị thay vì chép lại chuỗi.
 *
 * Đổi giá trị này là **phá vỡ giao thức**: mọi envelope đang lưu hành thành `bad_signature`.
 */
export const PROTOCOL_ID = 'ecoma-internal-v2';

/**
 * Internal HMAC contract canonical — protocol nền tảng, platform-neutral (`scope:platform`).
 *
 * Mọi cặp service nội bộ ký/verify qua envelope này — hiện tại `auth`, `account`,
 * `transactional-mail`, `transactional-mailer-job`. Giao thức chỉ là cơ chế xác thực
 * request-to-request: nó **không** mang khái niệm của một bounded context nào (không
 * principal, không user, không permission — receiver tự suy consumer từ credential),
 * nên nó thuộc tầng nền `scope:platform`, không thuộc `scope:account` hay
 * `scope:auth`. Đặt nhầm chỗ
 * biến một platform service thành consumer của contracts BC khác — đúng hướng phụ thuộc
 * ngược mà `docs/architecture/05-code-architecture.md` cấm.
 *
 * ## Vì sao chỉ có một bản cài đặt
 *
 * ⚠️ **Service Binding KHÔNG phải là cơ chế xác thực.** Cloudflare ghi rõ: không có
 * header hay thuộc tính request nào phân biệt được một request đi qua Service Binding
 * với một request từ internet; mô hình chính thức là *cô lập*, không phải *xác minh*.
 * `account` không dùng được cô lập vì nó phục vụ BFF công khai trên cùng một Worker.
 * Vì vậy internal contract cần một authenticator ở tầng ứng dụng: phía gọi ký bằng
 * secret dùng chung, phía nhận kiểm chữ ký trước khi **tin** bất kỳ dữ liệu nào.
 *
 * ⚠️ Chính xác hơn: thân request phải được **đọc** trước khi verify (chữ ký bao gồm nó),
 * nhưng nó được đọc dưới dạng **byte thô** và bị băm ngay — không decode, không parse, không
 * diễn giải — cho tới khi chữ ký hợp lệ. Một thứ tự "parse rồi mới verify" là sai cả về bảo
 * mật (xử lý payload chưa xác thực) lẫn về tính đúng đắn (parse + serialize lại đổi byte).
 *
 * ⚠️ **File này là nguồn sự thật duy nhất của giao thức.** Trước đây `auth` và
 * `account` ship hai envelope không tương thích (hai đường import của
 * `libs/identity-contracts` và `libs/identity-auth-contracts` — hai lib đã xoá khi hợp
 * nhất, issue #324) trùng tên header nhưng
 * lệch nhau ở chữ hoa/thường của method, đơn vị của length prefix, đơn vị của timestamp
 * và định dạng nonce — và `auth` hoàn toàn không có kho nonce bền, nên
 * `/internal/session/verified` của nó phát lại được trong cửa sổ skew. Hai bên chỉ test
 * với chính mình, nên sự không tương thích không hiện ra. File này hợp nhất chúng; từ
 * issue #324, hai contract lib của identity (`account-contracts`, `auth-contracts`)
 * re-export lại từ đây cho đúng phía của mình.
 *
 * ## Tính chất của envelope
 *
 * - **Chống replay**: timestamp nằm trong cửa sổ skew được chấp nhận, cộng với một nonce
 *   đã bị chiếm trước đó, đều bị từ chối.
 * - **Fail closed**: mọi sai lệch trả `{ ok: false }`; không có nhánh nào coi header
 *   thiếu là "chấp nhận được".
 * - **Tất định và đơn ánh (injective)**: mọi trường biến đổi đều có length prefix (trừ
 *   `method`, xem phần dưới) nên hai tập thành phần khác nhau không thể sinh ra cùng một
 *   chuỗi byte.
 *
 * ## Dạng canonical (bất biến)
 *
 * ```text
 * <method>\n<proto>\n<len(path)>:<path>\n<len(timestamp)>:<timestamp>\n<len(nonce)>:<nonce>\n<bodyHash>
 * ```
 *
 * - `method` được hạ về chữ thường.
 * - `path` là path chính xác của request, **kể cả query string**, có tiền tố độ dài theo
 *   byte UTF-8.
 * - `timestamp` là **epoch giây** dạng chuỗi chữ số thập phân, có tiền tố độ dài byte UTF-8.
 * - `nonce` là token ≥128 bit entropy không đoán được (mặc định `createNonce()` sinh UUID
 *   v4), có tiền tố độ dài byte UTF-8.
 * - `bodyHash` là SHA-256 hex chữ thường của **đúng byte thân request** (64 ký tự, độ dài cố
 *   định) — không phải của chuỗi đã decode từ byte đó. `hashBody` nhận `Uint8Array`, nên
 *   chữ ký buộc được byte trên dây — xem JSDoc của {@link hashBody}.
 * - `proto` là hằng {@link PROTOCOL_ID}, để chữ ký tính cho giao thức này không dùng lại
 *   được cho một giao thức khác.
 *
 * ## Tính đơn ánh đến từ đâu
 *
 * Mọi trường biến đổi **có** length prefix. Không có length prefix thì `path="ab",
 * nonce="c"` và `path="a", nonce="bc"` cho ra cùng một chuỗi — đúng kiểu va chạm
 * canonical hoá biến một thông điệp đã ký thành thứ kẻ tấn công ghép lại được. Length
 * prefix làm phép mã hoá trở thành đơn ánh.
 *
 * ⚠️ **Điều kiện tiên quyết: chuỗi phải well-formed, và hàm này ép điều đó.** `TextEncoder`
 * **thay** lone surrogate bằng U+FFFD (3 byte), nên `"/a\uD800"` và `"/a�"` cho ra
 * **cùng một chuỗi byte** — length prefix không cứu được, vì cả tiền tố độ dài lẫn giá trị
 * đều đi qua cùng phép mã hoá. Vì vậy hàm này **từ chối** mọi trường chứa surrogate lẻ (ném
 * {@link InvalidCanonicalFieldError}) thay vì im lặng canonical hoá hai chuỗi khác nhau
 * thành một. Đây là **siết đầu vào**, không phải đổi định dạng canonical: mọi input
 * well-formed được chấp nhận trước đây vẫn ra đúng chuỗi byte cũ, nên golden vector không
 * đổi. Ràng buộc áp cho **mọi** trường có length prefix: `path`, `timestamp`, `nonce` — và
 * cả `method`.
 *
 * ⚠️ `method` là **ngoại lệ**: nó là trường đầu tiên nên không có length prefix. Tính
 * đơn ánh của nó đến từ **hằng neo** {@link PROTOCOL_ID} đứng ngay sau nó: `path` luôn
 * bắt đầu bằng `<chữ số>:` nên không bao giờ khớp được một hằng chữ cái. Tức tiền đề
 * thật của tính đơn ánh ở vị trí đó là hằng cố định, **không** phải quy tắc length
 * prefix — và ai đổi dòng `proto` mà quên điều này thì tính đơn ánh biến mất trong im
 * lặng. `bodyHash` không cần tiền tố vì độ dài của nó cố định (và nó là hex, không thể
 * chứa surrogate).
 *
 * @param method HTTP method, không phân biệt chữ hoa/thường.
 * @param path Path của request, kể cả query string.
 * @param timestamp Epoch giây dạng chuỗi.
 * @param nonce Nonce.
 * @param bodyHash SHA-256 hex của thân request.
 * @throws {InvalidCanonicalFieldError} Khi một trường chứa surrogate lẻ — xem
 *   {@link hasLoneSurrogate}. Không trả về một canonical "đã sửa": hai đầu ký/kiểm phải
 *   cùng thấy một lỗi, không phải cùng thấy một biểu diễn khác.
 */
export function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
  actorSub?: string,
): string {
  assertWellFormed('method', method);
  assertWellFormed('path', path);
  assertWellFormed('timestamp', timestamp);
  assertWellFormed('nonce', nonce);
  const encoder = getEncoder();
  const normalizedActor = actorSub === undefined || actorSub === '' ? undefined : actorSub;
  if (normalizedActor !== undefined) {
    assertWellFormed('actorSub', normalizedActor);
    // oxlint-disable-next-line no-control-regex
    if (/[\r\n\x00-\x1f\x7f\u2028\u2029]/u.test(normalizedActor)) {
      throw new InvalidCanonicalFieldError('actorSub');
    }
  }
  const actorLine =
    normalizedActor === undefined
      ? 'actor-absent'
      : `actor-present:${encoder.encode(normalizedActor).length}:${normalizedActor}`;
  return [
    method.toLowerCase(),
    PROTOCOL_ID,
    `${encoder.encode(path).length}:${path}`,
    `${encoder.encode(timestamp).length}:${timestamp}`,
    `${encoder.encode(nonce).length}:${nonce}`,
    bodyHash,
    actorLine,
  ].join('\n');
}

/**
 * Lỗi canonical hoá: một trường của envelope chứa surrogate lẻ.
 *
 * Tồn tại như một **lớp riêng** (không phải `Error` trần) vì `verifyRequest` phải phân biệt
 * nó với lỗi của `claimNonce`: lỗi này là đầu vào hỏng, còn lỗi kia là kho nonce không gọi
 * được (`db_unreachable` ⇒ 503). Nuốt chung một `catch` thì hai sự kiện rất khác nhau bị
 * gộp thành một mã.
 *
 * `field` là **tên trường**, không bao giờ là giá trị: giá trị header là dữ liệu do người
 * gọi kiểm soát, và với `nonce` thì nó là thứ kho nonce lưu — không có lý do gì để nó đi
 * vào một message.
 */
export class InvalidCanonicalFieldError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`internal-auth: canonical field "${field}" contains an unpaired surrogate`);
    this.name = 'InvalidCanonicalFieldError';
    this.field = field;
  }
}

/** Ném {@link InvalidCanonicalFieldError} nếu `value` chứa surrogate lẻ. */
function assertWellFormed(field: string, value: string): void {
  if (hasLoneSurrogate(value)) {
    throw new InvalidCanonicalFieldError(field);
  }
}

/**
 * Phát hiện surrogate lẻ (unpaired surrogate) trong một chuỗi JS.
 *
 * Tự viết thay vì `String.prototype.isWellFormed()`: hàm đó là ES2024, không nằm trong
 * `lib: ["es2022", "dom"]` của lib này, và lib `runtime:universal` không nên phụ thuộc vào
 * một API chỉ có ở engine mới. Vòng lặp dưới chỉ đọc `charCodeAt`, có ở mọi runtime.
 *
 * Một surrogate **cao** (`D800`–`DBFF`) hợp lệ khi và chỉ khi theo sau là một surrogate
 * **thấp** (`DC00`–`DFFF`); một surrogate thấp đứng một mình luôn là lẻ.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Instance `TextEncoder` dùng chung.
 *
 * `TextEncoder` tạo mới thì rẻ, nhưng cấp phát lại mỗi lần gọi trên đường verify nóng là
 * thứ tránh được; biến toàn cục này là cùng một object qua mọi lần gọi.
 */
// `InstanceType<typeof TextEncoder>` thay vì `TextEncoder` làm kiểu: `TextEncoder` là **giá trị**
// trong cả hai bộ lib mà repo dùng, nhưng chỉ có **tên kiểu** khi có lib DOM. Consumer biên
// dịch file này qua `tsconfig.db.json` (lib es2023, types node) thì tên kiểu đó không tồn tại
// và `TextEncoder` bị đọc như một tham số kiểu. Suy kiểu từ chính giá trị thì đúng ở mọi bộ lib.
let sharedEncoder: InstanceType<typeof TextEncoder> | undefined;
function getEncoder(): InstanceType<typeof TextEncoder> {
  sharedEncoder ??= new TextEncoder();
  return sharedEncoder;
}

/**
 * SHA-256 hex của **đúng byte** thân request, qua WebCrypto.
 *
 * `crypto.subtle` là WebCrypto — có trên Cloudflare Workers và Node >= 19, nên lib này
 * không bao giờ cần `node:crypto` (bị cấm trong `libs/**`).
 *
 * ## Vì sao nhận byte chứ không nhận `string`
 *
 * Bản trước nhận `string` và băm `TextEncoder`-encode của **chuỗi đã decode**, nên chữ ký
 * chỉ buộc được chuỗi đó chứ không buộc được byte trên dây. Cả hai call site đều decode
 * **non-fatal**, tức byte không hợp lệ UTF-8 hoá thành U+FFFD: hai payload **byte khác
 * nhau** decode ra **cùng một chuỗi** ⇒ cùng `bodyHash` ⇒ cùng chữ ký, trong khi byte đã
 * đổi. Đó là một lỗ hổng chứ không phải chi tiết: chữ ký nói "tôi đã thấy đúng payload
 * này" trong khi thứ được xác thực là một ảnh chiếu mất thông tin của nó.
 *
 * Nhận `Uint8Array` thì phép băm là **trên đúng byte người nhận đã đọc**, không có bước
 * decode nào ở giữa. Hệ quả là API **không còn đường `string`**: không tồn tại một biến thể
 * "ký chuỗi" để call site lỡ dùng, nên không thể có chuyện một bên ký byte còn bên kia ký
 * chuỗi đã decode — hai bên buộc phải nói cùng một ngôn ngữ.
 *
 * ## Hợp đồng của call site
 *
 * Phía ký phải gửi **đúng mảng byte** đã truyền vào đây; phía nhận phải gọi hàm này với
 * byte nó đọc được **trước khi** decode/parse. Không được ký lại biểu diễn JSON đã parse
 * (`JSON.stringify(JSON.parse(x))` đổi whitespace và thứ tự khoá, nên nó là một payload
 * khác — xem test `rejects a valid JSON body re-serialized with different whitespace`).
 *
 * `undefined`/`null` được băm như mảng byte **rỗng**, giữ nguyên hành vi của bản nhận
 * `string` (khi đó là chuỗi rỗng): SHA-256 của ∅ là
 * `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
 *
 * @param body Byte thân request; `null`/`undefined` được băm như mảng rỗng.
 */
export async function hashBody(body: Uint8Array | null | undefined): Promise<string> {
  // `body` có thể là một view mang tham số `ArrayBufferLike` (`Buffer` của Node, hay view do
  // runtime HTTP trả về), trong khi `crypto.subtle.digest` của lib DOM/webworker chỉ nhận
  // `BufferSource` — mà `BufferSource = ArrayBufferView<ArrayBuffer> | ArrayBuffer`. Sao chép
  // sang một `Uint8Array` gắn `ArrayBuffer` là cách đúng với **mọi** backing buffer, kể cả
  // `SharedArrayBuffer`, và không cần một khẳng định kiểu nào có thể sai. Chi phí là một bản
  // sao bounded bởi `INTERNAL_BODY_LIMIT_BYTES` — không phải một tuyên bố về bộ nhớ.
  // ⚠️ **Không dựa vào caller để giữ hợp đồng kiểu.** Khi một chuỗi lọt vào đây (spec không
  // được typecheck, JS thuần, hoặc một `as` sai), `new Uint8Array('<chuỗi>')` cho ra mảng
  // **rỗng** — tức thân bị băm thành rỗng trong im lặng, và hai phía cùng "đúng" trên cùng
  // một sai lầm. Đã xảy ra thật với spec interop của một facade identity-contracts cũ. Ném thay vì
  // băm rỗng là fail-closed: chữ ký bao giờ cũng phải phủ đúng byte được truyền vào.
  if (body !== null && body !== undefined && !isUint8Array(body)) {
    throw new TypeError('hashBody can only hash a Uint8Array body, or null/undefined');
  }
  const bytes = body === null || body === undefined ? EMPTY_BYTES : new Uint8Array(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/**
 * Nhận diện `Uint8Array` theo **internal slot**, không phải theo `instanceof`.
 *
 * Hai lý do đo được:
 *
 * 1. `instanceof` so với hằng `Uint8Array` của module là so theo **realm**. Trong suite
 *    của `apps/account` (môi trường jsdom) `new TextEncoder().encode(...)` trả về mảng
 *    Uint8Array của realm jsdom, còn `Uint8Array` trong module là của realm Node —
 *    `instanceof` trả `false` cho **giá trị hoàn toàn hợp lệ**. Guard khi đó chặn nhầm
 *    đúng chữ ký mà nó muốn bảo vệ.
 * 2. Dùng riêng `Object.prototype.toString` thì một object phẳng gắn
 *    `[Symbol.toStringTag]: 'Uint8Array'` lọt qua. `ArrayBuffer.isView` loại object phẳng
 *    đó (không có internal slot [[TypedArray]]), và hai phép cùng lúc vẫn loại chuỗi,
 *    mảng thường, `DataView`, các `Uint16Array`/`Uint32Array` v.v.
 *
 * `Buffer` của Node thỏa cả hai điều kiện nên vẫn được nhận.
 */
function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

/**
 * Mảng byte rỗng dùng chung cho mọi lần hash thân rỗng.
 *
 * `crypto.subtle.digest` không sửa buffer đầu vào, nên chia sẻ một instance là an toàn và
 * tránh cấp phát một `Uint8Array(0)` mới trên đường verify nóng.
 */
const EMPTY_BYTES = new Uint8Array(0);

/** Đổi buffer byte sang hex chữ thường. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * So sánh chữ ký theo thời gian hằng, chạy được trên cả Workers lẫn Node.
 *
 * ## Vì sao không dùng `node:crypto`
 *
 * `crypto.timingSafeEqual` của Node chỉ nằm dưới `node:crypto` — bị cấm trong `libs/**`
 * (`.oxlintrc.json`: `no-restricted-imports` + `import/no-nodejs-modules`) vì một lib
 * `runtime:universal` phải chạy được ở edge. Cloudflare Workers có
 * `crypto.timingSafeEqual` như một **phần mở rộng WebCrypto không chuẩn**, nhưng Node
 * không đưa nó lên `crypto` toàn cục (đo trên Node v24:
 * `typeof globalThis.crypto.timingSafeEqual === 'undefined'`). Dùng phần mở rộng của
 * Workers thì hỏng đường test trên Node; import `node:crypto` thì hỏng build Workers.
 *
 * Chọn: tự viết phép so sánh thời gian hằng trên từng byte `Uint8Array`. Nó chỉ dùng
 * XOR/OR trên byte — có trên cả hai runtime — và không có nhánh short-circuit, nên thời
 * gian chạy không phụ thuộc vị trí byte khác nhau đầu tiên. HMAC mới là ranh giới thật;
 * đây là phòng thủ thực dụng trước rò rỉ timing kiểu so sánh mật khẩu thô.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  // So độ dài trước: độ dài hex của SHA-256 là hằng số công khai, nên rò ở đây không lộ
  // secret, và nó giữ phép so byte ở kích thước cố định.
  if (a.length !== b.length) {
    return false;
  }
  const left = hexToBytes(a);
  const right = hexToBytes(b);
  if (left === null || right === null) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    const leftByte = left[i] ?? 0;
    const rightByte = right[i] ?? 0;
    diff |= leftByte ^ rightByte;
  }
  return diff === 0;
}

/** Hex sang mảng byte, hoặc `null` nếu chuỗi không phải hex chữ thường độ dài chẵn. */
function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || /[^0-9a-f]/u.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Sinh một nonce.
 *
 * `crypto.randomUUID()` là UUID v4: 122 bit entropy thật lấy từ CSPRNG, bị ràng buộc bởi
 * định dạng (nibble version `4`, nibble variant `8/9/a/b`) nên nó không thể là nonce tuần
 * tự hay đoán được theo timestamp. Phép kiểm định dạng trong {@link isStrongNonce} chấp
 * nhận ngay một UUID v4 đúng định dạng; heuristic đếm ký tự khác nhau ở dưới chỉ áp cho
 * chuỗi không có dạng UUID.
 */
export function createNonce(): string {
  return crypto.randomUUID();
}

/**
 * Một UUID v4 (RFC 4122): nibble version `4`, nibble variant thuộc `8/9/a/b`. Không phân biệt chữ hoa/thường.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Trần độ dài nonce, tính bằng ký tự.
 *
 * ⚠️ Đây là **chặn chi phí**, không phải chặn định dạng. {@link isStrongNonce} chạy
 * **trước** bước chứng minh chữ ký, trên một giá trị header do bên gọi kiểm soát, và
 * {@link estimateNonceBits} dựng `new Set(nonce)` — O(n). Không có trần thì một nonce khổng
 * lồ biến thành chi phí CPU trên request **chưa xác thực**, và (khi qua được) thành một hàng
 * `nonce text PRIMARY KEY` to ngoài ý muốn trong kho nonce. Header bị platform giới hạn nên
 * đây không phải lỗ hổng, nhưng không có lý do gì để nhận một nonce dài hơn UUID rất nhiều.
 *
 * Trần này khớp bản `auth` cũ (`libs/identity-auth-contracts` trước khi hợp nhất — lib đã
 * xoá ở issue #324) để việc hợp nhất không **nới** một ràng buộc đã có.
 */
export const MAX_NONCE_CHARS = 128;

/**
 * Kiểm xem một nonce có đủ entropy không.
 *
 * ## Hai lớp
 *
 * 1. Một UUID v4 đúng định dạng được chấp nhận thẳng. Mục đích của phép kiểm nonce là
 *    từ chối nonce tuần tự hoặc đoán được theo timestamp; UUID v4 (nibble version `4`,
 *    variant `8/9/a/b`) không thể là loại đó — entropy thật đã được bảo đảm bằng định
 *    dạng + CSPRNG. Heuristic đếm ký tự khác nhau trước đây từ chối khoảng 0,16% số UUID
 *    v4 ngẫu nhiên **hợp lệ** (một UUID thật có thể có ít ký tự khác nhau mà vẫn vượt
 *    ngưỡng entropy: 11 ký tự khác nhau × bảng chữ 36 ≈ 124 bit < 128). Nó áp lên cả UUID
 *    v4 nên từ chối nhầm những giá trị đúng.
 *
 * 2. Chuỗi không có dạng UUID: entropy ước lượng bằng `độ dài × log2(số ký tự khác nhau)`
 *    với ngưỡng 128 bit, nên một nonce toàn `'0'` hay một bộ đếm tuần tự không được chấp nhận
 *    chỉ vì nó dài.
 *
 * Trần {@link MAX_NONCE_CHARS} áp cho **cả hai** lớp: một chuỗi dài hơn thế bị từ chối
 * trước khi chạm tới `new Set`.
 *
 * ## Đánh đổi đã biết
 *
 * Một chuỗi *trông giống* UUID v4 nhưng được cố ý chế ra (cùng một ký tự, v.v.) vẫn qua
 * được lớp định dạng. Cái giá chỉ thuộc về người chọn nonce: người gọi dùng CSPRNG (như
 * {@link createNonce}) không bao giờ sinh ra chuỗi như vậy, còn người gọi cố ý chọn một
 * nonce đoán được thì đang tự làm yếu hợp đồng của chính mình — phép kiểm này không cứu
 * họ, và cũng không cần cứu.
 */
export function isStrongNonce(nonce: string): boolean {
  if (nonce.length > MAX_NONCE_CHARS) {
    return false;
  }
  if (UUID_V4_PATTERN.test(nonce)) {
    return true;
  }
  return estimateNonceBits(nonce) >= 128;
}

/**
 * Ước lượng entropy của nonce từ bảng ký tự quan sát được.
 *
 * Chỉ dùng cho nonce không có dạng UUID (UUID v4 đi đường nhanh trong
 * {@link isStrongNonce}). Công thức là **`độ dài × log2(số ký tự khác nhau)`** — không
 * phải `log2(số ký tự khác nhau)`: thiếu thừa số độ dài thì một nonce một ký tự cũng ra
 * 0 bit và mọi nonce nhiều ký tự ra cùng một số, tức phép kiểm không còn theo dõi độ dài.
 * Nonce toàn `'0'` vẫn ra 0 bit vì `distinct <= 1`.
 *
 * ⚠️ Đây là ước lượng **theo bảng chữ quan sát được**, không phải entropy thật của nguồn
 * sinh: với trần {@link MAX_NONCE_CHARS} = 128, một nonce dài 128 ký tự chỉ gồm 2 ký hiệu
 * vẫn đạt đúng ngưỡng 128 bit. Ngưỡng này là rào chắn cho nonce do người gọi truyền vào,
 * không phải chứng minh nguồn ngẫu nhiên — `createNonce()` mới là đường được khuyến nghị.
 */
function estimateNonceBits(nonce: string): number {
  const distinct = new Set(nonce).size;
  if (distinct <= 1) {
    return 0;
  }
  return nonce.length * Math.log2(distinct);
}

/** Header mang timestamp (epoch giây, chuỗi thập phân). */
export const INTERNAL_TIMESTAMP_HEADER = 'x-ecoma-internal-timestamp';

/** Header mang nonce. */
export const INTERNAL_NONCE_HEADER = 'x-ecoma-internal-nonce';

/** Header mang chữ ký, định dạng `v1=<hex>`. */
export const INTERNAL_SIGNATURE_HEADER = 'x-ecoma-internal-signature';

/**
 * Header mang `kid` — định danh khoá HMAC của bên ký, tuỳ chọn.
 *
 * ⚠️ `kid` **KHÔNG nằm trong canonical string** — quyết định gần nhất của issue #64.
 * Thêm dòng `<len(kid)>:<kid>` vào canonical là một thay đổi giao thức: nó phá mọi golden
 * vector đang có và buộc dual-accept hai canonical cùng lúc — đúng vòng xoáy mà damas
 * muốn xoá. Khi `kid` chỉ là một header, người nhận kiểm nó như **một chỉ dẫn chọn khoá**
 * trước khi tính HMAC, và một envelope không `kid` vẫn verify được bằng secret hiện hành
 * (phase transition).
 *
 * ⚠️ `kid` tự nó **không được tin như một claim**: nó là dữ liệu đầu vào do bên gọi kiểm
 * soát, không có chữ ký phủ nó khi xét riêng. Sự thật bảo mật tạo từ tổ hợp: chữ ký phải
 * khớp với HMAC của **khoá** mà `kid` đã chọn — chọn một `kid` ngoài registry là không có
 * khoá để khớp, tức `bad_signature` (fail-closed, xem {@link verifyRequest}).
 */
export const INTERNAL_KID_HEADER = 'x-ecoma-internal-kid';

/** Header mang actor sub da verify (Backoffice principal OIDC sub) — audit-only,
 *  khong phai authorization input. Server-side resolve sub -> staff.id tu DB. */
export const INTERNAL_ACTOR_SUB_HEADER = 'x-ecoma-internal-actor-sub';

/**
 * Định dạng `kid` — 8–16 hex chữ thường (`/^[0-9a-f]{8,16}$/u`).
 *
 * Biên 8 chữ dưới = 32 bit entropy: đủ để regulator chọn không va chạm trong scope mỗi
 * service, và không quan trọng hơn chữ ký HMAC — `kid` chỉ cần chọn khoá, không tự nó là
 * bảo mật. Biên 16 trần để giữ header nhỏ) và **khoanh vùng lỗi cấu hình sai**: nếu cho
 * phép một chuỗi tự do dài, một người vận hành có thể dán nhầm giá trị secret vào `KID`
 * và nó rơi về lỗi `wrong key` khó tìm thay vì một lỗi hình dạng rõ ràng.
 *
 * Ký tự in hoa bị từ chối cùng với phân biệt chữ hoa/thường của hex là do cấu hình sai:
 * ở mỗi quota một format duy nhất. Xem {@link assertKid}.
 */
const KID_PATTERN = /^[0-9a-f]{8,16}$/u;

/** Giới hạn kích thước thân tối đa (byte) cho envelope nội bộ (đồng thuận giữa auth–account). */
export const INTERNAL_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Định dạng chữ ký — `v1=<hex sha-256>`.
 *
 * ⚠️ `v1` là version của **định dạng chữ ký** (scheme HMAC: thuật toán, cách mã hoá hex,
 * tiền tố `v1=`), **không** phải version của canonicalization. Việc canonicalization đổi
 * (thêm dòng `PROTOCOL_ID`, đổi length prefix sang byte UTF-8) được neo bằng
 * {@link PROTOCOL_ID}, không bằng tiền tố này — nên `v1=` giữ nguyên ở PR hợp nhất là
 * đúng chủ ý, không phải một lần bump bị bỏ sót. Đổi canonical lần sau thì bump
 * `PROTOCOL_ID`, vì đó là thứ nằm **trong** chuỗi được ký.
 *
 * Hệ quả cần biết khi hai phía lệch phiên bản: envelope cũ và envelope mới đều ra
 * `bad_signature` như nhau, không phân biệt được với secret sai. Đó là lý do docs
 * (`docs/applications/auth/03-operations.md`) ghi rõ xoay secret phải deploy đồng thời.
 */
const SIGNATURE_PREFIX = 'v1=';

/**
 * Kiểm `kid` có đúng định dạng {@link KID_PATTERN} không.
 *
 * Ném {@link InvalidKidError} thay vì trả `boolean`: đáy của hợp đồng là lỗi cấu hình sai
 * ở tầng **gửi** phải nổ ngay (tai nơi sinh giá trị), còn trên đường **nhận** nó được dịch
 * thành `invalid_field`. Service nhật ký phía nhận sẽ không thấy ngoại lệ nào — chỉ một
 * `401` và một `reason` trong log.
 */
export function assertKid(
  value: string | null | undefined,
): asserts value is string | null | undefined {
  if (value !== null && value !== undefined && !KID_PATTERN.test(value)) {
    throw new InvalidKidError('kid');
  }
}

/**
 * Lỗi hình dạng của `kid` — dùng ở tầng nhận dịch thành mã `invalid_field`.
 *
 * `field` chỉ là **tên** (`'kid'`), không bao giờ là giá trị: cấu hình sai của đầu vào
 * `kid` đọc được ở nhiều nơi, và một giá trị có thể là nhầm dán secret.
 */
export class InvalidKidError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`internal-auth: kid field "${field}" must be 8-16 lowercase hex characters`);
    this.name = 'InvalidKidError';
    this.field = field;
  }
}

/** Cửa sổ skew mặc định (giây) khi người gọi không nêu. */
export const DEFAULT_SKEW_SECONDS = 300;

/**
 * Biên dưới của cửa sổ skew (giây).
 *
 * `1` chứ không `0`: skew `0` nghĩa là `|now − timestamp| > 0`, mà `now` phía nhận và
 * `timestamp` phía gọi là hai lần đọc đồng hồ **khác nhau** nên gần như luôn lệch nhau ít
 * nhất một giây. Cửa sổ 0 vì vậy từ chối gần như **mọi** envelope hợp lệ, biến một giá trị
 * cấu hình gõ sai thành một kênh nội bộ chết thay vì một lỗi cấu hình bị bắt.
 */
export const MIN_SKEW_SECONDS = 1;

/**
 * Biên trên của cửa sổ skew (giây) — **hằng giao thức, không phải tuỳ chọn vận hành**.
 *
 * Skew là một phần của hợp đồng giữa hai Worker, nên nó phải có **một** trần và trần đó
 * phải nằm ở **đây** — chỗ `resolveSkewSeconds` định nghĩa luật — chứ không ở một validator
 * của một service. Không có trần dùng chung thì hai phía áp hai bộ luật khác nhau cho cùng
 * một hằng: `auth` chặn `86400` lúc khởi động, còn `account` nhận nó và mở cửa sổ replay
 * lên 24 giờ, kéo TTL của nonce theo đúng cửa sổ đó. Lệch trần là lệch đúng kiểu mà PR hợp
 * nhất này tồn tại để dẹp.
 *
 * `3600` rộng hơn {@link DEFAULT_SKEW_SECONDS} nhiều lần để vẫn nới được khi có lý do thật,
 * nhưng vẫn biến một giá trị vô lý (`86400`) thành lỗi cấu hình.
 */
export const MAX_SKEW_SECONDS = 3600;

/**
 * Biên lệch đồng hồ cộng thêm vào TTL của nonce, trên phần skew được chấp nhận (giây).
 *
 * TTL = `timestamp + skewSeconds + buffer`. Một nonce cần sống ít nhất qua toàn bộ
 * cửa sổ replay (`skewSeconds`) để tránh tình huống prune xóa trước khi envelope bị
 * từ chối vì `bad_timestamp`. Do đó, `buffer > 0` (TTL > skew). Hằng này là
 * giao thức (60 giây), được lặp lại có chủ đích trong `apps/account/db/migrate.mts`
 * (và migration đó cũng giữ bản lặp của `DEFAULT_SKEW_SECONDS`) vì script migration
 * Node không import được lib này. Bản lặp được kiểm chứng bằng test đọc nguồn.
 */
export const NONCE_TTL_BUFFER_SECONDS = 60;

/**
 * Ký một canonical string, trả về **hex trần** (64 ký tự), **không** kèm `v1=`.
 *
 * ⚠️ Chính xác như vậy: giá trị trả về là hex thô của HMAC-SHA-256. Tiền tố `v1=` được ghép
 * ở **đúng một chỗ** — {@link signRequest} — và bị bóc ở đúng một chỗ — `hasValidSignature`.
 * Nói hàm này "trả về `v1=<hex>`" là mô tả sai bản cài đặt và dễ dẫn tới việc ghép tiền tố
 * hai lần (`v1=v1=…`), thứ mà `hasValidSignature` từ chối như một chữ ký sai.
 */
async function signCanonical(canonical: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    getEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, getEncoder().encode(canonical));
  return toHex(new Uint8Array(signature));
}

/** Tham số để ký. */
export interface SignRequestInput {
  readonly method: string;
  readonly path: string;
  /**
   * **Đúng byte** sẽ được gửi làm thân request — không phải chuỗi đã decode.
   *
   * Bỏ trống/`null` = thân rỗng. Xem {@link hashBody} cho lý do kiểu ở đây là byte.
   */
  readonly body?: Uint8Array | null;
  readonly secret: string;
  /**
   * `kid` của khoá dùng ký — tuỳ chọn.
   *
   * Có ⇒ gắn {@link INTERNAL_KID_HEADER} vào bộ header trả về; bỏ trống ⇒ không gắn
   * (sender trong transition chưa bật `kid`, và phía nhận vẫn verify được bằng secret
   * hiện hành). Không bao giờ nằm trong canonical string → không đổi gì chữ ký.
   *
   * Sai định dạng (không phải 8–16 hex chữ thường) ⇒ ném {@link InvalidKidError} ngay
   * ở đây: một cấu hình sai lộ ra ở request đầu thay vì ở phía nhận.
   */
  readonly kid?: string;
  /**
   * Actor sub đã verify (OIDC sub) — audit-only. Khi có, được bind vào canonical
   * HMAC. Bỏ trống ⇒ `actor-absent` trong canonical.
   */
  readonly actorSub?: string;
  /** Epoch giây. Truyền vào để lib không tự đọc đồng hồ. */
  readonly timestamp: string;
  /** Nonce; tự sinh khi bỏ trống. */
  readonly nonce?: string;
}

/**
 * Bộ header đã ký, sẵn sàng gắn vào request.
 *
 * Index signature `[key: string]: string` là **bắt buộc**, không phải cho tiện: nó cho
 * phép người gọi truyền thẳng kết quả của `signRequest` vào `headers` của `verifyRequest`
 * mà không phải copy tay. Thiếu nó thì mọi call site phải copy từng header — và đó đúng
 * là chỗ một header bị bỏ sót trong im lặng.
 */
export interface InternalAuthHeaders extends Readonly<Record<string, string>> {
  readonly [INTERNAL_TIMESTAMP_HEADER]: string;
  readonly [INTERNAL_NONCE_HEADER]: string;
  readonly [INTERNAL_SIGNATURE_HEADER]: string;
  // ⚠️ `INTERNAL_KID_HEADER` **không** được khai báo ở đây, chủ ý: index signature của
  // interface này là `string` (xem JSDoc của nó — tồn tại để truyền thẳng vào `headers` của
  // `verifyRequest`), và một property tùy chọn `string | undefined` không gán được vào
  // `Record<string, string>`. Header `kid` đi qua cùng đường: khi có, nó là một entry của
  // record; khi không, nó vắng mặt. Không có cách type nào để biểu diễn "optional specific
  // key" trên một record bắt buộc mà không phá chính index signature đó.
}

/** Sinh bộ header đã ký cho một request nội bộ. */
export async function signRequest(input: SignRequestInput): Promise<InternalAuthHeaders> {
  // `kid` sai định dạng chết ngay nơi sinh giá trị — trước mọi phép HMAC: một cấu hình
  // sai lộ ra ở request đầu, đúng nguyên tắc fail-closed của file này.
  if (input.kid !== undefined) {
    assertKid(input.kid);
  }
  const nonce = input.nonce ?? createNonce();
  const hash = await hashBody(input.body);
  const normalizedActor =
    input.actorSub === undefined || input.actorSub === '' ? undefined : input.actorSub;
  const canonical = canonicalString(
    input.method,
    input.path,
    input.timestamp,
    nonce,
    hash,
    normalizedActor,
  );
  const signature = await signCanonical(canonical, input.secret);
  return {
    [INTERNAL_TIMESTAMP_HEADER]: input.timestamp,
    [INTERNAL_NONCE_HEADER]: nonce,
    [INTERNAL_SIGNATURE_HEADER]: `${SIGNATURE_PREFIX}${signature}`,
    ...(input.kid !== undefined ? { [INTERNAL_KID_HEADER]: input.kid } : {}),
    ...(normalizedActor !== undefined ? { [INTERNAL_ACTOR_SUB_HEADER]: normalizedActor } : {}),
  };
}

/** Lý do từ chối, mỗi lý do tách riêng để audit được. */
export type VerifyFailureReason =
  | 'missing_header'
  | 'bad_timestamp'
  | 'weak_nonce'
  | 'invalid_field'
  | 'replayed_nonce'
  | 'bad_signature';

/** Kết quả verify — union phân biệt theo `ok`. */
export type VerifyResult =
  | {
      readonly ok: true;
      readonly nonce: string;
      readonly timestamp: string;
      readonly actorSub: string | null;
    }
  | { readonly ok: false; readonly reason: VerifyFailureReason };

/** Tham số để verify. */
export interface VerifyRequestInput {
  readonly method: string;
  readonly path: string;
  /**
   * **Đúng byte** thân request đã đọc được từ dây — không phải chuỗi đã decode. Phải là byte
   * **thực tế** mà sign cũng đã dùng (hoặc sẽ dùng). Xem {@link hashBody}.
   */
  readonly body?: Uint8Array | null;
  /**
   * Nguồn header để đọc.
   *
   * Nhận `Headers` của Workers (`event.request.headers`) trực tiếp, hoặc một object thuần.
   * Xem JSDoc của `readHeader` cho lý do cả hai hình dạng đều phải chạy được.
   */
  readonly headers: InternalAuthHeaderSource;
  readonly secret: string;
  /**
   * Resolver secret theo `kid` của header `x-ecoma-internal-kid` — tuỳ chọn, cho phase
   * transition khi xoay secret.
   *
   * Chủ ý: một **callback** chứ không phải một map. Thiếu `kid` trên wire là trạng thái
   * bình thường trong transition (sender chưa bật `kid`), và một số receiver (medium: một
   * secret duy nhất) không muốn khai báo một map chỉ để chạy một khoá. Callback là hình
   * dạng tối thiểu, để hai bên đặt trên cùng một hợp đồng mà không cần loại nào đi trước.
   *
   * Nhận `string | null`: `null` khi header không có mặt (`kid` trống/missing). Trả
   * **secret** hay ném là do người cài resolver; một resolver trả `null`/biến thể khác
   * tuỳ ý làm có chữ ký sai sẽ bị phát hiện ở bên dưới, nhưng kể rõ tại sao trong
   * JSDoc của từng service.
   *
   * ⚠️ **Resolver chạy TRƯỚC verify tổng thể, nhưng sau kiểm hình dạng của `kid`**: sai
   * hình dạng của `kid` giữ nguyên là `invalid_field`, không kích resolver (một `kid`
   * rác có thể là đầu vào do người gọi kiểm soát, không có lý do gì đi vào lệnh tra
   * registry).
   *
   * ⚠️ **Resolver từ chối (ném) ⇔ `bad_signature`** — fail-closed. Không có `kid`-chưa-biết
   * ngày nào được nhận bằng secret fallback: đó là kết trở thành một nhánh "học từ
   * response" từ góc độ bảo mật.
   */
  readonly secretByKid?: (kid: string) => Promise<string>;
  /** Epoch giây hiện tại, do người gọi truyền vào. */
  readonly now: string;
  /**
   * Skew chấp nhận được, tính bằng giây.
   *
   * Bỏ trống ⇒ {@link DEFAULT_SKEW_SECONDS}. Giá trị không phải số hữu hạn không âm
   * (`NaN`, `Infinity`, số âm) **cũng** rơi về mặc định thay vì tắt cửa sổ timestamp —
   * xem {@link resolveSkewSeconds}.
   */
  readonly skewSeconds?: number;
  /**
   * Callback nonce kiểu **chiếm-và-ghi** — trả `true` nếu nonce đã bị chiếm trước đó.
   *
   * ⚠️ Hợp đồng là **chiếm (claim)**, không phải kiểm tra chỉ đọc. Mỗi lần gọi phải ghi
   * nguyên tử một bản ghi bền (insert-or-noop, ví dụ `INSERT ... ON CONFLICT DO NOTHING`)
   * rồi báo lại nonce đã có từ trước hay chưa. Một callback chỉ đọc (`SELECT` không)
   * **vi phạm hợp đồng**: nó không ghi gì, nên cùng một envelope verify được mãi mãi và
   * phần chống replay tắt trong im lặng — mọi test tuần tự vẫn xanh, và đó đúng là cách
   * lỗi này sống sót. Vì vậy tên là `claimNonce` chứ không phải `seenNonce`: cái tên phải
   * buộc người cài đặt thừa nhận phần **ghi**, không chỉ phần kiểm.
   *
   * Tham số thứ hai là timestamp **của envelope** (epoch giây, số nguyên, đã được kiểm
   * định dạng và skew). Phía nhận dùng nó thay vì đồng hồ của mình để tính `expires_at`:
   * nonce chỉ cần sống tới `timestamp + skew`, vì sau đó envelope bị từ chối với
   * `bad_timestamp` — nên neo vào envelope là chính xác. Neo vào `now` của phía nhận thì
   * trôi: `now` có thể chậm hơn timestamp tới trọn một skew (đồng hồ phía nhận chạy chậm),
   * và khi đó TTL `now + skew` làm nonce hết hạn **trước khi** envelope thôi phát lại
   * được (xấu nhất: `now = timestamp - skew` ⇒ TTL thực = `timestamp + buffer` <
   * `timestamp + skew` khi `buffer < skew`) — tức là mở ra một cửa sổ replay thay vì đóng nó lại.
   *
   * `verifyRequest` chỉ gọi callback này **sau khi chữ ký đã được chứng minh hợp lệ**. Đây
   * là điều kiện bảo mật, không phải sở thích về thứ tự: người gọi chưa được xác thực
   * không được phép ghi vào kho nonce. Nếu callback chạy trước bước kiểm chữ ký, kẻ tấn
   * công đọc được nonce của một request thật từ log proxy hay `wrangler tail` có thể gửi
   * một envelope đúng định dạng với chữ ký giả và đốt nonce đó; request thật sau đó rơi
   * vào `replayed_nonce` dù chưa từng bị phát lại, và kẻ tấn công không hề cần secret.
   */
  readonly claimNonce: (nonce: string, timestampSeconds: number) => Promise<boolean> | boolean;
}

/**
 * Chuẩn hoá `skewSeconds` trước khi dùng.
 *
 * ⚠️ Không được để giá trị sai định dạng lọt qua: `Math.abs(a - b) > NaN` là `false`, nên
 * một `skewSeconds` là `NaN` **tắt im lặng** cả cửa sổ timestamp — mọi envelope cũ tuỳ ý
 * qua được, và replay guard chỉ còn lại kho nonce. Đó là fail-**open**, ngược với doctrine
 * của file này. `Number.isFinite` chặn `NaN`/`Infinity`, biên dưới {@link MIN_SKEW_SECONDS}
 * chặn `0` và skew âm (skew âm biến mọi request hợp lệ thành `bad_timestamp`, còn `0` từ chối
 * gần như mọi envelope: hai lần đọc đồng hồ khác nhau hầu như luôn lệch ít nhất một giây), và
 * giá trị không phải số rơi về mặc định.
 *
 * `Infinity` rơi vào đây vì nó vượt mọi `Math.abs(...) > skew`, tức cũng là tắt cửa sổ.
 *
 * ⚠️ **Trần cũng nằm ở đây, không chỉ ở validator của từng service.** Một giá trị trên
 * {@link MAX_SKEW_SECONDS} rơi về mặc định y như `NaN`: cả hai đều là giá trị mà **không**
 * call site nào được phép chạy với nó, vì cửa sổ replay và TTL của nonce đều tính từ số này.
 * Đặt trần ở đây khiến `auth` và `account` không thể áp hai trần khác nhau cho cùng một hằng
 * giao thức — xem JSDoc của {@link MAX_SKEW_SECONDS} cho hậu quả đo được của việc lệch trần.
 * Validator của service vẫn kiểm lại vì chúng fail **lúc khởi động** (một Worker Secret gõ
 * sai phải làm Worker chết, không phải im lặng chạy với mặc định); hai lớp này độc lập và
 * cùng dùng chung hai hằng dưới đây.
 *
 * ⚠️ **Giá trị rơi về không phải giá trị "chặt nhất" — nó là `DEFAULT_SKEW_SECONDS` (300),
 * tức skew RỘNG NHẤT đã biết.** Skew âm **và** `0` không bị siết mà bị **nới** lên 300 giây,
 * nên đây là fail-**loose** ở đúng một chiều. `0` đi vào nhánh này sau khi biên dưới được
 * chốt ở `1` (xem {@link MIN_SKEW_SECONDS}): một cửa sổ `0` không phải "chặt nhất" mà là
 * hỏng, nên nó bị coi như cấu hình sai chứ không được thực thi. Chấp nhận được vì biên dưới
 * vẫn **hữu hạn** (cửa sổ timestamp không bị tắt như `NaN`/`Infinity`), nhưng không được đọc
 * thành "skew hỏng thì bị siết": người đọc sau phải biết chiều thật để không dựa vào một bảo
 * đảm không có.
 *
 * `export`: call site của `claimNonce` cần **đúng con số** mà `verifyRequest` đã dùng, vì
 * TTL của nonce được neo vào nó (`timestamp + skew + buffer`). Chép lại phép chuẩn hoá ở
 * call site là chỗ hai bên lệch nhau, và chiều lệch nguy hiểm là TTL **ngắn hơn** cửa sổ
 * replay — khi đó prune xoá được một nonce mà envelope tương ứng vẫn còn phát lại được.
 * Lấy từ đây thì không thể lệch.
 */
export function resolveSkewSeconds(value: number | undefined): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_SKEW_SECONDS ||
    value > MAX_SKEW_SECONDS
  ) {
    return DEFAULT_SKEW_SECONDS;
  }
  return value;
}

/**
 * Verify envelope của một request nội bộ.
 *
 * ⚠️ **Fail closed**: mọi sai lệch trả `{ ok: false }` — không có nhánh nào coi header
 * thiếu là "chấp nhận được".
 *
 * Thứ tự kiểm: thiếu header -> **hình dạng `kid`** -> **chọn khoá theo `kid`** -> timestamp
 * (định dạng và skew) -> độ mạnh nonce -> **dựng canonical** -> **chứng minh chữ ký** ->
 * **chiếm nonce**.
 *
 * ⚠️ **`kid` được kiểm TRƯỚC timestamp và trước chữ ký** — cố ý. `kid` là **chỉ dẫn chọn
 * khoá**, không phải một trường đã ký: không có khoá thì không có HMAC nào để tính, nên
 * hỏi "khoá nào?" phải đứng trước mọi phép băm. Hình dạng sai của `kid` là lỗi đầu vào
 * (`invalid_field`), không phải chữ ký sai — phân biệt hai thứ đó giữ được khi `kid` rác
 * không đi xây dựng lệnh tra registry.
 *
 * `body` được băm **ngay khi cần**, trên đúng mảng byte người gọi đưa vào, và người gọi phải
 * đọc byte đó từ dây **trước** khi decode/parse — xem {@link hashBody}. Xác thực không bao
 * giờ đi qua một biểu diễn đã parse: một body không hợp lệ UTF-8 vẫn verify được bình thường
 * (byte là byte), và một body JSON dị dạng bị từ chối vì chữ ký không khớp, không vì parse
 * lỗi.
 *
 * ⚠️ **Skew được kiểm TRƯỚC chữ ký** — cố ý, và ngược với bản `auth` cũ
 * (`libs/identity-auth-contracts` trước khi hợp nhất), bản đó kiểm chữ ký trước.
 *
 * ⚠️ **Một oracle thời gian phản hồi VẪN CÒN, và đây là chỗ nói thẳng điều đó.** Nhánh
 * `bad_timestamp` trả về gần như tức thì (regex + so số), còn nhánh còn lại phải đi qua
 * `hashBody` + `importKey`/`sign` của WebCrypto — chênh lệch đủ rõ để đo, nên thứ tự này
 * cho phép dò ra cửa sổ skew (và độ lệch đồng hồ của verifier) mà **không cần secret**.
 * Điều đó **không** được phủ nhận bằng lập luận "mọi call site trả cùng một `401`": một mã
 * lỗi chung là oracle **mã trạng thái**, không phải oracle **thời gian**, và nó không làm
 * hai nhánh mất chênh lệch thời gian. `reason` chỉ dành cho log phía server và cho test.
 *
 * Oracle đó được **chấp nhận**, vì cái giá của việc đóng nó là đắt hơn lợi ích: kiểm chữ ký
 * trước nghĩa là **mọi** request rác (timestamp méo, nonce rác) đều tốn một phép HMAC, tức
 * mở một đường DoS bằng CPU trên request chưa xác thực — bề mặt lớn hơn hẳn việc lộ một con
 * số là cửa sổ skew. Thứ mà thứ tự này **thật sự** chặn là một oracle rẻ hơn nhiều: nếu cửa
 * sổ timestamp bị kiểm **sau** khi chữ ký hợp lệ thì `claimNonce` cũng đã chạy, và kẻ tấn
 * công đọc được nonce từ log proxy/`wrangler tail` có thể **đốt** nonce của một request thật
 * bằng chữ ký giả. Giữ hai tính chất đó, và ghi rõ giới hạn đã biết ở đây thay vì để câu
 * "không thành oracle" đọc như đã đóng cả hai.
 *
 * `claimNonce` (chiếm-và-ghi nguyên tử) chỉ chạy **sau khi chữ ký hợp lệ**: xem JSDoc của
 * {@link VerifyRequestInput.claimNonce} — cho một người gọi chưa xác thực ghi vào kho nonce
 * là cách đốt nonce của người khác.
 */
export async function verifyRequest(input: VerifyRequestInput): Promise<VerifyResult> {
  let actorSub: string | null;
  const timestamp = readHeader(input.headers, INTERNAL_TIMESTAMP_HEADER);
  const nonce = readHeader(input.headers, INTERNAL_NONCE_HEADER);
  const signature = readHeader(input.headers, INTERNAL_SIGNATURE_HEADER);
  if (timestamp === null || nonce === null || signature === null) {
    return { ok: false, reason: 'missing_header' };
  }

  // `kid` đọc trước mọi phép tính HMAC: nó là **chỉ dẫn chọn khoá**, không phải một trường
  // đã ký. Sai hình dạng ⇒ `invalid_field` (giống `canonicalString` bắt surrogate lẻ) —
  // một `kid` rác không đi xây dựng lệnh tra registry, cũng không phải đủ để classify như
  // `bad_signature` (đó là lỗi hình dạng đầu vào, không phải chữ ký).
  const kidHeader = readHeader(input.headers, INTERNAL_KID_HEADER);
  try {
    if (kidHeader !== null) {
      assertKid(kidHeader);
    }
  } catch (error) {
    if (error instanceof InvalidKidError) {
      return { ok: false, reason: 'invalid_field' };
    }
    throw error;
  }

  // Resolver được gọi **riêng** khi có `kid`: không có nó, secret dùng là `input.secret`
  // (phase transition — sender chưa bật `kid`). Resolve sai/nhận ném ⇒ `bad_signature`,
  // fail-closed: không có nhánh nào "chấp nhận với secret mặc định" một envelope mà
  // resolver không biết chọn khoá.
  let secret = input.secret;
  if (kidHeader !== null && input.secretByKid !== undefined) {
    try {
      const resolved = await input.secretByKid(kidHeader);
      if (typeof resolved !== 'string' || resolved.length === 0) {
        return { ok: false, reason: 'bad_signature' };
      }
      secret = resolved;
    } catch {
      return { ok: false, reason: 'bad_signature' };
    }
  }

  if (!isEpochSeconds(timestamp)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const skewSeconds = resolveSkewSeconds(input.skewSeconds);
  // `now` được kiểm chặt như timestamp của header: `Number(' 1700000000')` và
  // `Number('1700000000.5')` đều là số hợp lệ trong JS, nên một phép kiểm
  // `Number.isFinite` đơn thuần sẽ nhận im lặng một đồng hồ sai định dạng rồi tính skew
  // trên một giá trị mà người gọi không hề muốn.
  if (!isEpochSeconds(input.now)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  if (Math.abs(Number(input.now) - Number(timestamp)) > skewSeconds) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  if (!isStrongNonce(nonce)) {
    return { ok: false, reason: 'weak_nonce' };
  }

  // Chữ ký được chứng minh trước khi chạm vào kho nonce. Chỉ sau đó người gọi chưa xác
  // thực mới bị chặn ghi nonce — xem JSDoc của `claimNonce`.
  //
  // ⚠️ Bước dựng canonical có thể ném `InvalidCanonicalFieldError` (trường chứa surrogate lẻ).
  // Bắt **riêng** nó và trả `invalid_field` — fail closed, không để lỗi thoát ra ngoài và
  // cũng không nuốt chung với lỗi `claimNonce` (lỗi kia là `db_unreachable` ⇒ 503, một sự
  // kiện vận hành hoàn toàn khác). Hàm vẫn giữ hợp đồng "mọi sai lệch trả `{ ok: false }`":
  // không có đường nào để một envelope hỏng biến thành `ok: true`, và cũng không có đường
  // nào để nó biến thành một biểu diễn canonical khác.
  let expected: string;
  try {
    const hash = await hashBody(input.body);
    const actorHeader = readHeader(input.headers, INTERNAL_ACTOR_SUB_HEADER);
    actorSub = typeof actorHeader === 'string' && actorHeader.length > 0 ? actorHeader : null;
    const canonical = canonicalString(
      input.method,
      input.path,
      timestamp,
      nonce,
      hash,
      actorSub ?? undefined,
    );
    expected = await signCanonical(canonical, secret);
  } catch (error) {
    if (error instanceof InvalidCanonicalFieldError) {
      return { ok: false, reason: 'invalid_field' };
    }
    throw error;
  }
  if (!hasValidSignature(signature, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // `timestamp` đã qua `isEpochSeconds`, nên `Number()` không mất mát (safe integer).
  // Truyền nó cho phía nhận thay vì để phía nhận đoán từ `now` của chính nó — xem JSDoc
  // của `claimNonce`.
  if (await input.claimNonce(nonce, Number(timestamp))) {
    return { ok: false, reason: 'replayed_nonce' };
  }

  return { ok: true, nonce, timestamp, actorSub };
}

/**
 * Kiểm một chữ ký `v1=<hex>` có khớp HMAC mong đợi không.
 *
 * Header phải mang đúng version `v1`; version khác bị từ chối thẳng thay vì được đem so
 * như một chữ ký bất kỳ — nếu không, một scheme tương lai dùng version riêng của nó sẽ lọt
 * qua dưới luật so sánh của `v1`.
 */
function hasValidSignature(header: string, expectedHex: string): boolean {
  if (!header.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const provided = header.slice(SIGNATURE_PREFIX.length);
  return timingSafeEqualHex(expectedHex, provided);
}

/**
 * Đọc một header không phân biệt chữ hoa/thường.
 *
 * Nhận **hai** hình dạng, và cả hai đều được hỗ trợ thật:
 *
 *  1. một `Iterable` cặp khoá/giá trị — `Headers` của Workers (`event.request.headers`),
 *     `Map`, hay mảng `[key, value]`; và
 *  2. một object thuần `Record<string, string | null | undefined>` — kết quả của
 *     `Object.fromEntries(...)`, một fixture test, hay chính giá trị `signRequest` trả về.
 *
 * ⚠️ **Vì sao phải là iterable chứ không chỉ object thuần.** `Headers` lưu cặp key/value
 * trong map nội bộ, **không** phải own enumerable property, nên
 * `Object.entries(new Headers({ 'x-ecoma-internal-signature': s }))` là `[]`. Nếu hàm này
 * chỉ đọc bằng `Object.entries` thì truyền thẳng `request.headers` trả `null` cho **mọi**
 * header và **mọi** request nội bộ thành `missing_header` — một bẫy im lặng trên đúng đường
 * xác thực, không có dấu hiệu nào chỉ ra nguyên nhân. Hợp đồng nhận iterable làm điều mà
 * một comment "nhớ chuyển `Headers` sang object trước" không làm được: nó đúng ở mức kiểu.
 *
 * Vòng lặp vẫn so khoá không phân biệt hoa thường. `Headers` và mọi nguồn HTTP đều đã hạ
 * chữ thường, nhưng một object thuần từ test hay từ adapter khác thì có thể chưa.
 */
function readHeader(headers: InternalAuthHeaderSource, name: string): string | null {
  const target = name.toLowerCase();
  const entries: Iterable<readonly [string, string | null | undefined]> = isIterable(headers)
    ? headers
    : Object.entries(headers);
  for (const [key, value] of entries) {
    if (key.toLowerCase() === target && typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** Nguồn header mà {@link readHeader} chấp nhận — xem JSDoc của nó cho hai hình dạng. */
type InternalAuthHeaderSource =
  | Readonly<Record<string, string | null | undefined>>
  | Iterable<readonly [string, string | null | undefined]>;

/**
 * Nhận diện nguồn dạng iterable (vd `Headers`) so với object thuần.
 *
 * Không dùng `instanceof Headers`: `Headers` là global của runtime và không tồn tại trong
 * mọi môi trường test, còn phép kiểm `Symbol.iterator` đúng cho mọi nguồn cặp khoá/giá trị
 * và **không** đúng cho object thuần (object thường không iterable).
 */
function isIterable(
  value: InternalAuthHeaderSource,
): value is Iterable<readonly [string, string | null | undefined]> {
  return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

/** Timestamp hợp lệ là chuỗi epoch giây, số nguyên không âm, không có phần thập phân. */
function isEpochSeconds(value: string): boolean {
  if (!/^\d+$/u.test(value)) {
    return false;
  }
  return Number.isSafeInteger(Number(value));
}

/**
 * Trần của mốc hết hạn nonce — `2100-01-01T00:00:00Z` tính bằng epoch giây.
 *
 * Không phải một con số tuỳ ý: nó là **chân trời thiết kế** của hệ thống, và giá trị đúng được
 * test đối chiếu với `Date.UTC(2100, 0, 1) / 1000` để không ai "làm tròn" nó.
 *
 * Vì sao cần một trần: `expires_at` là **dữ liệu do người gọi quyết định** (`timestamp + skew +
 * buffer`), và lỗi đơn vị ở đây không tự lộ ra. `to_timestamp(<epoch mili giây>)` của PostgreSQL
 * nhận im lặng một mốc mili giây và tạo ra `expires_at` vào **năm 57000** — một hàng không bao
 * giờ được prune, tức một nonce sống mãi. Trần này biến cả lớp lỗi đó thành từ chối thẳng.
 */
export const MAX_NONCE_EXPIRY_EPOCH_SECONDS = 4_102_444_800;

/**
 * Kiểm mốc hết hạn của một nonce có hợp lệ không — dùng ở **tầng ghi** của kho nonce.
 *
 * Bốn lớp lỗi bị chặn, mỗi lớp vì một lý do khác nhau:
 *
 * 1. **Không phải số nguyên hữu hạn** (`NaN`, `Infinity`, số thập phân, `string`). `NaN` đặc
 *    biệt nguy hiểm vì nó không ném ở tầng so sánh — nó chỉ khiến mọi so sánh thành `false`.
 * 2. **Không dương.** `expires_at` ở quá khứ là một nonce đã chết ngay khi ghi: prune xoá nó
 *    trong lần chạy kế tiếp, và cửa sổ replay mở lại trong khi envelope vẫn dùng được.
 * 3. **Vượt {@link MAX_NONCE_EXPIRY_EPOCH_SECONDS}.** Chặn lỗi đơn vị (epoch mili giây) và
 *    chặn một TTL vô hạn biến kho nonce thành bảng append-only phình mãi.
 * 4. **Không phải số** (ví dụ `undefined` lọt qua từ một call site thiếu tham số).
 *
 * ⚠️ Đây là phép kiểm **theo hợp đồng**, không phải theo thời điểm hiện tại: hàm không đọc
 * đồng hồ (giống phần còn lại của lib này), nên một mốc hợp lệ-về-hình-dạng nhưng nằm ở quá
 * khứ **gần** vẫn qua được. Người gọi phải neo đúng `timestamp + skew + buffer`.
 */
export function isValidNonceExpirySeconds(value: number): boolean {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return false;
  }
  return value >= 1 && value <= MAX_NONCE_EXPIRY_EPOCH_SECONDS;
}

/**
 * Khẳng định một mốc hết hạn nonce hợp lệ, ném nếu không — dùng ở tầng ghi của kho nonce.
 *
 * ⚠️ **Không đưa giá trị vào message.** Cùng lý do với mọi chỗ khác trong repo: một giá trị
 * cấu hình/tham số có thể là thứ không nên xuất hiện trong log, và một message chỉ cần nói
 * *cái gì* sai (tên tham số) chứ không cần nói *giá trị nào*. Ở đây nó còn là số, nhưng quy
 * tắc phải thống nhất — một ngoại lệ "số thì được" là chỗ để một giá trị khác lọt vào sau này.
 *
 * `error` mặc định là `RangeError`: đây là lỗi lập trình/đơn vị, không phải lỗi I/O, và nó
 * **phải** ném để đường gọi dịch thành fail-closed (503) chứ không thành một lần ghi sai.
 *
 * @param value Mốc hết hạn cần kiểm.
 * @param createError Dựng lỗi để ném — cho phép mỗi tầng dùng lớp lỗi của mình.
 */
export function assertNonceExpirySeconds(
  value: number,
  createError: (message: string) => Error = (message) => new RangeError(message),
): asserts value is number {
  if (!isValidNonceExpirySeconds(value)) {
    throw createError(
      'nonce expiry phai la epoch giay, so nguyen trong [1, MAX_NONCE_EXPIRY_EPOCH_SECONDS]',
    );
  }
}
