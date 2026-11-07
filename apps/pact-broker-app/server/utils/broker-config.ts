/**
 * Đọc cấu hình BFF ra khỏi `runtimeConfig` của Nuxt.
 *
 * ⚠️ Nhận `unknown` và kiểm **hình dạng thật**, không cast và tin: khoá
 * `cloudflare` không nằm trong `runtimeConfig` khai ở `nuxt.config.ts`, nên kiểu
 * mà Nuxt sinh cho `useRuntimeConfig()` không nói lên gì về các khoá này. Trên
 * Workers, secret được nối vào runtime config **ở request**, không phải lúc
 * module load — vì vậy accessor được gọi mỗi request, không cache ở module scope.
 *
 * ⚠️ Trả `null` **không phải** "chạy được không cần broker" — mọi caller fail
 * closed: route trả 503 `Service Unavailable` với mã ổn định, không đoán origin
 * và không để lỗi thoát ra h3.
 *
 * Không dùng `instanceof`: object binding/runtime của Workers đi qua shim và
 * không có prototype ổn định giữa môi trường build và runtime.
 */

/** Khoá trong `runtimeConfig` giữ base URL của pact-broker-api. */
export const PACT_BROKER_API_BASE_URL_KEY = 'pactBrokerApiBaseUrl';

/** Khoá trong `runtimeConfig` giữ machine token mà BFF dùng gọi API. */
export const PACT_BROKER_API_TOKEN_KEY = 'pactBrokerApiToken';

/** Cấu hình đã kiểm để nói chuyện với pact-broker-api. */
export interface PactBrokerBffConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/** Shape mà `useRuntimeConfig()` trả — chỉ phần app đọc. */
interface AppRuntimeConfig {
  pactBrokerApiBaseUrl?: unknown;
  pactBrokerApiToken?: unknown;
}

/**
 * Đọc cấu hình BFF; `null` khi thiếu/misconfigured — caller phải 503.
 *
 * Base URL phải là absolute URL có scheme http(s) và KHÔNG có path/query/hash
 * (parse bằng `new URL`, không so prefix chuỗi — prefix string bị qua mặt bằng
 * scheme hoa thường, userinfo, percent-encoding).
 */
export function pactBrokerBffConfig(runtimeConfig: unknown): PactBrokerBffConfig | null {
  const config = (runtimeConfig ?? {}) as AppRuntimeConfig;

  const rawBaseUrl = config.pactBrokerApiBaseUrl;
  if (typeof rawBaseUrl !== 'string' || rawBaseUrl === '') {
    return null;
  }
  let baseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      return null;
    }
    // Userinfo (`https://user:pass@host`) bị từ chối tường minh: `parsed.origin`
    // strip credential đi, chấp nhận thì config chứa credential bị "nuốt" im
    // lặng và URL gọi đi không còn credential nào cả — misconfiguration không
    // được nhìn thấy. Đúng vector bypass của so-prefix-chuỗi (memory:
    // url-parse-not-string-prefix-for-host-invariants).
    if (parsed.username !== '' || parsed.password !== '') {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    baseUrl = parsed.origin;
  } catch {
    return null;
  }

  const rawToken = config.pactBrokerApiToken;
  if (typeof rawToken !== 'string' || rawToken === '') {
    return null;
  }

  return { baseUrl, token: rawToken };
}
