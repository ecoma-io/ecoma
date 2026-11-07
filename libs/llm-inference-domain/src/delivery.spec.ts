/**
 * Ghim dữ kiện delivery như một chiều độc lập: response đã commit là absorbing,
 * client disconnect là fact chứ không phải cancellation, và thứ tự ghi không
 * phụ thuộc thứ tự giao message.
 */

import { describe, expect, it } from 'vitest';

import {
  INITIAL_CLIENT_DELIVERY,
  commitClientResponse,
  hasClientOutputCommitted,
  isClientDelivery,
  isClientDisconnected,
  recordClientDisconnect,
  type ClientDelivery,
} from './delivery';

const T = 1_700_000_000_000;

function committed(at: number = T): ClientDelivery {
  const result = commitClientResponse(INITIAL_CLIENT_DELIVERY, { committedAt: at });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
}

describe('client delivery facts', () => {
  it('starts with nothing committed and a connected client', () => {
    expect(INITIAL_CLIENT_DELIVERY).toEqual({
      state: 'not_committed',
      committedAt: null,
      disconnectedAt: null,
    });
    expect(hasClientOutputCommitted(INITIAL_CLIENT_DELIVERY)).toBe(false);
    expect(isClientDisconnected(INITIAL_CLIENT_DELIVERY)).toBe(false);
  });

  it('records the first committed response byte', () => {
    const delivery = committed(T + 5);
    expect(hasClientOutputCommitted(delivery)).toBe(true);
    expect(delivery.committedAt).toBe(T + 5);
  });

  it('keeps the first commit time when bytes are committed again', () => {
    const first = committed(T + 5);
    const result = commitClientResponse(first, { committedAt: T + 50 });
    expect(result.ok && result.value.committedAt).toBe(T + 5);
    expect(result.ok && result.value).toBe(first);
  });

  it('records a client disconnect without implying the provider stopped', () => {
    const result = recordClientDisconnect(INITIAL_CLIENT_DELIVERY, {
      disconnectedAt: T + 7,
    });
    expect(result.ok && isClientDisconnected(result.value)).toBe(true);
    expect(result.ok && hasClientOutputCommitted(result.value)).toBe(false);
  });

  it('allows a disconnect after output was committed', () => {
    const result = recordClientDisconnect(committed(T + 5), { disconnectedAt: T + 6 });
    expect(result.ok && result.value.state).toBe('committed');
    expect(result.ok && result.value.disconnectedAt).toBe(T + 6);
  });

  it('rejects committing output after the client disconnected', () => {
    const disconnected = recordClientDisconnect(INITIAL_CLIENT_DELIVERY, {
      disconnectedAt: T + 1,
    });
    if (!disconnected.ok) {
      throw new Error('fixture is invalid');
    }
    expect(commitClientResponse(disconnected.value, { committedAt: T + 2 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_delivery_transition' },
    });
  });

  it('is idempotent for a repeated disconnect and rejects time going backwards', () => {
    const first = recordClientDisconnect(INITIAL_CLIENT_DELIVERY, { disconnectedAt: T + 5 });
    if (!first.ok) {
      throw new Error('fixture is invalid');
    }
    expect(recordClientDisconnect(first.value, { disconnectedAt: T + 5 })).toMatchObject({
      ok: true,
      value: first.value,
    });
    expect(recordClientDisconnect(first.value, { disconnectedAt: T + 4 })).toMatchObject({
      ok: false,
      error: { code: 'timestamp_regression' },
    });
  });

  it('rejects a disconnect recorded before the commit it follows', () => {
    expect(recordClientDisconnect(committed(T + 5), { disconnectedAt: T + 4 })).toMatchObject({
      ok: false,
      error: { code: 'timestamp_regression' },
    });
  });

  it('validates timestamps', () => {
    for (const value of [null, undefined, 1.5, Number.NaN, 'now']) {
      expect(commitClientResponse(INITIAL_CLIENT_DELIVERY, { committedAt: value })).toMatchObject({
        ok: false,
        error: { code: 'invalid_timestamp' },
      });
      expect(
        recordClientDisconnect(INITIAL_CLIENT_DELIVERY, { disconnectedAt: value }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_timestamp' } });
    }
  });

  it('does not mutate the input delivery', () => {
    const input = INITIAL_CLIENT_DELIVERY;
    commitClientResponse(input, { committedAt: T });
    recordClientDisconnect(input, { disconnectedAt: T });
    expect(input).toEqual(INITIAL_CLIENT_DELIVERY);
    expect(Object.isFrozen(input)).toBe(true);
  });
});

describe('isClientDelivery', () => {
  it('accepts both valid shapes', () => {
    expect(isClientDelivery(INITIAL_CLIENT_DELIVERY)).toBe(true);
    expect(isClientDelivery(committed(T))).toBe(true);
  });

  it('rejects inconsistent shapes', () => {
    expect(isClientDelivery({ state: 'committed', committedAt: null, disconnectedAt: null })).toBe(
      false,
    );
    expect(isClientDelivery({ state: 'not_committed', committedAt: T, disconnectedAt: null })).toBe(
      false,
    );
    expect(isClientDelivery({ state: 'streaming', committedAt: null, disconnectedAt: null })).toBe(
      false,
    );
    expect(isClientDelivery(null)).toBe(false);
  });
});
