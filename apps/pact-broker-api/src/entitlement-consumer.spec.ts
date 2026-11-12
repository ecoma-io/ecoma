/**
 * Unit test cho `entitlementQueueBatch` — fakes in-memory, không dependency thật
 * (PostgreSQL, Hono, Cloudflare Queues). Ghi các hành vi OCR-fixed (PR #460):
 *
 * - envelope string được JSON.parse trước khi validate (không còn reject invalid_payload
 *   vì validateEntitlementEvent mong đợi object)
 *   envelope không phải object và không parse được JSON → invalid_payload, ack (không retry)
 *   HYPERDRIVE binding thiếu connectionString → fail-closed throw ngay trước khi pool tạo
 *   mỗi message xử lý tuần tự; lỗi port/DB → message.retry() thì continue, không làm
 *   gián đoạn message còn lại
 *   message xử lý xong (áp dụng / bỏ qua duplicate/stale/not-product) → ack
 *   env không cần INTERNAL_TENANT_OWNER_SUB — serving path chỉ đọc tenant
 *   canonical `ecoma`, không nhận chủ sở hữu tenant nào từ cấu hình
 */

import { describe, expect, it, vi } from 'vitest';

import type { EntitlementEvent } from '@ecoma-io/staff-access-contracts';

import { provisionEntitlementMembership } from '@ecoma-io/pact-broker-api-application';
import { createPool } from '@ecoma-io/pact-broker-api-infrastructure';
import { entitlementQueueBatch } from './entitlement-consumer';

vi.mock('@ecoma-io/pact-broker-api-application', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/pact-broker-api-application')>();
  return {
    ...actual,
    provisionEntitlementMembership:
      vi.fn<
        (
          event: Parameters<typeof provisionEntitlementMembership>[0],
          deps: Parameters<typeof provisionEntitlementMembership>[1],
        ) => Promise<ReturnType<typeof provisionEntitlementMembership>>
      >(),
  };
});

vi.mock('@ecoma-io/pact-broker-api-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/pact-broker-api-infrastructure')>();
  return {
    ...actual,
    createPool:
      vi.fn<
        (connectionString: Parameters<typeof createPool>[0]) => ReturnType<typeof createPool>
      >(),
  };
});

const mockedProvision = vi.mocked(provisionEntitlementMembership);
const mockedCreatePool = vi.mocked(createPool);

function makeEvent(overrides: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    event_id: '0f0e0d0c-0b0a-4928-8276-001122334455',
    type: 'entitlement.granted',
    staff_id: 'staff-0001',
    product: 'pact-broker',
    revision: 1,
    occurred_at: new Date().toISOString(),
    producer: 'staff-access',
    ...overrides,
  };
}

function eventId(n: string): string {
  // UUID v4 hợp lệ: 8-4-4-4-12 hex, nhóm thứ 3 bắt đầu bằng '4'.
  return `0f0e0d0c-0b0a-4${String(n).padStart(3, '0')}-8276-001122334455`;
}

