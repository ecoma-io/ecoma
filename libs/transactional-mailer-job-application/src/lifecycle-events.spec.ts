/**
 * Spec của lifecycle event trung tính (§11.3): normalizer, dedupe/correlate seam
 * và disposition của ingest.
 *
 * Fixtures bao **cả sáu loại event** và các ca adversarial đã chốt: duplicate eventId,
 * payload hỏng (quarantine, không retry), event trước correlate (persist vẫn xảy ra),
 * replay, sai cấu trúc. KHÔNG fixture nào mang shape raw của một vendor — shape raw
 * là việc của normalizer ở composition root; model chỉ thấy envelope trung tính.
 */

import { describe, expect, it } from 'vitest';

import {
  ingestLifecycleEventMessage,
  MAIL_LIFECYCLE_EVENT_TYPE_VALUES,
  MAIL_LIFECYCLE_REASON_TOKEN_VALUES,
  normalizeLifecycleEventMessage,
  type MailLifecycleEvent,
} from './lifecycle-events';

const NOW_MS = 1_800_000_000_000;

/** Envelope trung tính hợp lệ — mỗi test clone và bẻ một field. */
function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: 'evt-1',
    type: 'delivered',
    messageId: '0101018f7d0c4d9a-msg-sentinel',
    occurredAt: NOW_MS - 5000,
    terminal: true,
    ...overrides,
  });
}

/** Store fake đếm lần gọi và trả kết quả cấu hình. */
function fakeStore(result: 'stored' | 'duplicate' | 'throw' = 'stored'): {
  readonly events: MailLifecycleEvent[];
  readonly store: (event: MailLifecycleEvent) => Promise<'stored' | 'duplicate'>;
} {
  const events: MailLifecycleEvent[] = [];
  return {
    events,
    store: (event) => {
      events.push(event);
      if (result === 'throw') {
        return Promise.reject(new Error('d1 down'));
      }
      return Promise.resolve(result);
    },
  };
}

/** Narrow union kết quả về event đã chuẩn hoá — throw ở ngoài `expect` cho rule vitest. */
function assertNormalized(raw: string, nowMs: number): MailLifecycleEvent {
  const result = normalizeLifecycleEventMessage(raw, nowMs);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error('Expected the payload to normalize, but it was rejected.');
  }
  return result.event;
}

