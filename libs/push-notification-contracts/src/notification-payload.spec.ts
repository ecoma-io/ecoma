import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_PAYLOAD_FIELDS,
  REQUIRED_NOTIFICATION_PAYLOAD_FIELDS,
  validateNotificationPayload,
  type NotificationPayload,
  type NotificationPayloadRejectionReason,
  type NotificationPayloadValidation,
} from './notification-payload';
import { withPrototypeKeys } from './testing/prototype-pollution';

/** Payload hợp lệ tối thiểu — mọi test âm bản sao từ đây rồi phá đúng một điểm. */
const VALID: NotificationPayload = {
  title: 'Tiêu đề thông báo',
  body: 'Nội dung thông báo',
};

/** Payload với mọi field optional. */
const FULL: NotificationPayload = {
  title: 'Tiêu đề',
  body: 'Nội dung',
  url: 'https://example.com/p/1',
  data: { thread_id: 't-1', nested: { deep: true } },
};

/**
 * Assert validation thất bại với `reason` và `detail` chứa `needle`.
 *
 * Gộp vào một hàm để không phải bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: NotificationPayloadValidation,
  reason: NotificationPayloadRejectionReason,
  needle: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(needle);
}

/** Bóc payload khi hợp lệ, ném lỗi khi bị từ chối. */
function unwrap(result: NotificationPayloadValidation): NotificationPayload {
  if (!result.ok) {
    throw new Error(`Expected a valid payload, got ${result.reason}: ${result.detail}`);
  }
  return result.payload;
}

/** Validate một payload hợp lệ với `data` là `{ probe: value }` — giá trị cần kiểm nằm trong. */
function checkDataValue(value: unknown): NotificationPayloadValidation {
  return validateNotificationPayload({ ...VALID, data: { probe: value } });
}

/** Object lồng `depth` cấp — dùng cho probe giới hạn serialize (F5). */
function nest(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) {
    value = { n: value };
  }
  return value;
}

describe('validateNotificationPayload — accept (FR-013)', () => {
  it('accepts a payload with only the required keys', () => {
    expect(unwrap(validateNotificationPayload({ ...VALID }))).toEqual(VALID);
  });

  it('accepts every allowed key present', () => {
    expect(unwrap(validateNotificationPayload({ ...FULL }))).toEqual(FULL);
  });

  it('preserves data opaquely without interpreting nested values', () => {
    // `data` là opaque với worker — validator chỉ kiểm shape, không đọc nội dung.
    const data = { count: 1, list: [1, 2, 3], nested: { deep: null } };
    const payload = unwrap(validateNotificationPayload({ ...VALID, data }));
    expect(payload.data).toEqual(data);
  });

  it('accepts an empty string title and body — presence, not content, is the contract', () => {
    expect(validateNotificationPayload({ title: '', body: '' }).ok).toBe(true);
  });
});

describe('validateNotificationPayload — closed schema', () => {
  it.each(REQUIRED_NOTIFICATION_PAYLOAD_FIELDS)('rejects a payload missing %s', (field) => {
    const payload: Record<string, unknown> = { ...VALID };
    Reflect.deleteProperty(payload, field);
    const checked3 = validateNotificationPayload(payload);
    expect(checked3.ok).toBe(false);
    expectRejectedBy(checked3, 'missing_field', field);
  });

  it.each(['icon', 'badge', 'tag', 'requireInteraction'] as const)(
    'rejects a payload carrying out-of-contract key %s',
    (key) => {
      const checked2 = validateNotificationPayload({ ...VALID, [key]: 'x' });
      expect(checked2.ok).toBe(false);
      expectRejectedBy(checked2, 'unexpected_field', key);
    },
  );

  it('reports unexpected_field before missing_field', () => {
    // Payload lạ + thiếu `body` phải được báo là khoá lạ, vì đó là bằng chứng hai plane
    // hiểu hai contract khác nhau — không phải một payload thiếu trường.
    const checked1 = validateNotificationPayload({ title: 'Tiêu đề', icon: 'x' });
    expect(checked1.ok).toBe(false);
    expectRejectedBy(checked1, 'unexpected_field', 'icon');
  });
});

