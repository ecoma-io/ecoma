// Fixture dùng chung cho các spec của application lib.
//
// ⚠️ **Vì sao file này không phải một `.spec.ts`.** Nó không chứa test nào; nó là bộ dữ liệu
// và bộ giả lập port mà nhiều spec dùng. Đặt nó trong `src/` cạnh mã nguồn (thay vì `tests/`
// của project khác) là vì `tsconfig.lib.json` của repo loại `*.spec.ts`/`*.test.ts` khỏi
// build còn mọi `.ts` khác thì không — và một fixture chỉ dùng bởi test không được lọt vào
// `dist/`. Tên file có hậu tố `.fixture.ts` để không ai đọc nhầm nó là một spec.
//
// ⚠️ **Mọi fake ở đây là bản ghi lệnh, không phải bản trả về giá trị cố định.** Một fake
// trả về hằng số làm một test xanh giả: assert trên giá trị trả về đó không đo được liệu
// pipeline có **gọi** port với đúng tham số hay không. Vì vậy fake gom mọi lệnh vào một mảng
// (`RuntimeCalls`/`JobCalls`) và spec assert trên mảng đó.

import {
  deliveryClaim,
  deliveryCommandV1,
  type ClaimRejectionReason,
  type DeliveryClaim,
  type DeliveryCommandV1,
  type TerminalDeliveryStatus,
} from '@ecoma-io/push-notification-contracts';

import type {
  ClaimPortResult,
  DeliveryRuntimePort,
  FencedWritePortResult,
} from './runtime-control-plane-port';
import type { AttemptOutcome, AttemptPhase, JobRecord, JobStatePort } from './job-state-port';
import type {
  DeliveryLogFields,
  DeliveryLogLevel,
  DeliveryMetricName,
  MetricDimensions,
} from './observability-port';
import type { WebPushSendRequest, WebPushSendResult, WebPushSender } from './web-push-sender';

/** Mốc thời gian tuyệt đối — mọi biên được tính trên giá trị tường minh, không dùng đồng hồ. */
export const T0 = Date.parse('2026-03-01T11:00:00.000Z');

/** `expires_at` còn 30 phút ở T0 — TTL dương, nên pipeline gửi thật. */
export const EXPIRES_IN_30_MIN = '2026-03-01T11:30:00.000Z';

/** `expires_at` đã qua ở T0 — đường "hết hạn", không gọi provider. */
export const EXPIRES_IN_PAST = '2026-03-01T10:59:59.000Z';

export const ENDPOINT = 'https://push.example/subscription-endpoint';
export const P256DH = 'p256dh-public-key-value';
export const AUTH_SECRET = 'auth-secret-value';
export const VAPID_PRIVATE_KEY = 'vapid-private-key-value';
export const VAPID_PUBLIC_KEY = 'vapid-public-key-value';
export const VAPID_SUBJECT = 'mailto:ops@ecoma.io';
export const PROVIDER_ID = 'prov-webpush-eu';
export const SUBSCRIPTION_ID = 'sub_fixture_1';
export const APP = 'ecoma-web';
export const DISPATCH_GENERATION = 7;

/** Envelope hợp lệ — dựng qua builder canonical để không tự chế ra một envelope sai. */
export function envelopeFor(
  deliveryId: string,
  overrides: {
    readonly providerId?: string;
    readonly subscriptionId?: string;
    readonly transport?: 'web' | 'app';
    readonly payload?: {
      readonly title: string;
      readonly body: string;
      readonly url?: string;
      readonly data?: Readonly<Record<string, unknown>>;
    };
  } = {},
): DeliveryCommandV1 {
  return deliveryCommandV1({
    delivery_id: deliveryId,
    notification_id: `ntf_${deliveryId}`,
    subscription_id: overrides.subscriptionId ?? SUBSCRIPTION_ID,
    provider_id: overrides.providerId ?? PROVIDER_ID,
    transport: overrides.transport ?? 'web',
    payload: overrides.payload ?? {
      title: 'Tiêu đề',
      body: 'Nội dung',
      url: 'https://ecoma.io/inbox',
    },
  });
}

