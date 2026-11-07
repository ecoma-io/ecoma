// Pipeline xử lý **một** message — nơi duy nhất một message đi từ byte trên Queue tới
// `ack()`/`retry()`.
//
// ⚠️ Suite này khẳng định **hành động** trên ba mặt phẳng độc lập: disposition (quyền ACK/retry
// thật), lệnh gọi lên control plane, và lệnh gọi lên provider. Chỉ assert một mặt phẳng là
// xanh giả: một pipeline ghi outcome rồi quên `ack()` vẫn xanh nếu chỉ assert outcome.

import { describe, expect, it } from 'vitest';

import {
  processDeliveryMessage,
  serializeEnvelopePayload,
  type DeliveryPipelineDeps,
} from './delivery-pipeline';
import {
  AUTH_SECRET,
  FakeJobState,
  FakeObservability,
  FakeRuntime,
  FakeSender,
  P256DH,
  PROVIDER_ID,
  SUBSCRIPTION_ID,
  T0,
  VAPID_PRIVATE_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_SUBJECT,
  jobRecord,
  envelopeFor,
  type JobCalls,
  type RuntimeCalls,
} from './delivery.fixtures';
import {
  RuntimeAuthResolutionError,
  RuntimeContractError,
  RuntimeTransportError,
} from './runtime-control-plane-port';
import type { ClaimRejectionReason } from '@ecoma-io/push-notification-contracts';
import { WEB_PUSH_REQUEST_TIMEOUT_MS } from './timing';
import type { DeliveryMetricName } from './observability-port';
import type { MessageDisposition } from './ports';

/* -------------------------------------------------------------------------------------- */
/* Harness                                                                                    */
/* -------------------------------------------------------------------------------------- */

type Trace = { readonly kind: 'ack' } | { readonly kind: 'retry'; readonly delaySeconds?: number };

interface Scenario {
  readonly runtime: FakeRuntime;
  readonly jobs: FakeJobState;
  readonly sender: FakeSender;
  readonly observability: FakeObservability;
  readonly trace: Trace[];
  /** Nhật ký **thứ tự** của release/invalidate/outcome/ack/retry — thứ mà `trace` không đo. */
  readonly order: string[];
  readonly deps: DeliveryPipelineDeps;
  // ⚠️ `ReturnType<…>` **không** được bọc trong `Promise<>`: `processDeliveryMessage` đã trả
  // `Promise<MessageProcessingOutcome>`, nên `Promise<Promise<…>>` là một loại không tồn tại —
  // và TypeScript bắt được điều đó khiến `await s.run(…)` không được suy ra kiểu.
  readonly run: (body: unknown, attempts?: number) => ReturnType<typeof processDeliveryMessage>;
}

function scenario(
  options: {
    runtime?: FakeRuntime;
    jobs?: FakeJobState;
    sender?: FakeSender;
    nowMs?: number;
  } = {},
): Scenario {
  const runtime = options.runtime ?? new FakeRuntime();
  const jobs = options.jobs ?? new FakeJobState();
  const sender = options.sender ?? new FakeSender();
  const observability = new FakeObservability();
  const trace: Trace[] = [];
  const order: string[] = [];

  // ⚠️ Bọc từng method ghi để **thứ tự** trở nên quan sát được. `trace` chỉ ghi disposition, nên
  // một pipeline gọi `retry()` rồi mới `release()`, hoặc đặt processed marker trước khi ghi
  // outcome, vẫn xanh với `trace`; chỉ một nhật ký chung mới bắt được các lỗi thứ tự đó — và
  // chúng là lỗi im lặng đắt nhất ở đây, vì chúng chỉ biểu hiện dưới tải thật thành "retry
  // không bao giờ thử lại provider" (§12/FR-008) hoặc "redelivery bị bỏ qua vĩnh viễn".
  const baseRelease = runtime.release.bind(runtime);
  runtime.release = async (deliveryId: string, generation: number) => {
    order.push('release');
    return baseRelease(deliveryId, generation);
  };
  const baseOutcome = runtime.writeOutcome.bind(runtime);
  runtime.writeOutcome = async (
    deliveryId: string,
    generation: number,
    outcome: 'delivered' | 'failed',
  ) => {
    order.push(`outcome:${outcome}`);
    return baseOutcome(deliveryId, generation, outcome);
  };
  const baseInvalidate = runtime.invalidateSubscription.bind(runtime);
  runtime.invalidateSubscription = async (subscriptionId: string) => {
    order.push('invalidate');
    return baseInvalidate(subscriptionId);
  };
  const baseMarkProcessed = jobs.markProcessed.bind(jobs);
  jobs.markProcessed = async (input: {
    readonly deliveryId: string;
    readonly terminalOutcome: 'delivered' | 'failed' | 'expired';
    readonly nowMs: number;
  }) => {
    order.push(`mark:${input.terminalOutcome}`);
    return baseMarkProcessed(input);
  };

  const deps: DeliveryPipelineDeps = {
    runtime,
    jobs,
    sender,
    clock: { now: () => options.nowMs ?? T0 },
    metrics: {
      increment: observability.port.increment,
      observe: observability.port.observe,
    },
    logger: observability.port,
  };
  return {
    runtime,
    jobs,
    sender,
    observability,
    trace,
    order,
    deps,
    run: (body, attempts = 1) => {
      const disposition: MessageDisposition = {
        ack: () => {
          trace.push({ kind: 'ack' });
          order.push('ack');
        },
        retry: (retryOptions) => {
          trace.push(
            retryOptions === undefined
              ? { kind: 'retry' }
              : { kind: 'retry', delaySeconds: retryOptions.delaySeconds },
          );
          order.push('retry');
        },
      };
      return processDeliveryMessage(deps, body, { attempts }, disposition);
    },
  };
}

