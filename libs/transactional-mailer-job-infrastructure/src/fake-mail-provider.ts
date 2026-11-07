import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from '@ecoma-io/transactional-mailer-job-application';

/**
 * `providerMessageId` tổng hợp, **cố định** cho mọi lần gọi `accepted`.
 *
 * Không bao giờ suy ra từ `deliveryId` hay `recipient`: một id "trông như thật"
 * được dẫn xuất từ dữ liệu delivery sẽ bị đọc như bằng chứng provider đã gửi,
 * đúng thứ mà §11.1 cấm adapter bịa ra.
 */
export const FAKE_PROVIDER_MESSAGE_ID = 'fake-provider-message-id' as const;

/**
 * `retryAfterMs` tổng hợp, cố định, cho token `fake:retryable-after`.
 *
 * 30 giây là số giây nguyên dương, dưới trần 24 giờ của `delaySeconds`
 * (`01-architecture.md` §11.1) — đủ để test phân biệt nhánh có `Retry-After`
 * với nhánh `retryable` không có.
 */
export const FAKE_RETRY_AFTER_MS = 30_000 as const;

export type FakeMailProviderOptions = {
  /**
   * Hàm trả epoch ms hiện tại.
   *
   * Inject được để test hoàn toàn xác định; **không** đặt trên
   * `MailProviderSendRequest` vì request không mang trạng thái của worker
   * (`01-architecture.md` §11.1). Mặc định `Date.now`.
   */
  readonly now?: () => number;
};

type FakeScenario = {
  /** Token test khớp theo substring, phân biệt hoa-thường. */
  readonly needle: string;
  readonly outcome: MailProviderSendResult;
};

/**
 * Bảng scenario **có thứ tự**: token xếp trước thắng khi request khớp nhiều token.
 *
 * Thứ tự này là một phần của contract của fake, không phải chi tiết cài đặt:
 * - `fake:retryable-after` phải đứng trước `fake:retryable` vì token sau là
 *   substring của token trước.
 * - Ba token `rejected` xếp theo mức độ nghiêm trọng của class canonical
 *   (`credential` → `blocked`, `permanent` → `failed`, `retryable` → retry:
 *   `01-architecture.md` §9.4), token `accepted` mang tín hiệu (`warningCode`)
 *   đứng trước token `accepted` không mang tín hiệu.
 */
const FAKE_SCENARIOS: readonly FakeScenario[] = [
  {
    needle: 'fake:credential',
    outcome: {
      kind: 'rejected',
      errorClass: 'credential',
      retryAfterMs: null,
      errorCode: 'http-401',
    },
  },
  {
    needle: 'fake:permanent',
    outcome: {
      kind: 'rejected',
      errorClass: 'permanent',
      retryAfterMs: null,
      errorCode: 'http-400',
    },
  },
  {
    needle: 'fake:retryable-after',
    outcome: {
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: FAKE_RETRY_AFTER_MS,
      errorCode: 'http-429',
    },
  },
  {
    needle: 'fake:retryable',
    outcome: {
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: null,
      errorCode: 'network',
    },
  },
  {
    needle: 'fake:malformed-response',
    outcome: {
      kind: 'accepted',
      providerMessageId: null,
      warningCode: 'malformed-response',
    },
  },
  {
    needle: 'fake:no-message-id',
    outcome: {
      kind: 'accepted',
      providerMessageId: null,
      warningCode: null,
    },
  },
];

/** Outcome mặc định: request sạch, provider chấp nhận và trả message id. */
const ACCEPTED_WITH_MESSAGE_ID: MailProviderSendResult = {
  kind: 'accepted',
  providerMessageId: FAKE_PROVIDER_MESSAGE_ID,
  warningCode: null,
};

/**
 * Khớp token theo substring, phân biệt hoa-thường.
 *
 * Guard `typeof` không thừa: `recipient`/`subject` được type là `string`, nhưng
 * request là dữ liệu đi qua ranh giới (đọc từ store rồi từ Queue), nên ở runtime
 * vẫn có thể là `undefined`/`null`. Gọi thẳng `field.includes(...)` với giá trị
 * như vậy sẽ ném `TypeError` — tức adapter biến một input sai shape thành lỗi
 * hạ tầng thay vì một outcome xác định. Trả `false` giữ đúng tính chất
 * "resolve-only" của fake.
 *
 * Hệ quả phải nói rõ, vì `false` **không** phải một kết quả fail-closed: một
 * field không phải string thì không khớp được token nào, nên request rơi xuống
 * outcome canonical `accepted` — nhánh dễ dãi nhất trong bốn nhánh. Adapter này
 * **không** kiểm shape của request (xem {@link FakeMailProvider}); nó chỉ fail
 * closed cho deadline — `deadlineMs` và giá trị đồng hồ đều phải hữu hạn —
 * điều kiện duy nhất mà §11.1 yêu cầu đánh giá theo thời gian thực. Ca
 * `resolves a deterministic outcome when a token field is not a string` ghim
 * đúng hành vi này.
 */
