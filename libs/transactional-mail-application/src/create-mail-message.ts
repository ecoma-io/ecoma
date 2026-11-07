/**
 * Use case tạo message — hàm thuần **orchestration**, không HTTP.
 *
 * ⚠️ Thứ tự kiểm ở đây là **hệ quả của tài liệu**, không phải lựa chọn triển khai: schema nằm
 * trong từng template version, nên không thể kiểm schema trước khi chọn version; và replay (bước
 * lookup) MUST trả `200`/`409` **trước** khi chạm schema — một request **đã tạo thành công** không
 * bao giờ bị `400` vì schema của version hiện tại, kể cả khi template đã lên version mới hay đã
 * bị xoá. Đảo hai bước này làm replay của một row hợp lệ thành `400`/`404`.
 *
 * Đường **replay dưới rate limit**: `findByIdempotencyKey` chạy **trước** `tryConsume`, nên một
 * caller retry không bị phạt vì việc đã làm xong. `principal` bị từ chối trước `system` để một
 * principal bị giới hạn không tiêu slot hệ thống — và khi cả hai đều từ chối, lý do trả về là của
 * `principal` (giới hạn hẹp hơn, thông tin hữu ích hơn). Counter **thứ ba** theo
 * `(principal_id, idempotency_key)` (FR-002) chỉ tiêu ở nhánh **lệch fingerprint** — xem
 * {@link compareFingerprint}.
 *
 * ⚠️ Module này **không log gì** ngoài {@link MailIdempotencyProbeAlert} qua `deps.logAlert`,
 * và **không** đưa `recipient`/`variables`/tên template vào kết quả lỗi: những thứ đó nhạy
 * cảm (FR-007), và một error message free-form là đường rò của nó.
 */

import type { MailMessageRepository } from './mail-message-repository';
import type { MailRateLimitStore } from './mail-rate-limit-store';
import { parseTemplateSchema, validateVariablesAgainstSchema } from './mail-template-schema';
import { renderMail } from './mail-render';
import {
  normalizeLocale,
  normalizeRecipient,
  validateRequestShapeVariables,
} from './normalize-request';
import {
  computeRequestFingerprint,
  fingerprintProfileKeyTag,
  parseStoredFingerprintTag,
  verifyStoredRequestFingerprint,
} from './request-fingerprint';
import type {
  MailMessageRecord,
  MailRateLimitConsumeResult,
  MailRateLimitScope,
  MailTemplateRecord,
} from './records';
import type { MailTemplateRepository } from './mail-template-repository';

/**
 * Khai báo global tối thiểu cho `TextEncoder` — có ở **cả** Cloudflare Workers lẫn Node.
 *
 * Ngưỡng `413` đo trên **byte UTF-8**, không trên UTF-16 code unit: một payload tiếng Việt có
 * `length` (UTF-16) nhỏ hơn nhiều byte UTF-8, nên đo bằng `String#length` là vượt ngưỡng trễ hơn
 * thực tế. `TextEncoder` là cách đo byte UTF-8 đúng mà không kéo `Buffer` của Node vào.
 *
 * Khai ở **phạm vi module** (file này là module) nên nó che global chứ không đụng file khác.
 */
declare const crypto: {
  readonly subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
};

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** Port phụ thuộc của use case. */
export interface CreateMailMessageDeps {
  readonly templates: MailTemplateRepository;
  readonly messages: MailMessageRepository;
  readonly rateLimits: MailRateLimitStore;
  /**
   * Nơi phát alert — inject để test quan sát được, composition root wire `console`.
   *
   * ⚠️ Chỉ truyền **token đã sanitize**. Xem {@link MailIdempotencyProbeAlert}.
   */
  readonly logAlert: (event: MailIdempotencyProbeAlert) => void;
}

/** Ngưỡng rate limit của một scope; giá trị vận hành chốt ở deploy, không phải schema. */
export interface MailRateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Alert probe `409` lặp trên cùng một key (FR-002, mục rủi ro còn lại).
 *
 * ⚠️ Không field nào mang recipient/variables/idempotency key gốc: `idempotencyKeyHash`
 * là **hex digest HMAC** (một chiều), còn `principalId` là định danh do server kiểm soát —
 * cùng whitelist §6 của `03-operations.md`.
 */
