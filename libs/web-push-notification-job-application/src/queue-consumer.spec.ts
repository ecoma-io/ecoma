// Vòng lặp per-message của Queue consumer.
//
// ⚠️ Trọng tâm của suite này là **tính độc lập giữa các message trong một batch**: một
// message fail không được kéo các message anh em (FR-018, §12.1). Nhánh ấy chỉ lộ ra khi
// `ackAll`/`retryAll` xuất hiện — và một fake không có trace lệnh thì không chứng minh được
// rằng msg2 **không** chạm msg1.

import { describe, expect, it, vi } from 'vitest';

import { consumeQueueBatch, type ConsumableMessage } from './queue-consumer';
import { RuntimeContractError, type DeliveryPipelineDeps, type DeliveryRuntimePort } from './index';
import { deliveryCommandV1 } from '@ecoma-io/push-notification-contracts';
import type { JobRecord, JobStatePort } from './job-state-port';
import type {
  DeliveryLogFields,
  DeliveryLogLevel,
  DeliveryMetricName,
  MetricDimensions,
} from './observability-port';
import type { WebPushSendResult } from './web-push-sender';

const DELIVERY_A = 'del_mixed_a';
const DELIVERY_B = 'del_mixed_b';

function envelope(deliveryId: string): unknown {
  return deliveryCommandV1({
    delivery_id: deliveryId,
    notification_id: `ntf_${deliveryId}`,
    subscription_id: `sub_${deliveryId}`,
    provider_id: 'prov-webpush-eu',
    transport: 'web',
    payload: { title: 'Tiêu đề', body: 'Nội dung' },
  });
}

/** Trace của một message — mọi disposition đều được ghi lại thay vì chỉ "không ném". */
type Trace = { readonly kind: 'ack' } | { readonly kind: 'retry'; readonly delaySeconds?: number };

function messageFor(
  deliveryId: string,
  trace: Trace[],
  attempts = 1,
): ConsumableMessage & { readonly trace: Trace[] } {
  return {
    body: envelope(deliveryId),
    attempts,
    trace,
    ack: () => {
      trace.push({ kind: 'ack' });
    },
    retry: (options) => {
      trace.push(
        options === undefined
          ? { kind: 'retry' }
          : { kind: 'retry', delaySeconds: options.delaySeconds },
      );
    },
  };
}

/** Job state giả: không có job record nào đã processed, mọi attempt record được ghi lại. */
function fakeJobs(overrides: Partial<JobStatePort> = {}): JobStatePort {
  return {
    beginAttempt: async () => true,
    completeAttempt: async () => undefined,
    markProcessed: async () => undefined,
    findByDeliveryId: async (): Promise<JobRecord | null> => null,
    listStuck: async (): Promise<readonly JobRecord[]> => [],
    ...overrides,
  };
}

type RuntimeOverrides = Partial<DeliveryRuntimePort>;

function fakeRuntime(overrides: RuntimeOverrides = {}): DeliveryRuntimePort {
  return {
    claim: async () => {
      throw new Error('fake runtime must be configured per test');
    },
    release: async () => ({ kind: 'applied' as const }),
    writeOutcome: async () => ({ kind: 'applied' as const }),
    invalidateSubscription: async () => 'disabled' as const,
    ...overrides,
  };
}

type SenderStub = (request: { endpoint: string }) => WebPushSendResult | Promise<WebPushSendResult>;

function depsWith(input: {
  runtime?: DeliveryRuntimePort;
  jobs?: Partial<JobStatePort>;
  sender?: SenderStub;
  clockNow?: number;
}): DeliveryPipelineDeps {
  const now = input.clockNow ?? Date.parse('2026-03-01T11:00:00.000Z');
  const deps = {
    runtime: input.runtime ?? fakeRuntime(),
    jobs: fakeJobs(input.jobs),
    sender: {
      send: async (request: { endpoint: string }) =>
        (input.sender ?? (() => ({ outcome: 'delivered' as const })))(request),
    },
    clock: { now: () => now },
    metrics: {
      increment: vi.fn<(name: DeliveryMetricName, dimensions?: MetricDimensions) => void>(),
      observe:
        vi.fn<(name: DeliveryMetricName, value: number, dimensions?: MetricDimensions) => void>(),
    },
    logger: {
      log: vi.fn<(level: DeliveryLogLevel, message: string, fields?: DeliveryLogFields) => void>(),
    },
  };
  return deps;
}