/**
 * Runtime material hợp lệ — đúng tập field của `validateDeliveryClaim`.
 *
 * ⚠️ Dựng qua builder canonical `deliveryClaim` (giống `envelopeFor` dựng qua
 * `deliveryCommandV1`): fixture tự chế shape thì validator của control plane có thể từ chối
 * chính fixture của test, và một spec đỏ vì lý do đó là xanh giả theo hướng ngược lại.
 */
export function claimFor(
  deliveryId: string,
  overrides: Partial<DeliveryClaim> = {},
): DeliveryClaim {
  return deliveryClaim({
    delivery_id: deliveryId,
    notification_id: `ntf_${deliveryId}`,
    app: APP,
    status: 'processing' as const,
    expires_at: EXPIRES_IN_30_MIN,
    dispatch_generation: DISPATCH_GENERATION,
    lease_expires_at: '2026-03-01T11:05:00.000Z',
    transport: 'web' as const,
    provider_id: PROVIDER_ID,
    subscription_id: SUBSCRIPTION_ID,
    subscription: {
      endpoint: ENDPOINT,
      p256dh: P256DH,
      auth: AUTH_SECRET,
      vapid_key_id: 'vapid-key-2026-01',
    },
    provider: {
      type: 'web-push' as const,
      configuration: { vapidSubject: VAPID_SUBJECT },
      credential: { privateKey: VAPID_PRIVATE_KEY, publicKey: VAPID_PUBLIC_KEY },
    },
    ...overrides,
  });
}

/* -------------------------------------------------------------------------------------- */
/* Runtime port                                                                               */
/* -------------------------------------------------------------------------------------- */

/** Mọi lệnh gọi lên `DeliveryRuntimePort`, theo thứ tự. */
export type RuntimeCalls = {
  claims: string[];
  releases: { deliveryId: string; dispatchGeneration: number }[];
  outcomes: { deliveryId: string; dispatchGeneration: number; outcome: 'delivered' | 'failed' }[];
  invalidations: string[];
};

/** Kết quả claim cho một delivery cụ thể; `throw` được dùng để mô phỏng lỗi tầng client. */
export type ClaimPlan =
  | { readonly kind: 'won' }
  | {
      readonly kind: 'lost';
      // reason/state dùng đúng union contract thay vì `string` — fake trả đúng shape mà port hứa.
      readonly rejection: {
        readonly reason: ClaimRejectionReason;
        readonly state?: TerminalDeliveryStatus;
      };
    }
  | { readonly kind: 'throw'; readonly error: unknown };

export interface FakeRuntimeOptions {
  /** Mặc định mọi delivery đều thắng claim. */
  readonly plan?: ClaimPlan | ((deliveryId: string) => ClaimPlan);
  /** Ghi đè field của claim thắng (ví dụ `provider.type` cho guard layer-2). */
  readonly claimOverrides?: Partial<DeliveryClaim>;
  readonly release?: (
    deliveryId: string,
    generation: number,
  ) => FencedWritePortResult | Promise<FencedWritePortResult>;
  readonly writeOutcome?: (
    deliveryId: string,
    generation: number,
    outcome: 'delivered' | 'failed',
  ) => FencedWritePortResult | Promise<FencedWritePortResult>;
  readonly invalidate?: (
    subscriptionId: string,
  ) => 'disabled' | 'no_op' | 'auth_rejected' | Promise<'disabled' | 'no_op' | 'auth_rejected'>;
  readonly claimThrowsFor?: (deliveryId: string) => unknown | undefined;
}

/**
 * `DeliveryRuntimePort` giả — gom lệnh, không tự quyết định gì.
 *
 * ⚠️ `claim` **không** tự dựng claim hợp lệ từ `deliveryId`: spec truyền vào một claim để
 * mình kiểm soát `expires_at`, `provider.type` và các field identity — vì ba thứ đó là ba
 * nhánh khác nhau của pipeline và cần điều khiển riêng.
 */