function makeMessage(body: unknown): {
  id: string;
  body: unknown;
  ack(): Promise<void>;
  retry(): Promise<void>;
} {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    body,
    ack: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    retry: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

const fakePool = {
  on: vi.fn<() => void>(),
  end: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

async function runBatch(
  messages: { id: string; body: unknown; ack(): Promise<void>; retry(): Promise<void> }[],
  env: { HYPERDRIVE?: { connectionString: string } } = {},
): Promise<void> {
  mockedCreatePool.mockReturnValue(fakePool as never);

  await entitlementQueueBatch({ queue: 'ecoma-staff-access-entitlement-events', messages }, env);
}

describe('entitlementQueueBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // fakePool.end giữ mockResolvedValue qua clearAllMocks (resetAllMocks sẽ xóa
    // implementation rồi pool.end() trả undefined → .catch lỗi).
    vi.mocked(fakePool.end).mockResolvedValue(undefined);
  });

  it('ends the batch pool exactly once per batch (pool-per-batch lifecycle, issue #118)', async () => {
    // Pool sống đúng MỘT batch: tạo một lần ở đầu batch, `end()` đúng một lần
    // trong `finally` khi batch kết thúc — kể cả khi mọi message đều được ack.
    const event = makeEvent();
    mockedProvision.mockResolvedValue({ applied: true, reason: 'first' });

    await runBatch([makeMessage(JSON.stringify(event))], {
      HYPERDRIVE: { connectionString: 'postgres://fake/db' },
    });

    expect(mockedCreatePool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fakePool.end).mock.calls).toHaveLength(1);
  });

  it('envelope string hợp lệ được parse rồi validate → applied, ack', async () => {
    const event = makeEvent();
    const message = makeMessage(JSON.stringify(event));
    mockedProvision.mockResolvedValue({ applied: true, reason: 'first' });

    await runBatch([message], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });

    expect(mockedProvision).toHaveBeenCalledTimes(1);
    const eventArg = mockedProvision.mock.calls[0][0];
    expect(eventArg).toEqual(event);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('chuỗi không phải JSON → invalid_payload, ack (không retry)', async () => {
    const message = makeMessage('not-json-at-all');

    await runBatch([message], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });

    // Payload lỗi → ack, không retry, không gọi provision.
    expect(mockedProvision).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('ack() throws on invalid payload → log ack_failed and return, no retry (poison pill dropped)', async () => {
    const message = makeMessage('not-json-at-all');
    vi.mocked(message.ack).mockRejectedValueOnce(new Error('ack failed'));
    const logSpy = vi.spyOn(console, 'log');

    await runBatch([message], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });

    expect(message.ack).toHaveBeenCalledTimes(1);
    // ack thất bại → ghi log ack_failed, KHÔNG retry: payload lỗi là poison pill,
    // retry cũng không bao giờ thành công; runtime redelivery sẽ ack lại sau.
    expect(message.retry).not.toHaveBeenCalled();
    const ackFailedLog = logSpy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { event: string })
      .find((entry) => entry.event === 'entitlement_consumer.ack_failed');
    expect(ackFailedLog).toBeDefined();
    logSpy.mockRestore();
  });

  it('retry() throw trong catch → không gián đoạn message còn lại, không throw', async () => {
    const first = makeMessage(JSON.stringify(makeEvent({ event_id: eventId('1') })));
    const second = makeMessage(JSON.stringify(makeEvent({ event_id: eventId('2') })));
    mockedProvision
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ applied: true, reason: 'first' });
    vi.mocked(first.retry).mockRejectedValueOnce(new Error('retry failed'));

    await runBatch([first, second], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
  });

  it('HYPERDRIVE binding missing connectionString fails closed without creating a pool', async () => {
    const message = makeMessage(JSON.stringify(makeEvent()));
    await expect(runBatch([message], {})).rejects.toThrow(
      /Hyperdrive binding HYPERDRIVE has no connectionString/u,
    );

    expect(mockedProvision).not.toHaveBeenCalled();
    expect(mockedCreatePool).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('lỗi port/DB trên message đầu → retry message đầu, message thứ hai vẫn xử lý và ack', async () => {
    const first = makeMessage(JSON.stringify(makeEvent({ event_id: eventId('1') })));
    const second = makeMessage(JSON.stringify(makeEvent({ event_id: eventId('2') })));
    mockedProvision
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ applied: true, reason: 'first' });

    await runBatch([first, second], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledTimes(1);
    expect(second.retry).not.toHaveBeenCalled();
  });

  it('hai message cùng batch xử lý tuần tự, không dùng Promise.all', async () => {
    const order: string[] = [];
    const first = makeMessage(JSON.stringify(makeEvent({ event_id: eventId('1'), revision: 1 })));
    const second = makeMessage(JSON.stringify(makeEvent({ event_id: eventId('2'), revision: 2 })));
    mockedProvision
      .mockImplementationOnce(async (event: EntitlementEvent) => {
        order.push(`start-${event.event_id}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        order.push(`end-${event.event_id}`);
        return { applied: true, reason: 'first' };
      })
      .mockImplementation(async (event: EntitlementEvent) => {
        order.push(`start-${event.event_id}`);
        order.push(`end-${event.event_id}`);
        return { applied: true, reason: 'newer' };
      });

    await runBatch([first, second], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });

    expect(order).toEqual([
      `start-${eventId('1')}`,
      `end-${eventId('1')}`,
      `start-${eventId('2')}`,
      `end-${eventId('2')}`,
    ]);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
  });

  it('batch rỗng → không gọi provision, không throw', async () => {
    await runBatch([], { HYPERDRIVE: { connectionString: 'postgres://fake/db' } });
    expect(mockedProvision).not.toHaveBeenCalled();
  });

  it('processes a valid batch with no INTERNAL_TENANT_OWNER_SUB in env (serving path needs no owner subject)', async () => {
    const message = makeMessage(JSON.stringify(makeEvent()));
    mockedProvision.mockResolvedValue({ applied: true, reason: 'first' });

    // Env chỉ có HYPERDRIVE — không có biến chủ sở hữu tenant nào. Consumer
    // read-only trên tenant canonical: không còn fail-closed theo env này.
    await entitlementQueueBatch(
      { queue: 'ecoma-staff-access-entitlement-events', messages: [message] },
      { HYPERDRIVE: { connectionString: 'postgres://fake/db' } },
    );

    expect(mockedProvision).toHaveBeenCalledTimes(1);
    expect(mockedProvision.mock.calls[0]).toHaveLength(2); // event + deps, không còn ownerSub
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
  });
});
