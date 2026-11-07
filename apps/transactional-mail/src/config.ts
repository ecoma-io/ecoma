/**
 * Cấu hình của control plane `transactional-mail`, nạp từ Worker Secrets + vars.
 *
 * ## Vì sao loader nằm ở module khởi động chứ không ở chỗ dùng
 *
 * ⚠️ **Thiếu cấu hình là LỖI, không phải lý do đoán.** `docs/applications/transactional-mail/
 * 03-operations.md` §3 chốt mọi giá trị vận hành là Worker Secret/var bắt buộc và
 * **không** có giá trị mặc địn nào. Mỗi `require*` ở đây ném
 * {@link TransactionalMailConfigError} lúc boot, để lỗi cấu hình lộ ra lúc deploy
 * chứ không phải lúc có request đầu tiên của khách.
 *
 * ⚠️ Riêng credential registry còn có một lý do fail-closed mạnh hơn nữa
 * (`01-architecture.md` §7.4): envelope internal **không mang principal**, nên hai
 * entry trùng giá trị secret là **không phân biệt được ở runtime**. Cửa nạp registry
 * là lớp phòng vệ **duy nhất** có thể có — không có, và không được thiết kế, một
 * nhánh runtime để "phát hiện" nó sau đó.
 *
 * ⚠️ **Không có giá trị mặc địn cho bất kỳ bí mật nào.** Default cho một secret là
 * bằng với việc dùng một khoá mà người đọc repo đoán được.
 *
 * ⚠️ **Message lỗi chỉ nói TÊN biến, không nói giá trị** (kể cả khi biết chính xác
 * giá trị sai là gì). Một operator có thể dán nhầm `MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH`
 * vào `MAIL_INTERNAL_AUTH_SKEW_SECONDS`; nếu nhắc giá trị vào message thì nó lọt thẳng ra
 * error log của Worker. Đây là F-07, không phải chi tiết hiển thị.
 *
 * Tài liệu tham chiếu:
 * - `docs/applications/transactional-mail/01-architecture.md` §7.4 (credential registry)
 * - `docs/applications/transactional-mail/03-operations.md` §1, §3
 * - `docs/applications/transactional-mail/02-requirements.md` FR-002 (keyring fingerprint)
 */

import {
  DEFAULT_SKEW_SECONDS,
  MAX_SKEW_SECONDS,
  MIN_SKEW_SECONDS,
} from '@ecoma-io/internal-auth-contracts';

import {
  PERMISSION_DELIVERY_OUTCOME,
  PERMISSION_DELIVERY_READ,
  PERMISSION_MESSAGE_CREATE,
} from './principal';

/**
 * Shape của `env` mà Worker nhận từ binding + secrets.
 *
 * ⚠️ Kiểu `Record<string, unknown>` **cố ý**, không phải một interface liệt kê từng
 * biến: đây là Worker `env` thật, và một interface đóng sẽ khiến mọi Worker Secret mới
 * thêm vào là một breaking change của type. Fail-closed không nằm ở chỗ liệt kê type mà
 * ở chỗ loader **đọc và kiểm từng biến một cách tường minh**.
 */
export type TransactionalMailEnv = Readonly<Record<string, unknown>>;

/** Phụ thuộc tùy chọn của {@link loadTransactionalMailConfig}. */
export interface TransactionalMailConfigLoaderDeps {
  /**
   * `false` ⇒ **không** đọc và **không** ghi cache ở module. Chỉ dùng trong test, để mỗi
   * `it` nạp lại từ `env` của riêng nó thay vì nhận config của test trước.
   *
   * Bỏ trống ⇒ cache theo isolate, đúng precedent `apps/auth/src/config.ts`.
   */
  readonly cache?: boolean;
}

/** Lớp lỗi riêng của cấu hình — để composition root bắt được khác lỗi hạ tầng. */
export class TransactionalMailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionalMailConfigError';
  }
}

/** Worker Secret chứa keyring HMAC của `request_fingerprint`. */
export const FINGERPRINT_KEYRING_ENV = 'MAIL_FINGERPRINT_KEYRING';

/** Worker Secret chứa cửa sổ skew của envelope internal (giây). */
export const INTERNAL_AUTH_SKEW_ENV = 'MAIL_INTERNAL_AUTH_SKEW_SECONDS';

/** Var chứa danh sách host được phép trong URL của template, phân tác bằng dấu phẩy. */
export const TEMPLATE_URL_ALLOWED_HOSTS_ENV = 'MAIL_TEMPLATE_URL_ALLOWED_HOSTS';

