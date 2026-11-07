/**
 * Loader cấu hình của worker `transactional-mailer-job`.
 *
 * ⚠️ **Fail-closed, không default ngầm** (`03-operations.md` §3): mọi giá trị vận hành ở
 * đây là một lease, một ngân sách hay một trần — thiếu mục nào thì bound tương ứng ở
 * `01-architecture.md` §9/§11 **không** có hiệu lực, nên thiếu là lỗi khởi động, không
 * phải giá trị "tạm được". Một default ngầm ở đường execution là một ngân sách tự chọn
 * mà không ai review.
 *
 * ⚠️ Module này chỉ **đọc và kiểm** `env`; nó không giữ secret vào biến module scope nào
 * ngoài giá trị trả về, và không log gì — mọi thông báo lỗi chỉ nêu **tên biến** cấu hình,
 * không bao giờ giá trị của nó (`MAIL_PROVIDER_TOKEN` là bearer credential).
 */

/** Shape của `env` mà Worker nhận từ binding + secrets. */
export type MailerJobEnv = Readonly<Record<string, unknown>>;

/** Lớp lỗi riêng của cấu hình — để composition root bắt được khác lỗi hạ tầng. */
export class MailerJobConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailerJobConfigError';
  }
}

/** Worker Secret chọn provider — `cloudflare` là provider thật mặc định, `resend` adapter phụ, `fake` chỉ test/dev. */
export const PROVIDER_KIND_ENV = 'MAIL_PROVIDER_KIND';

/** Worker Secret trần chờ của **một** request provider (ms). */
export const PROVIDER_TIMEOUT_ENV = 'MAIL_PROVIDER_TIMEOUT_MS';

/** Lease execution của một generation (`mail_jobs.lease_expires_at`, ms). */
export const EXECUTION_LEASE_ENV = 'MAIL_JOB_EXECUTION_LEASE_MS';

/**
 * Cửa sổ an toàn idempotency theo **delivery** (ms, tính từ `provider_call_at`).
 *
 * Resend giữ `Idempotency-Key` khoảng 24 giờ — con số **tài liệu hóa, chưa verify** với
 * API thật (GitHub issue #37): trong cửa sổ, một attempt bị mest claim vẫn được auto-resend
 * qua Queue redelivery với CÙNG key; ngoài cửa sổ, worker chốt `provider-ambiguous-outcome`
 * và dừng — đỏi operator, KHÔNG tự gọi lại provider. Phải <= 24h để không vượt quá cửa sổ
 * mà provider giữ key; loader kiểm advisory (không phải hợp đồng provider đã chứng minh).
 */
export const PROVIDER_CALL_SAFE_WINDOW_ENV = 'MAIL_JOB_PROVIDER_CALL_SAFE_WINDOW_MS';

/** Trần advisory của cửa sổ an toàn — 24 giờ, mốc tài liệu Resend idempotency. */
const PROVIDER_CALL_SAFE_WINDOW_CEILING_MS = 24 * 60 * 60 * 1000;

/** Hex 64 ký tự chữ thường — hình của một khoá HMAC-SHA-256. */
const HEX_KEY_64 = /^[0-9a-f]{64}$/u;

/** Giá trị hợp lệ của {@link PROVIDER_KIND_ENV}. */
const PROVIDER_KIND_VALUES = ['cloudflare', 'resend', 'fake'] as const;

/** Tên binding `send_email` trong wrangler.jsonc — composition root đọc `env` theo tên này. */
export const SEND_EMAIL_BINDING_NAME = 'SEND_EMAIL';

/** Worker var sender cố định của provider Cloudflare (không phải secret — địa chỉ public). */
export const CLOUDFLARE_SENDER_ENV = 'MAIL_CF_SENDER';

/** Sender cố định mà adapter Cloudflare được phép dùng — ghim ở wrangler binding lẫn config. */
export const CLOUDFLARE_SENDER_ADDRESS = 'no-reply@ecoma.io' as const;

/**
 * Cấu hình đã kiểm — mirror `MailerJobConfig` đã chốt shape; loader là nơi sinh nó.
 *
 * `timeoutMs` của provider ở đây là **trần ms của một request**, không phải mốc tuyệt đối:
 * orchestration (`processMailCommand`) mới là nơi ghép `now + providerTimeoutMs` với
 * `leaseExpiresAt` bằng `Math.min` (`mail-provider-port.ts`).
 */
/**
 * Cấu hình provider Resend — mirror cấu trúc của `ResendProviderConfig` ở adapter
 * (`libs/transactional-mailer-job-infrastructure/src/resend-mail-provider.ts`); spec
 * `resend-mail-provider.spec.ts` đối chiếu field của hai phía để lệch tên là đỏ ngay.
 */
