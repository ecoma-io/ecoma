/**
 * Validate `endpoint` của `Push Subscription` — canonical của FR-003.
 *
 * FR-003 liệt kê sáu điều kiện bắt buộc, và file này thực thi đúng sáu đó, không thêm
 * điều kiện thứ bảy trừ khi nó là hệ quả tất yếu của một điều kiện đã có:
 *
 * 1. scheme phải là `https:`
 * 2. URL phải parse được
 * 3. không có userinfo (`user:pass@`)
 * 4. không phải IP literal, không thuộc dải private/reserved/link-local/loopback
 * 5. host phải khớp allowlist **theo ranh giới nhãn**
 * 6. (đăng ký/update) không follow redirect ra ngoài allowlist — ở tầng control plane có nghĩa
 *    là: endpoint **không** chứa cơ chế redirect nào mà ta kiểm được; worker không follow
 *    redirect nào (`03-operations.md` §5), nên control plane chỉ cần từ chối endpoint sai.
 *
 * ⚠️ **Đây là giảm thiểu, không phải chống SSRF hoàn hảo — và FR-003 nói thẳng như vậy.**
 * Host trong allowlist vẫn có thể resolve về địa chỉ private qua **DNS rebinding**: allowlist
 * kiểm tra *tên*, còn request đi tới *địa chỉ*, và hai cái tách rời nhau ngay sau khi DNS
 * trả lời. Cách triệt để là resolve + kiểm IP + khoá kết nối vào đúng IP đó, điều mà
 * `fetch()` của Workers **không** cho kiểm soát. Vì vậy:
 *   - allowlist ở đây là **cấu hình do operator kiểm soát**, không phải danh sách đóng của spec;
 *   - hàm này **không** tuyên bố chặn được SSRF, và comment này tồn tại để người đọc không
 *     diễn giải `isValidPushEndpoint()` thành đảm bảo đó.
 */

import { MAX_PUSH_ENDPOINT_LENGTH, REQUEST_REJECTION } from './records';
import type { UseCaseResult } from './records';

/** Kết quả validate — trả về host đã chuẩn hoá để lưu `endpoint_hash` ổn định. */
export interface EndpointValidationSuccess {
  readonly endpoint: string;
  readonly host: string;
}

export type EndpointValidation =
  | { readonly ok: true; readonly value: EndpointValidationSuccess }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

/**
 * Dải địa chỉ bị cấm — RFC 1918, loopback, link-local, CGNAT, IPv6 ULA + link-local, và
 * các dải reserved/documentation mà không thuộc Internet công cộng.
 *
 * ⚠️ Vì sao liệt kê **tường minh** thay vì chỉ chặn "private": một danh sách bỏ sót một dải
 * là một lỗ hổng, và `Number.isFinite` trên một IP literal dạng số nguyên (`http://2130706433/`)
 * là một cách vòng tắt. Vì thế cả **hai** lớp đều chặn: literal dạng số/hex bị từ chối ngay ở
 * điều kiện 4, và allowlist (điều kiện 5) là cổng thật sự cho những gì tên host có thể là.
 */
const FORBIDDEN_IPV4_PATTERNS: readonly RegExp[] = [
  /^0\./u,
  /^10\./u,
  /^127\./u,
  /^169\.254\./u,
  /^172\.(1[6-9]|2\d|3[01])\./u,
  /^192\.0\.0\./u,
  /^192\.0\.2\./u,
  /^192\.168\./u,
  /^198\.18\./u,
  /^198\.51\.100\./u,
  /^203\.0\.113\./u,
  /^224\./u,
  /^240\./u,
];

/**
 * Dải IPv6 bị cấm: loopback `::1`, IPv4-mapped `::ffff:a.b.c.d`, unique local `fc00::/7`,
 * link-local `fe80::/10`. Ứng dụng ở dạng nén của IPv6 có nhiều cách viết tương đương
 * (`[::1]`, `[0:0:0:0:0:0:0:1]`), nên ký tự kiểm là: có `:` **hoặc** toàn chữ số hex ngắn.
 */
