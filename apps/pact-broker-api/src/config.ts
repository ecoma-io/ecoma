/**
 * Nạp cấu hình của Pact Broker API từ binding + secrets.
 *
 * Nguyên tắc giống `apps/auth/src/config.ts`: **thiếu cấu hình là lỗi, không
 * phải lý do đoán**. Mỗi `require` ném `PactBrokerConfigurationError` làm
 * request fail-closed thay vì chạy bằng default đoán được. Nhắc TÊN biến trong
 * message lỗi, KHÔNG BAO GIỜ nhắc giá trị.
 */

/** Shape của `env` mà Worker nhận từ binding + secrets. */
export interface PactBrokerEnv {
  /** Hyperdrive binding tới `db-pact-broker`. Không phải connection string. */
  HYPERDRIVE?: { connectionString: string };
  /**
   * Cờ bật outbound webhook execution. Mặc định TẮT (SR-006): cho tới khi có
   * SSRF guard, giá trị true chỉ được chấp nhận ở môi trường dev/test —
   * production không được phép true (kiểm bởi `webhooksEnabled`).
   */
  PACT_BROKER_WEBHOOKS_ENABLED?: string;
  /**
   * Origin của dashboard BFF được phép CORS. Để trống ⇒ không CORS nào được
   * bật (API không tin origin nào ngoài cùng origin).
   */
  PACT_BROKER_DASHBOARD_ORIGIN?: string;
  /**
   * Issuer OIDC mà access token user (forward bởi BFF) phải khớp `iss`
   * (ADR-0031 §1.2: verifier đọc từ config của chính mình). Tuỳ chọn: thiếu ⇒
   * đường user 503 fail-closed, đường machine token KHÔNG bị ảnh hưởng.
   */
  PACT_BROKER_AUTH_ISSUER?: string;
  /**
   * Audience mà access token user phải khớp `aud` — audience chung của lane
   * (ADR-0031 §4), không phải audience per-app. Tuỳ chọn cùng issuer.
   */
  PACT_BROKER_AUTH_AUDIENCE?: string;
  /**
   * Origin server-side để fetch JWKS (tuỳ chọn, local-only). Khi có, JWKS được
   * fetch từ origin NỘI Bộ này thay vì từ `PACT_BROKER_AUTH_ISSUER` — cùng
   * cơ chế `internalOrigin` của BFF (`apps/pact-broker-app/server/auth/config.ts`).
   * Issuer vẫn là giá trị dùng để so claim `iss`; chỉ NƠI lấy JWKS đổi.
   *
   * ⚠️ Issuer là URL public (`https://auth.<host>`) — trong container không
   * resolve được (Traefik chỉ publish host port trên loopback của host), nên
   * đường user sẽ luôn 503 nếu không có origin nội bộ.
   */
  PACT_BROKER_AUTH_INTERNAL_ORIGIN?: string;
}

/** Cấu hình đã kiểm, dùng bởi composition root. */
export interface PactBrokerConfig {
  readonly hyperdrive: { connectionString: string };
  /**
   * Outbound webhook execution có được chạy không. `false` = mọi đường execute
   * chỉ ghi `webhook_executions` với `succeeded = false` (hoặc không chạy) mà
   * KHÔNG mở kết nối ra ngoài. Schema webhook vẫn CRUD được — cấu hình được
   * lưu, delivery bị khoá.
   */
  readonly webhooksEnabled: boolean;
  /** Origin dashboard được CORS, hoặc `null` = không CORS. */
  readonly dashboardOrigin: string | null;
  /**
   * Issuer OIDC của đường user (ADR-0031 §1.2), hoặc `null` = chưa cấu hình —
   * mọi access token user gặp `null` là 503 fail-closed, riêng từng path-type;
   * machine token path không đọc trường này.
   */
  readonly authIssuer: string | null;
  /** Audience chung mà token user phải khớp, hoặc `null` = chưa cấu hình. */
  readonly authAudience: string | null;
  /**
   * Origin server-side để fetch JWKS, hoặc `null` = không có (fetch từ issuer).
   * Không bao giờ dùng để so claim `iss` — chỉ là NƠI lấy JWKS.
   */
  readonly authInternalOrigin: string | null;
}

/**
 * Ném khi thiếu/giả cấu hình. Thông báo nêu TÊN biến để người vận hành biết
 * cấp cái gì — nhưng không bao giờ nêu giá trị (giống F-07 của auth).
 */
export class PactBrokerConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PactBrokerConfigurationError';
  }
}

function requireHyperdrive(value: unknown): { connectionString: string } {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new PactBrokerConfigurationError(
      'Hyperdrive binding toi db-pact-broker chua duoc gan; pact-broker-api fail-closed',
    );
  }
  const cs = (value as { connectionString?: unknown }).connectionString;
  if (typeof cs !== 'string' || cs === '') {
    throw new PactBrokerConfigurationError(
      'Hyperdrive binding khong co connectionString; pact-broker-api fail-closed',
    );
  }
  return { connectionString: cs };
}

/**
 * Parse cờ webhook — chỉ nhận 'true'/'false' tường minh; mọi giá trị khác bị
 * từ chối thay vì âm thầm hiểu là false (cùng bộ luật fail-closed với auth).
 */
function parseWebhooksEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') {
    return false; // default TẮT — SR-006
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PactBrokerConfigurationError(
    'PACT_BROKER_WEBHOOKS_ENABLED chi nhan "true" hoac "false"',
  );
}

/** Nạp và kiểm toàn bộ cấu hình. `undefined`/`null` coi như env rỗng. */
export function loadPactBrokerConfig(envInput: PactBrokerEnv | undefined | null): PactBrokerConfig {
  const env: PactBrokerEnv = envInput ?? {};
  const hyperdrive = requireHyperdrive(env.HYPERDRIVE);

  const webhooksEnabled = parseWebhooksEnabled(env.PACT_BROKER_WEBHOOKS_ENABLED);
  if (webhooksEnabled) {
    // SR-006: outbound HTTP do dữ liệu người dùng kiểm soát (URL webhook) là
    // bề mặt SSRF; không có guard thì không bật — kể cả khi secret nói true.
    // Đây là khoá cứng trong code, không phải cấu hình.
    throw new PactBrokerConfigurationError(
      'PACT_BROKER_WEBHOOKS_ENABLED=true bi tu choi: chua co SSRF guard cho outbound webhook (SR-006)',
    );
  }

  const rawOrigin = env.PACT_BROKER_DASHBOARD_ORIGIN;
  let dashboardOrigin: string | null = null;
  if (rawOrigin !== undefined && rawOrigin !== '') {
    // Chỉ nhận origin hợp lệ (scheme + host), chặn prefix-string như
    // https://evil.comhttps://good.example (bất biến host parse bằng URL).
    try {
      const parsed = new URL(rawOrigin);
      if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
        throw new Error('origin khong duoc co path/query/hash');
      }
      dashboardOrigin = parsed.origin;
    } catch {
      throw new PactBrokerConfigurationError(
        'PACT_BROKER_DASHBOARD_ORIGIN khong phai mot origin hop le',
      );
    }
  }

  return {
    hyperdrive,
    webhooksEnabled,
    dashboardOrigin,
    ...parseUserAuthConfig(env),
  };
}

/**
 * Parse cặp issuer/audience của đường user — TUỴ CHỌN và fail-closed một nửa:
 * thiếu (cả hai vắng hoặc rỗng) ⇒ `null/null` (đường user 503, machine path
 * nguyên vẹn); có nhưng sai hình dạng URL ⇒ lỗi cấu hình (deploy sai phải đỏ
 * ngay, không chạy kiểu "bỏ qua auth user"). Chỉ chấp nhận cả hai cùng có:
 * một nửa cấu hình là cấu hình sai.
 */
function parseUserAuthConfig(env: PactBrokerEnv): {
  authIssuer: string | null;
  authAudience: string | null;
  authInternalOrigin: string | null;
} {
  const rawIssuer = env.PACT_BROKER_AUTH_ISSUER;
  const rawAudience = env.PACT_BROKER_AUTH_AUDIENCE;
  if (
    (rawIssuer === undefined || rawIssuer === '') &&
    (rawAudience === undefined || rawAudience === '')
  ) {
    return { authIssuer: null, authAudience: null, authInternalOrigin: null };
  }
  if (
    rawIssuer === undefined ||
    rawIssuer === '' ||
    rawAudience === undefined ||
    rawAudience === ''
  ) {
    throw new PactBrokerConfigurationError(
      'PACT_BROKER_AUTH_ISSUER and PACT_BROKER_AUTH_AUDIENCE must be configured together',
    );
  }
  try {
    const parsedIssuer = new URL(rawIssuer);
    if (parsedIssuer.pathname !== '/' && parsedIssuer.pathname !== '') {
      throw new Error('issuer must not carry a path');
    }
    if (parsedIssuer.search !== '' || parsedIssuer.hash !== '') {
      throw new Error('issuer must not carry query or fragment');
    }
    // Issuer chuẩn hoá về origin + không trailing slash — JWKS URL dựng từ đây.
    const issuer = parsedIssuer.origin;
    const audience = rawAudience.trim();
    if (audience === '') {
      throw new Error('audience must not be blank');
    }
    return {
      authIssuer: issuer,
      authAudience: audience,
      authInternalOrigin: parseInternalOrigin(env.PACT_BROKER_AUTH_INTERNAL_ORIGIN),
    };
  } catch (error) {
    // Chuỗi `cause` giữ chi tiết lỗi gốc (URL nào sai, check nào fail) cho việc
    // triage; message công khai vẫn chung chung và KHÔNG BAO GIỜ nhắc giá trị.
    throw new PactBrokerConfigurationError(
      'PACT_BROKER_AUTH_ISSUER must be a valid URL origin and PACT_BROKER_AUTH_AUDIENCE a non-empty audience',
      { cause: error },
    );
  }
}

/**
 * Origin nội bộ (tuỳ chọn) để fetch JWKS — origin thuần, không path/query/hash.
 * Rỗng ⇒ `null` ⇒ fetch JWKS từ issuer.
 */
function parseInternalOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new Error('internal origin must not carry a path');
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new Error('internal origin must not carry query or fragment');
    }
    return parsed.origin;
  } catch {
    throw new PactBrokerConfigurationError(
      'PACT_BROKER_AUTH_INTERNAL_ORIGIN must be a valid URL origin',
    );
  }
}
