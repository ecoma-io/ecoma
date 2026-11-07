import { assertKid, DEFAULT_SKEW_SECONDS, MAX_SKEW_SECONDS } from '@ecoma-io/auth-contracts';
// Port (kiểu) từ domain; bản cài đặt (giá trị, đường `jose`) từ infrastructure —
// composition root là nơi duy nhất được ghép hai lớp này vào nhau.
import { AuthConfigurationError, type SigningKeyProvider } from '@ecoma-io/auth-domain';
import { SigningKeyProvider as SigningKeyProviderImpl } from '@ecoma-io/auth-infrastructure';

/**
 * Nạp cấu hình từ Worker Secrets (D2, D4).
 *
 * ⚠️ Nguyên tắc: **thiếu cấu hình là lỗi, không phải lý do đoán**. Mỗi `require`
 * ở đây ném `AuthConfigurationError` và làm Worker KHÔNG phát hành token. Điều
 * này cố ý đặt ở module khởi động thay vì ở chỗ dùng, để lỗi cấu hình lộ ra
 * lúc deploy chứ không phải lúc có request đầu tiên của khách.
 *
 * ⚠️ KHÔNG có giá trị mặc địn nào cho bí mật. Default cho một secret là bằng với
 * việc dùng một khoá mà người đọc repo đoán được.
 */

/** Shape của `env` mà Worker nhận từ binding + secrets. */
export interface AuthEnv {
  /** Hyperdrive binding tới `db-auth`. Không phải connection string. */
  HYPERDRIVE?: { connectionString: string };
  /** PKCS#8 PEM ES256 (D4). */
  AUTH_SIGNING_KEY?: string;
  /** `kid` công bố trong JWKS. */
  AUTH_SIGNING_KEY_ID?: string;
  /** 32 byte base64url — khoá HMAC cho handle X/Y/Z (FR-016k). */
  AUTH_HANDLE_KEY?: string;
  /**
   * Phiên bản khoá `AUTH_HANDLE_KEY` tại thời điểm mint (§5.6) — chuỗi chữ số
   * thập phân của số nguyên dương. Được ghi vào cột `key_version` của
   * `authorization_transactions`.
   */
  AUTH_HANDLE_KEY_VERSION?: string;
  /** Secret HMAC dùng cho các contract nội bộ hai chiều. */
  AUTH_INTERNAL_SECRET?: string;
  /**
   * `kid` của `AUTH_INTERNAL_SECRET` — tuỳ chọn (transition). Có ⇒ mọi envelope đi ra
   * gắn `x-ecoma-internal-kid`; thiếu ⇒ sender gửi envelope không `kid` (phía nhận vẫn
   * verify được bằng secret hiện hành).
   */
  AUTH_INTERNAL_KID?: string;
  /**
   * Secret HMAC **chỉ dùng để verify** — tuỳ chọn. Không bao giờ dùng để **ký**.
   *
   * ⚠️ **Đây là slot "verify-only", không phải slot "khoá cũ".** Khi xoay secret, nó
   * chứa khoá **mới** trong pha nạp trước, rồi khoá **cũ** trong pha overlap — cùng một
   * cặp biến, hai ý nghĩa khác nhau theo giai đoạn. Xem runbook ở
   * `docs/applications/auth/03-operations.md` §3.3.
   */
  AUTH_INTERNAL_PREVIOUS_SECRET?: string;
  /** `kid` của `AUTH_INTERNAL_PREVIOUS_SECRET` — bắt buộc khi previous secret được đặt. */
  AUTH_INTERNAL_PREVIOUS_KID?: string;
  /** Skew (giây) của envelope internal — để trống ⇒ `DEFAULT_SKEW_SECONDS`. */
  AUTH_INTERNAL_SKEW_SECONDS?: string;
  /** Issuer, phải khớp `iss` trong discovery. */
  AUTH_ISSUER?: string;
  /** Audience của access token — resource server được phép dùng. */
  AUTH_AUDIENCE?: string;
  /**
   * JSON array của registry resource server: mỗi phần tử `{ audience, clientIds? }`.
   * `audience` là resource indicator được phép; `clientIds` (tuỳ chọn) là danh
   * sách client được glue tự chọn resource đó. Thiếu biến ⇒ chỉ dùng
   * `AUTH_AUDIENCE` như resource duy nhất (back-compat).
   */
  AUTH_RESOURCES?: string;
  /**
   * Cookie keys (keygrip) dùng ký cookie phiên của oidc-provider — một hoặc nhiều
   * key, phân tách bằng dấu phẩy. Key đầu là key ký; các key sau chỉ để verify
   * trong cửa sổ xoay khoá.
   */
  AUTH_COOKIE_KEYS?: string;
  /**
   * Base URL của deploy unit `account` — nơi interactions.url của provider dẫn
   * browser tới trang login (`https://account.ecoma.io/login?handle=...`).
   */
  AUTH_ACCOUNT_BASE_URL?: string;
  /** Cổng dịch vụ `account`. Bắt buộc — thiếu thì không có fail-closed point. */
  ACCOUNT_SERVICE?: {
    fetch: (request: Request, init?: RequestInit) => Promise<Response>;
  };
}