export type MailIdempotencyProbeAlert = {
  readonly event: 'idempotency-fingerprint-mismatch';
  readonly principalId: string;
  readonly idempotencyKeyHash: string;
  readonly mismatchCount: number;
};

/**
 * Hash hex (SHA-256) của idempotency key — key gốc **không bao giờ** đi vào D1 làm phần của
 * scope counter: bảng này là state dùng chung bền vững và mọi caller đã authenticate đều
 * đọc được `mail_rate_limits.principal_id` qua D1 nếu credential D1 rò rỉ, nên phần theo
 * key phải một chiều. Hash thôi là đủ: counter chỉ cần phân biệt được "cùng key" với nhau,
 * không cần reconstruct key.
 *
 * Cùng một hash function cho cả hai nơi conflict của use case, nên hai scope của cùng key
 * luôn là một dòng counter.
 */
async function idempotencyKeyScopeHash(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(idempotencyKey));
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Tham số của một lần tạo message — mọi giá trị do caller (HTTP layer) quyết định. */
export interface CreateMailMessageConfig {
  readonly rateLimitPrincipal: MailRateLimitPolicy;
  readonly rateLimitSystem: MailRateLimitPolicy;
  /**
   * Ngưỡng chặn probe `409` lặp theo key (FR-002): các lần thử bị `409` trên cùng
   * `(principal_id, idempotency_key)` tiêu counter riêng theo key và bị `429` khi vượt.
   * Ngữ nghĩa `200` (khớp) / `409` (lệch) **không** đổi — replay khớp không bao giờ chạm
   * counter này.
   */
  readonly rateLimitIdempotencyKey: MailRateLimitPolicy;
  /** Allowlist host cho biến `format: 'url'` — cấu hình theo environment, không hard-code. */
  readonly urlAllowlist: readonly string[];
  /**
   * Keyring fingerprint (FR-002): tag của profile **ký** row mới (`p1.k1`) và khoá hex của
   * **mọi** profile còn verify được — gồm khoá cũ trong cửa sổ rotation. Khoá cũ bị xoá sớm
   * hơn retention của `mail_messages` là một row không còn verify được: replay của row đó
   * trả `service-unavailable` (`503`), không `409`.
   */
  readonly fingerprintKeyring: {
    /** Tag của profile dùng cho row mới — phải là một key có mặt trong {@link keysByProfileHex}. */
    readonly currentProfile: string;
    /** Profile tag (dạng `p1.k1`) → khoá HMAC hex. */
    readonly keysByProfileHex: ReadonlyMap<string, string>;
  };
  /** Hằng default locale của service — truyền tường minh, v1 là `'en'`. */
  readonly defaultLocale: string;
  /** Ngưỡng `413` của payload render, tính bằng byte UTF-8. */
  readonly maxRenderBytes: number;
  readonly nowMs: number;
  /** Id do **caller** sinh — tiền tố `msg_`/`obx_`/`dlv_` thuộc trách nhiệm tầng trên. */
  readonly messageId: string;
  readonly outboxId: string;
  /** `deliveryId = idempotencyKey` lúc tạo; hai lần gọi lại tạo thì thay đổi. */
  readonly deliveryId: string;
  /** Principal do server kiểm soát — không bao giờ lấy từ body hay header chưa verify. */
  readonly principal: { readonly id: string; readonly app: string };
  /** Đã được kiểm `≤ 128` ký tự ở tầng trên. */
  readonly idempotencyKey: string;
  readonly request: {
    readonly template: string;
    readonly recipient: string;
    readonly locale?: string;
    readonly variables?: Record<string, unknown>;
    readonly correlationId?: string | null;
  };
}

/**
 * Kết quả của use case, đã phân loại theo mã lỗi public của FR-001.
 *
 * `invalid.field` là **enum** chứ không phải tên field tự do: `recipient`/`locale`/`variables` là
 * ba nhánh tầng service, `idempotency_key` là nhánh mà tầng trên sẽ kiểm. Không nhánh nào mang giá
 * trị bị từ chối.
 */