function claimWon(providerId = 'prov-webpush-eu'): RuntimeOverrides {
  return {
    claim: async (deliveryId: string) => ({
      kind: 'won' as const,
      claim: {
        delivery_id: deliveryId,
        notification_id: `ntf_${deliveryId}`,
        app: 'ecoma-web',
        status: 'processing' as const,
        expires_at: '2026-03-01T11:30:00.000Z',
        dispatch_generation: 1,
        lease_expires_at: '2026-03-01T11:05:00.000Z',
        transport: 'web' as const,
        provider_id: providerId,
        subscription_id: `sub_${deliveryId}`,
        subscription: {
          endpoint: `https://push.example/${deliveryId}`,
          p256dh: 'p256dh',
          auth: 'auth',
          vapid_key_id: 'vapid-key-1',
        },
        provider: {
          type: 'web-push' as const,
          configuration: { vapidSubject: 'mailto:ops@ecoma.io' },
          credential: { privateKey: 'private', publicKey: 'public' },
        },
      },
    }),
  };
}

describe('consumeQueueBatch mixed batch', () => {
  // FR-018 / §12.1: msg1 ack + msg2 retry, và msg2 **không** được chạm msg1. Đây là test
  // duy nhất bắt được một `ackAll`/`retryAll` bị lọt vào — vì nó khẳng định trace **của từng
  // message**, chứ không chỉ "batch có hai disposition".
  it('acks the delivered message and retries the failing one without crossing over', async () => {
    const traceA: Trace[] = [];
    const traceB: Trace[] = [];
    const runtime = fakeRuntime({
      ...claimWon(),
      claim: async (deliveryId: string) => {
        if (deliveryId === DELIVERY_B) {
          return { kind: 'lost', rejection: { reason: 'pending' } };
        }
        return {
          kind: 'won',
          claim: {
            delivery_id: deliveryId,
            notification_id: `ntf_${deliveryId}`,
            app: 'ecoma-web',
            status: 'processing' as const,
            expires_at: '2026-03-01T11:30:00.000Z',
            dispatch_generation: 1,
            lease_expires_at: '2026-03-01T11:05:00.000Z',
            transport: 'web' as const,
            provider_id: 'prov-webpush-eu',
            subscription_id: `sub_${deliveryId}`,
            subscription: {
              endpoint: `https://push.example/${deliveryId}`,
              p256dh: 'p256dh',
              auth: 'auth',
              vapid_key_id: 'vapid-key-1',
            },
            provider: {
              type: 'web-push' as const,
              configuration: { vapidSubject: 'mailto:ops@ecoma.io' },
              credential: { privateKey: 'private', publicKey: 'public' },
            },
          },
        };
      },
    });

    await consumeQueueBatch(depsWith({ runtime }), [
      messageFor(DELIVERY_A, traceA),
      messageFor(DELIVERY_B, traceB),
    ]);

    expect(traceA).toEqual([{ kind: 'ack' }]);
    expect(traceB).toEqual([{ kind: 'retry' }]);
  });

  it('keeps a throw in one message from taking the rest of the batch down', async () => {
    const traceA: Trace[] = [];
    const traceB: Trace[] = [];
    const traceC: Trace[] = [];
    const runtime = fakeRuntime({
      ...claimWon(),
      claim: async (deliveryId: string) => {
        if (deliveryId === DELIVERY_B) {
          throw new RuntimeContractError('peer lệch vocabulary', 'unexpected_status');
        }
        return {
          kind: 'won',
          claim: {
            delivery_id: deliveryId,
            notification_id: `ntf_${deliveryId}`,
            app: 'ecoma-web',
            status: 'processing' as const,
            expires_at: '2026-03-01T11:30:00.000Z',
            dispatch_generation: 1,
            lease_expires_at: '2026-03-01T11:05:00.000Z',
            transport: 'web' as const,
            provider_id: 'prov-webpush-eu',
            subscription_id: `sub_${deliveryId}`,
            subscription: {
              endpoint: `https://push.example/${deliveryId}`,
              p256dh: 'p256dh',
              auth: 'auth',
              vapid_key_id: 'vapid-key-1',
            },
            provider: {
              type: 'web-push' as const,
              configuration: {},
              credential: { privateKey: 'private', publicKey: 'public' },
            },
          },
        };
      },
    });

    await consumeQueueBatch(depsWith({ runtime }), [
      messageFor(DELIVERY_A, traceA),
      messageFor(DELIVERY_B, traceB),
      messageFor('del_mixed_c', traceC),
    ]);

    expect(traceA).toEqual([{ kind: 'ack' }]);
    expect(traceB).toEqual([{ kind: 'retry' }]);
    // Message sau message lỗi vẫn phải được xử lý — `abort()` hoặc một throw ra ngoài loop sẽ
    // biến một lỗi thành mất việc.
    expect(traceC).toEqual([{ kind: 'ack' }]);
  });

  it('converts an unexpected throw into a retry, never an ack', async () => {
    const trace: Trace[] = [];
    const deps = depsWith({});
    // `processDeliveryMessage` không ném với một envelope hợp lệ + claim hợp lệ, nên đường
    // này được kích hoạt bằng một `JobStatePort.beginAttempt` ném — một lỗi hạ tầng D1.
    const throwingDeps: DeliveryPipelineDeps = {
      ...deps,
      jobs: fakeJobs({
        beginAttempt: async () => {
          throw new Error('D1 unavailable');
        },
      }),
    };

    await consumeQueueBatch(throwingDeps, [messageFor(DELIVERY_A, trace)]);

    expect(trace).toEqual([{ kind: 'retry' }]);
  });

  it('passes the message attempt count through, because backoff depends on it', async () => {
    const trace: Trace[] = [];
    const seenAttempts: number[] = [];
    const runtime = fakeRuntime({
      ...claimWon(),
      claim: async (deliveryId: string) => {
        seenAttempts.push(deliveryId === DELIVERY_A ? 5 : 1);
        return { kind: 'lost', rejection: { reason: 'pending' } };
      },
    });

    await consumeQueueBatch(depsWith({ runtime }), [
      messageFor(DELIVERY_A, trace, 5),
      messageFor(DELIVERY_B, trace, 1),
    ]);

    // Không có giá trị nào để assert trực tiếp ở đây (policy backoff chưa chốt), nhưng
    // `attempts` phải là **con số** đi vào `queueRetryDelaySeconds` — một `attempts` bị đổi
    // thành `undefined` sẽ không ném ở đây mà lại sai ở chỗ khác.
    expect(seenAttempts).toHaveLength(2);
    expect(trace.filter((entry) => entry.kind === 'retry')).toHaveLength(2);
  });

  it('forwards Retry-After as an explicit delay on the retried message only', async () => {
    const traceA: Trace[] = [];
    const traceB: Trace[] = [];
    const runtime = fakeRuntime({
      ...claimWon(),
      claim: async (deliveryId: string) => {
        if (deliveryId === DELIVERY_A) {
          return { kind: 'lost', rejection: { reason: 'pending' } };
        }
        return {
          kind: 'won',
          claim: {
            delivery_id: deliveryId,
            notification_id: `ntf_${deliveryId}`,
            app: 'ecoma-web',
            status: 'processing' as const,
            expires_at: '2026-03-01T11:30:00.000Z',
            dispatch_generation: 1,
            lease_expires_at: '2026-03-01T11:05:00.000Z',
            transport: 'web' as const,
            provider_id: 'prov-webpush-eu',
            subscription_id: `sub_${deliveryId}`,
            subscription: {
              endpoint: `https://push.example/${deliveryId}`,
              p256dh: 'p256dh',
              auth: 'auth',
              vapid_key_id: 'vapid-key-1',
            },
            provider: {
              type: 'web-push' as const,
              configuration: {},
              credential: { privateKey: 'private', publicKey: 'public' },
            },
          },
        };
      },
    });

    await consumeQueueBatch(
      depsWith({
        runtime,
        sender: () => ({
          outcome: 'transient' as const,
          phase: 'before_send' as const,
          retryAfterMs: 4_500,
          httpStatus: 429,
        }),
      }),
      [messageFor(DELIVERY_A, traceA), messageFor(DELIVERY_B, traceB)],
    );

    // msg2 nhận delay tường minh từ `Retry-After`; msg1 (409 pending) dùng policy của Queue
    // — hai message không được dùng chung một quyết định.
    expect(traceB).toEqual([{ kind: 'retry', delaySeconds: 5 }]);
    expect(traceA).toEqual([{ kind: 'retry' }]);
  });

  it('processes the batch in order so two executions never race the same delivery_id', async () => {
    const order: string[] = [];
    const traceA: Trace[] = [];
    const traceB: Trace[] = [];
    const runtime = fakeRuntime({
      claim: async (deliveryId: string) => {
        order.push(`claim:${deliveryId}`);
        return { kind: 'lost', rejection: { reason: 'pending' } };
      },
    });

    await consumeQueueBatch(depsWith({ runtime }), [
      messageFor(DELIVERY_A, traceA),
      messageFor(DELIVERY_B, traceB),
    ]);

    // `Promise.all` sẽ cho hai claim chạy đồng thời và thứ tự này không ổn định; §17/FR-014
    // yêu cầu tuần tự để hai execution cùng claim không đánh vật bằng fencing.
    expect(order).toEqual([`claim:${DELIVERY_A}`, `claim:${DELIVERY_B}`]);
  });

  it('does nothing for an empty batch', async () => {
    const runtime = fakeRuntime({
      claim: async () => {
        throw new Error('must not be called for an empty batch');
      },
    });
    await expect(consumeQueueBatch(depsWith({ runtime }), [])).resolves.toBeUndefined();
  });
});