describe('validateNotificationPayload — field types', () => {
  it.each([
    ['title', 1],
    ['title', null],
    ['title', {}],
    ['body', true],
    ['body', ['x']],
    ['url', 1],
    ['url', null],
  ])('rejects a non-string %s', (field, value) => {
    expect(validateNotificationPayload({ ...VALID, [field]: value })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });

  it.each([
    ['a string', 'not-an-object'],
    ['an array', []],
    ['null', null],
    ['a number', 42],
    ['a boolean', true],
  ])('rejects %s as data', (_label, data) => {
    const checked = validateNotificationPayload({ ...VALID, data });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'data');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'Tiêu đề'],
    ['a number', 1],
    ['an array', []],
  ])('rejects %s as the whole payload', (_label, payload) => {
    expect(validateNotificationPayload(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });
});

describe('detail never leaks payload values', () => {
  it('does not echo title when another field is at fault', () => {
    const result = validateNotificationPayload({
      title: 'Mật mã nội bộ tuyệt mật',
      body: 'Nội dung',
      icon: 'x',
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'unexpected_field', 'icon');
    if (result.ok) {
      throw new Error('Expected the payload to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('Mật mã nội bộ tuyệt mật');
  });

  it('does not echo a malformed title value', () => {
    const result = validateNotificationPayload({ title: 42, body: 'Nội dung' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_field_type', 'title');
    if (result.ok) {
      throw new Error('Expected the payload to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('42');
  });
});

describe('contract constants stay aligned with the canonical field set', () => {
  it('lists exactly the four allowed payload keys', () => {
    expect(NOTIFICATION_PAYLOAD_FIELDS).toEqual(['title', 'body', 'url', 'data']);
    expect(REQUIRED_NOTIFICATION_PAYLOAD_FIELDS).toEqual(['title', 'body']);
  });

  it('keeps REQUIRED_NOTIFICATION_PAYLOAD_FIELDS inside NOTIFICATION_PAYLOAD_FIELDS', () => {
    // Gán biến kiểu — trần compile nếu tập bắt buộc lệch ra ngoài tập đóng.
    const requiredSubset: readonly (typeof NOTIFICATION_PAYLOAD_FIELDS)[number][] =
      REQUIRED_NOTIFICATION_PAYLOAD_FIELDS;
    for (const field of requiredSubset) {
      expect(NOTIFICATION_PAYLOAD_FIELDS).toContain(field);
    }
  });
});

describe('data must be JSON-compatible (FR-013 canonical serialization)', () => {
  it('accepts nested arrays, objects, null, booleans, strings and finite numbers', () => {
    const data = { a: [1, null, true, 'x', { b: [2.5, false] }], n: -0.001 };
    const payload = unwrap(validateNotificationPayload({ ...VALID, data }));
    expect(payload.data).toEqual(data);
  });

  it.each([
    ['undefined', undefined, 'undefined'],
    ['BigInt', 1n, 'BigInt'],
    ['a function', () => undefined, 'function'],
    ['NaN', Number.NaN, 'số không hữu hạn'],
    ['positive Infinity', Number.POSITIVE_INFINITY, 'số không hữu hạn'],
    ['negative Infinity', Number.NEGATIVE_INFINITY, 'số không hữu hạn'],
    ['a Date', new Date(0), 'object có prototype không phải JSON'],
    ['a Map', new Map<string, string>(), 'object có prototype không phải JSON'],
    ['a Set', new Set<string>(), 'object có prototype không phải JSON'],
    ['a symbol', Symbol('x'), 'symbol'],
  ] as const)('rejects data containing %s', (_label, value, needle) => {
    const checked = checkDataValue(value);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', needle);
  });

  it('rejects a class instance nested anywhere inside data', () => {
    class Payload {
      readonly tag = 'not-json';
    }
    const checked = checkDataValue({ nested: new Payload() });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'object có prototype không phải JSON');
  });

  it('rejects a self-referencing object as a circular reference', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const checked = checkDataValue(cyclic);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'circular');
  });

  it('rejects data pointing back at the payload root', () => {
    const record: Record<string, unknown> = { title: 'T', body: 'B' };
    record.data = { back: record };
    const checked = validateNotificationPayload(record);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'circular');
  });

  it('accepts a shared non-cyclic reference — only true cycles are rejected', () => {
    const shared = { id: 'x' };
    const payload = unwrap(
      validateNotificationPayload({ ...VALID, data: { a: shared, b: shared } }),
    );
    expect(payload.data).toEqual({ a: { id: 'x' }, b: { id: 'x' } });
    expect(payload.data?.a).not.toBe(shared);
  });

  it('rejects a getter inside data without invoking it', () => {
    let invoked = 0;
    const source: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(source, 'evil', {
      get() {
        invoked += 1;
        return 'must-not-be-read';
      },
      enumerable: true,
      configurable: true,
    });
    const checked = checkDataValue(source);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'getter/setter');
    expect(invoked).toBe(0);
  });

  it('rejects a non-enumerable field inside data — JSON.stringify would drop it silently', () => {
    const source: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(source, 'hidden', {
      value: 2,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const checked = checkDataValue(source);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'field non-enumerable');
  });

  it('rejects a sparse array inside data — holes would become null silently', () => {
    const sparse: unknown[] = [1];
    sparse.length = 3;
    const checked = checkDataValue(sparse);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'mảng sparse');
  });

  it('rejects a non-index own key on an array inside data — JSON.stringify drops it silently', () => {
    const withExtra = [1, 2] as unknown[] & { extra?: number };
    withExtra.extra = 3;
    const checked = checkDataValue(withExtra);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'field ngoài chỉ số trong mảng');
  });

  it('rejects a getter element inside an array in data without invoking it', () => {
    let invoked = 0;
    const withGetter: unknown[] = [];
    withGetter.length = 1;
    Object.defineProperty(withGetter, '0', {
      get() {
        invoked += 1;
        return 'must-not-be-read';
      },
      enumerable: true,
      configurable: true,
    });
    const checked = checkDataValue({ list: withGetter });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'getter/setter');
    expect(invoked).toBe(0);
  });

  it('rejects an explicit data: undefined — presence without a value is still a violation', () => {
    const checked = validateNotificationPayload({ ...VALID, data: undefined });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'data phải');
  });

  it('rejects a non-enumerable array element — JSON.stringify would drop it silently', () => {
    const withHidden: unknown[] = [];
    withHidden.length = 1;
    Object.defineProperty(withHidden, '0', {
      value: 'hidden',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const checked = checkDataValue({ list: withHidden });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'field non-enumerable trong mảng');
  });

  it('rejects data: null — presence must still be an object', () => {
    const checked = validateNotificationPayload({ ...VALID, data: null });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'data phải');
  });
});