export type CreateMailMessageResult =
  | { readonly kind: 'created'; readonly message: MailMessageRecord }
  | { readonly kind: 'replay'; readonly message: MailMessageRecord }
  | { readonly kind: 'conflict'; readonly message: MailMessageRecord }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number }
  | { readonly kind: 'template-not-found' }
  | {
      readonly kind: 'invalid';
      readonly field: 'recipient' | 'locale' | 'variables' | 'idempotency_key';
    }
  | { readonly kind: 'broken-schema' }
  | { readonly kind: 'unrenderable' }
  | { readonly kind: 'allowlist-unconfigured' }
  | { readonly kind: 'payload-too-large' }
  /**
   * Fail-closed `503` (FR-002): một row idempotency đã lưu mà **không verify được** — tag
   * không parse được, tag không còn trong keyring, hay khoá hex hỏng. KHÔNG phải `409`: một
   * giá trị lưu hỏng là chuyện của keyring/operator, không phải payload sai của caller.
   */
  | { readonly kind: 'service-unavailable' };

/**
 * Tạo một message.
 *
 * Bảy bước theo đúng thứ tự FR-001:
 *
 * 1. Chuẩn hoá `recipient` + `locale` + kiểm shape `variables` — trước rate limit và idempotency.
 * 2. **Lookup trước**: `findByIdempotencyKey` rồi so fingerprint → `replay` / `conflict`, **không**
 *    rate limit, **không** render, **không** tra template.
 * 3. Rate limit `principal` rồi `system`.
 * 4. Chọn template version: `(name, locale)`, fallback về `defaultLocale` **một lần**, chọn
 *    version cao nhất trong ứng viên.
 * 5. Parse schema → kiểm `variables` theo schema → render → đo payload.
 * 6. `createWithOutbox`; `already-exists` (bên thắng là request đồng thời) → đọc lại rồi so
 *    fingerprint với **row vừa đọc**, không đệ quy.
 */
