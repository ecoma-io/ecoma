/**
 * HTTP client từ BFF sang pact-broker-api.
 *
 * ## Access token của chủ phiên, không phải machine token của BFF (ADR-0031 §4–5)
 *
 * Trước #206, BFF forward **một** machine token server-side duy nhất cho mọi
 * request. ADR-0031 §5 quyết định retire hẳn đường đó: BFF forward access
 * token **của chủ phiên** (`Authorization: Bearer <user token>`), và API là
 * resource server tự verify token + phân quyền theo membership (ADR-0032).
 *
 * Hệ quả trực tiếp: **browser không bao giờ thấy token nào** (token nằm ở
 * cookie HttpOnly phía server và trong context của request), và BFF không còn
 * secret nào với API — không có machine token của deploy unit này còn tồn tại.
 *
 * Quy tắc lỗi (giống `apps/account`): **không** nối `error` của driver/fetch
 * vào log hay response — message của nó có thể chứa URL/credential. Chỉ log mã
 * ổn định (`broker_unreachable`).
 *
 * Trạng thái HTTP từ API được truyền **nguyên văn** về cho UI kèm body đã parse
 * — UI quyết định render gì; BFF không hiện hóa lỗi của API thành 500.
 */

/** Kết quả một lần gọi broker API. */
export interface BrokerCallResult {
  readonly status: number;
  /** Body đã parse JSON, hoặc `null` khi body rỗng/không phải JSON. */
  readonly body: unknown;
  /** Mã lỗi ổn định khi request không tới được API (`broker_unreachable`). */
  readonly errorCode: 'broker_unreachable' | null;
}

/**
 * Gọi một endpoint của broker API với access token của chủ phiên.
 *
 * @param config Cấu hình BFF — chỉ base URL (không còn token của BFF).
 * @param accessToken Access token của phiên, lấy từ principal do middleware
 *   authn gắn (`server/principal.ts`). KHÔNG ghi log, KHÔNG trả response.
 * @param path Path của API, ví dụ `/pacticipants`.
 * @param init Init tuỳ chọn cho `fetch`.
 *
 * ⚠️ KHÔNG BAO GIỜ log `Authorization`, token, hay body request/response —
 * SR-007. Log duy nhất là một dòng mã ổn định khi fetch ném.
 */
export async function brokerCall(
  config: { baseUrl: string },
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<BrokerCallResult> {
  const url = `${config.baseUrl}${path}`;
  const headers = new Headers(init.headers);
  // Lưới an toàn runtime (review #254): mọi caller lấy token từ
  // `requirePrincipal` (type đã không rỗng), nhưng principal gắn sai ở một
  // middleware nào đó là lỗi im lặng khó lần — rỗng thì fail-loud ngay, thay
  // vì gửi `Bearer ` đi và đọc 401 mờ của API.
  if (accessToken === '') {
    throw new Error('brokerCall: access token of the session principal is empty');
  }
  headers.set('authorization', `Bearer ${accessToken}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch {
    // Message của fetch có thể chứa URL (đích + có thể credential trong query
    // nếu caller dựng sai) — không nối vào log.
    // oxlint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', code: 'broker_unreachable', path }));
    return { status: 0, body: null, errorCode: 'broker_unreachable' };
  }

  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      // Không phải JSON — giữ `null`; caller chỉ nhìn status.
    }
  }

  return { status: response.status, body, errorCode: null };
}