export type ResendProviderConfig = {
  readonly endpoint: string;
  readonly token: string;
  readonly from: string;
  readonly timeoutMs: number;
};

/**
 * Cấu hình provider Cloudflare — mirror **phần cấu hình có thể có** của
 * `CloudflareProviderConfig` ở adapter (`libs/transactional-mailer-job-infrastructure/
 * src/cloudflare-mail-provider.ts`); spec `cloudflare-mail-provider.spec.ts` đối chiếu
 * field của hai phía để lệch tên là đỏ ngay.
 *
 * Khác Resend: KHÔNG có endpoint/token (binding `send_email` là kênh in-process của
 * cùng Cloudflare account) và KHÔNG có field `binding` ở đây — binding không phải giá
 * trị cấu hình, nó là dependency của composition root; loader chỉ kiểm hình dạng của
 * nó tồn tại (fail-closed) rồi composition root truyền thẳng vào adapter.
 *
 * `sender` bị ghim bằng đúng giá trị {@link CLOUDFLARE_SENDER_ADDRESS} — khác giá trị
 * là lỗi khởi động, không phải giá trị "tạm được" (fail-closed, §3).
 */
export type CloudflareProviderConfig = {
  readonly sender: string;
  readonly timeoutMs: number;
};

export interface LoadedMailerJobConfig {
  readonly provider:
    | {
        readonly kind: 'cloudflare';
        readonly cloudflare: CloudflareProviderConfig;
      }
    | {
        readonly kind: 'resend';
        readonly resend: ResendProviderConfig;
      }
    | { readonly kind: 'fake' };
  readonly maxExecutionAttempts: number;
  readonly executionLeaseMs: number;
  readonly reportLeaseMs: number;
  readonly maxReportAttempts: number;
  readonly sweepBatchLimit: number;
  readonly providerTimeoutMs: number;
  readonly providerCallSafeWindowMs: number;
  readonly quarantineHmacKeyHex: string;
}

/**
 * Nạp và kiểm toàn bộ cấu hình của worker.
 *
 * Không cache ở module: `queue()` và `scheduled()` là hai đường kích hoạt độc lập, mỗi lần
 * chạy đọc `env` của chính nó. `env` của một isolate không đổi, nhưng không cache cũng có
 * chi phí đáng kể nào — loader là thuần, không I/O.
 *
 * @throws {MailerJobConfigError} Với **mọi** cấu hình thiếu/sai.
 */
