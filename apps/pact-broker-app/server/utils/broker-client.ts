/**
 * HTTP client từ BFF sang pact-broker-api.
 *
 * Mô hình: **một** machine token server-side duy nhất (cấp cho deploy unit
 * `pact-broker-app`, scope `read`), browser không bao giờ thấy nó. Mọi request
 * dashboard đi qua BFF; BFF forward kèm token của chính mình. Đây là hướng đi
 * tối thiểu khi Auth/OIDC chưa provision — khi OIDC có mặt, tầng session sẽ
 * thay token tĩnh bằng token per-user và ForwardAuth, nhưng hợp đồng của các
 * hàm ở đây không đổi.
 *
 * Quy tắc lỗi (giống `apps/account`): **không** nối `error` của driver/fetch
 * vào log hay response — message của nó có thể chứa URL/credential. Chỉ log mã
 * ổn định (`broker_unreachable`, `broker_not_configured`).
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
 * Gọi một endpoint của broker API với machine token của BFF.
 *
 * ⚠️ KHÔNG BAO GIỜ log `Authorization`, token, hay body request/response —
 * SR-007. Log duy nhất là một dòng mã ổn định khi fetch ném.
 */
export async function brokerCall(
  config: { baseUrl: string; token: string },
  path: string,
  init: RequestInit = {},
): Promise<BrokerCallResult> {
  const url = `${config.baseUrl}${path}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${config.token}`);
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