const FORBIDDEN_IPV6_PATTERNS: readonly RegExp[] = [
  /^::1$/u,
  /^::$/u,
  /^fe[89ab][0-9a-f]:/iu,
  /^f[cd][0-9a-f]{2}:/iu,
  // IPv4-mapped: `$` ở giữa mẫu trước (`/^::$ffff:/iu`) là một anchor nên mẫu đó không bao
  // giờ khớp gì cả — mẫu duy nhất mang tải là dòng này, khớp cả dạng nén lẫn dạng đã chuẩn
  // hoá (`::ffff:127.0.0.1` → `::ffff:7f00:1`).
  /^\[?::ffff:/iu,
];

/** IPv4 literal thuần dạng `a.b.c.d` (không phải hostname). */
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/** Một nhãn DNS hợp lệ — dùng để chặn host dạng `fcm.googleapis.com.evil` hay ký tự lạ. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/iu;

/**
 * Khớp allowlist **theo ranh giới nhãn** — FR-003 nêu đúng phản diện: allowlist
 * `example.com` **không** được khớp bởi `evil-example.com`.
 *
 * ⚠️ Vì sao chuẩn hoá lowercase trước khi so: host trong URL là case-insensitive, và
 * `FCM.googleapis.com` là cùng một host. Bỏ qua bước này thì một endpoint hợp lệ bị từ chối
 * theo cách mà người vận hành không đoán ra, dẫn tới việc họ nới allowlist cho tới khi nó
 * rộng bất khả chấp nhận.
 */
export function hostMatchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  return allowlist.some((entry) => {
    const candidate = entry.toLowerCase();
    if (candidate === normalized) {
      return true;
    }
    // Suffix có **boundary dấu chấm**: `updates.push.services.mozilla.com` khớp
    // `a.updates.push.services.mozilla.com` nhưng không khớp `evil-updates.push...`.
    return normalized.endsWith(`.${candidate}`);
  });
}

/**
 * Host có phải IP literal không — gồm dạng số nguyên (`2130706433`), hex (`0x7f000001`) và
 * IPv6 trong ngoặc vuông.
 *
 * ⚠️ Đây là điều kiện FR-003 ("MUST NOT là IP literal") nhưng cũng là **chống vòng tắt**: một
 * host dạng số nguyên là biểu diễn khác của `127.0.0.1`, và nếu chỉ kiểm dải bằng regex theo
 * dạng dotted thì `http://2130706433/` đi qua allowlist check với một "hostname" trông
 * hợp lệ.
 */
export function looksLikeIpLiteral(host: string): boolean {
  if (host.startsWith('[') || host.endsWith(']')) {
    return true;
  }
  if (IPV4_LITERAL.test(host)) {
    return true;
  }
  if (/^\d+$/u.test(host) || /^0x[0-9a-f]+$/iu.test(host)) {
    return true;
  }
  return FORBIDDEN_IPV6_PATTERNS.some((pattern) => pattern.test(host));
}

/** Host có thuộc dải private/reserved/link-local/loopback không. */
export function isForbiddenIpv4(host: string): boolean {
  return FORBIDDEN_IPV4_PATTERNS.some((pattern) => pattern.test(host));
}

/** Host có phải một hostname DNS hợp lệ (mọi nhãn khớp `DNS_LABEL`) không. */
export function isDnsHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  const labels = host.split('.');
  return labels.every((label) => DNS_LABEL.test(label));
}

/**
 * Validate một endpoint theo đúng sáu điều kiện của FR-003.
 *
 * Thứ tự kiểm là thứ tự **rẻ → đắt** và là thứ tự chẩn đoán: một URL sai scheme không cần
 * parse host; một host sai allowlist không cần kiểm IP. Thứ tự này **không** đổi tập endpoint
 * được chấp nhận (mọi điều kiện đều phải đúng), chỉ quyết định `detail` nào được trả.
 *
 * @param allowlist host allowlist của Browser Push Service; rỗng → mọi endpoint bị từ chối.
 *   Rỗng là **fail-closed**: một deployment chưa cấu hình allowlist thì không nên đăng ký
 *   được subscription nào, thay vì đăng ký được bất kỳ endpoint nào.
 */