/** Một resource server được `auth` phục vụ — audience và các client được glue
 *  tự chọn resource đó cho. */
export interface AuthResource {
  readonly audience: string;
  readonly clientIds: readonly string[];
}

/** Cấu hình đã kiểm, dùng bởi composition root. */
export interface AuthConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Registry resource server được `auth` phục vụ (audience → client). Dùng cho
   *  `resourceIndicators` của provider và glue chọn resource theo client. */
  readonly resources: readonly AuthResource[];
  readonly handleKey: string;
  /** Phiên bản của `handleKey` tại thời điểm mint (§5.6: ghi lại lúc mint). */
  readonly handleKeyVersion: number;
  readonly internalSecret: string;
  /** `kid` của `internalSecret`, đã qua kiểm — `undefined` khi chưa bật `kid`. */
  readonly internalKid: string | undefined;
  /**
   * Map `kid` → secret cho resolver phía nhận: current trước, previous sau (nếu có).
   * Nhóm lại ở đây để composition root truyền thẳng một callback duy nhất xuống
   * `isAuthenticatedInternalRequest`, không thiếu thành phần nào mỗi lần gắn.
   */
  readonly internalSecretsByKid: ReadonlyMap<string, string>;
  readonly internalAuthSkewSeconds: number;
  readonly accessTokenTtlSeconds: number;
  readonly signingKeyProvider: SigningKeyProvider;
  /**
   * PEM PKCS#8 đã qua kiểm của `SigningKeyProvider.fromPem` — bản rõ mà keystore
   * của oidc-provider cần để export JWK có `d` (xem `oidc/provider.ts`). Giữ ở đây
   * thay vì đọc lại `env` ở factory để cấu hình được nạp ĐÚNG MỘT lần và mọi dependency
   * nhận cùng một giá trị đã kiểm.
   */
  readonly signingKeyPem: string;
  readonly hyperdrive: { connectionString: string };
  /**
   * Cookie keys (keygrip) của oidc-provider: phần tử đầu ký, phần tử sau verify.
   * Bắt buộc ít nhất một key — cookie phiên không ký là cookie phiên làm giả được.
   */
  readonly cookieKeys: readonly string[];
  /** Base URL của `account` cho interactions.url (login/consent UI). */
  readonly accountBaseUrl: string;
}

/**
 * Ném khi thiếu secret. Thông báo nêu TÊN biến để người vận hành biết cấp cái
 * gì — nhưng không bao giờ nêu giá trị.
 *
 * ⚠️ Secret có whitespace đầu/cuối bị TỪ CHỐI, không phải trim rồi dùng. Trim
 * âm thầm đổi giá trị bí mật: cả `account` dùng chung HMAC secret sẽ ký với
 * chuỗi đã trim, còn `auth` ký với chuỗi có khoảng trắng — hai chữ ký lệch và
 * mọi request nội bộ hỏng, mà nguyên nhân là một cú dán thiếu tinh tế. Không
 * âm thầm đổi: fail-closed để người vận hành thấy rõ.
 */