describe('normalizeLifecycleEventMessage', () => {
  it('accepts all six lifecycle event types', () => {
    expect(MAIL_LIFECYCLE_EVENT_TYPE_VALUES).toEqual([
      'delivered',
      'deferred',
      'bounced',
      'failed',
      'rejected',
      'complained',
    ]);

    for (const type of MAIL_LIFECYCLE_EVENT_TYPE_VALUES) {
      expect(assertNormalized(envelope({ type }), NOW_MS).type).toBe(type);
    }
  });

  it('normalizes a delivered event with every field present', () => {
    const normalized = normalizeLifecycleEventMessage(envelope(), NOW_MS);

    expect(normalized).toEqual({
      ok: true,
      event: {
        eventId: 'evt-1',
        type: 'delivered',
        messageId: '0101018f7d0c4d9a-msg-sentinel',
        occurredAt: NOW_MS - 5000,
        terminal: true,
        reasonToken: null,
      },
    });
  });

  it('maps a deferred event to the bounce-soft reason token and non-terminal default', () => {
    // `terminal` thiếu — chưa chứng minh terminal, default trung thực là `false`.
    const event = assertNormalized(envelope({ type: 'deferred', terminal: undefined }), NOW_MS);

    expect(event.terminal).toBe(false);
    expect(event.reasonToken).toBe('bounce-soft');
  });

  it('assigns closed reason tokens per type and none to delivered', () => {
    const expected: Record<string, string | null> = {
      delivered: null,
      deferred: 'bounce-soft',
      bounced: 'bounce-hard',
      failed: 'delivery-failed',
      rejected: 'policy-rejected',
      complained: 'spam-complaint',
    };

    for (const type of MAIL_LIFECYCLE_EVENT_TYPE_VALUES) {
      expect(assertNormalized(envelope({ type }), NOW_MS).reasonToken).toBe(expected[type] ?? null);
    }
  });

  it('keeps the reason token vocabulary closed and provider-free', () => {
    // Token là enum đóng không mang dữ liệu provider: KHÔNG token nào cho phép chuỗi
    // free-form (smtpResponse, reason text) đi vào model.
    expect(MAIL_LIFECYCLE_REASON_TOKEN_VALUES).toEqual([
      'bounce-soft',
      'bounce-hard',
      'delivery-failed',
      'policy-rejected',
      'spam-complaint',
    ]);
  });

  it('falls back to the caller clock when occurredAt is absent', () => {
    expect(assertNormalized(envelope({ occurredAt: undefined }), NOW_MS).occurredAt).toBe(NOW_MS);
  });

  it('rejects unparseable JSON with no payload echo', () => {
    const result = normalizeLifecycleEventMessage('{not json', NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('rejects a non-object payload', () => {
    expect(normalizeLifecycleEventMessage('[1,2]', NOW_MS)).toEqual({
      ok: false,
      reason: 'unparseable',
    });
    expect(normalizeLifecycleEventMessage('42', NOW_MS)).toEqual({
      ok: false,
      reason: 'unparseable',
    });
  });

  it('rejects a payload missing any required identifier field', () => {
    expect(normalizeLifecycleEventMessage(envelope({ eventId: undefined }), NOW_MS)).toEqual({
      ok: false,
      reason: 'missing-field',
    });
    expect(normalizeLifecycleEventMessage(envelope({ messageId: undefined }), NOW_MS)).toEqual({
      ok: false,
      reason: 'missing-field',
    });
    expect(normalizeLifecycleEventMessage(envelope({ type: undefined }), NOW_MS)).toEqual({
      ok: false,
      reason: 'missing-field',
    });
  });

  it('rejects wrong-type identifiers and out-of-window timestamps', () => {
    expect(normalizeLifecycleEventMessage(envelope({ eventId: 42 }), NOW_MS)).toEqual({
      ok: false,
      reason: 'wrong-type',
    });
    expect(normalizeLifecycleEventMessage(envelope({ messageId: '' }), NOW_MS)).toEqual({
      ok: false,
      reason: 'wrong-type',
    });
    // Timestamp phi thực (năm 1970 / năm 3000) — loại trước khi vào storage.
    expect(normalizeLifecycleEventMessage(envelope({ occurredAt: 500 }), NOW_MS)).toEqual({
      ok: false,
      reason: 'wrong-type',
    });
    expect(
      normalizeLifecycleEventMessage(envelope({ occurredAt: 4_102_444_800_001 }), NOW_MS),
    ).toEqual({ ok: false, reason: 'wrong-type' });
    expect(normalizeLifecycleEventMessage(envelope({ terminal: 'yes' }), NOW_MS)).toEqual({
      ok: false,
      reason: 'wrong-type',
    });
  });

  it('rejects an unknown event type — closed enum, no passthrough', () => {
    // Type lạ (provider thêm event mới) KHÔNG được đi vào model: model là trung tính
    // đóng; mở rộng là một quyết định schema, không phải đường im lặng.
    expect(normalizeLifecycleEventMessage(envelope({ type: 'message.rated' }), NOW_MS)).toEqual({
      ok: false,
      reason: 'unknown-type',
    });
  });

  it('rejects an identifier beyond the length ceiling', () => {
    const huge = 'x'.repeat(257);
    expect(normalizeLifecycleEventMessage(envelope({ eventId: huge }), NOW_MS)).toEqual({
      ok: false,
      reason: 'wrong-type',
    });
  });
});

describe('ingestLifecycleEventMessage', () => {
  it('persists before reporting stored — the ack path depends on this order', async () => {
    const fake = fakeStore();
    const outcome = await ingestLifecycleEventMessage(envelope(), {
      store: fake.store,
      nowMs: () => NOW_MS,
    });

    expect(outcome).toEqual({ kind: 'stored' });
    expect(fake.events).toHaveLength(1);
  });

  it('reports duplicate for a replayed eventId and still lets the caller ack', async () => {
    // Dedupe nằm ở store (PRIMARY KEY `event_id`): replay trả `duplicate`, ingest
    // KHÔNG biến nó thành lỗi — caller ack như thường.
    const fake = fakeStore('duplicate');
    const outcome = await ingestLifecycleEventMessage(envelope(), {
      store: fake.store,
      nowMs: () => NOW_MS,
    });

    expect(outcome).toEqual({ kind: 'duplicate' });
  });

  it('quarantines a malformed payload instead of retrying it', async () => {
    const fake = fakeStore();
    const outcome = await ingestLifecycleEventMessage('{broken', {
      store: fake.store,
      nowMs: () => NOW_MS,
    });

    // Payload hỏng không bao giờ hợp lệ hơn bằng cách retry — quarantine là đích.
    expect(outcome).toEqual({ kind: 'quarantined', reason: 'unparseable' });
    expect(fake.events).toHaveLength(0);
  });

  it('reports transient when the store throws and nothing was persisted', async () => {
    const fake = fakeStore('throw');
    const outcome = await ingestLifecycleEventMessage(envelope(), {
      store: fake.store,
      nowMs: () => NOW_MS,
    });

    // Chưa có gì bền vững — Queue retry là an toàn và là đường đúng.
    expect(outcome).toEqual({ kind: 'transient' });
  });

  it('does not let the store see a payload it did not normalize', async () => {
    // Store chỉ bao giờ nhận model đã chuẩn hoá — không có đường raw payload nào.
    const fake = fakeStore();
    await ingestLifecycleEventMessage(envelope(), { store: fake.store, nowMs: () => NOW_MS });

    expect(fake.events[0]).toEqual({
      eventId: 'evt-1',
      type: 'delivered',
      messageId: '0101018f7d0c4d9a-msg-sentinel',
      occurredAt: NOW_MS - 5000,
      terminal: true,
      reasonToken: null,
    });
  });
});
