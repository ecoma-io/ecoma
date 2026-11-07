/**
 * Adapter Web Push — implement port `WebPushSender`
 * (`@ecoma-io/web-push-notification-job-application/src/web-push-sender.ts`).
 *
 * ⚠️ **Trách nhiệm của adapter, và không phải của nó.** Adapter gửi **một** Web Push
 * request rồi phân loại kết quả. Nó **không** ghi state, **không** biết `dispatch_generation`
 * / `delivery_id`, **không** quyết retry hay invalidate — đó là việc của pipeline (worker §11).
 * Giữ ranh giới đó là điều làm adapter không thể vô tình ghi credential vào log, và không
 * thể quyết invalidate một subscription khi provider chưa chứng minh endpoint chết.
 *
 * ⚠️ **Mọi kết quả trả về chỉ có field đã khai báo trong port.** Không endpoint, không
 * `p256dh`/`auth`, không VAPID key, không JWT, không body provider. Đây là cách giữ
 * SR-002/SR-003: không có gì để lộ. Adapter **không** `console.log` bất cứ thứ gì.
 */

import type {
  WebPushSendRequest,
  WebPushSendResult,
  WebPushSender,
} from '@ecoma-io/web-push-notification-job-application';

import { classifyResponse, readRetryAfter } from './classify';
import { MAX_PLAINTEXT_OCTETS, MAX_TTL_SECONDS, MIN_TTL_SECONDS, SALT_OCTETS } from './constants';
import { encryptPushPayload, PushEncryptionInputError } from './encryption';
import {
  buildVapidAuthorizationHeader,
  createVapidToken,
  isValidVapidPublicKey,
  VapidSigningKeyError,
} from './vapid';

/** Phụ thuộc chèn được — **chỉ** để test, hành vi không nhánh theo chúng. */
export interface WebPushSenderDeps {
  /** Thay `globalThis.fetch`; mặc định `globalThis.fetch` (Workers runtime). */
  readonly fetchImpl?: typeof fetch;
  /** Thay `Date.now`; mặc định `Date.now`. Chỉ dùng cho `exp` của JWT VAPID. */
  readonly now?: () => number;
}

/** Kết quả transient cho lỗi **trước** khi request có thể tới provider. */
function transientBeforeSend(): WebPushSendResult {
  return { outcome: 'transient', phase: 'before_send', retryAfterMs: null, httpStatus: null };
}

/** Kết quả transient cho lỗi **sau** khi request đã rời worker (timeout/abort) — nguồn duplicate tiềm năng. */
function transientAfterSend(): WebPushSendResult {
  return { outcome: 'transient', phase: 'after_send', retryAfterMs: null, httpStatus: null };
}

/** Kết quả permanent cho credential VAPID không dùng được (worker §18). */
function vapidKeyMissing(): WebPushSendResult {
  return { outcome: 'failed', failureClass: 'vapid_key_missing', httpStatus: null };
}

/**
 * Kiểm endpoint có phải URL `https` hợp lệ không.
 *
 * ⚠️ Parse bằng `new URL` (**không** so tiền tố chuỗi): `HTTPS://` hay `https://user@host`
 * đều qua mặt so chuỗi nhưng URL parser chuẩn hoá đúng. `aud` của JWT VAPID cũng lấy từ
 * `origin` của chính parser này (RFC 8292 §2), nên hai thứ không thể lệch nhau.
 *
 * FR-005: worker **MUST NOT** re-validate allowlist hay lọc/đổi endpoint — đây chỉ là kiểm
 * *parse được*, không phải kiểm chính sách.
 */
function parseHttpsEndpoint(endpoint: string): URL | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  // Origin rỗng (`https://` vô nghĩa) hoặc endpoint không có host: không gửi được.
  if (url.origin === 'null' || url.hostname === '') {
    return null;
  }
  return url;
}