function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new AuthConfigurationError(`Worker Secret ${name} chua duoc dat; auth KHONG cap token`);
  }
  if (value !== value.trim()) {
    throw new AuthConfigurationError(
      `Worker Secret ${name} co khoang trang dau/cuoi; auth tu choi thay vi trim am tham`,
    );
  }
  return value;
}

/**
 * Nạp và kiểm toàn bộ cấu hình.
 *
 * ⚠️ `AUTH_SIGNING_KEY` được truyền vào `SigningKeyProvider.fromPem`, và hàm đó
 * KHÔNG sinh khoá thay thế khi thiếu. Đó là một quyết định của quyết định
 * D4: một khoá sinh lúc khởi động sẽ đổi mỗi lần deploy, làm JWKS đổi theo và
 * làm mọi token đã cấu không còn verify được.
 */
export async function loadAuthConfig(env: AuthEnv): Promise<AuthConfig> {
  const signingKeyPem = requireSecret(env.AUTH_SIGNING_KEY, 'AUTH_SIGNING_KEY');
  const kid = requireSecret(env.AUTH_SIGNING_KEY_ID, 'AUTH_SIGNING_KEY_ID');

  // `kid` của envelope internal — cặp (kid, secret hiện hành) và (kid, secret cũ) được
  // kiểm nguyên vẹn ở đây: một biến được đặt mà cặp của nó thiếu là cấu hình sai rõ ràng
  // (fail-closed lúc boot, trước request đầu). Xem `parseInternalKidPair` dưới đây.
  const internalKid = parseOptionalKid(env.AUTH_INTERNAL_KID, 'AUTH_INTERNAL_KID');
  const internalPreviousKid = parseOptionalKid(
    env.AUTH_INTERNAL_PREVIOUS_KID,
    'AUTH_INTERNAL_PREVIOUS_KID',
  );
  const internalPreviousSecret = env.AUTH_INTERNAL_PREVIOUS_SECRET;
  if (internalPreviousSecret !== undefined) {
    if (
      internalPreviousSecret.trim() === '' ||
      internalPreviousSecret !== internalPreviousSecret.trim()
    ) {
      throw new AuthConfigurationError(
        'Worker Secret AUTH_INTERNAL_PREVIOUS_SECRET rong hoac co khoang trang dau/cuoi; auth tu choi thay vi trim am tham',
      );
    }
    if (internalPreviousKid === undefined) {
      throw new AuthConfigurationError(
        'AUTH_INTERNAL_PREVIOUS_SECRET duoc dat nhung thieu AUTH_INTERNAL_PREVIOUS_KID; ' +
          'envelope co kid khong the duoc li khong co anh xa kid -> secret',
      );
    }
  } else if (internalPreviousKid !== undefined) {
    throw new AuthConfigurationError(
      'AUTH_INTERNAL_PREVIOUS_KID duoc dat nhung thieu AUTH_INTERNAL_PREVIOUS_SECRET',
    );
  }
  if (
    internalKid !== undefined &&
    internalPreviousKid !== undefined &&
    internalKid === internalPreviousKid
  ) {
    throw new AuthConfigurationError(
      'AUTH_INTERNAL_KID trung AUTH_INTERNAL_PREVIOUS_KID; hai khoa khong the chia mot kid',
    );
  }

  // Hyperdrive: thiếu binding là fail-closed, không phải "chạy không có DB".
  // `auth` cần `db-auth` ở mọi đường phát hành, nên Worker không có database là
  // Worker không có chức năng.
  const hyperdrive = env.HYPERDRIVE;
  if (hyperdrive === undefined || typeof hyperdrive.connectionString !== 'string') {
    throw new AuthConfigurationError(
      'Hyperdrive binding tới db-auth chua duoc gan; auth fail-closed',
    );
  }

  // Service binding tới `account` là control point fail-closed lúc phát hành.
  // Thiếu nó thì ta sẽ không có cách nào hỏi trạng thái account, và "không hỏi
  // được cũng coi như khoẻ" chính là lỗi mà thiết kế cấm.
  if (env.ACCOUNT_SERVICE === undefined) {
    throw new AuthConfigurationError(
      'Service binding ACCOUNT_SERVICE chua duoc gan; auth khong the fail-closed khi Account khong goi duoc',
    );
  }

  // Skew của envelope internal — để trống ⇒ `DEFAULT_SKEW_SECONDS` của lib, tức
  // cùng con số `verifyRequest` dùng. Đặt số khác lib mà không cập nhật lib là một
  // cách để hai bên lệch nhau im lặng: phía `auth` **không** có cross-check nào —
  // `internal-nonces.spec.ts` đọc nguồn `apps/account/db/migrate.mts` để so hằng lặp
  // lại của **account**, còn skew của `auth` chỉ được parse ở đây. Skew là một hằng
  // giao thức, không phải một tuỳ chọn deploy; đổi nó phải đổi cả hai service.
  const internalAuthSkewSeconds = parseInternalAuthSkewSeconds(env.AUTH_INTERNAL_SKEW_SECONDS);
  const handleKeyVersion = parseHandleKeyVersion(env.AUTH_HANDLE_KEY_VERSION);

  const audience = requireSecret(env.AUTH_AUDIENCE, 'AUTH_AUDIENCE');

  return {
    issuer: requireSecret(env.AUTH_ISSUER, 'AUTH_ISSUER'),
    audience,
    resources: parseResources(env.AUTH_RESOURCES, audience),
    handleKey: requireSecret(env.AUTH_HANDLE_KEY, 'AUTH_HANDLE_KEY'),
    handleKeyVersion,
    internalSecret: requireSecret(env.AUTH_INTERNAL_SECRET, 'AUTH_INTERNAL_SECRET'),
    internalKid,
    internalSecretsByKid: buildInternalSecretsByKid({
      currentKid: internalKid,
      currentSecret: requireSecret(env.AUTH_INTERNAL_SECRET, 'AUTH_INTERNAL_SECRET'),
      previousKid: internalPreviousKid,
      previousSecret: internalPreviousSecret,
    }),
    internalAuthSkewSeconds,
    accessTokenTtlSeconds: 300,
    signingKeyProvider: await SigningKeyProviderImpl.fromPem({ pem: signingKeyPem, kid }),
    signingKeyPem,
    hyperdrive,
    cookieKeys: parseCookieKeys(env.AUTH_COOKIE_KEYS),
    accountBaseUrl: requireSecret(env.AUTH_ACCOUNT_BASE_URL, 'AUTH_ACCOUNT_BASE_URL'),
  };
}

