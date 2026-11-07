/**
 * Authorization boundary của **endpoint reconciliation nội bộ** của chính delivery plane:
 * `POST /internal/reconcile/jobs`.
 *
 * ⚠️ **Vì sao Worker này vẫn có một authorization boundary dù nó không có HTTP API public.**
 * Invariant 1 (§19) nói worker không có *public application API*; endpoint này là **internal
 * operator surface**, không phải application API. Nó tồn tại vì trigger của job reconciliation
 * là một quyết định **chưa chốt** (xem `job-reconciliation.ts`), và Lead đã cấm `scheduled()`;
 * một endpoint có xác thực là hình thức duy nhất để sweep chạy được mà không bịa một cron.
 *
 * ⚠️ **Cùng một cơ chế auth với private API của control plane**: shared secret qua header +
 * principal header, so sánh constant-time, `401` trước mọi việc khác. Cùng cơ chế **không**
 * phải cùng một secret: `RUNTIME_API_SHARED_SECRET` là secret worker↔control plane, còn
 * `RUNTIME_API_EXPECTED_PRINCIPAL` ở đây là principal mà **endpoint reconciliation** kỳ vọng.
 * Hai giá trị đều fail-closed khi thiếu.
 *
 * ⚠️ **Service Binding không phải authorization boundary** — Cloudflare không phân biệt được
 * request qua binding với request từ Internet (§6.1). Vì vậy endpoint này xác thực ở tầng ứng
 * dụng, dù nó có hostname hay không.
 */

/** Header mang shared secret — **giá trị nguyên văn**, không có scheme `Bearer`. */
export const RECONCILE_SHARED_SECRET_HEADER = 'authorization';

/** Header principal tự khai — giá trị chính nó không phải bằng chứng danh tính. */
export const RECONCILE_PRINCIPAL_HEADER = 'x-ecoma-principal';

/** Principal mà endpoint reconciliation của delivery worker tự khai khi gọi chính nó. */
export const WEB_PUSH_JOB_PRINCIPAL = 'svc.web-push-notification-job';

/** Cấu hình auth của endpoint reconciliation — fail-closed ở tầng resolve. */
export interface ReconciliationAuthConfig {
  readonly sharedSecret: string;
  readonly expectedPrincipal: string;
}

/** Header đọc từ `Request` — `{ [name]: string | null }`. */
export type ReconcileHeaderReader = (name: string) => string | null;

/**
 * Header của một request, đọc từ `Headers` (case-insensitive theo chuẩn HTTP).
 *
 * ⚠️ Không khai tham số là `Headers`: tầng application của repo này build với
 * `lib: ["es2022"]` + `types: []` (không có DOM, không có `@cloudflare/workers-types`), nên
 * `Headers` là một `TS2304` ở đây. Port {@link ReconcileHeaderReader} là hình dạng thật sự cần —
 * `(name: string) => string | null` — và nó làm việc với `Headers` của Workers lẫn của Node mà
 * không cần biết global nào tồn tại ở tầng này.
 */
export function readRequestHeader(headers: HeadersLike): ReconcileHeaderReader {
  return (name: string): string | null => headers.get(name);
}

/** Đúng một phần của `Headers` mà boundary này cần — không khai toàn bộ global Web API. */
export interface HeadersLike {
  get(name: string): string | null;
}

/**
 * Xác thực caller của endpoint reconciliation.
 *
 * ⚠️ **So secret trước principal**, và so **cả hai** bằng constant-time. So principal trước bằng
 * `===` làm thời gian trả lời phụ thuộc việc principal có khớp — tức rò principal đúng qua
 * timing, dù principal là header tự khai (không phải bí mật, nhưng vẫn là một phần của định
 * danh đang xác thực). Cùng policy với `authenticateRuntimeCaller` phía control plane.
 *
 * ⚠️ **Một câu trả lời duy nhất**: thiếu header, sai secret, sai principal — cùng `401`. Phân
 * biệt "thiếu" với "sai" là một oracle đo lời gọi đã thử gì.
 */
export function authenticateReconciliationCaller(
  read: ReconcileHeaderReader,
  config: ReconciliationAuthConfig,
): { readonly principal: string } | null {
  const provided = read(RECONCILE_SHARED_SECRET_HEADER);
  const principal = read(RECONCILE_PRINCIPAL_HEADER);
  // ⚠️ **Rỗng cũng là fail-closed**, không chỉ "vắng". Thiếu header là `null` từ `Headers.get`,
  // nhưng một header mang chuỗi rỗng là một trạng thái khác — và nếu cấu hình lẫn header đều
  // rỗng thì so sánh constant-time sẽ cho `true`, tức cấu hình hỏng biến thành một
  // authorization boundary **mở toạch**. Cấu hình hỏng không bao giờ là một cách để mở cửa.
  if (provided === null || provided === '' || principal === null || principal === '') {
    return null;
  }
  if (config.sharedSecret === '' || config.expectedPrincipal === '') {
    return null;
  }
  if (!constantTimeEquals(provided, config.sharedSecret)) {
    return null;
  }
  if (!constantTimeEquals(principal, config.expectedPrincipal)) {
    return null;
  }
  return { principal: config.expectedPrincipal };
}

/**
 * So sánh hai chuỗi **constant-time** theo byte UTF-8.
 *
 * ⚠️ `===` rời ngay tại byte khác nhau đầu tiên, nên thời gian đo được là thứ đo được tiền tố
 * secret. Vòng lặp luôn chạy trên **chiều dài lớn hơn** và XOR cả phần chênh độ dài, nên một
 * secret ngắn hơn không lộ qua nhịp vòng lặp.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = toUtf8Bytes(left);
  const rightBytes = toUtf8Bytes(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

/**
 * UTF-8 encode **không dùng global `TextEncoder`**.
 *
 * ⚠️ `lib: ["es2022"]` + `types: []` của tầng application không có global Web API, nên
 * `TextEncoder` là một `TS2304`. Hàm này chỉ cần một phép encode UTF-8 đúng để so sánh byte —
 * và việc tự viết ở đây còn có một lý do thứ hai: nó **không** phụ thuộc vào việc `TextEncoder` của
 * runtime nào giả định gì về surrogate lẻ, nên phép so sánh constant-time đo được cùng một
 * cách trên Workers lẫn Node.
 */
function toUtf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}