export async function createMailMessage(
  deps: CreateMailMessageDeps,
  config: CreateMailMessageConfig,
): Promise<CreateMailMessageResult> {
  const request = config.request;
  const variables = request.variables ?? {};

  // Bước 1 — chuẩn hoá + shape. Trước rate limit: một request không hợp lệ không được tiêu slot
  // của bất kỳ ai.
  const recipient = normalizeRecipient(request.recipient);

  if (!recipient.ok) {
    return { kind: 'invalid', field: 'recipient' };
  }

  const locale = normalizeLocale(request.locale);

  if (!locale.ok) {
    return { kind: 'invalid', field: 'locale' };
  }

  if (!validateRequestShapeVariables(variables).ok) {
    return { kind: 'invalid', field: 'variables' };
  }

  const currentKey = requireCurrentKey(config.fingerprintKeyring);
  const fingerprint = await computeRequestFingerprint({
    keyHex: currentKey.keyHex,
    keyTag: currentKey.keyTag,
    template: request.template,
    locale: locale.value,
    recipient: recipient.value,
    variables,
  });

  if (!fingerprint.ok) {
    // `non_finite_number` là lỗi của request dù tầng shape đã chặn trước: một đường gọi mới không
    // được lọt — và nó là `400`, không phải `500`.
    return { kind: 'invalid', field: 'variables' };
  }

  // Bước 2 — lookup trước. Replay dưới rate limit: không tiêu slot cho việc đã xong.
  const existing = await deps.messages.findByIdempotencyKey(
    config.principal.id,
    config.idempotencyKey,
  );

  if (existing !== null) {
    return compareFingerprint(deps, config, existing, {
      template: request.template,
      locale: locale.value,
      recipient: recipient.value,
      variables,
    });
  }

  // Bước 3 — rate limit: principal trước system.
  const principalLimit = await consumeRateLimit(
    deps.rateLimits,
    { kind: 'principal', principalId: config.principal.id },
    config.rateLimitPrincipal,
    config.nowMs,
  );

  if (principalLimit.kind === 'denied') {
    return {
      kind: 'rate-limited',
      retryAfterMs: retryAfterMs(principalLimit, config.rateLimitPrincipal, config.nowMs),
    };
  }

  const systemLimit = await consumeRateLimit(
    deps.rateLimits,
    { kind: 'system' },
    config.rateLimitSystem,
    config.nowMs,
  );

  if (systemLimit.kind === 'denied') {
    return {
      kind: 'rate-limited',
      retryAfterMs: retryAfterMs(systemLimit, config.rateLimitSystem, config.nowMs),
    };
  }

  // Bước 4 — chọn template version, fallback locale một lần, version cao nhất thắng.
  const template = await selectTemplate(
    deps.templates,
    request.template,
    locale.value,
    config.defaultLocale,
  );

  if (template === null) {
    return { kind: 'template-not-found' };
  }

  // Bước 5 — schema, validation theo schema, render, ngưỡng payload.
  const schema = parseTemplateSchema(template.variablesSchemaJson);

  if (!schema.ok) {
    return { kind: 'broken-schema' };
  }

  const validated = validateVariablesAgainstSchema(schema.schema, variables, config.urlAllowlist);

  if (!validated.ok) {
    return validated.reason === 'allowlist_unconfigured'
      ? { kind: 'allowlist-unconfigured' }
      : { kind: 'invalid', field: 'variables' };
  }

  const rendered = renderMail({
    subjectTemplate: template.subjectTemplate,
    bodyTemplate: template.bodyTemplate,
    schema: schema.schema,
    normalized: validated.normalized,
    htmlEscapeForSubject: escapeSubjectValue,
  });

  if (!rendered.ok) {
    return rendered.reason === 'subject_control_character'
      ? { kind: 'invalid', field: 'variables' }
      : { kind: 'unrenderable' };
  }

  if (utf8ByteLength(rendered.subject) + utf8ByteLength(rendered.body) > config.maxRenderBytes) {
    return { kind: 'payload-too-large' };
  }

  // Bước 6 — ghi.
  const write = await deps.messages.createWithOutbox({
    messageId: config.messageId,
    outboxId: config.outboxId,
    deliveryId: config.deliveryId,
    app: config.principal.app,
    principalId: config.principal.id,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    locale: template.locale,
    recipient: recipient.value,
    subjectRendered: rendered.subject,
    bodyRendered: rendered.body,
    idempotencyKey: config.idempotencyKey,
    requestFingerprint: fingerprint.value,
    correlationId: request.correlationId ?? null,
    nowMs: config.nowMs,
  });

  if (write.kind === 'created') {
    return { kind: 'created', message: write.message };
  }

  // `already-exists`: một request đồng thời đã thắng unique index. So với **row vừa đọc lại** —
  // so với giá trị đọc trước INSERT (stale read) là sai và bị FR-002 loại. Không đệ quy: một lần
  // đọc nữa không thể thay đổi kết quả vì unique index giữ bất biến.
  const winner = await deps.messages.findByIdempotencyKey(
    config.principal.id,
    config.idempotencyKey,
  );

  return winner === null
    ? { kind: 'conflict', message: write.message }
    : compareFingerprint(deps, config, winner, {
        template: request.template,
        locale: locale.value,
        recipient: recipient.value,
        variables,
      });
}