/**
 * Một profile khoá HMAC của `request_fingerprint`.
 *
 * `currentProfile` là tag được ghi vào giá trị persist để một row cũ luôn verify được kể
 * cả sau khi profile hoặc keyring đổi (FR-002). `keys` giữ **mọi** profile đang hiệu lực
 * — đọc row cũ cần key cũ, nên keyring không phải "một key hiện tại" mà là một keyring.
 */
export interface MailFingerprintKeyring {
  /** Tag của profile dùng để **ký** fingerprint mới, ví dụ `p1.k1`. */
  readonly currentProfile: string;
  /** Profile tag → khoá HMAC 32 byte giải mã từ hex. */
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

/** Vị trí của một credential trong registry: đang dùng, hay đang trong cửa sổ overlap. */
export type MailCredentialKind = 'current' | 'previous';

/** Một entry của credential registry — `principal → secret` đã kiểm. */
export interface MailInternalCredential {
  /** Principal server-controlled, suy ra từ credential khớp — không bao giờ từ header. */
  readonly principal: string;
  /** HMAC secret **nguyên văn**, không trim (xem {@link requireCredentialSecret}). */
  readonly secret: string;
  /** `current` luôn đứng trước `previous` của cùng principal. */
  readonly kind: MailCredentialKind;
}

/** Hạn mức rate limit theo principal, theo key probe `409`, và hạn mức toàn hệ thống. */
export interface MailRateLimitConfig {
  readonly principal: { readonly limit: number; readonly windowMs: number };
  readonly system: { readonly limit: number; readonly windowMs: number };
  /**
   * Ngưỡng chặn probe `409` lặp trên cùng `(principal_id, idempotency_key)` (FR-002) —
   * giới hạn theo **key**, không chỉ theo principal.
   */
  readonly idempotencyKey: { readonly limit: number; readonly windowMs: number };
}

/**
 * Allowlist logical template của một principal (SR-001 authorization table): principal
 * chỉ được `POST /v1/messages` với template nằm trong danh sách này.
 *
 * ⚠️ **Rỗng là trạng thái hợp lệ và chặt nhất** — một principal không có template nào được
 * approve thì không gửi được mail nào. Không có giá trị "cho phép tất cả": một allowlist
 * mở là bỏ authorization.
 */
export type MailTemplateAllowlist = readonly string[];

/** Ngân sách của publish loop: lease, batch, số lần thử, backoff. */
export interface MailPublishConfig {
  readonly leaseMs: number;
  readonly batchLimit: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

/** Ngưỡng tuổi, biên batch, và ngân sách A của reconciler/redispatch. */
export interface MailReconcilerConfig {
  readonly maxAgeMs: number;
  readonly batchLimit: number;
  /**
   * Ngân sách **A** (`mail_messages.recovery_cycle_count < maxRecoveryCycles`) — predicate
   * của statement re-dispatch mà adapter của composition root viết (`01-architecture.md`
   * §6.5). Port của reconciler cố ý không nhận nó; chỉ config ở đây mới là nguồn.
   */
  readonly maxRecoveryCycles: number;
}

/** Ngưỡng byte UTF-8 của subject + body đã render — vượt → `413` trước khi ghi. */
export interface MailRenderConfig {
  readonly maxRenderBytes: number;
}

/** Biên batch của prune nonce. */
export interface MailNoncePruneConfig {
  readonly batchLimit: number;
}

/** Tuổi lưu giữ nội dung và ngưỡng cảnh báo delivery kẹt. */
export interface MailRetentionConfig {
  readonly contentMs: number;
  readonly staleAlertMs: number;
}

/**
 * Cấu hình đã kiểm, dùng bởi composition root.
 *
 * ⚠️ `credentialRegistry` là **registry của receiver**, không phải danh sách key để thử tuỳ ý.
 * (Tên field tránh hậu tố trần `credentials` — xem chú thích ở `buildTransactionalMailConfig`.)
 * Thứ tự của nó là một phần của hợp đồng: receiver duyệt theo thứ tự này, `bad_signature`
 * mới là lý do duy nhất đi tiếp candidate kế tiếp, và receiver dừng ở lần khớp đầu —
 * nên mỗi request tạo **đúng một** claim nonce (`01-architecture.md` §7.4 bước 4).
 */
export interface TransactionalMailConfig {
  readonly fingerprintKeyring: MailFingerprintKeyring;
  /** Registry credential — thứ tự cố định: `current` trước `previous` của mỗi principal. */
  readonly credentialRegistry: readonly MailInternalCredential[];
  /**
   * Permission cấp cho từng principal. Tách khỏi `credentialRegistry` vì quyền là thuộc tính của
   * **principal**, không của entry credential: `current` và `previous` của cùng principal
   * luôn có cùng tập quyền, và nhân bản nó vào từng entry là một nguồn lệch im lặng.
   */
  readonly permissionsByPrincipal: ReadonlyMap<string, readonly string[]>;
  /**
   * Logical template mà từng principal được phép dùng (`POST /v1/messages` — SR-001
   * authorization table: "Chỉ những logical template đã approve cho principal đó").
   *
   * Tách khỏi permission `message.create` vì hai trục quyền khác nhau: permission là
   * **operation** (được tạo message hay không), allowlist là **tài nguyên** (template nào).
   * Một principal có thể có `message.create` mà allowlist rỗng — nó authenticate được,
   * `403` ngay khi gọi, và không gửi được mail nào tới khi có template được approve.
   * Cùng principal ⇒ cùng allowlist cho mọi entry credential (`current` lẫn `previous`),
   * cùng lý do với {@link permissionsByPrincipal}.
   */
  readonly templatesByPrincipal: ReadonlyMap<string, MailTemplateAllowlist>;
  /** Cửa sổ skew (giây) — đã nằm trong `[MIN_SKEW_SECONDS, MAX_SKEW_SECONDS]`. */
  readonly skewSeconds: number;
  readonly rateLimits: MailRateLimitConfig;
  readonly render: MailRenderConfig;
  readonly publish: MailPublishConfig;
  readonly reconciler: MailReconcilerConfig;
  readonly noncePrune: MailNoncePruneConfig;
  readonly retention: MailRetentionConfig;
  /**
   * Host được phép trong URL của template, đã lowercase. Rỗng ⇒ không host nào được phép;
   * renderer tự fail-closed (503) khi gặp URL ngoài allowlist. Không có "mặc định là cho
   * phép tất cả": một allowlist rỗng là cấu hình chặt nhất.
   */
  readonly templateUrlAllowedHosts: readonly string[];
}

/**
 * Một slot của credential registry: principal, hậu tố tên Worker Secret, tập quyền, và
 * allowlist template.
 *
 * ⚠️ **Thứ tự mảng này là thứ tự duyệt của receiver**, không phải thứ tự trình bày. Nó
 * được giữ ở đúng một chỗ (module scope, không truy cập được từ ngoài) để loader và tài
 * liệu không trôi khỏi nhau: một registry duyệt theo thứ tự khác vẫn xác thực đúng, nhưng
 * nhánh "dừng ở lần khớp đầu" sẽ gắn claim nonce với một principal khác.
 *
 * ⚠️ Tập quyền ở đây là **allowlist**, không phải nguồn duy nhất: route vẫn enforce quyền
 * của chính nó (`01-architecture.md` §7.4 — authentication không thay thế authorization).
 *
 * ⚠️ `allowedTemplates` là **evidence-based** (SR-001): chỉ principal có bằng chứng dùng
 * thật mới được grant. V1: `svc.account` dùng `account.login-otp` (`OTP_LOGIN_TEMPLATE`
 * của `apps/account/server/lib/mail.ts`; template được seed ở migration `0009` của service
 * này). `svc.auth`/`svc.payment` chưa có đường gọi nào trong repo ⇒ explicit empty — nhận
 * credential nhưng `403` mọi template cho tới khi có template được approve cho chúng.
 * Mọi principal mới thêm vào registry đều phải khai `allowedTemplates` tường minh: thiếu
 * là lỗi compile (thuộc tính bắt buộc), không phải default "được tất cả".
 */
const CREDENTIAL_SLOTS: readonly MailCredentialSlot[] = [
  {
    principal: 'svc.account',
    secretSuffix: 'SVC_ACCOUNT',
    permissions: [PERMISSION_MESSAGE_CREATE],
    allowedTemplates: ['account.login-otp'],
  },
  {
    principal: 'svc.auth',
    secretSuffix: 'SVC_AUTH',
    permissions: [PERMISSION_MESSAGE_CREATE],
    allowedTemplates: [],
  },
  {
    principal: 'svc.payment',
    secretSuffix: 'SVC_PAYMENT',
    permissions: [PERMISSION_MESSAGE_CREATE],
    allowedTemplates: [],
  },
  {
    principal: 'svc.transactional-mailer-job',
    secretSuffix: 'SVC_TRANSACTIONAL_MAILER_JOB',
    permissions: [PERMISSION_DELIVERY_READ, PERMISSION_DELIVERY_OUTCOME],
    allowedTemplates: [],
  },
];

/** Một dòng của bảng {@link CREDENTIAL_SLOTS}. */
interface MailCredentialSlot {
  readonly principal: string;
  readonly secretSuffix: string;
  readonly permissions: readonly string[];
  /** Logical template được approve cho principal — SR-001. Rỗng = không gửi được mail nào. */
  readonly allowedTemplates: MailTemplateAllowlist;
}

/** Tiền tố chung của tên Worker Secret credential registry. */
const CREDENTIAL_SECRET_PREFIX = 'MAIL_INTERNAL_AUTH_SECRET_';

/** Hậu tố của entry `previous` — tức credential của cửa sổ overlap khi xoay khoá. */
const PREVIOUS_SECRET_SUFFIX = '_PREVIOUS';

/**
 * Dạng của một giá trị khoá fingerprint trong keyring: 64 ký tự hex **chữ thường**.
 *
 * ⚠️ Chặn hex HOA chứ không phải vì phong cách: `hashBody`/các chữ ký khác của protocol
 * đều là hex chữ thường, và một keyring chấp nhận hai hình viết của cùng một byte là
 * registry mà không ai đọc là biết phải viết hình nào.
 */
const FINGERPRINT_KEY_HEX = /^[0-9a-f]{64}$/u;

/**
 * Cấu hình đã nạp, cache theo promise ở module scope.
 *
 * ⚠️ **Cache theo PROMISE, không theo giá trị** — cùng lý do và cùng hệ quả với
 * `apps/auth/src/config.ts`: `cached ??= await load()` chỉ gán SAU khi resolve, nên N
 * request đầu đến đồng thời trên isolate vừa ấm sẽ cùng chạy loader. Gán promise vào
 * biến đồng bộ thì lời gọi đầu tiên "đặt cọc" và các lời gọi sau await đúng promise đó.
 *
 * ⚠️ **Cache LỖI không.** Nếu ta nhớ cả lỗi cấu hình, thì việc thêm Worker Secret và
 * restart là cách **duy nhất** để phục hồi, và một lỗi cấu hình tạm thời sẽ thành vĩnh viễn.
 * Đó là lý do `.catch` ở dưới tự xoá ô cache trước khi ném lại.
 */
let cachedConfigPromise: Promise<TransactionalMailConfig> | undefined;

/**
 * Xoá ô cache của {@link loadTransactionalMailConfig} — **chỉ test dùng**.
 *
 * Dùng trong `beforeEach` của `describe('cache')` để mỗi test được cache **lạnh** (cache
 * LỖI không, nên một test gây lỗi trước đó đã tự xoá ô — nhưng một test ấm nó bằng
 * `env` hợp lệ thì không), để kết quả của test không phụ thuộc thứ tự chạy (kể cả khi
 * vitest shuffle). Production không bao giờ gọi: isolate chết thì cache chết cùng.
 */
export function resetTransactionalMailConfigCacheForTests(): void {
  cachedConfigPromise = undefined;
}

/**
 * Nạp và kiểm toàn bộ cấu hình của `transactional-mail`.
 *
 * @param env Worker `env` (binding + secrets + vars).
 * @param deps Xem {@link TransactionalMailConfigLoaderDeps}; mặc định cache theo isolate.
 * @throws {TransactionalMailConfigError} Với **mọi** cấu hình thiếu/sai — không có nhánh
 *   nào trả về config "tạm được" với giá trị mặc địn.
 */
export async function loadTransactionalMailConfig(
  env: TransactionalMailEnv,
  deps: TransactionalMailConfigLoaderDeps = {},
): Promise<TransactionalMailConfig> {
  if (deps.cache === false) {
    return buildTransactionalMailConfig(env);
  }
  cachedConfigPromise ??= Promise.resolve()
    .then(() => buildTransactionalMailConfig(env))
    .catch((error: unknown) => {
      cachedConfigPromise = undefined;
      throw error;
    });
  return await cachedConfigPromise;
}

/**
 * Dựng config từ `env` mà không chạm cache.
 *
 * ⚠️ Đồng bộ thuần: không có thao tác I/O nào ở đây, nên một cấu hình sai lộ ra ngay trong
 * lời gọi đầu thay vì sau một `await` — và lỗi vẫn là rejection của hàm `async` bao ngoài.
 */
function buildTransactionalMailConfig(env: TransactionalMailEnv): TransactionalMailConfig {
  // ⚠️ Field config đặt tên `credentialRegistry` (không phải `credentials` trần): rule
  // semgrep `security-sensitive-value-in-http-response` coi mọi ĐỌC của biến/field trùng
  // danh sách nhạy cảm (`credentials`, `secret`, `token`, `response`, ...) là taint
  // source, và object literal chứa field trùng danh sách là sink — `credentials` trần
  // trong return của builder bị flag dù config không bao giờ đi vào HTTP response.
  // Tên có hậu tố không khớp regex (không kết thúc ngay sau `credential`), hết FP
  // mà không cần suppress directive nào.
  const credentials = loadCredentialRegistry(env);
  return {
    fingerprintKeyring: parseFingerprintKeyring(env[FINGERPRINT_KEYRING_ENV]),
    credentialRegistry: credentials.entries,
    permissionsByPrincipal: credentials.permissionsByPrincipal,
    templatesByPrincipal: credentials.templatesByPrincipal,
    skewSeconds: parseSkewSeconds(env[INTERNAL_AUTH_SKEW_ENV]),
    rateLimits: {
      principal: {
        limit: requirePositiveInteger(env, 'MAIL_RATE_LIMIT_PRINCIPAL_LIMIT'),
        windowMs: requirePositiveInteger(env, 'MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS'),
      },
      system: {
        limit: requirePositiveInteger(env, 'MAIL_RATE_LIMIT_SYSTEM_LIMIT'),
        windowMs: requirePositiveInteger(env, 'MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS'),
      },
      idempotencyKey: {
        limit: requirePositiveInteger(env, 'MAIL_RATE_LIMIT_KEY_LIMIT'),
        windowMs: requirePositiveInteger(env, 'MAIL_RATE_LIMIT_KEY_WINDOW_MS'),
      },
    },
    render: {
      maxRenderBytes: requirePositiveInteger(env, 'MAIL_RENDER_MAX_BYTES'),
    },
    publish: {
      leaseMs: requirePositiveInteger(env, 'MAIL_PUBLISH_LEASE_MS'),
      batchLimit: requirePositiveInteger(env, 'MAIL_PUBLISH_BATCH_LIMIT'),
      maxAttempts: requirePositiveInteger(env, 'MAIL_PUBLISH_MAX_ATTEMPTS'),
      backoffBaseMs: requirePositiveInteger(env, 'MAIL_PUBLISH_BACKOFF_BASE_MS'),
    },
    reconciler: {
      maxAgeMs: requirePositiveInteger(env, 'MAIL_RECONCILER_MAX_AGE_MS'),
      batchLimit: requirePositiveInteger(env, 'MAIL_RECONCILER_BATCH_LIMIT'),
      maxRecoveryCycles: requirePositiveInteger(env, 'MAIL_RECOVERY_MAX_CYCLES'),
    },
    noncePrune: {
      batchLimit: requirePositiveInteger(env, 'MAIL_NONCE_PRUNE_BATCH_LIMIT'),
    },
    retention: {
      contentMs: requirePositiveInteger(env, 'MAIL_RETENTION_CONTENT_MS'),
      staleAlertMs: requirePositiveInteger(env, 'MAIL_RETENTION_STALE_ALERT_MS'),
    },
    templateUrlAllowedHosts: parseAllowedHosts(env[TEMPLATE_URL_ALLOWED_HOSTS_ENV]),
  };
}

/**
 * Đọc một Worker Secret bắt buộc, giữ **nguyên văn** giá trị.
 *
 * ⚠️ **Cố ý KHÔNG trim và cố ý KHÔNG từ chối khoảng trắng đầu/cuối** (khác `requireSecret`
 * của `apps/auth/src/config.ts`, vốn từ chối). Ở đây việc quan trọng là **không sửa bí mật
 * âm thầm**: hai bên ký/verify phải thấy đúng cùng một chuỗi, và một secret có khoảng trắng
 * thở là giá trị hợp lệ mà người vận hành chủ động chọn. Vấn đề của auth — hai bên lệch âm
 * thầm — không xảy ra ở đây vì **không có bước trim nào** để lệch.
 *
 * ⚠️ Bộ ba điều kiện bên dưới là ba lỗi khác nhau và giữ riêng để người vận hành biết
 * phải cấp cái gì: thiếu hẳn, rỗng, hay chỉ có khoảng trắng (thường là biến đặt nhầm tên).
 */
function requireCredentialSecret(value: unknown, variableName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} chua duoc dat; transactional-mail KHONG cap credential`,
    );
  }
  assertCredentialSecretShape(value, variableName);
  return value;
}

/**
 * Hai gate shape dùng chung cho **mọi** credential entry — `current` lẫn `previous`.
 *
 * ⚠️ Đây là lớp chống lại chính lỗi đã tái hiện ở registry: nhánh `previous` từng tự viết
 * lại luồng kiểm thay vì gọi chung validator, và khi đó một gate mới (lone surrogate) chỉ
 * được thêm vào `current` — hai nhánh lại lệch nhau. Mọi gate shape về sau thêm vào **đây**
 * để cả hai nhánh tự mắc phải, không thêm vào một nhánh riêng nào.
 */
function assertCredentialSecretShape(value: string, variableName: string): void {
  if (value.trim() === '') {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} chi co khoang trang; transactional-mail tu choi`,
    );
  }
  if (containsLoneSurrogate(value)) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} chua lone surrogate; transactional-mail tu choi`,
    );
  }
}

/**
 * True khi chuỗi chứa **lone surrogate** — code unit U+D800..U+DFFF không nằm trong một cặp
 * hợp lệ. Hai chuỗi khác nhau về lone surrogate (`"\uD800"` vs `"\uFFFD"`) là hai chuỗi
 * theo `===` của JS, nhưng `TextEncoder` encode **cùng byte** (U+FFFD) — hai credential
 * "khác nhau" theo Map của registry là **cùng key material HMAC**: duplicate check sẽ cho
 * qua, còn HMAC envelope thì lệch ngầm. Fail-closed lúc boot thay vì lệch lúc verify.
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
 * Nạp credential registry: mỗi principal một entry `current` bắt buộc, `previous` tuỳ
 * chọn cho cửa sổ overlap khi xoay khoá.
 *
 * ⚠️ **Bất biến của registry: không có hai entry nào trùng giá trị secret** — kể cả
 * `previous` của một principal với `current` của principal khác. Vì envelope không mang
 * key id, hai entry trùng giá trị **không thể phân biệt được ở runtime**: registry sẽ dừng
 * ở lần khớp đầu và principal nhận được là principal của entry đứng trước, tức request của
 * `svc.auth` có thể chạy dưới danh tính `svc.account`. Đó là vi phạm cô lập chéo consumer
 * (SR-002) **từ cấu hình**, và cửa nạp registry là lớp phòng vệ duy nhất có thể có.
 *
 * ⚠️ Message lỗi liệt kê **tên các biến bị trùng**, không phải giá trị: tên biến đủ để
 * người vận hành tìm đúng chỗ cần sửa, còn giá trị thì không bao giờ được ghi ra log.
 */
function loadCredentialRegistry(env: TransactionalMailEnv): {
  readonly entries: readonly MailInternalCredential[];
  readonly permissionsByPrincipal: ReadonlyMap<string, readonly string[]>;
  readonly templatesByPrincipal: ReadonlyMap<string, MailTemplateAllowlist>;
} {
  const entries: MailInternalCredential[] = [];
  const permissionsByPrincipal = new Map<string, readonly string[]>();
  const templatesByPrincipal = new Map<string, MailTemplateAllowlist>();
  // secret (giá trị, KHÔNG đưa vào message) → tên biến đã dùng nó lần đầu.
  const firstOwnerOfSecret = new Map<string, string>();
  const duplicatedVariableNames = new Set<string>();

  for (const slot of CREDENTIAL_SLOTS) {
    const currentName = `${CREDENTIAL_SECRET_PREFIX}${slot.secretSuffix}`;
    const previousName = `${currentName}${PREVIOUS_SECRET_SUFFIX}`;
    const current = requireCredentialSecret(env[currentName], currentName);
    // `previous` tuỳ chọn: vắng mặt ⇒ chỉ có một entry, và đó là trạng thái bình thường
    // ngoài cửa sổ overlap. Không có default ngầm cho nó — không có previous nghĩa là
    // không có credential nào để xoay sang.
    const previous = env[previousName];

    permissionsByPrincipal.set(slot.principal, slot.permissions);
    templatesByPrincipal.set(slot.principal, slot.allowedTemplates);
    registerSecret(current, currentName);
    entries.push({ principal: slot.principal, secret: current, kind: 'current' });

    if (typeof previous === 'string' && previous.length > 0) {
      // Cùng bộ gate shape với `current` (`assertCredentialSecretShape`): một `previous`
      // chứa lone surrogate không bị chặn ở đây thì duplicate check bên dưới (so `===`)
      // cho qua trong khi `TextEncoder` encode cùng byte — hai credential "khác nhau" theo
      // registry nhưng cùng key material HMAC. Fail-closed lúc boot, message chỉ tên biến.
      assertCredentialSecretShape(previous, previousName);
      registerSecret(previous, previousName);
      // `current` đứng trước `previous` của CÙNG principal — thứ tự cố định của receiver.
      entries.push({ principal: slot.principal, secret: previous, kind: 'previous' });
    }
  }

  if (duplicatedVariableNames.size > 0) {
    throw new TransactionalMailConfigError(
      `Worker Secret sau co gia tri trung nhau: ${[...duplicatedVariableNames].join(', ')}; ` +
        'credential registry phai fail-closed vi envelope khong mang key id',
    );
  }

  return { entries, permissionsByPrincipal, templatesByPrincipal };

  function registerSecret(secret: string, variableName: string): void {
    const owner = firstOwnerOfSecret.get(secret);
    if (owner === undefined) {
      firstOwnerOfSecret.set(secret, variableName);
      return;
    }
    duplicatedVariableNames.add(owner);
    duplicatedVariableNames.add(variableName);
  }
}

/**
 * Parse keyring fingerprint — Worker Secret JSON
 * `{"current":"p1.k1","keys":{"p1.k1":"<64 hex chữ thường>"}}`.
 *
 * ⚠️ **`current` phải là một key CÓ THẬT trong `keys`**, không chỉ là một chuỗi: `current`
 * là tag ghi vào fingerprint mới, và một tag không có khoá tương ứng là mọi message mới đều
 * không sign được — lỗi chỉ lộ ra ở request đầu tiên chứ không ở lúc boot.
 *
 * ⚠️ Key cũ **không được xoá** khi đổi `current`: giá trị `request_fingerprint` đã persist
 * mang tag của profile đã ký, và verify idempotency replay cần đúng khoá đó (FR-002). Vì
 * vậy loader chỉ kiểm `keys` **không rỗng**, không kiểm `current` là phần tử duy nhất.
 *
 * ⚠️ Khoá được trả về dưới dạng **byte thô**, không phải hex: `crypto.subtle` nhận byte, và
 * giữ chuỗi hex trong config chỉ là một bước decode ở đúng nơi dùng, ở mọi lần dùng.
 */
function parseFingerprintKeyring(raw: unknown): MailFingerprintKeyring {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV} chua duoc dat; khong sign duoc request_fingerprint`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // ⚠️ KHÔNG nối message của `JSON.parse` vào đây: nó **chứa toàn bộ chuỗi JSON**, tức
    // khoá hex nếu parse hỏng vì một ký tự đó. Đây là đường rò secret vào error log.
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV} khong phai JSON hop le`,
    );
  }

  if (!isRecord(parsed)) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV} phai la JSON object`,
    );
  }

  const current = parsed['current'];
  if (typeof current !== 'string' || current.length === 0) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV} thieu truong "current"`,
    );
  }

  const rawKeys = parsed['keys'];
  if (!isRecord(rawKeys)) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV} thieu truong "keys"`,
    );
  }

  const profileTags = Object.keys(rawKeys);
  if (profileTags.length === 0) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV} co "keys" rong`,
    );
  }
  if (!Object.hasOwn(rawKeys, current)) {
    // ⚠️ Nêu **tên profile tag** (public: nó nằm trong mọi giá trị fingerprint đã persist),
    // không nêu giá trị khoá. Nêu tag là đủ để người vận hành biết đang trỏ vào chỗ nào.
    throw new TransactionalMailConfigError(
      `Worker Secret ${FINGERPRINT_KEYRING_ENV}: "current" la profile "${current}" ` +
        'khong ton tai trong "keys"',
    );
  }

  const keys = new Map<string, Uint8Array>();
  for (const tag of profileTags) {
    const keyHex = rawKeys[tag];
    if (typeof keyHex !== 'string' || !FINGERPRINT_KEY_HEX.test(keyHex)) {
      throw new TransactionalMailConfigError(
        `Worker Secret ${FINGERPRINT_KEYRING_ENV}: khoa cua profile "${tag}" ` +
          'phai la 64 ky tu hex chu thuong',
      );
    }
    keys.set(tag, hexToBytes(keyHex));
  }

  return { currentProfile: current, keys };
}

/**
 * Parse skew của envelope internal — **chuỗi chu so thap phan**, so nguyen, giay.
 *
 * ⚠️ KHONG fallback ve mac dinh khi gia tri sai. `resolveSkewSeconds` cua lib **co**
 * fallback (ve `DEFAULT_SKEW_SECONDS`) — va chinh do la ly do khong duoc dung o day: mot
 * Worker Secret go sai se chay im lang bang 300 giay thay vi chet luc boot, va nguoi van
 * hanh khong bao gio thay. Hai lop phai tach: lib chuan hoa **gia tri runtime** (mat an toan
 * khi co caller lap trinh), loader nay **tu choi cau hinh sai** (fail-closed luc boot).
 *
 * ⚠️ Biet `[MIN_SKEW_SECONDS, MAX_SKEW_SECONDS]` lay tu contract chu khong hardcode de
 * trong mot hang so, dung hinh thuc doc lap giua cac service — `01-architecture.md` §7.4
 * ghi ro day la hang giao thuc.
 */
function parseSkewSeconds(raw: unknown): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_SKEW_SECONDS;
  }
  if (typeof raw !== 'string') {
    throw new TransactionalMailConfigError(
      `Worker Secret ${INTERNAL_AUTH_SKEW_ENV} phai la chuoi chu so thap phan`,
    );
  }
  if (!/^\d+$/u.test(raw)) {
    // ⚠️ `Number('1e3')`, `Number(' 300 ')`, `Number('300.0')` đều ra một số hợp lệ trong
    // JS — regex mới chặn được mọi dạng mà `Number()` âm thầm chấp nhận.
    throw new TransactionalMailConfigError(
      `Worker Secret ${INTERNAL_AUTH_SKEW_ENV} phai la chuoi chu so thap phan`,
    );
  }
  const parsed = Number(raw);
  if (parsed < MIN_SKEW_SECONDS) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${INTERNAL_AUTH_SKEW_ENV} phai >= ${MIN_SKEW_SECONDS} giay`,
    );
  }
  if (parsed > MAX_SKEW_SECONDS) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${INTERNAL_AUTH_SKEW_ENV} vuot tran ${MAX_SKEW_SECONDS} giay`,
    );
  }
  return parsed;
}

/**
 * Parse danh sách host được phép cho URL của template.
 *
 * ⚠️ **Không có host nào khi biến vắng mặt** — đây là quyết định, không phải thiếu sót.
 * Renderer tự fail-closed (503) khi gặp URL ngoài allowlist; một mặc định "cho phép tất
 * cả" biến một danh sách quên cấp hình thành SSRF.
 *
 * ⚠️ Trim khoảng trắng quanh dấu phẩy ở đây là **được phép**: đây là danh sách hostname,
 * không phải bí mật, và `a.test, b.test` là cách người vận hành tự nhiên viết. Mỗi token
 * rỗng bị bỏ, và mọi token hạ chữ thường để so khớp với `URL.hostname` (h3/URL đã hạ
 * chữ thường theo RFC 3986).
 */
function parseAllowedHosts(raw: unknown): readonly string[] {
  if (raw === undefined || raw === '') {
    return [];
  }
  if (typeof raw !== 'string') {
    throw new TransactionalMailConfigError(
      `Var ${TEMPLATE_URL_ALLOWED_HOSTS_ENV} phai la chuoi hostname phan tach bang dau phay`,
    );
  }
  const hosts: string[] = [];
  for (const token of raw.split(',')) {
    const host = token.trim().toLowerCase();
    if (host.length > 0) {
      hosts.push(host);
    }
  }
  return hosts;
}

/**
 * Đọc một giá trị vận hành bắt buộc: **so nguyen duong**, khong mac dinh.
 *
 * ⚠️ Dùng `/^\d+$/` chứ không phải `Number(value)`: `Number('1e3')` = 1000,
 * `Number(' 60 ')` = 60, `Number('60.5')` = 60.5 — tất cả đều là những cách viết mà
 * `Number()` chấp nhận im lặng và một biến `60_000` gõ thành `1e5` sẽ chạy được. Với
 * vòng lặp publish và backoff, một giá trị lệch đơn vị không báo lỗi mà chỉ tạo ra hành
 * vi sai lặp im lặng.
 *
 * ⚠️ `>= 1`, không phải `>= 0`: một lease 0 ms, một batch limit 0 hay một limit 0 là
 * "chạy được nhưng không bao giờ làm gì" — một cấu hình fail-closed trông giống hệt cấu
 * hình hỏng. Số 0 phải là lỗi cấu hình, không phải tắt hạng mục.
 */
function requirePositiveInteger(env: TransactionalMailEnv, variableName: string): number {
  const raw = env[variableName];
  if (raw === undefined || raw === '') {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} chua duoc dat; operational value khong co gia tri mac dinh`,
    );
  }
  if (typeof raw !== 'string') {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} phai la chuoi chu so thap phan`,
    );
  }
  if (!/^\d+$/u.test(raw)) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} phai la chuoi chu so thap phan`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TransactionalMailConfigError(
      `Worker Secret ${variableName} phai la so nguyen duong (>= 1)`,
    );
  }
  return parsed;
}

/** Object thuần (không phải `null`, không phải mảng) — kết quả của `JSON.parse`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Hex chữ thường, cặp ký tự một, sang byte thô. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