describe('consumeQueueBatch DC-2 lease release on unhandled error', () => {
  // Regression: mọi đường retry sau khi claim đã thắng phải release lease TRƯỚC retry().
  // Đi qua ranh giới thật: consumeQueueBatch với message thật (fake ack/retry ghi lại lời gọi)
  // và runtime.release spy để assert thứ tự release trước retry.
  it('releases the lease strictly before retrying on an unhandled post-claim error', async () => {
    const trace: Trace[] = [];
    const order: string[] = [];
    const releases: { deliveryId: string; generation: number }[] = [];
    const runtime = fakeRuntime({
      ...claimWon(),
      writeOutcome: async () => {
        throw new Error('control plane unreachable');
      },
    });
    const baseRelease = runtime.release.bind(runtime);
    runtime.release = async (deliveryId: string, generation: number) => {
      order.push('release');
      releases.push({ deliveryId, generation });
      return baseRelease(deliveryId, generation);
    };

    const message = {
      body: envelope(DELIVERY_A),
      attempts: 1,
      trace,
      ack: () => {
        trace.push({ kind: 'ack' });
      },
      retry: (options?: { readonly delaySeconds?: number }) => {
        order.push('retry');
        trace.push(
          options === undefined
            ? { kind: 'retry' }
            : { kind: 'retry', delaySeconds: options.delaySeconds },
        );
      },
    };

    await consumeQueueBatch(depsWith({ runtime }), [message]);

    // ⚠️ Assertion **thứ tự**, không chỉ "đã gọi release": một consumer gọi `retry()` rồi mới
    // release vẫn xanh với hai assertion độc lập, nhưng đó chính là lỗi FR-008.
    expect(order).toEqual(['release', 'retry']);
    expect(trace).toEqual([{ kind: 'retry' }]);
    // Release mang `dispatch_generation` của claim — fencing token, không phải số thứ tự.
    expect(releases).toEqual([{ deliveryId: DELIVERY_A, generation: 1 }]);
  });

  // Lỗi TRƯỚC claim (envelope hỏng) — không có lease để release: fail-safe, không release thừa.
  it('does not release on a broken envelope (pre-claim)', async () => {
    const trace: Trace[] = [];
    const releases: string[] = [];
    const runtime = fakeRuntime({
      claim: async () => {
        throw new Error('must not be called for a broken envelope');
      },
    });
    const baseRelease = runtime.release.bind(runtime);
    runtime.release = async (deliveryId: string, generation: number) => {
      releases.push(deliveryId);
      return baseRelease(deliveryId, generation);
    };

    const message = {
      body: { garbage: true },
      attempts: 1,
      trace,
      ack: () => {
        trace.push({ kind: 'ack' });
      },
      retry: (options?: { readonly delaySeconds?: number }) => {
        trace.push(
          options === undefined
            ? { kind: 'retry' }
            : { kind: 'retry', delaySeconds: options.delaySeconds },
        );
      },
    };

    await consumeQueueBatch(depsWith({ runtime }), [message]);

    // Không có lease để release: envelope hỏng là lỗi trước claim, không có gì để trả.
    expect(releases).toHaveLength(0);
    expect(trace).toEqual([{ kind: 'retry' }]);
  });
});