export function loadMailerJobConfig(env: MailerJobEnv): LoadedMailerJobConfig {
  const maxExecutionAttempts = requirePositiveInteger(env, 'MAIL_JOB_MAX_EXECUTION_ATTEMPTS');
  const executionLeaseMs = requirePositiveInteger(env, EXECUTION_LEASE_ENV);
  const reportLeaseMs = requirePositiveInteger(env, 'MAIL_JOB_REPORT_LEASE_MS');
  const maxReportAttempts = requirePositiveInteger(env, 'MAIL_JOB_MAX_REPORT_ATTEMPTS');
  const sweepBatchLimit = requirePositiveInteger(env, 'MAIL_JOB_SWEEP_BATCH_LIMIT');
  const providerTimeoutMs = requirePositiveInteger(env, PROVIDER_TIMEOUT_ENV);
  // Cửa sổ an toàn có một trần advisory riêng (24h), ngoài trần >= 1 chung của mọi giá trị
  // vận hành: vượt trần này nghĩa là cấu hình tin cửa sổ dài hơn mốc mà provider tài liệu
  // hóa — auto-resend ngoài cửa sổ key-có-thể-đã-lồng là đường double-send tiềm tàng.
  const providerCallSafeWindowMsRaw = requirePositiveInteger(env, PROVIDER_CALL_SAFE_WINDOW_ENV);
  if (providerCallSafeWindowMsRaw > PROVIDER_CALL_SAFE_WINDOW_CEILING_MS) {
    throw new MailerJobConfigError(
      `${PROVIDER_CALL_SAFE_WINDOW_ENV} phai <= ${PROVIDER_CALL_SAFE_WINDOW_CEILING_MS} (24h - mốc giữ Idempotency-Key mà provider tài liệu hóa)`,
    );
  }
  const quarantineHmacKeyHex = requireHexKey(env, 'MAIL_QUARANTINE_HMAC_KEY');

  // Advisory: cửa sổ an toàn nhỏ hơn trần chờ của một request provider là cấu hình vô nghĩa —
  // mọi mơ hồ được phát hiện ở `resolveAmbiguityAfterLostClaim` đều xảy ra tối thiểu sau
  // `providerTimeoutMs` kể từ marker, nên đường auto-resend sau persist-denied sẽ chết âm
  // thầm và toàn bộ mơ hồ chốt `provider-ambiguous-outcome` đỏi operator. Riêng mơ hồ trên
  // đường statement (e) nhánh `already-marked` (Queue redelivery sớm sau attempt mất) được
  // đánh giá theo tuổi marker: với redelivery nhanh, marker còn trẻ và auto-resend vẫn
  // sống kể cả khi cấu hình lệch này tồn tại. Mâu thuẫn kiểu này phải dừng ở loader
  // (cùng tinh thần với kiểm tra `maxExecutionAttempts >= 4` ở khối return dưới),
  // không để operator tự phát hiện qua alert blocked backlog.
  if (providerCallSafeWindowMsRaw <= providerTimeoutMs) {
    throw new MailerJobConfigError(
      `${PROVIDER_CALL_SAFE_WINDOW_ENV} phai > ${PROVIDER_TIMEOUT_ENV}: window nho hon mot provider request thi moi mo ho deu ngoai window`,
    );
  }

  // Kiểm chéo của lease execution: ghim bất đẳng thức gia hạn §9.2.1 — "leaseMs phải lớn
  // hơn runtime resolution + provider timeout + ghi D1 + margin" — thành điều kiện loader,
  // vì `mail-provider-port` dựng deadline của một request provider bằng
  // `min(now + providerTimeoutMs, lease_expires_at)` (chống overlap với generation kế sau
  // khi lease được renew). Với `executionLeaseMs <= providerTimeoutMs`, deadline sập về
  // lease expiry: không còn chỗ cho một lần gọi provider trọn vẹn nào trong lease, mọi
  // request bị cắt ngắn ở lease expiry — theo contract adapter, request gặp
  // `deadlineMs <= now` trả ngay `rejected`/`retryable` ⇒ RETRY, không bao giờ tới làn
  // ambiguity. Bắt ở loader — cùng tinh thần với `MAIL_JOB_MAX_EXECUTION_ATTEMPTS >= 4`,
  // không để operator tự phát hiện qua alert blocked backlog.
  if (executionLeaseMs <= providerTimeoutMs) {
    throw new MailerJobConfigError(
      `${EXECUTION_LEASE_ENV} phai > ${PROVIDER_TIMEOUT_ENV} (mot request provider tron ven phai vua trong lease - bat dang thuc gia han §9.2.1)`,
    );
  }

  const provider = loadProvider(env, providerTimeoutMs);

  return {
    provider,
    // Ngân sách B của một generation phải >= `max_retries + 1` (= 4): Queue cho 3 retry,
    // nên một ngân sách nhỏ hơn 4 là worker từ chối nhiều hơn platform cho phép — cấu hình
    // mâu thuẫn với `max_retries` của wrangler.jsonc.
    maxExecutionAttempts:
      maxExecutionAttempts >= 4
        ? maxExecutionAttempts
        : raiseConfig(
            'MAIL_JOB_MAX_EXECUTION_ATTEMPTS phai >= 4 (max_retries + 1 cua Queue consumer)',
          ),
    executionLeaseMs,
    reportLeaseMs,
    maxReportAttempts,
    sweepBatchLimit,
    providerTimeoutMs,
    providerCallSafeWindowMs: providerCallSafeWindowMsRaw,
    quarantineHmacKeyHex,
  };
}