/* -------------------------------------------------------------------------------------- */
/* Happy path                                                                                 */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage happy path', () => {
  // FR-005/§6: sender phải nhận **đúng** endpoint/p256dh/auth từ runtime material và TTL
  // đã bị chặn trên `expires_at`. Assert cả ba mặt phẳng: tham số send, outcome ghi, ACK.
  it('sends with the claimed endpoint and subscription secrets, then records delivered and acks', async () => {
    const s = scenario();

    const outcome = await s.run(envelopeFor('del_happy'));

    expect(outcome).toEqual({ kind: 'delivered' });
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    expect(s.sender.calls).toHaveLength(1);
    expect(s.sender.calls[0]).toEqual({
      endpoint: 'https://push.example/subscription-endpoint',
      p256dh: P256DH,
      auth: AUTH_SECRET,
      vapidPrivateKey: VAPID_PRIVATE_KEY,
      vapidPublicKey: VAPID_PUBLIC_KEY,
      vapidSubject: VAPID_SUBJECT,
      payloadJson: JSON.stringify({
        title: 'Tiêu đề',
        body: 'Nội dung',
        url: 'https://ecoma.io/inbox',
      }),
      ttlSeconds: 1_800,
      timeoutMs: WEB_PUSH_REQUEST_TIMEOUT_MS,
    });
    expect(s.runtime.calls).toMatchObject({
      claims: ['del_happy'],
      outcomes: [{ deliveryId: 'del_happy', dispatchGeneration: 7, outcome: 'delivered' }],
      releases: [],
      invalidations: [],
    });
    expect(s.jobs.calls.marked).toEqual([
      { deliveryId: 'del_happy', terminalOutcome: 'delivered' },
    ]);
    expect(s.observability.countOf('deliveries_delivered')).toBe(1);
  });

  it('caps the TTL at the remaining business window, never at the lease', async () => {
    const runtime = new FakeRuntime({
      plan: {
        kind: 'won',
      },
    });
    // 30 phút còn lại tới `expires_at`; lease chỉ còn 5 phút. TTL phải là 1800 — nó không
    // bao giờ vượt hạn nghiệp vụ, và cũng không lấy từ lease.
    const s = scenario({ runtime });
    await s.run(envelopeFor('del_ttl'));
    expect(s.sender.calls[0]?.ttlSeconds).toBe(1_800);
  });

  it('records the attempt as terminal_sent once the provider has accepted the push', async () => {
    const s = scenario();
    await s.run(envelopeFor('del_phase'));
    expect(s.jobs.calls.completed).toEqual([
      {
        deliveryId: 'del_phase',
        attempt: 1,
        outcome: 'delivered',
        phase: 'terminal_sent',
        httpStatus: 200,
        retryAfterMs: null,
      },
    ]);
  });

  it('opens an attempt keyed by the queue attempt number before claiming', async () => {
    const s = scenario();
    await s.run(envelopeFor('del_attempt'), 4);
    expect(s.jobs.calls.begun).toEqual([{ deliveryId: 'del_attempt', attempt: 4 }]);
    expect(s.jobs.calls.completed[0]?.attempt).toBe(4);
  });

  it('observes the provider latency with the documented dimensions', async () => {
    const s = scenario();
    await s.run(envelopeFor('del_latency'));
    expect(
      s.observability.observations.map(
        (entry: { readonly name: DeliveryMetricName }) => entry.name,
      ),
    ).toEqual(['provider_request_latency_ms']);
    expect(s.observability.observations[0]?.dimensions).toEqual({
      provider_id: PROVIDER_ID,
      transport: 'web',
    });
    expect(s.observability.countOf('provider_request_total')).toBe(1);
  });

  // Thứ tự terminal: ghi outcome **trước** khi đặt processed marker, và marker **trước** ACK.
  // Đặt marker trước outcome biến một lần gửi chưa persist thành một lần bị bỏ qua vĩnh viễn
  // khi redelivery tới (W3 → W4 với state mâu thuẫn).
  it('persists the outcome before the processed marker and acks last', async () => {
    const s = scenario();
    await s.run(envelopeFor('del_order'));

    expect(s.order).toEqual(['outcome:delivered', 'mark:delivered', 'ack']);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Envelope boundary + two-layer guard                                                        */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage envelope boundary', () => {
  // Poison message: không gửi provider, không claim, và **không** ACK mù — Queue đưa vào DLQ
  // sau khi retry exhausted.
  it.each([
    ['a non-object body', 'not an object'],
    ['a missing field', { version: 1, delivery_id: 'del_x' }],
    ['an unknown top-level field', { ...envelopeFor('del_x'), status: 'processing' }],
    ['an unsupported version', { ...envelopeFor('del_x'), version: 2 }],
    [
      'a secret smuggled into the payload',
      { ...envelopeFor('del_x'), payload: { title: 'a', body: 'b', auth: 'leak' } },
    ],
  ])('retries without claiming or sending on %s', async (_name, body) => {
    const s = scenario();
    const outcome = await s.run(body);

    expect(outcome.kind).toBe('poison');
    expect(s.trace).toEqual([{ kind: 'retry' }]);
    expect(s.runtime.calls.claims).toEqual([]);
    expect(s.sender.calls).toEqual([]);
    expect(s.jobs.calls.begun).toEqual([]);
  });

  // Thứ tự guard-envelope **trước** claim là bắt buộc: `transport = app` thuộc worker khác,
  // claim nó sẽ thắng lease một delivery mà worker này không gửi được.
  it('does not claim a delivery whose transport is out of scope for this worker', async () => {
    const s = scenario();
    const outcome = await s.run(envelopeFor('del_app', { transport: 'app' }));

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unsupported_transport' });
    expect(s.runtime.calls.claims).toEqual([]);
    expect(s.sender.calls).toEqual([]);
    // Retry, không ack: ACK sẽ làm message biến mất vĩnh viễn chỉ vì worker không đúng scope.
    expect(s.trace).toEqual([{ kind: 'retry' }]);
  });
});