/**
 * Parse cookie keys — phân tách bằng dấu phẩy, ít nhất MỘT key.
 *
 * ⚠️ Cùng bộ luật "fail-closed, không trim âm thầm" với `requireSecret`: key có
 * khoảng trắng đầu/cuối bị từ chối thay vì được dùng. Keygrip verify tuần tự theo
 * danh sách, key đầu ký — thứ tự trong chuỗi chính là thứ tự xoay khoá.
 */
function parseCookieKeys(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_COOKIE_KEYS chua duoc dat; cookie phien oidc-provider khong the duoc ky',
    );
  }
  const keys = value.split(',');
  for (const key of keys) {
    if (key !== key.trim() || key === '') {
      throw new AuthConfigurationError(
        'Worker Secret AUTH_COOKIE_KEYS co phan tu rong hoac khoang trang dau/cuoi',
      );
    }
  }
  return keys;
}

/**
 * Parse phiên bản khoá handle — **chuỗi chữ số thập phân của số nguyên dương**.
 *
 * ⚠️ Cùng bộ luật với `parseInternalAuthSkewSeconds`: chuỗi bừa đảo bị từ chối
 * thay vì `Number()` âm thầm nhận (`'0x10'`, `'1e3'`, `'+3'`, `'3.0'`, khoảng
 * trắng). Thiếu biến là LỖI chứ không phải "mặc định 1": một giá trị ẩn dưới
 * default biến rotation thành vô dụng — mọi transaction mint sau khi xoay
 * khoá vẫn ghi version cũ mà không ai biết. Việc xoay khoá là thao tác vận
 * hành PHẢI cập nhật biến này cùng `AUTH_HANDLE_KEY`; thiếu một trong hai là
 * cấu hình sai rõ ràng, fail-closed ngay lúc boot.
 */