/** Đọc nhóm biến provider theo `MAIL_PROVIDER_KIND`. */
function loadProvider(
  env: MailerJobEnv,
  providerTimeoutMs: number,
): LoadedMailerJobConfig['provider'] {
  const kind = env[PROVIDER_KIND_ENV];
  if (typeof kind !== 'string' || !(PROVIDER_KIND_VALUES as readonly string[]).includes(kind)) {
    throw new MailerJobConfigError(
      `${PROVIDER_KIND_ENV} phai la mot trong: ${PROVIDER_KIND_VALUES.join(', ')}`,
    );
  }
  if (kind === 'cloudflare') {
    // Sender cố định: giá trị bắt buộc khớp đúng hằng — không phải phép "cấu hình linh
    // hoạt" vì binding wrangler đã khai `allowed_sender_addresses` với đúng địa chỉ này;
    // hai lớp chặn phải nói cùng một sự thật, lệch nhau là lỗi cấu hình phải đỏ ngay.
    const sender = requireNonEmptyString(env, CLOUDFLARE_SENDER_ENV);
    if (sender !== CLOUDFLARE_SENDER_ADDRESS) {
      throw new MailerJobConfigError(
        `${CLOUDFLARE_SENDER_ENV} phai bang "${CLOUDFLARE_SENDER_ADDRESS}" (khop allowed_sender_addresses cua binding SEND_EMAIL)`,
      );
    }
    // Binding thiếu ở env là fail-closed ở loader — KHÔNG fallback sang provider khác
    // (một auto-fallback là đường gửi mail qua kênh không ai review).
    const binding = env[SEND_EMAIL_BINDING_NAME];
    if (
      typeof binding !== 'object' ||
      binding === null ||
      typeof (binding as { send?: unknown }).send !== 'function'
    ) {
      throw new MailerJobConfigError(
        `${SEND_EMAIL_BINDING_NAME} binding khong ton tai hoac khong co send(); provider cloudflare khong fallback`,
      );
    }
    // Credential Resend tồn tại cạnh provider cloudflare là dấu hiệu môi trường nhầm
    // lẫn — cùng quy tắc với nhánh fake (credential production ở nơi không dùng là leak).
    for (const [variableName, value] of [
      ['MAIL_PROVIDER_ENDPOINT', env['MAIL_PROVIDER_ENDPOINT']] as const,
      ['MAIL_PROVIDER_TOKEN', env['MAIL_PROVIDER_TOKEN']] as const,
    ]) {
      if (typeof value === 'string' && value.length > 0) {
        throw new MailerJobConfigError(
          `${variableName} phai KHONG dat khi ${PROVIDER_KIND_ENV}=cloudflare`,
        );
      }
    }
    return {
      kind: 'cloudflare',
      cloudflare: { sender, timeoutMs: providerTimeoutMs },
    };
  }
  if (kind === 'fake') {
    // Fake provider KHÔNG cần endpoint/token/from, và KHÔNG được có nó — một env mang
    // credential thật nhưng kind=fake là dấu hiệu môi trường nhầm lẫn: credential production
    // tồn tại ở nơi không bao giờ dùng tới nó (03-operations.md §1.1, PW4/PW5).
    for (const [variableName, value] of [
      ['MAIL_PROVIDER_ENDPOINT', env['MAIL_PROVIDER_ENDPOINT']] as const,
      ['MAIL_PROVIDER_TOKEN', env['MAIL_PROVIDER_TOKEN']] as const,
    ]) {
      if (typeof value === 'string' && value.length > 0) {
        throw new MailerJobConfigError(
          `${variableName} phai KHONG dat khi ${PROVIDER_KIND_ENV}=fake; credential ton tai o moi truong khong dung no la leak`,
        );
      }
    }
    return { kind: 'fake' };
  }
  const endpoint = requireNonEmptyString(env, 'MAIL_PROVIDER_ENDPOINT');
  const token = requireNonEmptyString(env, 'MAIL_PROVIDER_TOKEN');
  const from = requireNonEmptyString(env, 'MAIL_PROVIDER_FROM');
  return {
    kind: 'resend',
    resend: { endpoint, token, from, timeoutMs: providerTimeoutMs },
  };
}

/** Đọc một biến bắt buộc, phải là chuỗi khác rỗng — không trim, giữ nguyên văn. */
function requireNonEmptyString(env: MailerJobEnv, variableName: string): string {
  const raw = env[variableName];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MailerJobConfigError(
      `${variableName} chua duoc dat; worker khong chay khong co gia tri nay`,
    );
  }
  if (raw.trim() === '') {
    throw new MailerJobConfigError(`${variableName} chi chua khoang trang`);
  }
  return raw;
}

/** Đọc một giá trị vận hành bắt buộc: số nguyên dương, không mặc định. */
function requirePositiveInteger(env: MailerJobEnv, variableName: string): number {
  const raw = env[variableName];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MailerJobConfigError(
      `${variableName} chua duoc dat; operational value khong co gia tri mac dinh`,
    );
  }
  if (!/^\d+$/u.test(raw)) {
    throw new MailerJobConfigError(`${variableName} phai la chuoi chu so thap phan`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MailerJobConfigError(`${variableName} phai la so nguyen duong (>= 1)`);
  }
  return parsed;
}

/** Đọc khoá HMAC quarantine: 64 hex chữ thường — hình mà `computeQuarantineId` nhận. */
function requireHexKey(env: MailerJobEnv, variableName: string): string {
  const raw = requireNonEmptyString(env, variableName);
  if (!HEX_KEY_64.test(raw)) {
    throw new MailerJobConfigError(
      `${variableName} phai la 64 hex chu thuong (khoa HMAC-SHA-256 32 byte)`,
    );
  }
  return raw;
}

/** Helper ném có kiểu — dùng ở chỗ cần biểu thức giá trị. */
function raiseConfig(message: string): never {
  throw new MailerJobConfigError(message);
}