/**
 * So fingerprint của request với row đã đọc: khớp → `replay` (trả nguyên kết quả cũ, **không**
 * re-render theo version hiện tại), lệch → `conflict` **sau khi** tiêu một slot của counter
 * theo key (FR-002).
 *
 * ⚠️ **Keyring-aware (FR-002, mục keyring):** replay **đọc tag từ tiền tố của row** rồi tính
 * lại canonical request **bằng đúng khoá của tag đó** — không tính bằng khoá current rồi so,
 * vì sau rotation row cũ vẫn phải replay `200` bằng khoá cũ. Tag lạ (profile chưa từng định
 * nghĩa, key version đã bị xoá khỏi keyring) hay giá trị lưu hỏng → `service-unavailable`
 * (`503`), **không** `409`: đây là trạng thái keyring, không phải payload của caller.
 *
 * Lỗi decode khoá (`invalid_fingerprint_key_hex`) cũng rơi `503` — khoá trong keyring hỏng là
 * lỗi cấu hình đã lọt loader, fail-closed.
 *
 * ## Chặn probe `409` theo key (FR-002, mục rủi ro còn lại)
 *
 * `200`/`409` trên cùng `(principal_id, idempotency_key)` là kênh xác nhận: một caller đã
 * authenticate có thể gửi giá trị **đoán** và đọc kết quả so fingerprint. Vì vậy mọi lần
 * **lệch fingerprint** tiêu một slot của counter riêng theo key (scope
 * `'idempotency-key'`, giá trị `<principal_id>:<SHA-256 hex>` — key gốc không vào D1) và
 * vượt ngưỡng → `429`; đồng thời một alert phát **mỗi lần lệch** với số mismatch đã ghi bền
 * (alert token-hoá, không mang key gốc). **Replay khớp `200` không bao giờ chạm counter này**
 * — một caller retry đúng nghĩa không bị phạt. `429` của counter key trả **trước** khi so
 * fingerprint lần nữa, nhưng kết quả `200`/`409` của các request trước đó **không đổi**.
 *
 * ⚠️ Consume nằm **sau** verify (chỉ nhánh lệch tiêu slot) nhưng trong cùng hàm với cả hai
 * nơi conflict (lookup-before và concurrent-winner), nên không có đường lệch nào bỏ qua nó.
 * Nếu consume bị lỗi D1 thì lỗi **nổi lên** (throw): một probe đã vượt ngưỡng mà trả `409`
 * vì alert lỗi là fail-open — không chấp nhận được với một MUST của FR-002.
 */
async function compareFingerprint(
  deps: CreateMailMessageDeps,
  config: CreateMailMessageConfig,
  message: MailMessageRecord,
  current: {
    readonly template: string;
    readonly locale: string;
    readonly recipient: string;
    readonly variables: Record<string, unknown>;
  },
): Promise<CreateMailMessageResult> {
  const storedTag = parseStoredFingerprintTag(message.requestFingerprint);
  if (storedTag === null) {
    return { kind: 'service-unavailable' };
  }

  const keyHex = config.fingerprintKeyring.keysByProfileHex.get(
    fingerprintProfileKeyTag(storedTag),
  );
  if (keyHex === undefined) {
    return { kind: 'service-unavailable' };
  }

  let matches: boolean;
  try {
    matches = await verifyStoredRequestFingerprint({
      stored: message.requestFingerprint,
      storedTag,
      keyHex,
      template: current.template,
      locale: current.locale,
      recipient: current.recipient,
      variables: current.variables,
    });
  } catch {
    return { kind: 'service-unavailable' };
  }

  if (matches) {
    return { kind: 'replay', message };
  }

  // Lệch fingerprint — tiêu slot theo key, phát alert với số mismatch đã bền, rồi `409`.
  const keyHash = await idempotencyKeyScopeHash(config.idempotencyKey);
  const consumed = await consumeRateLimit(
    deps.rateLimits,
    { kind: 'idempotency-key', scopeValue: `${config.principal.id}:${keyHash}` },
    config.rateLimitIdempotencyKey,
    config.nowMs,
  );

  deps.logAlert({
    event: 'idempotency-fingerprint-mismatch',
    principalId: config.principal.id,
    idempotencyKeyHash: keyHash,
    mismatchCount: consumed.hits,
  });

  if (consumed.kind === 'denied') {
    return {
      kind: 'rate-limited',
      retryAfterMs: retryAfterMs(consumed, config.rateLimitIdempotencyKey, config.nowMs),
    };
  }

  return { kind: 'conflict', message };
}

/**
 * Khoá **ký** row mới — entry `currentProfile` của keyring, kèm key tag tách khỏi profile tag.
 *
 * Không có entry → `Error` (lỗi cấu hình): loader đã kiểm `current` có mặt trong `keys` lúc
 * boot, nên nhánh này chỉ đạt được khi caller tự dựng keyring thủ công; ném thay vì fallback
 * giữ đúng bất biến "không hash trần" của FR-002.
 */