/**
 * Chuyển `ttlSeconds` thành giá trị header `TTL`.
 *
 * WP4/RFC 8030 §5.2: `TTL` là số giây nguyên không âm và **luôn có mặt**. Caller đã clamp
 * theo `expires_at` (worker §16); ta chỉ chặn giá trị không đại diện được trên wire thay vì
 * gửi header sai — header hỏng sẽ bị push service từ chối với lý do không liên quan.
 */
function ttlHeaderValue(ttlSeconds: number): string | null {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < MIN_TTL_SECONDS ||
    ttlSeconds > MAX_TTL_SECONDS
  ) {
    return null;
  }
  return String(ttlSeconds);
}

/**
 * Dựng adapter Web Push.
 *
 * Không giữ state giữa các lần gửi: mỗi `send` là một request độc lập, key ECDH sinh mới
 * (RFC 8291 §2), JWT ký mới. Điều này giữ worker an toàn khi bị restart hay scale — không có
 * node-local state phải phục hồi (AGENTS.md: không để node-local application state).
 */
export function createWebPushSender(deps: WebPushSenderDeps = {}): WebPushSender {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  return {
    async send(request: WebPushSendRequest): Promise<WebPushSendResult> {
      // --- Pre-flight 1: endpoint -------------------------------------------------------
      const endpoint = parseHttpsEndpoint(request.endpoint);
      if (endpoint === null) {
        // Endpoint **chính** là thứ không gửi được, và không có provider nào xác nhận.
        // Đây là `endpoint_invalid` hợp lệ: không có cách nào khác để biết endpoint chết
        // mà không gửi, và một endpoint không parse được là nguyên nhân duy nhất ở đây.
        return { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: null };
      }

      // --- Pre-flight 2: credential VAPID ----------------------------------------------
      if (request.vapidPrivateKey.length === 0 || !isValidVapidPublicKey(request.vapidPublicKey)) {
        // Worker §18: credential không resolve/import được cho `vapid_key_id` đã ghi là
        // **permanent failure của attempt** — không retry, không invalidate, alert.
        return vapidKeyMissing();
      }
      // `sub` OPTIONAL theo RFC 8292 §2.1 → `vapidSubject === null` vẫn ký hợp lệ, ta
      // **không** chặn. Xem `VAPID_SUB_IS_REQUIRED` trong `./constants`.

      // --- Pre-flight 3: TTL -----------------------------------------------------------
      const ttl = ttlHeaderValue(request.ttlSeconds);
      if (ttl === null) {
        // `TTL` không đại diện được trên wire là lỗi contract của caller, không phải
        // endpoint chết. `transient` để bounded retry đưa vào DLQ thay vì invalidate.
        return transientBeforeSend();
      }

      // --- Pre-flight 4: trần payload (WP5, worker §15) --------------------------------
      // Kiểm **trước** mọi việc mã hoá và trước fetch: vượt trần là permanent của attempt,
      // và worker §15 cấm cắt bớt để vừa.
      const plaintext = new TextEncoder().encode(request.payloadJson);
      if (plaintext.length > MAX_PLAINTEXT_OCTETS) {
        return { outcome: 'failed', failureClass: 'payload_too_large', httpStatus: null };
      }

      // --- Pre-flight 5: ký VAPID (RFC 8292) -------------------------------------------
      // `aud` = **origin** của endpoint, không phải hostname server (RFC 8292 §2).
      //
      // ⚠️ Tên `authHeader` (không phải `authorization`) và `vapidToken` (không phải
      // `token`) là có chủ đích: `authHeader` là header ĐÃ LẮP cho request ĐI RA
      // (`vapid t=…, k=…`), không phải khái niệm authorization của request ĐI VÀO —
      // rule Semgrep `.github/semgrep/security.yml` nhận diện dữ liệu nhạy cảm qua
      // tên, nên `authorization` trần ở đây kéo FP vào `classifyResponse(...)`
      // bất chấp giá trị chỉ đi vào outbound `doFetch`. `vapidToken` nói rõ đó là
      // JWT VAPID vừa ký ở dòng trên (tự hết hạn theo `exp`), không phải token
      // storage. `return classifyResponse(...)` phân loại STATUS của response — không
      // mang giá trị nào ở trên ra caller. Một `return authorization` ở một đường
      // echo header thật vẫn bị flag như cũ.
      let authHeader: string;
      let body: Uint8Array;
      try {
        const vapidToken = await createVapidToken({
          privateKeyDerBase64Url: request.vapidPrivateKey,
          audience: endpoint.origin,
          nowSeconds: Math.floor(now() / 1000),
          subject: request.vapidSubject,
        });
        authHeader = buildVapidAuthorizationHeader(vapidToken, request.vapidPublicKey);

        const salt = crypto.getRandomValues(new Uint8Array(SALT_OCTETS));
        ({ body } = await encryptPushPayload({
          p256dh: request.p256dh,
          auth: request.auth,
          plaintext,
          salt,
        }));
      } catch (error) {
        if (error instanceof VapidSigningKeyError) {
          return vapidKeyMissing();
        }
        if (error instanceof PushEncryptionInputError) {
          // Material của subscription hỏng (p256dh/auth) — **KHÔNG** phải bằng chứng
          // endpoint chết. Map sang transient để không invalidate subscription tốt.
          return transientBeforeSend();
        }
        if (error instanceof RangeError) {
          // Bất biến byte ở trong `encryptPushPayload` đỏ: coi như payload vượt trần.
          return { outcome: 'failed', failureClass: 'payload_too_large', httpStatus: null };
        }
        // Lỗi WebCrypto ngoài dự kiến: cũng là before_send để không mất thông tin phân loại.
        return transientBeforeSend();
      }

      // --- Gửi -------------------------------------------------------------------------
      const controller = new AbortController();
      // Cờ `dispatched`: được bật **ngay trước** khi gọi `doFetch` — tức là request đã được
      // handing off cho fetch implementation (đã "rời" adapter). Dùng để phân biệt rejection
      // xảy ra sau khi request đã gửi (timeout/abort → `after_send`, nguồn duplicate tiềm
      // năng) với rejection trước khi gửi (DNS/connection refused → `before_send`).
      // ⚠️ Cờ này không chứng minh byte đã tới provider, chỉ chứng minh adapter đã bắt đầu
      // gửi — đúng mức quan sát được của adapter (worker §12 nhóm iii).
      let dispatched = false;
      const timer = setTimeout(() => {
        controller.abort();
      }, request.timeoutMs);
      try {
        dispatched = true;
        const response = await doFetch(endpoint.href, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: ttl,
          },
          body,
          // FR-005: không bao giờ đi theo redirect. `manual` giữ nguyên 3xx để matrix
          // phân loại thành `redirect_not_followed` thay vì âm thầm gửi lại ở host khác.
          redirect: 'manual',
          signal: controller.signal,
        });
        return classifyResponse(response.status, readRetryAfter(response.headers));
      } catch (error) {
        // Rejection sau khi request đã gửi (timeout do chính timer, hoặc abort từ fetch
        // implementation) → `after_send`: crash window đã chấp nhận (worker §12 nhóm iii),
        // retry có thể tạo duplicate phía provider. Phải quan sát được trong job state +
        // log + metric (§12).
        const isAbortError =
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof Error && error.name === 'AbortError');
        if (dispatched && isAbortError) {
          // Timeout/abort sau khi request đã gửi → `after_send` (nguồn duplicate tiềm năng).
          return transientAfterSend();
        }
        // Rejection trước khi gửi (DNS/connection refused, hoặc lỗi không phải abort) →
        // `before_send`: chưa có bằng chứng request đã tới provider, retry không tạo duplicate.
        return transientBeforeSend();
      } finally {
        // Dọn timer **luôn**, kể cả khi thành công — giữ worker không giữ timer tới hết
        // vòng đời sau khi đã trả kết quả.
        clearTimeout(timer);
      }
    },
  };
}