export class FakeRuntime implements DeliveryRuntimePort {
  readonly calls: RuntimeCalls = { claims: [], releases: [], outcomes: [], invalidations: [] };
  readonly #options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#options = options;
  }

  async claim(deliveryId: string): Promise<ClaimPortResult> {
    this.calls.claims.push(deliveryId);
    const thrown = this.#options.claimThrowsFor?.(deliveryId);
    if (thrown !== undefined) {
      throw thrown;
    }
    const plan =
      typeof this.#options.plan === 'function'
        ? this.#options.plan(deliveryId)
        : (this.#options.plan ?? { kind: 'won' });
    if (plan.kind === 'throw') {
      throw plan.error;
    }
    if (plan.kind === 'lost') {
      return {
        kind: 'lost',
        rejection: {
          reason: plan.rejection.reason,
          ...(plan.rejection.state === undefined ? {} : { state: plan.rejection.state }),
        },
      };
    }
    return { kind: 'won', claim: claimFor(deliveryId, this.#options.claimOverrides) };
  }

  async release(deliveryId: string, dispatchGeneration: number): Promise<FencedWritePortResult> {
    this.calls.releases.push({ deliveryId, dispatchGeneration });
    return (await this.#options.release?.(deliveryId, dispatchGeneration)) ?? { kind: 'applied' };
  }

  async writeOutcome(
    deliveryId: string,
    dispatchGeneration: number,
    outcome: 'delivered' | 'failed',
  ): Promise<FencedWritePortResult> {
    this.calls.outcomes.push({ deliveryId, dispatchGeneration, outcome });
    return (
      (await this.#options.writeOutcome?.(deliveryId, dispatchGeneration, outcome)) ?? {
        kind: 'applied',
      }
    );
  }

  async invalidateSubscription(
    subscriptionId: string,
  ): Promise<'disabled' | 'no_op' | 'auth_rejected'> {
    this.calls.invalidations.push(subscriptionId);
    return (await this.#options.invalidate?.(subscriptionId)) ?? 'disabled';
  }
}

/* -------------------------------------------------------------------------------------- */
/* Job state port                                                                             */
/* -------------------------------------------------------------------------------------- */

/** Mọi lệnh gọi lên `JobStatePort`, theo thứ tự. */
export type JobCalls = {
  begun: { deliveryId: string; attempt: number }[];
  completed: {
    deliveryId: string;
    attempt: number;
    outcome: AttemptOutcome;
    phase: AttemptPhase;
    httpStatus: number | null;
    retryAfterMs: number | null;
  }[];
  marked: { deliveryId: string; terminalOutcome: 'delivered' | 'failed' | 'expired' }[];
};

export interface FakeJobStateOptions {
  /** Job record trả về cho `findByDeliveryId`; `null` = chưa từng consume. */
  readonly existing?: JobRecord | null;
  readonly beginAttempt?: (deliveryId: string, attempt: number) => boolean | Promise<boolean>;
  readonly completeAttemptThrows?: boolean;
  readonly markProcessedThrows?: boolean;
}

/** `JobStatePort` giả — gom lệnh, không có persistence. */
export class FakeJobState implements JobStatePort {
  readonly calls: JobCalls = { begun: [], completed: [], marked: [] };
  readonly #options: FakeJobStateOptions;

  constructor(options: FakeJobStateOptions = {}) {
    this.#options = options;
  }

  async beginAttempt(input: {
    readonly envelope: { readonly delivery_id: string };
    readonly attempt: number;
    readonly nowMs: number;
  }): Promise<boolean> {
    const deliveryId = input.envelope.delivery_id;
    this.calls.begun.push({ deliveryId, attempt: input.attempt });
    return (await this.#options.beginAttempt?.(deliveryId, input.attempt)) ?? true;
  }

  async completeAttempt(input: {
    readonly deliveryId: string;
    readonly attempt: number;
    readonly outcome: AttemptOutcome;
    readonly phase: AttemptPhase;
    readonly httpStatus: number | null;
    readonly retryAfterMs: number | null;
    readonly nowMs: number;
  }): Promise<void> {
    if (this.#options.completeAttemptThrows) {
      throw new Error('D1 write failed while closing the attempt');
    }
    this.calls.completed.push({
      deliveryId: input.deliveryId,
      attempt: input.attempt,
      outcome: input.outcome,
      phase: input.phase,
      httpStatus: input.httpStatus,
      retryAfterMs: input.retryAfterMs,
    });
  }

  async markProcessed(input: {
    readonly deliveryId: string;
    readonly terminalOutcome: 'delivered' | 'failed' | 'expired';
    readonly nowMs: number;
  }): Promise<void> {
    if (this.#options.markProcessedThrows) {
      throw new Error('D1 write failed while setting the processed marker');
    }
    this.calls.marked.push({
      deliveryId: input.deliveryId,
      terminalOutcome: input.terminalOutcome,
    });
  }

  async findByDeliveryId(): Promise<JobRecord | null> {
    return this.#options.existing ?? null;
  }

  async listStuck(): Promise<readonly JobRecord[]> {
    return [];
  }
}

/* -------------------------------------------------------------------------------------- */
/* Sender port                                                                                */
/* -------------------------------------------------------------------------------------- */

/** Mọi tham số `send`, theo thứ tự. */
export type SendCalls = WebPushSendRequest[];

export interface FakeSenderOptions {
  readonly result?: WebPushSendResult | ((request: WebPushSendRequest) => WebPushSendResult);
  /** Cho phép `undefined`/`null` **cố ý** để spec dựng một kết quả ngoài union xem adapter xử lý sao. */
  readonly offUnionResult?: unknown;
  readonly throws?: unknown;
}

/** `WebPushSender` giả — gom tham số để spec assert trên **đường dây thật**. */
export class FakeSender implements WebPushSender {
  readonly calls: SendCalls = [];
  readonly #options: FakeSenderOptions;

  constructor(options: FakeSenderOptions = {}) {
    this.#options = options;
  }

  async send(request: WebPushSendRequest): Promise<WebPushSendResult> {
    this.calls.push(request);
    if (this.#options.throws !== undefined) {
      throw this.#options.throws;
    }
    // Kết quả **ngoài** union, đặt bằng key riêng để không phải ép kiểu ở call site: `result`
    // được khai đúng union của `WebPushSendResult`, nên một `as unknown as WebPushSendResult`
    // trong spec là một ép kiểu nằm sai chỗ — nó biến lỗi ở call site thành im lặng.
    //
    // ⚠️ `Object.hasOwn` chứ **không** phải `!== undefined`: một trong các ca là chính
    // `undefined` — đó là ca mà ta muốn dựng để hỏi "adapter xử lý `undefined` thế nào", và
    // một so sánh `undefined` sẽ nuốt đúng ca đó rồi trả `delivered`. Đây là lý do test này
    // đỏ ngay sau khi refactor: nó chứng minh cái bẫy có thật.
    if (Object.hasOwn(this.#options, 'offUnionResult')) {
      return this.#options.offUnionResult as WebPushSendResult;
    }
    // ⚠️ `Object.hasOwn` chứ không phải `??`: một spec cố tình trả kết quả **ngoài** union (xem
    // `offUnionResult`) sẽ bị `??` nuốt thành `delivered` và test thành xanh giả — đúng loại
    // assertion không đo được đường nào.
    if (!Object.hasOwn(this.#options, 'result')) {
      return { outcome: 'delivered' };
    }
    // Narrow the declared union **không** mất nhánh function: `as WebPushSendResult` sẽ làm
    // `typeof result === 'function'` thành nhánh unreachable mà TypeScript cũng báo lỗi.
    const result = this.#options.result as NonNullable<FakeSenderOptions['result']>;
    return typeof result === 'function' ? result(request) : result;
  }
}

/* -------------------------------------------------------------------------------------- */
/* Observability                                                                               */
/* -------------------------------------------------------------------------------------- */

export type MetricEntry = {
  readonly name: DeliveryMetricName;
  readonly dimensions?: MetricDimensions;
};
export type LogEntry = {
  readonly level: DeliveryLogLevel;
  readonly message: string;
  readonly fields?: DeliveryLogFields;
};

/** Ghi lại metric/log để spec assert trên việc **đo** thay vì trên việc trả về. */
export class FakeObservability {
  readonly metrics: MetricEntry[] = [];
  readonly observations: {
    name: DeliveryMetricName;
    value: number;
    dimensions?: MetricDimensions;
  }[] = [];
  readonly logs: LogEntry[] = [];

  readonly port = {
    increment: (name: DeliveryMetricName, dimensions?: MetricDimensions): void => {
      this.metrics.push(dimensions === undefined ? { name } : { name, dimensions });
    },
    observe: (name: DeliveryMetricName, value: number, dimensions?: MetricDimensions): void => {
      this.observations.push(
        dimensions === undefined ? { name, value } : { name, value, dimensions },
      );
    },
    log: (level: DeliveryLogLevel, message: string, fields?: DeliveryLogFields): void => {
      this.logs.push(fields === undefined ? { level, message } : { level, message, fields });
    },
  };

  /** Tổng số lần tăng của một metric — dùng khi chỉ cần biết "có hay không". */
  countOf(name: DeliveryMetricName): number {
    return this.metrics.filter((entry) => entry.name === name).length;
  }

  logNamed(message: string): LogEntry[] {
    return this.logs.filter((entry) => entry.message === message);
  }

  /** Mọi giá trị `fields` đã ghi, gộp lại — để assert "không secret nào lọt vào log". */
  allLoggedFieldValues(): string[] {
    const values: string[] = [];
    for (const entry of this.logs) {
      for (const value of Object.values(entry.fields ?? {})) {
        if (Array.isArray(value)) {
          values.push(...value.map((item) => String(item)));
        } else {
          values.push(String(value));
        }
      }
    }
    return values;
  }
}

/**
 * Dựng một `JobRecord` tối thiểu cho các test chỉ cần `processed`/`envelope`.
 *
 * ⚠️ **Override `deliveryId` kéo theo `envelope.delivery_id`.** Trên D1, `push_jobs` được
 * key bởi chính `delivery_id` trong envelope, nên một record mà id ở ngoài khác id trong
 * envelope là một trạng thái **không tồn tại được**. Fixture cho phép tạo ra nó thì các test
 * khẳng định "cùng `delivery_id` sẽ trượt" — và sẽ đỏ vì lý do không liên quan tới production.
 * Giữ hai id đồng bộ ở đây, và để `job-reconciliation.spec.ts` kiểm tra tính nhất quán đó
 * như một bất biến riêng.
 */
export function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const deliveryId = overrides.deliveryId ?? 'del_fixture';
  // `envelope` được tính **trước** spread và không nằm trong object literal: nếu viết
  // `envelope: <default>` rồi `...overrides` sau đó, TypeScript đúng đáng báo `TS2783`
  // ("specified more than once") — và dù bỏ qua cảnh báo thì default đó là code chết.
  const envelope =
    overrides.envelope === undefined
      ? jobRecordEnvelopeFor(deliveryId)
      : { ...overrides.envelope, delivery_id: overrides.envelope.delivery_id ?? deliveryId };
  return {
    deliveryId,
    consumeCount: 1,
    openAttempt: null,
    lastAttempt: null,
    processed: false,
    terminalOutcome: null,
    lastConsumedAt: T0,
    updatedAt: T0,
    ...overrides,
    // ⚠️ `envelope` **chỉ** xuất hiện ở đây, không có bản trước `...overrides`: viết hai lần
    // trong một object literal là `TS1117`, và bản trước cũng là code chết vì bản sau thắng.
    // Đặt sau spread nghĩa là một override tường minh thắng, còn khi caller chỉ đổi
    // `deliveryId` thì envelope đi theo `deliveryId` đó.
    envelope,
  };
}

/** Envelope chuẩn của fixture, gắn với `deliveryId`. */
function jobRecordEnvelopeFor(deliveryId: string): JobRecord['envelope'] {
  return {
    version: 1,
    delivery_id: deliveryId,
    notification_id: `ntf_${deliveryId}`,
    subscription_id: SUBSCRIPTION_ID,
    provider_id: PROVIDER_ID,
    transport: 'web',
    payload: { title: 'Tiêu đề', body: 'Nội dung' },
  };
}