function parseHandleKeyVersion(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_HANDLE_KEY_VERSION chua duoc dat; khong the ghi key_version khi mint handle',
    );
  }
  if (!/^\d+$/u.test(value)) {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_HANDLE_KEY_VERSION khong phai chuoi chu so thap phan',
    );
  }
  const parsed = Number(value);
  if (parsed < 1) {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_HANDLE_KEY_VERSION phai la so nguyen duong (>= 1)',
    );
  }
  return parsed;
}

/**
 * Trần của skew envelope internal (giây) — **hằng giao thức, không phải tuỳ chọn vận hành**.
 *
 * Trần sống ở `@ecoma-io/auth-contracts` (`MAX_SKEW_SECONDS`) chứ không ở đây: nếu
 * mỗi service tự chốt trần riêng thì `auth` có thể từ chối `86400` lúc boot trong khi
 * `account` vẫn nhận và mở cửa sổ replay 24 giờ — đúng kiểu trôi lệch mà PR hợp nhất này
 * dẹp. `parseInternalAuthSkewSeconds` kiểm lại cùng con số đó (chứ không chỉ đọc hằng) vì
 * nó phải **fail lúc boot** với `AuthConfigurationError`, không được để lib âm thầm thay
 * bằng mặc định. Skew cũng kéo TTL của nonce theo (`timestamp + skew + buffer`), tức làm
 * phình bảng `auth.internal_nonces` theo đúng cửa sổ đó.
 */
const MAX_INTERNAL_SKEW_SECONDS = MAX_SKEW_SECONDS;

/**
 * Parse skew envelope internal — **chuỗi chữ số thập phân**, số nguyên **dương**, giây.
 *
 * ⚠️ Không accept chuỗi số bừa đảo: `Number('300')` là 300, `Number('300x')` là
 * NaN, `Number(' 300 ')` là 300. Dùng `/^\d+$/` để từ chối mọi dạng mà `Number()` vẫn
 * nhận im lặng — `'0x10'` (16), `'1e3'` (1000), `'+300'` (300), `'3.0'` (3) — và từ chối
 * khoảng trắng: một skew là một hằng giao thức, không phải một trường người vận hành
 * điền bừa. Giá trị vượt {@link MAX_INTERNAL_SKEW_SECONDS} cũng bị từ chối.
 *
 * ⚠️ **`'0'` cũng bị từ chối, và đó không phải chi tiết hình thức.** Skew 0 nghĩa là
 * `Math.abs(now - timestamp) > 0`, mà `now` phía nhận và `timestamp` phía gọi là hai lần
 * đọc đồng hồ khác nhau — chúng gần như luôn lệch nhau ít nhất 1 giây. Kết quả: gần như
 * **mọi** envelope hợp lệ rơi vào `bad_timestamp` và toàn bộ đường nội bộ trả `401`, tức
 * một Worker Secret gõ sai làm chết kênh thay vì bị từ chối. Bên `account`
 * (`config-validation.ts`) cũng đã chốt "phải là số nguyên dương" cho **cùng hằng giao
 * thức này**; hai bộ luật khác nhau cho một hằng số là đúng kiểu trôi lệch mà PR hợp nhất
 * này đang dẹp. Biên dưới 1 giây là biên nhỏ nhất còn dùng được.
 *
 * ⚠️ **Không bao giờ nhắc giá trị vào message lỗi.** Một operator có thể dán nhầm một
 * `AUTH_INTERNAL_SECRET` vào `AUTH_INTERNAL_SKEW_SECONDS` (hoặc ngược lại). Nếu nhắc giá trị
 * vào message, nó sẽ lọt ra **error log** của Worker. Do đó tất cả các nhánh lỗi đều chỉ nói
 * *cái gì* sai (định dạng, biên dưới, biên trên) chứ không bao giờ nói *giá trị nào*. Đây là
 * áp dụng trực tiếp F-07, không phải chi tiết hiển thị.
 */