export function validatePushEndpoint(
  endpoint: unknown,
  allowlist: readonly string[],
): EndpointValidation {
  if (typeof endpoint !== 'string') {
    return {
      ok: false,
      reason: 'endpoint_type',
      detail: 'Endpoint phải là chuỗi.',
    };
  }
  if (endpoint.length === 0) {
    return { ok: false, reason: 'endpoint_empty', detail: 'Endpoint rỗng.' };
  }
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
    return {
      ok: false,
      reason: 'endpoint_too_long',
      detail: `Endpoint vượt trần ${MAX_PUSH_ENDPOINT_LENGTH} ký tự.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return {
      ok: false,
      reason: 'endpoint_malformed',
      detail: 'Endpoint không parse được thành URL.',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'endpoint_not_https',
      detail: 'Endpoint phải dùng scheme https.',
    };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return {
      ok: false,
      reason: 'endpoint_userinfo',
      detail: 'Endpoint chứa userinfo — không được phép.',
    };
  }
  // Host rỗng: `https://` không có host parse được thành URL với hostname `''` ở một số
  // runtime, và một endpoint không có host không thể là endpoint của push service.
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    return { ok: false, reason: 'endpoint_no_host', detail: 'Endpoint không có host.' };
  }
  if (looksLikeIpLiteral(host)) {
    return {
      ok: false,
      reason: 'endpoint_ip_literal',
      detail: 'Endpoint không được là IP literal.',
    };
  }
  if (isForbiddenIpv4(host)) {
    return {
      ok: false,
      reason: 'endpoint_private_address',
      detail: 'Endpoint thuộc dải private/reserved/loopback.',
    };
  }
  if (!isDnsHostname(host)) {
    return {
      ok: false,
      reason: 'endpoint_malformed_host',
      detail: 'Host không phải hostname DNS hợp lệ.',
    };
  }
  if (allowlist.length === 0) {
    return {
      ok: false,
      reason: 'endpoint_allowlist_empty',
      detail: 'Chưa cấu hình allowlist host — fail closed, không đăng ký endpoint nào.',
    };
  }
  if (!hostMatchesAllowlist(host, allowlist)) {
    return {
      ok: false,
      reason: 'endpoint_host_not_allowlisted',
      detail: 'Host không khớp allowlist của Browser Push Service (theo ranh giới nhãn).',
    };
  }

  return { ok: true, value: { endpoint, host } };
}

/**
 * Endpoint đã lưu có còn hợp lệ theo allowlist/policy **hiện tại** không — FR-003 đòi
 * re-validate khi allowlist đổi và theo định kỳ.
 *
 * ⚠️ Hàm này trả kết quả như một use case khác (`UseCaseResult`) chứ không phải
 * `EndpointValidation`: lượt quét định kỳ cần phân biệt "endpoint sai (disable subscription)"
 * với "row hỏng / storage lỗi (để lượt sau)", và một union `ok:false` không nói lời được
 * điều đó.
 */
export function revalidateStoredEndpoint(
  storedEndpoint: string,
  allowlist: readonly string[],
): UseCaseResult<{ readonly valid: true }> {
  const validation = validatePushEndpoint(storedEndpoint, allowlist);
  if (validation.ok) {
    return { ok: true, value: { valid: true } };
  }
  if (validation.reason === 'endpoint_type' || validation.reason === 'endpoint_empty') {
    return {
      ok: false,
      reason: REQUEST_REJECTION.NotFound,
      detail: 'Endpoint đã lưu không đọc được — coi như row hỏng, không tự disable.',
    };
  }
  return {
    ok: false,
    reason: REQUEST_REJECTION.EndpointRejected,
    detail: `Endpoint đã lưu không còn hợp lệ (${validation.reason}).`,
  };
}