function matchesToken(field: unknown, needle: string): boolean {
  if (typeof field !== 'string') {
    return false;
  }

  return field.includes(needle);
}

function scenarioFor(request: MailProviderSendRequest): FakeScenario | null {
  for (const scenario of FAKE_SCENARIOS) {
    if (
      matchesToken(request.recipient, scenario.needle) ||
      matchesToken(request.subject, scenario.needle)
    ) {
      return scenario;
    }
  }

  return null;
}

/**
 * Kiểm tra deadline trước mọi scenario needle, fail closed.
 *
 * `deadlineMs` là trần cứng **tuyệt đối** (epoch ms) cho cả lần gọi: quá hạn
 * thì adapter không tiêu network và không sinh side effect nào
 * (`01-architecture.md` §11.1).
 *
 * Cả **hai** phía của phép so sánh đều phải hữu hạn mới kết luận được. Nếu chỉ
 * kiểm `deadlineMs`, một `nowMs` không hữu hạn (clock inject trả `NaN`) làm
 * `deadlineMs <= nowMs` luôn `false`, và request đã quá hạn rơi xuống outcome
 * canonical `accepted` — trần cứng bị vô hiệu hoá im lặng. Vì vậy `nowMs` được
 * kiểm cùng một nhánh với `deadlineMs`.
 */
function checkDeadline(
  request: MailProviderSendRequest,
  nowMs: number,
): MailProviderSendResult | null {
  // Non-finite là request hỏng (hoặc clock của adapter hỏng), không phải lỗi
  // provider: `retryable` sẽ quay vòng retry một bug của caller vô hạn, nên fail
  // closed bằng `permanent`.
  if (!Number.isFinite(request.deadlineMs) || !Number.isFinite(nowMs)) {
    return {
      kind: 'rejected',
      errorClass: 'permanent',
      retryAfterMs: null,
      errorCode: 'invalid-deadline',
    };
  }

  if (request.deadlineMs <= nowMs) {
    return {
      kind: 'rejected',
      errorClass: 'retryable',
      retryAfterMs: null,
      errorCode: 'timeout',
    };
  }

  return null;
}

/**
 * Adapter giả cho `MailProviderPort`, dùng được trước khi provider thật được chốt
 * (`01-architecture.md` §11.2).
 *
 * Bất biến:
 * - **Không** network, SDK, credential, endpoint, file, `console`, hay retry
 *   bên trong một lần gọi; không sleep, không timer.
 * - Outcome chọn theo token trong `recipient`/`subject`; **không** đọc `body`.
 * - `providerMessageId` luôn là hằng {@link FAKE_PROVIDER_MESSAGE_ID}.
 * - `errorCode`/`warningCode` chỉ lấy từ bảng cố định, không bao giờ chứa dữ
 *   liệu của request.
 * - Resolve, không throw: mọi outcome nghiệp vụ đi qua `MailProviderSendResult`.
 *
 * Request được coi là đã đúng kiểu theo contract port; adapter chỉ kiểm tra
 * fail-closed cho deadline — `deadlineMs` và giá trị đồng hồ đều phải hữu hạn —
 * điều kiện duy nhất mà §11.1 yêu cầu đánh giá theo thời gian thực.
 *
 * Đây **không** phải bằng chứng gửi mail thật: không kết quả nào của adapter này
 * nói thư đã tới inbox, và nó không chứng minh exactly-once (§9.1, §9.3).
 */
export class FakeMailProvider implements MailProviderPort {
  readonly #now: () => number;

  constructor(options: FakeMailProviderOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async send(request: MailProviderSendRequest): Promise<MailProviderSendResult> {
    const deadlineFailure = checkDeadline(request, this.#now());
    if (deadlineFailure !== null) {
      return deadlineFailure;
    }

    const scenario = scenarioFor(request);

    return scenario === null ? { ...ACCEPTED_WITH_MESSAGE_ID } : { ...scenario.outcome };
  }
}