function parseInternalAuthSkewSeconds(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_SKEW_SECONDS;
  }
  if (!/^\d+$/u.test(value)) {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_INTERNAL_SKEW_SECONDS khong phai chuoi chu so thap phan',
    );
  }
  const parsed = Number(value);
  if (parsed < 1) {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_INTERNAL_SKEW_SECONDS phai la so nguyen duong (>= 1) giay',
    );
  }
  if (parsed > MAX_INTERNAL_SKEW_SECONDS) {
    throw new AuthConfigurationError(
      `Worker Secret AUTH_INTERNAL_SKEW_SECONDS vuot tran ${MAX_INTERNAL_SKEW_SECONDS} giay`,
    );
  }
  return parsed;
}

/**
 * Dựng resolver `kid` → secret cho phía nhận envelope.
 *
 * ⚠️ Callback ném khi `kid` không có trong map — lib dịch thành `bad_signature`
 * (fail-closed): envelope tự khao `kid` ngoài registry là envelope không có khoá để
 * khớp, không bao giờ được "chấp nhận với secret mặc định".
 *
 * ⚠️ Resolver này là **cùng một nguồn** với secret dùng ký (`internalSecret`): khi
 * `internalKid` được đặt, entry current của map trả về chính secret đó — hai nguồn số
 * cho một khoá là chỗ hai phía lệch nhau trong transition.
 */
export function resolveInternalSecret(config: AuthConfig): (kid: string) => Promise<string> {
  return async (kid: string): Promise<string> => {
    const secret = config.internalSecretsByKid.get(kid);
    if (secret === undefined) {
      throw new Error(`kid '${kid}' khong co trong registry secret internal cua auth`);
    }
    return secret;
  };
}

/**
 * Parse `kid` tuỳ chọn của envelope internal — rỗng ⇒ `undefined` (transition: `kid`
 * chưa bật), và khi có thì phải đúng hình dạng 8–16 hex chữ thường của lib
 * (`assertKid`). Sai hình dạng là lỗi cấu hình, phải nổ lúc boot — không âm thầm gửi
 * một header `kid` rác đi ra.
 */
function parseOptionalKid(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value !== value.trim()) {
    throw new AuthConfigurationError(
      `Worker Secret ${name} co khoang trang dau/cuoi; auth tu choi thay vi trim am tham`,
    );
  }
  try {
    assertKid(value);
  } catch {
    throw new AuthConfigurationError(
      `Worker Secret ${name} khong dung dinh dang 8-16 hex chu thuong cung kid envelope`,
    );
  }
  return value;
}

/**
 * Dựng map `kid` → secret cho resolver phía nhận.
 *
 * ⚠️ Entry previous chỉ có khi **cả hai** biến previous được đặt — hai kiểm rời ở
 * `loadAuthConfig` đã chặn mọi tổ hợp lệch, nên builder này chỉ còn xử lý trường hợp
 * chuẩn. Map rỗng (không `kid` nào được đặt) là hợp lệ: phía nhận verify envelope có
 * `kid` sẽ trả `bad_signature` từ resolver, còn envelope không `kid` dùng secret
 * hiện hành như trước.
 */
function buildInternalSecretsByKid(entries: {
  currentKid: string | undefined;
  currentSecret: string;
  previousKid: string | undefined;
  previousSecret: string | undefined;
}): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (entries.currentKid !== undefined) {
    map.set(entries.currentKid, entries.currentSecret);
  }
  if (entries.previousKid !== undefined && entries.previousSecret !== undefined) {
    map.set(entries.previousKid, entries.previousSecret);
  }
  // Hai secret trùng giá trị (kể khác kid) là cấu hình mơ hồ: cùng giá trị nhưng hai
  // `kid` khác nhau khiến "kid nào cũng đúng" — xóa chủ ý của selector. Chặn lúc boot.
  const secretsByValue = new Map<string, string>();
  for (const [kid, secret] of map) {
    const owner = secretsByValue.get(secret);
    if (owner !== undefined) {
      throw new AuthConfigurationError(
        `AUTH_INTERNAL_SECRET va AUTH_INTERNAL_PREVIOUS_SECRET trung gia tri; hai kid ${owner} va ${kid} khong the chia mot secret`,
      );
    }
    secretsByValue.set(secret, kid);
  }
  return map;
}