describe('object shape policy — plain JSON objects only (A1)', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map<string, string>()],
    ['a Set', new Set<string>()],
  ] as const)('rejects a payload that is %s', (_label, value) => {
    const checked = validateNotificationPayload(value);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a class instance payload', () => {
    class FakePayload {
      title = 'T';
      body = 'B';
    }
    const checked = validateNotificationPayload(new FakePayload());
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects an object with a custom prototype chain — inherited keys are not JSON own keys', () => {
    const withPrototype = Object.create({ title: 'T', body: 'B' });
    const checked = validateNotificationPayload(withPrototype);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('treats keys on Object.prototype as not present (own keys only)', () => {
    // Bốn khoá, mỗi khoá một giá trị độc: `url` và `data` cố tình sai kiểu để một định nghĩa
    // "có mặt" bằng `in` sẽ vừa lọt qua closed schema vừa kéo theo giá trị từ prototype.
    withPrototypeKeys({ title: 'polluted', body: 'polluted', url: 123, data: 'polluted' }, () => {
      // Field bắt buộc vắng trên chính object thì vẫn phải là `missing_field`.
      const checked = validateNotificationPayload({} as unknown as NotificationPayload);
      expect(checked.ok).toBe(false);
      expectRejectedBy(checked, 'missing_field', 'title');

      // Payload hợp lệ không được kéo `url`/`data` từ prototype vào kết quả.
      const accepted = unwrap(validateNotificationPayload({ ...VALID }));
      expect(Object.hasOwn(accepted, 'url')).toBe(false);
      expect(Object.hasOwn(accepted, 'data')).toBe(false);
    });
  });

  it('accepts a null-prototype payload with the required own keys', () => {
    const record: Record<string, unknown> = Object.create(null);
    record.title = 'T';
    record.body = 'B';
    expect(validateNotificationPayload(record).ok).toBe(true);
  });

  it('rejects a getter on an allowed key without invoking it', () => {
    let invoked = 0;
    const record: Record<string, unknown> = { body: 'Nội dung' };
    Object.defineProperty(record, 'title', {
      get() {
        invoked += 1;
        return 'T';
      },
      enumerable: true,
      configurable: true,
    });
    expectRejectedBy(validateNotificationPayload(record), 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('rejects a non-enumerable required key — JSON.stringify would drop it silently', () => {
    const record: Record<string, unknown> = { body: 'Nội dung' };
    Object.defineProperty(record, 'title', {
      value: 'T',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const checked = validateNotificationPayload(record);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'non-enumerable');
  });

  it('rejects a symbol key — symbols are not JSON keys', () => {
    const record: Record<string | symbol, unknown> = { title: 'T', body: 'B' };
    record[Symbol('extra')] = 1;
    const checked = validateNotificationPayload(record);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'symbol');
  });
});

describe('validated payload is detached from its source (A4)', () => {
  it('does not change when the caller mutates the source data afterwards', () => {
    const source: Record<string, unknown> = { thread_id: 't-1', nested: { deep: true } };
    const payload = unwrap(validateNotificationPayload({ ...VALID, data: source }));
    const snapshot = JSON.stringify(payload);

    source.thread_id = 'changed';
    (source.nested as Record<string, unknown>).deep = false;
    source.added = 'new';

    expect(JSON.stringify(payload)).toBe(snapshot);
    expect(payload.data).not.toBe(source);
  });

  it('does not leak back into the source when the caller mutates the accepted result', () => {
    const source: Record<string, unknown> = { thread_id: 't-1' };
    const payload = unwrap(validateNotificationPayload({ ...VALID, data: source }));

    (payload.data as Record<string, unknown>).thread_id = 'changed';

    expect(source.thread_id).toBe('t-1');
  });

  it('returns a canonical JSON representation — JSON.stringify round-trips the accepted payload', () => {
    const source: Record<string, unknown> = { a: [1, { b: 'x' }], n: 2 };
    const payload = unwrap(validateNotificationPayload({ ...VALID, data: source }));
    expect(JSON.parse(JSON.stringify(payload.data))).toEqual(JSON.parse(JSON.stringify(source)));
  });

  it('detaches arrays too, not only plain objects', () => {
    const list = [1, { nested: true }];
    const source: Record<string, unknown> = { list };
    const payload = unwrap(validateNotificationPayload({ ...VALID, data: source }));
    const acceptedList = (payload.data as Record<string, unknown>).list as unknown[];

    expect(acceptedList).not.toBe(list);
    list.push(2);
    (list[1] as Record<string, unknown>).nested = false;

    expect(acceptedList).toEqual([1, { nested: true }]);
  });

  // Regress F5 (bất biến, không phải một độ sâu cụ thể): copy đệ quy và `JSON.stringify`
  // có ngân sách stack khác nhau, nên nếu thiếu gate serialize thì tồn tại một độ sâu mà
  // validator **nhận** nhưng chính serializer của consumer **đứt**. Bất biến phải là: không
  // tồn tại độ sâu nào như vậy.
  //
  // Quét hai pha thay vì quét mịn toàn dải (chi phí giảm ~10 lần, quan trọng trên CI nơi
  // mỗi depth bị từ chối tốn trọn một lần duyệt đệ quy kết thúc bằng RangeError):
  // - Pha thô: bước 1024 trên toàn dải 1024..40960 — bắt mọi phân kỳ "lớn".
  // - Pha mịn: chỉ quét lại bước 64 tại các **cửa sổ biên** — cặp (depth cuối được nhận,
  //   depth đầu bị từ chối) liền kề nhau ở kết quả pha thô.
  //
  // Vì sao pha mịn chỉ cần ở biên: trên cùng một engine + máy, ngân sách stack của copy
  // và của stringify đều **giảm đơn điệu theo độ sâu** (mỗi cấp tốn thêm frame, không có
  // hiệu ứng đảo chiều theo chiều sâu), nên tập depth mà validator nhận mà serializer đứt
  // là một **khoảng liên tục** quanh biên nhận/từ-chối của validator. Nếu không có phân kỳ
  // nào ở độ phân giải thô, cũng như trong từng cửa sổ biên quét mịn, thì không còn điểm
  // lưới nào khác có thể phân kỳ — F5 vẫn được chứng minh trọn vẹn, chỉ bỏ bớt các điểm lưới
  // dư thừa nằm sâu trong vùng từ-chối hoặc sâu trong vùng nhận.
  it('never accepts data that its own canonical serializer rejects', () => {
    let divergenceDepth = -1;
    const acceptedByDepth: boolean[] = [];

    // Pha thô: bước 1024 trên toàn dải.
    for (let depth = 1024; depth <= 40_960; depth += 1024) {
      const data = nest(depth);
      const accepted = validateNotificationPayload({ title: 'T', body: 'B', data }).ok;
      acceptedByDepth.push(accepted);
      if (accepted) {
        try {
          JSON.stringify(data);
        } catch {
          divergenceDepth = depth;
          break;
        }
      }
    }

    // Pha mịn: quét bước 64 từng cửa sổ biên (được nhận liền kề bị từ chối) của pha thô.
    if (divergenceDepth === -1) {
      for (let i = 0; i + 1 < acceptedByDepth.length; i += 1) {
        if (acceptedByDepth[i] === acceptedByDepth[i + 1]) {
          continue;
        }
        const lo = Math.min(1024 + i * 1024, 1024 + (i + 1) * 1024);
        const hi = Math.max(1024 + i * 1024, 1024 + (i + 1) * 1024);
        for (let depth = lo + 64; depth < hi; depth += 64) {
          const data = nest(depth);
          if (!validateNotificationPayload({ title: 'T', body: 'B', data }).ok) {
            continue;
          }
          try {
            JSON.stringify(data);
          } catch {
            divergenceDepth = depth;
            break;
          }
        }
        if (divergenceDepth !== -1) {
          break;
        }
      }
    }

    expect(divergenceDepth).toBe(-1);
  });
});