describe('processDeliveryMessage second-layer guard on claimed material', () => {
  // `validateDeliveryCommand(...).ok === true` KHÔNG đủ: `provider.type` chỉ có ở runtime
  // material. Material ngoài scope phải release rồi retry — giữ lease mà không release làm
  // retry của Queue vô hiệu (FR-008).
  it.each(['fcm', 'apns'])(
    'releases and retries when the claimed provider type is %s',
    async (providerType) => {
      // Ghi đè `provider.type` ngay lúc dựng claim (claimOverrides) thay vì monkey-patch method.
      const runtime = new FakeRuntime({
        plan: {
          kind: 'won',
        },
        claimOverrides: {
          provider: {
            type: providerType as 'web-push',
            configuration: {},
            credential: {},
          },
        },
      });
      const s = scenario({ runtime });

      const outcome = await s.run(envelopeFor('del_fcm'));

      expect(outcome).toMatchObject({ kind: 'retried', releaseAttempted: true });
      expect(s.sender.calls).toEqual([]);
      expect(s.runtime.calls.releases).toEqual([{ deliveryId: 'del_fcm', dispatchGeneration: 7 }]);
      expect(s.runtime.calls.outcomes).toEqual([]);
      expect(s.trace).toEqual([{ kind: 'retry' }]);
    },
  );

  // Gửi payload của delivery A tới endpoint của delivery B là vi phạm SR-002 (recipient sai).
  it.each(['subscription_id', 'provider_id'] as const)(
    'releases and retries when the claimed %s belongs to another delivery',
    async (field) => {
      const runtime = new FakeRuntime();
      const original = runtime.claim.bind(runtime);
      runtime.claim = async (deliveryId: string) => {
        const result = await original(deliveryId);
        if (result.kind !== 'won') {
          return result;
        }
        return {
          kind: 'won',
          claim: { ...result.claim, [field]: `${field}_của_delivery_khác` },
        };
      };
      const s = scenario({ runtime });

      const outcome = await s.run(envelopeFor('del_mismatch'));

      expect(outcome).toMatchObject({ kind: 'retried' });
      expect(s.sender.calls).toEqual([]);
      expect(s.runtime.calls.releases).toEqual([
        { deliveryId: 'del_mismatch', dispatchGeneration: 7 },
      ]);
    },
  );

  it('treats an unparseable expires_at as a contract violation rather than a zero TTL', async () => {
    const runtime = new FakeRuntime();
    const original = runtime.claim.bind(runtime);
    runtime.claim = async (deliveryId: string) => {
      const result = await original(deliveryId);
      if (result.kind !== 'won') {
        return result;
      }
      return { kind: 'won', claim: { ...result.claim, expires_at: 'không-phải-ngày' } };
    };
    const s = scenario({ runtime });

    const outcome = await s.run(envelopeFor('del_baddate'));

    expect(outcome).toMatchObject({ kind: 'retried' });
    expect(s.sender.calls).toEqual([]);
    expect(s.runtime.calls.releases).toHaveLength(1);
    expect(s.jobs.calls.completed[0]?.outcome).toBe('contract_violation');
  });
});