/**
 * Parse registry resource server từ env `AUTH_RESOURCES` (JSON array). Thiếu
 * biến ⇒ chỉ primary audience (back-compat). Fail-closed khi JSON hỏng hoặc
 * thiếu `audience`.
 *
 * Mỗi phần tử: `{ audience: string, clientIds?: string[] }`.
 */
export function parseResources(
  value: string | undefined,
  primaryAudience: string,
): readonly AuthResource[] {
  const primary: AuthResource = { audience: primaryAudience, clientIds: Object.freeze([]) };
  if (value === undefined || value.trim() === '') {
    return Object.freeze([Object.freeze(primary)]);
  }
  if (value !== value.trim()) {
    throw new AuthConfigurationError(
      'Worker Secret AUTH_RESOURCES co khoang trang dau/cuoi; auth tu choi thay vi trim am tham',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AuthConfigurationError('Worker Secret AUTH_RESOURCES khong phai JSON hop le');
  }
  if (!Array.isArray(parsed)) {
    throw new AuthConfigurationError('Worker Secret AUTH_RESOURCES phai la JSON array');
  }
  const resources: AuthResource[] = [];
  const seenAudiences = new Set<string>();
  // Client ID phải duy nhất TOÀN CỤC: một client map vào hai audience là mapping
  // mơ hồ — glue chọn theo thứ tự mảng sẽ cho kết quả khác nhau khi thứ tự đổi.
  // Chặn lúc boot, cùng bộ luật "cấu hình mơ hồ bị từ chối" với kid/secret trùng.
  const seenClientIds = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AuthConfigurationError('Worker Secret AUTH_RESOURCES: moi phan tu phai la object');
    }
    const record = entry as Record<string, unknown>;
    const aud = record['audience'];
    if (typeof aud !== 'string' || aud.trim() === '' || aud !== aud.trim()) {
      throw new AuthConfigurationError(
        'Worker Secret AUTH_RESOURCES: truong "audience" phai la chuoi khong rong, khong khoang trang dau/cuoi',
      );
    }
    if (seenAudiences.has(aud)) {
      throw new AuthConfigurationError('Worker Secret AUTH_RESOURCES: audience trung lap');
    }
    seenAudiences.add(aud);
    const rawClientIds = record['clientIds'];
    let clientIds: readonly string[] = Object.freeze([]);
    if (rawClientIds !== undefined) {
      if (!Array.isArray(rawClientIds)) {
        throw new AuthConfigurationError(
          'Worker Secret AUTH_RESOURCES: "clientIds" phai la mang chuoi',
        );
      }
      const localSeen = new Set<string>();
      const frozen: string[] = [];
      for (const id of rawClientIds) {
        if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
          throw new AuthConfigurationError(
            'Worker Secret AUTH_RESOURCES: moi client id phai la chuoi khong rong',
          );
        }
        if (localSeen.has(id) || seenClientIds.has(id)) {
          throw new AuthConfigurationError(
            'Worker Secret AUTH_RESOURCES: client id trung lap trong registry',
          );
        }
        localSeen.add(id);
        seenClientIds.add(id);
        frozen.push(id);
      }
      clientIds = Object.freeze(frozen);
    }
    resources.push({ audience: aud, clientIds });
  }
  // Đảm bảo primary audience luôn có trong registry (back-compat): nếu
  // AUTH_RESOURCES không khai primary, thêm primary vào đầu.
  if (!resources.some((resource) => resource.audience === primaryAudience)) {
    resources.unshift(Object.freeze(primary));
  }
  return Object.freeze(resources);
}