function requireCurrentKey(keyring: CreateMailMessageConfig['fingerprintKeyring']): {
  readonly keyHex: string;
  readonly keyTag: string;
} {
  const keyHex = keyring.keysByProfileHex.get(keyring.currentProfile);
  if (keyHex === undefined) {
    throw new Error(
      `fingerprint keyring thieu khoa cua current profile "${keyring.currentProfile}"`,
    );
  }

  // `currentProfile` có dạng `<profileTag>.<keyTag>` — đúng hai tag mà một giá trị đã persist
  // mang ở tiền tố. Tách ở dấu `.` đầu: profile tag của service không chứa `.` (loader ghim
  // `p1.k1`/`p1.k2`…), nên tách đầu và tách cuối cho cùng kết quả; chọn đầu vì rẻ hơn.
  const separator = keyring.currentProfile.indexOf('.');
  if (separator <= 0 || separator === keyring.currentProfile.length - 1) {
    throw new Error(`fingerprint keyring current profile sai dang "${keyring.currentProfile}"`);
  }

  return { keyHex, keyTag: keyring.currentProfile.slice(separator + 1) };
}

/**
 * Chọn template version: ứng viên `active` của `(name, locale)`, fallback về
 * `defaultLocale` **một lần** khi locale yêu cầu khác default, rồi lấy **version cao nhất**.
 *
 * Lưu `locale` của template **đã dùng** — không phải locale của request: validation theo schema
 * phải chạy trên đúng version được dùng (FR-003, locale fallback).
 *
 * Quy tắc "version cao nhất thắng" là quyết định của tầng này (port `findActiveByNameAndLocale` cố
 * ý trả **mảng** vì tài liệu chưa chốt cách chọn khi có nhiều version active). `reduce` so sánh
 * `version` nên thứ tự ứng viên từ port không ảnh hưởng kết quả.
 */
async function selectTemplate(
  templates: MailTemplateRepository,
  name: string,
  locale: string,
  defaultLocale: string,
): Promise<MailTemplateRecord | null> {
  let candidates = await templates.findActiveByNameAndLocale(name, locale);

  if (candidates.length === 0 && locale !== defaultLocale) {
    candidates = await templates.findActiveByNameAndLocale(name, defaultLocale);
  }

  return candidates.reduce<MailTemplateRecord | null>(
    (best, candidate) => (best === null || candidate.version > best.version ? candidate : best),
    null,
  );
}

/** Tiêu một slot rate limit cho `scope`. */
function consumeRateLimit(
  rateLimits: MailRateLimitStore,
  scope: MailRateLimitScope,
  policy: MailRateLimitPolicy,
  nowMs: number,
): Promise<MailRateLimitConsumeResult> {
  return rateLimits.tryConsume({
    scope,
    windowDurationMs: policy.windowMs,
    limit: policy.limit,
    nowMs,
  });
}

/**
 * `Retry-After` của `429` = thời điểm cửa sổ đóng trừ `nowMs`, **max 0**.
 *
 * Mốc là `config.nowMs` — cùng mốc mà port nhận — chứ không phải đồng hồ thật của process: hai
 * đồng hồ lệch nhau là `Retry-After` sai, và test thì không kiểm soát được đồng hồ thật.
 *
 * `max 0` vì `window_started_at` trả về là đã bền và có thể lớn hơn `nowMs` khi đồng hồ lệch; một
 * `Retry-After` âm sẽ là header không hợp lệ.
 */
function retryAfterMs(
  consumed: MailRateLimitConsumeResult,
  policy: MailRateLimitPolicy,
  nowMs: number,
): number {
  return Math.max(0, consumed.windowStartedAtMs + policy.windowMs - nowMs);
}

/** Số **byte UTF-8** của chuỗi — ngưỡng `413` đo trên byte, không trên UTF-16 code unit. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Escape dùng cho **context subject**.
 *
 * Subject đi vào **header MIME**, không phải HTML: escape kiểu HTML ở đây sẽ đổi nội dung người
 * nhận thấy (`R&D` thành `R&amp;D` ngay trong header). Nên context subject **không** HTML-escape —
 * ở header không có ngữ cảnh HTML nào để escape vào, và HTML escape ở body đã đủ cho phần HTML
 * của một lá thư multipart. Header không cần escape HTML; nó cần chặn control character, việc
 * đó do `renderMail` kiểm riêng trên chuỗi subject đã render.
 *
 * Đây là hàm thay thế **tường minh** (identity) chứ không phải `escapeHtmlText`: để một người đọc
 * sau này không tưởng đây là chỗ sót sót của escape.
 */
function escapeSubjectValue(value: string): string {
  return value;
}