/* -------------------------------------------------------------------------------------- */
/* expires_at                                                                                 */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage expires_at', () => {
  // §16: hết hạn → KHÔNG gọi provider, KHÔNG ghi outcome, KHÔNG invalidate, KHÔNG release
  // (lease tự hết hạn và tự fence). Chỉ ghi attempt rồi ACK.
  it('never calls the provider and never releases for an expired notification', async () => {
    const runtime = new FakeRuntime();
    const original = runtime.claim.bind(runtime);
    runtime.claim = async (deliveryId: string) => {
      const result = await original(deliveryId);
      if (result.kind !== 'won') {
        return result;
      }
      return { kind: 'won', claim: { ...result.claim, expires_at: '2026-03-01T10:59:59.000Z' } };
    };
    const s = scenario({ runtime });

    const outcome = await s.run(envelopeFor('del_expired'));

    expect(outcome).toEqual({ kind: 'expired_before_send' });
    expect(s.sender.calls).toEqual([]);
    expect(s.runtime.calls.outcomes).toEqual([]);
    expect(s.runtime.calls.releases).toEqual([]);
    expect(s.runtime.calls.invalidations).toEqual([]);
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    expect(s.jobs.calls.marked).toEqual([
      { deliveryId: 'del_expired', terminalOutcome: 'expired' },
    ]);
    expect(s.jobs.calls.completed[0]).toMatchObject({
      outcome: 'expired_before_send',
      phase: 'no_provider_call',
      httpStatus: null,
    });
  });

  it('checks expiry once, right before the provider call, so a slow clock advance does not re-send', async () => {
    let calls = 0;
    let nowMs = T0;
    const runtime = new FakeRuntime();
    const sender = new FakeSender();
    const observability = new FakeObservability();
    const trace: Trace[] = [];
    const deps: DeliveryPipelineDeps = {
      runtime,
      jobs: new FakeJobState(),
      sender: {
        send: async (request) => {
          calls += 1;
          // Đồng hồ đi qua ranh giới hạn **trong lúc** provider call đang chạy.
          nowMs = Date.parse('2026-03-01T11:45:00.000Z');
          return sender.send(request);
        },
      },
      clock: { now: () => nowMs },
      metrics: observability.port,
      logger: observability.port,
    };

    await processDeliveryMessage(
      deps,
      envelopeFor('del_onecheck'),
      { attempts: 1 },
      { ack: () => trace.push({ kind: 'ack' }), retry: () => trace.push({ kind: 'retry' }) },
    );

    expect(calls).toBe(1);
    expect(trace).toEqual([{ kind: 'ack' }]);
    // TTL đã bị chặn ở 1800 giây **trước** khi đồng hồ đi qua hạn — một kiểm thứ hai sau
    // call sẽ hoặc là gửi lại (duplicate) hoặc là bác bỏ một message đã gửi thành công.
    expect(sender.calls[0]?.ttlSeconds).toBe(1_800);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Claim 409 matrix                                                                           */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage claim rejection matrix', () => {
  // `pending` là nhóm DUY NHẤT retry mà **không** release: chưa có lease để trả.
  it('retries without releasing for a pending claim', async () => {
    const s = scenario({
      runtime: new FakeRuntime({ plan: { kind: 'lost', rejection: { reason: 'pending' } } }),
    });

    const outcome = await s.run(envelopeFor('del_pending'));

    expect(outcome).toEqual({ kind: 'retried', releaseAttempted: false, releaseSucceeded: false });
    expect(s.trace).toEqual([{ kind: 'retry' }]);
    expect(s.runtime.calls.releases).toEqual([]);
    expect(s.sender.calls).toEqual([]);
    expect(s.observability.countOf('deliveries_retried')).toBe(1);
  });

  // Năm `reason` còn lại là **no-op an toàn**: ACK, không ghi state nào (worker không sở hữu
  // terminal state của control plane).
  it.each([
    ['lease_held', 'claim_lease_held'],
    ['terminal', 'claim_terminal'],
    ['expired', 'claim_expired'],
    ['ineligible_subscription', 'claim_ineligible_subscription'],
    ['ineligible_provider_hold', 'claim_ineligible_provider_hold'],
  ])('acks safely without releasing for a %s claim', async (reason, expectedSkipReason) => {
    const s = scenario({
      runtime: new FakeRuntime({
        plan: { kind: 'lost', rejection: { reason: reason as ClaimRejectionReason } },
      }),
    });

    const outcome = await s.run(envelopeFor('del_reject'));

    expect(outcome).toEqual({ kind: 'skipped', reason: expectedSkipReason });
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    expect(s.runtime.calls.releases).toEqual([]);
    expect(s.runtime.calls.outcomes).toEqual([]);
    expect(s.sender.calls).toEqual([]);
    expect(s.observability.countOf('deliveries_skipped')).toBe(1);
  });

  it('logs the terminal state the control plane reported, without writing it locally', async () => {
    const s = scenario({
      runtime: new FakeRuntime({
        plan: { kind: 'lost', rejection: { reason: 'terminal', state: 'delivered' } },
      }),
    });

    await s.run(envelopeFor('del_terminal'));

    const entry = s.observability.logNamed('delivery.claim_rejected')[0];
    expect(entry?.fields).toMatchObject({ reason: 'terminal', state: 'delivered' });
    expect(s.jobs.calls.marked).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Error matrix                                                                               */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage error matrix', () => {
  // FR-009: `endpoint_invalid` là class DUY NHẤT invalidate; nó **fire trước** outcome và
  // kết quả invalidate không chặn outcome.
  it('invalidates the subscription and then records failed for endpoint_invalid', async () => {
    const sender = new FakeSender({
      result: { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: 404 },
    });
    const s = scenario({ sender });

    const outcome = await s.run(envelopeFor('del_404'));

    expect(outcome).toEqual({ kind: 'failed', failureClass: 'endpoint_invalid' });
    expect(s.runtime.calls.invalidations).toEqual([SUBSCRIPTION_ID]);
    expect(s.runtime.calls.outcomes).toEqual([
      { deliveryId: 'del_404', dispatchGeneration: 7, outcome: 'failed' },
    ]);
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    expect(s.jobs.calls.marked).toEqual([{ deliveryId: 'del_404', terminalOutcome: 'failed' }]);
    expect(s.observability.countOf('subscriptions_invalidated')).toBe(1);
    expect(s.observability.countOf('deliveries_failed')).toBe(1);
  });

  // ⚠️ Invalidate **trước** outcome: `404` là bằng chứng endpoint đã chết, và bằng chứng đó
  // không được phụ thuộc vào một lệnh ghi khác có thể thất bại. Đảo thứ tự thì khi `outcome`
  // lỗi, subscription chết không bao giờ bị disable trong khi delivery vẫn thành terminal —
  // vi phạm FR-009 ở cả hai vế.
  it('invalidates before recording the terminal outcome', async () => {
    const sender = new FakeSender({
      result: { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: 404 },
    });
    const s = scenario({ sender });

    await s.run(envelopeFor('del_order_invalidate'));

    expect(s.order).toEqual(['invalidate', 'outcome:failed', 'mark:failed', 'ack']);
  });

  // Invalidate là **fire**, không chặn: một lỗi mạng khi gọi invalidate không được làm mất cả
  // bằng chứng endpoint chết lẫn kết cục terminal.
  it.each([
    ['a transport failure', () => Promise.reject(new RuntimeTransportError('không gọi được'))],
    ['an auth rejection', async () => 'auth_rejected' as const],
    ['a missing subscription', async () => 'no_op' as const],
  ])('still records the terminal outcome when invalidate hits %s', async (_name, invalidate) => {
    const sender = new FakeSender({
      result: { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: 404 },
    });
    const runtime = new FakeRuntime({ invalidate: () => invalidate() });
    const s = scenario({ runtime, sender });

    const outcome = await s.run(envelopeFor('del_404_fire'));

    expect(outcome).toEqual({ kind: 'failed', failureClass: 'endpoint_invalid' });
    expect(s.runtime.calls.invalidations).toEqual([SUBSCRIPTION_ID]);
    expect(s.runtime.calls.outcomes).toHaveLength(1);
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    // `no_op`/`auth_rejected` là kết quả hợp lệ, nên chỉ `disabled` mới tăng metric.
    expect(s.observability.countOf('subscriptions_invalidated')).toBe(0);
  });

  // Ba class permanent còn lại: KHÔNG invalidate, không retry, ack.
  it.each([
    'provider_auth',
    'payload_too_large',
    'redirect_not_followed',
    'vapid_key_missing',
  ] as const)('records failed without invalidating for %s', async (failureClass) => {
    const sender = new FakeSender({
      result: { outcome: 'failed', failureClass, httpStatus: 410 },
    });
    const s = scenario({ sender });

    const outcome = await s.run(envelopeFor('del_permanent'));

    expect(outcome).toEqual({ kind: 'failed', failureClass });
    expect(s.runtime.calls.invalidations).toEqual([]);
    expect(s.runtime.calls.releases).toEqual([]);
    expect(s.runtime.calls.outcomes).toEqual([
      { deliveryId: 'del_permanent', dispatchGeneration: 7, outcome: 'failed' },
    ]);
    expect(s.trace).toEqual([{ kind: 'ack' }]);
  });

  // `provider_auth` và `redirect_not_followed` có alert-level trong §12 — log `error`, không
  // phải `info`. Alert dựa trên log sẽ hỏng nếu chúng chung mức với `expired`.
  it.each(['provider_auth', 'redirect_not_followed'] as const)(
    'logs %s at alert level',
    async (failureClass) => {
      const sender = new FakeSender({
        result: { outcome: 'failed', failureClass, httpStatus: 401 },
      });
      const s = scenario({ sender });

      await s.run(envelopeFor('del_alert'));

      expect(s.observability.logNamed('delivery.failed')[0]?.level).toBe('error');
    },
  );

  it('logs payload_too_large at info, because it is a permanent outcome rather than an alert', async () => {
    const sender = new FakeSender({
      result: { outcome: 'failed', failureClass: 'payload_too_large', httpStatus: 413 },
    });
    const s = scenario({ sender });

    await s.run(envelopeFor('del_413'));

    expect(s.observability.logNamed('delivery.failed')[0]?.level).toBe('info');
    // Không retry, không truncate: payload đi nguyên vẹn và terminal.
    expect(s.trace).toEqual([{ kind: 'ack' }]);
  });

  // Transient: **release lease TRƯỚC** rồi `retry()` — không release thì redelivery gặp
  // `409 lease_held` và bị ACK, tức retry của Queue không thực sự retry provider (FR-008).
  it.each(['before_send', 'after_send'] as const)(
    'releases before retrying on a %s transient',
    async (phase) => {
      const sender = new FakeSender({
        result: { outcome: 'transient', phase, retryAfterMs: null, httpStatus: 503 },
      });
      const s = scenario({ sender });

      const outcome = await s.run(envelopeFor('del_transient'));

      expect(outcome).toEqual({ kind: 'retried', releaseAttempted: true, releaseSucceeded: true });
      expect(s.runtime.calls.releases).toEqual([
        { deliveryId: 'del_transient', dispatchGeneration: 7 },
      ]);
      expect(s.runtime.calls.outcomes).toEqual([]);
      expect(s.jobs.calls.marked).toEqual([]);
      expect(s.trace).toEqual([{ kind: 'retry' }]);
      expect(s.jobs.calls.completed[0]).toMatchObject({
        outcome: 'retrying',
        phase: phase === 'after_send' ? 'after_send' : 'before_send',
      });
    },
  );

  // Release fail sau transient: log + **vẫn retry**. Không release và không retry là mất
  // việc; release fail rồi bỏ retry là chờ lease hết hạn mà không có backoff.
  // ⚠️ Assertion **thứ tự**, không chỉ "đã gọi release". `runtime.calls.releases` dài 1 và
  // `trace` là `[{retry}]` đều xanh kể cả khi code gọi `retry()` **trước** rồi mới release —
  // và đúng thứ tự sai đó làm FR-008 hỏng: redelivery gặp `409 lease_held` và bị ACK, nên
  // `retry()` của Queue không bao giờ thử lại provider.
  it('releases the lease strictly before handing the message back to the queue', async () => {
    const sender = new FakeSender({
      result: { outcome: 'transient', phase: 'before_send', retryAfterMs: null, httpStatus: 503 },
    });
    const s = scenario({ sender });

    await s.run(envelopeFor('del_order_release'));

    expect(s.order).toEqual(['release', 'retry']);
  });

  it('releases before retrying even when the transient happened after the request was sent', async () => {
    const sender = new FakeSender({
      result: { outcome: 'transient', phase: 'after_send', retryAfterMs: null, httpStatus: null },
    });
    const s = scenario({ sender });

    await s.run(envelopeFor('del_order_release_after'));

    expect(s.order).toEqual(['release', 'retry']);
  });

  it('still retries when the release itself fails', async () => {
    const sender = new FakeSender({
      result: { outcome: 'transient', phase: 'before_send', retryAfterMs: null, httpStatus: 503 },
    });
    const runtime = new FakeRuntime({
      release: () => Promise.reject(new RuntimeTransportError('control plane unreachable')),
    });
    const s = scenario({ runtime, sender });

    const outcome = await s.run(envelopeFor('del_relfail'));

    expect(outcome).toEqual({ kind: 'retried', releaseAttempted: true, releaseSucceeded: false });
    expect(s.trace).toEqual([{ kind: 'retry' }]);
    expect(s.observability.logNamed('delivery.release_failed')).toHaveLength(1);
  });

  it('forwards Retry-After as an explicit delay so the provider is not polled sooner', async () => {
    const sender = new FakeSender({
      result: { outcome: 'transient', phase: 'before_send', retryAfterMs: 4_500, httpStatus: 429 },
    });
    const s = scenario({ sender });

    await s.run(envelopeFor('del_429'));

    expect(s.trace).toEqual([{ kind: 'retry', delaySeconds: 5 }]);
    expect(s.jobs.calls.completed[0]?.retryAfterMs).toBe(4_500);
  });

  // Adapter throw = lỗi contract của adapter; đường an toàn duy nhất là transient trước khi
  // biết request đã tới provider hay chưa — và vì claim đã thắng nên vẫn phải release.
  it('treats a sender that throws as a before_send transient with a release', async () => {
    const sender = new FakeSender({ throws: new Error('adapter bug') });
    const s = scenario({ sender });

    const outcome = await s.run(envelopeFor('del_throw'));

    expect(outcome).toEqual({ kind: 'retried', releaseAttempted: true, releaseSucceeded: true });
    expect(s.runtime.calls.releases).toHaveLength(1);
    expect(s.trace).toEqual([{ kind: 'retry' }]);
    expect(s.jobs.calls.completed[0]).toMatchObject({ outcome: 'retrying', phase: 'before_send' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an unknown outcome', { outcome: 'quyết định chưa rõ' }],
    ['a failed result without a failure class', { outcome: 'failed', httpStatus: 404 }],
  ])('treats a sender result of %s as transient, never terminal', async (_name, result) => {
    const sender = new FakeSender({ offUnionResult: result });
    const s = scenario({ sender });

    const outcome = await s.run(envelopeFor('del_unknown'));

    expect(outcome).toMatchObject({ kind: 'retried' });
    expect(s.runtime.calls.releases).toHaveLength(1);
    expect(s.runtime.calls.outcomes).toEqual([]);
    expect(s.jobs.calls.marked).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Control-plane failure                                                                      */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage control-plane failures', () => {
  it.each([
    ['a contract violation', new RuntimeContractError('peer lệch vocabulary', 'unknown_reason')],
    ['a missing secret', new RuntimeAuthResolutionError('thieu RUNTIME_API_SHARED_SECRET')],
    ['an unexpected error', new Error('điều không lường trước')],
  ])('retries without provider call on %s, and never acks blindly', async (_name, error) => {
    const runtime = new FakeRuntime({ plan: { kind: 'throw', error } });
    const s = scenario({ runtime });

    const outcome = await s.run(envelopeFor('del_cpfail'));

    expect(outcome).toEqual({ kind: 'retried', releaseAttempted: false, releaseSucceeded: false });
    expect(s.sender.calls).toEqual([]);
    expect(s.trace).toEqual([{ kind: 'retry' }]);
    expect(s.observability.countOf('runtime_resolution_errors')).toBe(1);
    expect(s.observability.countOf('retry_count')).toBe(1);
    expect(s.jobs.calls.completed[0]).toMatchObject({ phase: 'no_provider_call' });
  });

  it('classifies a 5xx-shaped transport failure as runtime_unavailable, not a contract violation', async () => {
    const runtime = new FakeRuntime({
      plan: { kind: 'throw', error: new RuntimeTransportError('control plane 503') },
    });
    const s = scenario({ runtime });

    await s.run(envelopeFor('del_5xx'));

    expect(s.jobs.calls.completed[0]?.outcome).toBe('runtime_unavailable');
    expect(s.observability.logNamed('delivery.runtime_unavailable')).toHaveLength(1);
    expect(s.observability.logNamed('delivery.runtime_contract_violation')).toHaveLength(0);
  });

  it('classifies a contract violation as contract_violation, not runtime_unavailable', async () => {
    const runtime = new FakeRuntime({
      plan: { kind: 'throw', error: new RuntimeContractError('x', 'unexpected_status') },
    });
    const s = scenario({ runtime });

    await s.run(envelopeFor('del_contract'));

    expect(s.jobs.calls.completed[0]?.outcome).toBe('contract_violation');
    expect(s.observability.logNamed('delivery.runtime_contract_violation')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Idempotency + crash windows                                                                */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage idempotency', () => {
  // W4 / redelivery của một delivery đã có processed marker: ACK ngay, KHÔNG claim, KHÔNG
  // gọi provider. Đây là thứ chặn một duplicate ở nguồn.
  it('acks a redelivered message without claiming or sending when the marker is set', async () => {
    const jobs = new FakeJobState({
      existing: jobRecord({ processed: true, terminalOutcome: 'delivered' }),
    });
    const s = scenario({ jobs });

    const outcome = await s.run(envelopeFor('del_done'));

    expect(outcome).toEqual({ kind: 'skipped', reason: 'already_processed' });
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    expect(s.runtime.calls.claims).toEqual([]);
    expect(s.sender.calls).toEqual([]);
    expect(s.jobs.calls.begun).toEqual([]);
    expect(s.jobs.calls.marked).toEqual([]);
  });

  it('proceeds normally when a job record exists but carries no processed marker', async () => {
    const jobs = new FakeJobState({ existing: jobRecord({ processed: false, consumeCount: 3 }) });
    const s = scenario({ jobs });

    const outcome = await s.run(envelopeFor('del_inflight'));

    expect(outcome).toEqual({ kind: 'delivered' });
    expect(s.runtime.calls.claims).toEqual(['del_inflight']);
  });

  // W1: crash **trước** claim. Attempt record đã ghi, nhưng không có claim, không có
  // provider call, không có processed marker. Redelivery phải đi lại từ đầu — và vì
  // `(delivery_id, attempt)` là idempotent nên nó không tạo state mâu thuẫn.
  it('W1: re-processing after a crash before claim retries the whole path', async () => {
    const jobs = new FakeJobState({
      existing: jobRecord({
        processed: false,
        openAttempt: { attempt: 1, startedAt: T0 - 60_000 },
      }),
      beginAttempt: () => false,
    });
    const s = scenario({ jobs });

    const outcome = await s.run(envelopeFor('del_w1'), 1);

    expect(outcome).toEqual({ kind: 'delivered' });
    expect(s.jobs.calls.begun).toEqual([{ deliveryId: 'del_w1', attempt: 1 }]);
    expect(s.runtime.calls.claims).toEqual(['del_w1']);
    expect(s.sender.calls).toHaveLength(1);
  });

  // W2: provider **đã** nhận, nhưng worker chết trước khi ghi outcome. Redelivery claim
  // được lại (lease đã hết hạn hoặc control plane đã trả `queued` sau release) và gửi lại —
  // đây là nguồn duplicate **đã được chấp nhận**. Điều quan trọng là attempt record phải
  // phản ánh `after_send`, và job state phải đọc được điều đó.
  it('W2: keeps the after_send phase observable so a potential duplicate is countable from D1', async () => {
    const sender = new FakeSender({
      result: { outcome: 'transient', phase: 'after_send', retryAfterMs: null, httpStatus: null },
    });
    const s = scenario({ sender });

    await s.run(envelopeFor('del_w2'));

    expect(s.jobs.calls.completed[0]).toMatchObject({ outcome: 'retrying', phase: 'after_send' });
    expect(s.runtime.calls.releases).toHaveLength(1);
    expect(s.observability.logNamed('delivery.retrying')[0]?.fields).toMatchObject({
      failure_phase: 'after_send',
      lease_released: true,
    });
  });

  // W3: ghi outcome được nhưng crash trước `markProcessed`. Redelivery gặp `409 terminal`
  // (control plane đã terminal) → ACK an toàn, không gửi lại. Đây là lý do marker được
  // đặt **sau** outcome.
  it('W3: a redelivery after the outcome was persisted acks on 409 terminal without resending', async () => {
    const runtime = new FakeRuntime({
      plan: { kind: 'lost', rejection: { reason: 'terminal', state: 'delivered' } },
    });
    const jobs = new FakeJobState({
      existing: jobRecord({ processed: false, lastAttempt: null }),
      beginAttempt: () => false,
    });
    const s = scenario({ runtime, jobs });

    const outcome = await s.run(envelopeFor('del_w3'), 2);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'claim_terminal' });
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    expect(s.sender.calls).toEqual([]);
    expect(s.runtime.calls.releases).toEqual([]);
  });

  // W4: đã persist kết cục + marker, crash trước ACK. Marker short-circuit.
  it('W4: a redelivery after both persist and marker acks immediately', async () => {
    const jobs = new FakeJobState({
      existing: jobRecord({ processed: true, terminalOutcome: 'delivered' }),
    });
    const s = scenario({ jobs });

    const outcome = await s.run(envelopeFor('del_w4'), 3);

    expect(outcome).toEqual({ kind: 'skipped', reason: 'already_processed' });
    expect(s.sender.calls).toEqual([]);
    expect(s.jobs.calls.marked).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Fenced write results                                                                       */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage fenced write results', () => {
  // `stale_write`/`terminal` là no-op an toàn: ACK, không coi là lỗi, không tăng retry —
  // và pipeline vẫn đặt processed marker vì kết cục **đã** xong ở phía worker.
  it.each(['stale_write', 'terminal'] as const)(
    'treats a %s outcome rejection as a safe ack',
    async (reason) => {
      const runtime = new FakeRuntime({ writeOutcome: () => ({ kind: 'rejected', reason }) });
      const s = scenario({ runtime });

      const outcome = await s.run(envelopeFor('del_stale'));

      expect(outcome).toEqual({ kind: 'delivered' });
      expect(s.trace).toEqual([{ kind: 'ack' }]);
      expect(s.observability.logNamed('delivery.outcome_stale')).toHaveLength(1);
      expect(s.jobs.calls.marked).toEqual([
        { deliveryId: 'del_stale', terminalOutcome: 'delivered' },
      ]);
    },
  );

  it('treats a stale release rejection as a completed release for the retry decision', async () => {
    const sender = new FakeSender({
      result: { outcome: 'transient', phase: 'before_send', retryAfterMs: null, httpStatus: 503 },
    });
    const runtime = new FakeRuntime({
      release: () => ({ kind: 'rejected', reason: 'stale_write' }),
    });
    const s = scenario({ runtime, sender });

    const outcome = await s.run(envelopeFor('del_stalerel'));

    expect(outcome).toEqual({ kind: 'retried', releaseAttempted: true, releaseSucceeded: false });
    expect(s.trace).toEqual([{ kind: 'retry' }]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Missing VAPID material                                                                     */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage missing VAPID material', () => {
  // Credential là `Record<string, unknown>` opaque; khi **cả cặp** khoá vắng thì material hỏng
  // theo nghĩa khác provider failure — coi là contract violation, không phải để adapter phân
  // loại thành `vapid_key_missing` rồi không retry mãi.
  it.each([
    ['an empty credential', {}],
    ['only a private key', { privateKey: VAPID_PRIVATE_KEY }],
    ['only a public key', { publicKey: VAPID_PUBLIC_KEY }],
    ['keys that are not strings', { privateKey: 1, publicKey: 2 }],
  ])('releases and retries without sending when the claim has %s', async (_name, credential) => {
    const runtime = new FakeRuntime();
    const original = runtime.claim.bind(runtime);
    runtime.claim = async (deliveryId: string) => {
      const result = await original(deliveryId);
      if (result.kind !== 'won') {
        return result;
      }
      return {
        kind: 'won',
        claim: { ...result.claim, provider: { ...result.claim.provider, credential } },
      };
    };
    const s = scenario({ runtime });

    const outcome = await s.run(envelopeFor('del_nokey'));

    expect(outcome).toMatchObject({ kind: 'retried' });
    expect(s.sender.calls).toEqual([]);
    expect(s.runtime.calls.releases).toHaveLength(1);
    expect(s.observability.logNamed('delivery.vapid_material_missing')).toHaveLength(1);
  });

  it('passes vapidSubject as null when the provider configuration has none, instead of inventing one', async () => {
    const runtime = new FakeRuntime();
    const original = runtime.claim.bind(runtime);
    runtime.claim = async (deliveryId: string) => {
      const result = await original(deliveryId);
      if (result.kind !== 'won') {
        return result;
      }
      return {
        kind: 'won',
        claim: { ...result.claim, provider: { ...result.claim.provider, configuration: {} } },
      };
    };
    const s = scenario({ runtime });

    await s.run(envelopeFor('del_nosubj'));

    expect(s.sender.calls[0]?.vapidSubject).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------- */
/* Payload serialization                                                                      */
/* -------------------------------------------------------------------------------------- */

describe('serializeEnvelopePayload', () => {
  // FR-013 byte budget được control plane đo bằng `serializePayloadCanonically`; cùng nội
  // dung phải cho **cùng số octet**, nên thứ tự khoá là hằng chứ không phải thứ tự chèn.
  it('emits the canonical key order regardless of the source insertion order', () => {
    const reordered = {
      payload: { data: { a: 1 }, url: 'https://ecoma.io/x', body: 'B', title: 'A' },
    } as unknown as Parameters<typeof serializeEnvelopePayload>[0];
    const canonical = {
      payload: { title: 'A', body: 'B', url: 'https://ecoma.io/x', data: { a: 1 } },
    } as unknown as Parameters<typeof serializeEnvelopePayload>[0];

    const fromReordered = serializeEnvelopePayload(reordered);
    expect(fromReordered).toBe(serializeEnvelopePayload(canonical));
    expect(fromReordered).toBe(
      '{"title":"A","body":"B","url":"https://ecoma.io/x","data":{"a":1}}',
    );
  });

  it('omits optional keys that are absent', () => {
    const minimal = {
      payload: { title: 'A', body: 'B' },
    } as unknown as Parameters<typeof serializeEnvelopePayload>[0];
    expect(serializeEnvelopePayload(minimal)).toBe('{"title":"A","body":"B"}');
  });

  it('sends the serialized envelope payload, never a payload read back from the runtime API', async () => {
    const runtime = new FakeRuntime();
    const original = runtime.claim.bind(runtime);
    runtime.claim = async (deliveryId: string) => {
      const result = await original(deliveryId);
      if (result.kind !== 'won') {
        return result;
      }
      return {
        kind: 'won',
        // Claim **không** được mang payload (validator chặn `runtime_material_leak`); test này
        // ghim rằng pipeline không đọc payload từ đâu khác ngoài envelope.
        claim: { ...result.claim, payload: 'payload-from-control-plane' },
      } as ReturnType<typeof original> extends Promise<infer R> ? R : never;
    };
    const s = scenario({ runtime });

    await s.run(envelopeFor('del_payload'));

    expect(s.sender.calls[0]?.payloadJson).toBe(
      '{"title":"Tiêu đề","body":"Nội dung","url":"https://ecoma.io/inbox"}',
    );
  });
});

/* -------------------------------------------------------------------------------------- */
/* Write failures propagate                                                                   */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage write failures', () => {
  // ⚠️ Đây là khác biệt lớn nhất giữa `invalidate` và `outcome`: invalidate là **fire** nên nuốt
  // lỗi, còn `outcome` thì **phải ném**. Nuốt lỗi ở đây là mất kết quả vĩnh viễn — provider đã
  // nhận, delivery vẫn `processing`, và reconciliation phải đoán lại bằng cách gửi lại.
  // Test này ghim hành vi bằng cách **quan sát rằng nó ném**, chứ không chỉ kiểm ACK/retry.
  it.each([
    ['on the delivered path', 'delivered'],
    ['on the failed path', 'failed'],
  ])('propagates an outcome-write failure %s instead of acking', async (_name, outcome) => {
    const sender =
      outcome === 'delivered'
        ? new FakeSender()
        : new FakeSender({
            result: { outcome: 'failed', failureClass: 'provider_auth', httpStatus: 401 },
          });
    const runtime = new FakeRuntime({
      writeOutcome: () => Promise.reject(new RuntimeTransportError('control plane unreachable')),
    });
    const s = scenario({ runtime, sender });

    await expect(s.run(envelopeFor(`del_outcomefail_${outcome}`))).rejects.toThrow(
      'control plane unreachable',
    );

    // Không ACK và không đặt marker: message phải được Queue redeliver, nơi `409 terminal`
    // (nếu lần này thực sự đã ghi) hoặc `409 pending` dẫn tới kết cục an toàn.
    expect(s.trace).toEqual([]);
    expect(s.jobs.calls.marked).toEqual([]);
  });

  it('propagates a processed-marker failure so a redelivery can re-read the outcome', async () => {
    const jobs = new FakeJobState({ markProcessedThrows: true });
    const s = scenario({ jobs });

    await expect(s.run(envelopeFor('del_markfail'))).rejects.toThrow(
      'D1 write failed while setting the processed marker',
    );

    // `409 terminal` ở lần redelivery là đường an toàn; marker **thiếu** thì đường đó mới còn
    // mở, nên nuốt lỗi ở đây sẽ biến một lần ghi thành công thành một lần gửi lại.
    expect(s.runtime.calls.outcomes).toHaveLength(1);
    expect(s.trace).toEqual([]);
  });

  // `completeAttempt` là ghi **job state**, không phải logical delivery state; nếu nó lỗi thì
  // attempt không đóng, nhưng kết quả provider **đã** xảy ra — nên vẫn phải đi tiếp và ghi
  // outcome, không ném ra làm mất kết cục.
  it('still records the outcome when closing the local attempt row fails', async () => {
    const jobs = new FakeJobState({ completeAttemptThrows: true });
    const s = scenario({ jobs });

    const outcome = await s.run(envelopeFor('del_attemptfail'));

    expect(outcome).toEqual({ kind: 'delivered' });
    expect(s.runtime.calls.outcomes).toHaveLength(1);
    expect(s.trace).toEqual([{ kind: 'ack' }]);
    // Phải **để lại dấu vết** của việc attempt row hở: một attempt không đóng mà không ai
    // biết là một việc đã xong không bao giờ đóng, và nó chỉ lộ ra khi reconciliation
    // đếm khác với những gì pipeline cho là đã xong.
    expect(s.observability.logNamed('delivery.attempt_close_failed')).toHaveLength(1);
    expect(s.observability.countOf('queue_consumer_errors')).toBe(1);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Observability safety                                                                       */
/* -------------------------------------------------------------------------------------- */

describe('processDeliveryMessage observability safety', () => {
  // SR-003: không endpoint, không payload, không p256dh/auth/VAPID/secret ở bất kỳ log nào.
  // Assertion này quét **mọi** giá trị field đã ghi, không chỉ một entry — một test chỉ nhìn
  // `delivery.delivered` sẽ bỏ sót secret rò ở một log khác.
  it('never writes an endpoint, a subscription secret or a VAPID key to any log line', async () => {
    const cases: { runtime: FakeRuntime; sender: FakeSender }[] = [
      { runtime: new FakeRuntime(), sender: new FakeSender() },
      {
        runtime: new FakeRuntime(),
        sender: new FakeSender({
          result: { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: 404 },
        }),
      },
      {
        runtime: new FakeRuntime(),
        sender: new FakeSender({
          result: {
            outcome: 'transient',
            phase: 'after_send',
            retryAfterMs: 1_000,
            httpStatus: 503,
          },
        }),
      },
      {
        runtime: new FakeRuntime({
          plan: { kind: 'throw', error: new RuntimeContractError('x', 'y') },
        }),
        sender: new FakeSender(),
      },
    ];

    for (const [index, { runtime, sender }] of cases.entries()) {
      const s = scenario({ runtime, sender });
      await s.run(envelopeFor(`del_secret_${index}`));

      const logged = s.observability.allLoggedFieldValues().join('|');
      expect(logged).not.toContain('push.example');
      expect(logged).not.toContain(P256DH);
      expect(logged).not.toContain(AUTH_SECRET);
      expect(logged).not.toContain(VAPID_PRIVATE_KEY);
      expect(logged).not.toContain(VAPID_PUBLIC_KEY);
      expect(logged).not.toContain('Nội dung');
    }
  });

  // `delivery_id` KHÔNG bao giờ là metric label (high cardinality); nó được phép trong log để
  // dựng correlation chain. Metric chỉ nhận `provider_id`/`transport`/`app`.
  it('never uses delivery_id as a metric label', async () => {
    const s = scenario();
    await s.run(envelopeFor('del_metric'));

    for (const entry of s.observability.metrics) {
      expect(Object.keys(entry.dimensions ?? {})).not.toContain('delivery_id');
      expect(Object.keys(entry.dimensions ?? {})).not.toContain('notification_id');
      expect(Object.keys(entry.dimensions ?? {})).not.toContain('subscription_id');
    }
  });

  it('logs the delivery_id so the correlation chain stays readable', async () => {
    const s = scenario();
    await s.run(envelopeFor('del_logged'));

    expect(s.observability.logNamed('delivery.delivered')[0]?.fields).toMatchObject({
      delivery_id: 'del_logged',
      notification_id: 'ntf_del_logged',
      subscription_id: SUBSCRIPTION_ID,
      provider_id: PROVIDER_ID,
      app: 'ecoma-web',
    });
  });
});

/* -------------------------------------------------------------------------------------- */
/* Trace helpers                                                                              */
/* -------------------------------------------------------------------------------------- */

/** Type guard chỉ phục vụ đọc type trong các helper của chính file này. */
export type { JobCalls, RuntimeCalls };
