import { describe, expect, it } from 'vitest';

import { validateDeliveryCommand, type DeliveryCommandV1 } from './delivery-command';
import { validateClaimRejection } from './claim';
import { validateLeaseFencedRejection, validateOutcomeRequest } from './delivery-write';
import { validateInvalidateAck, type InvalidateAck } from './invalidate';
import { validateNotificationPayload } from './notification-payload';
import { scanJsonDataObject } from './shared';
import { withThrowingTrap } from './testing/hostile-reflection';

/**
 * Bất biến: validator là boundary cho dữ liệu **không tin cậy**, nên với **mọi** giá trị đầu
 * vào nó phải trả một kết quả union phân biệt (`ok: false` + reason trong tập đóng), không
 * bao giờ để exception chưa phân loại thoát ra. Accessor ném lỗi đã được diệt trước
 * (`readJsonDataProperty`); `Proxy` đặt trap cho `getPrototypeOf`/`ownKeys`
 * /`getOwnPropertyDescriptor`/`get` là cùng loại vấn đề ở tầng phản chiếu — nếu lọt, caller
 * nhận exception thay vì một lần từ chối, mất hẳn khả năng phân loại metric/alert.
 *
 * Phạm vi là **validator** (nhận body thô từ wire); builder nhận input đã đóng kiểu.
 */

const VALID_ENVELOPE: DeliveryCommandV1 = {
  version: 1,
  delivery_id: 'dlv_123',
  notification_id: 'ntf_123',
  subscription_id: 'sub_123',
  provider_id: 'prv_123',
  transport: 'web',
  payload: { title: 'Tiêu đề', body: 'Nội dung' },
};

const VALID_INVALIDATE_ACK: InvalidateAck = { subscription_id: 'sub_1', status: 'disabled' };

/** Gọi `fn`: trả kết quả của nó, hoặc chuỗi mô tả exception đã thoát ra ngoài boundary. */
function rejectionOrEscape<T extends { readonly ok: boolean }>(fn: () => T): T | string {
  try {
    return fn();
  } catch (error: unknown) {
    return `ESCAPED: ${(error as Error).message}`;
  }
}

/**
 * Assert lần gọi bị **từ chối** chứ không throw, rồi trả kết quả để test assert thêm
 * `reason`/`detail`. Ném `Error` (không phải `expect`) khi exception lọt để message chỉ rõ
 * label; kiểu trả về giữ nguyên kiểu hẹp của validator.
 */
function expectRejected<T extends { readonly ok: boolean }>(outcome: T | string, label: string): T {
  if (typeof outcome === 'string') {
    throw new Error(`${label}: ${outcome}`);
  }
  expect(outcome.ok).toBe(false);
  return outcome;
}

describe('a Proxy trap that throws never escapes a validator (F1)', () => {
  it.each([
    ['getPrototypeOf', 'getPrototypeOf'],
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
    ['get', 'get'],
  ] as const)('rejects the envelope when its %s trap throws', (_label, trap) => {
    const hostile = withThrowingTrap(trap, VALID_ENVELOPE);
    const outcome = expectRejected(
      rejectionOrEscape(() => validateDeliveryCommand(hostile)),
      `envelope trap ${trap}`,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects the envelope when the descriptor trap throws only on a forbidden key', () => {
    // Vòng kiểm field bị cấm chạy **trước** bước quét và dùng `Object.hasOwn` — trap đó
    // phải được dò ở chính vòng này, nếu không thì exception thoát ra từ bước sớm nhất.
    const hostile = withThrowingTrap('descriptor', VALID_ENVELOPE, 'auth');
    const outcome = expectRejected(
      rejectionOrEscape(() => validateDeliveryCommand(hostile)),
      'descriptor trên khoá bị cấm',
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects the envelope when the get trap throws only on an allowed key', () => {
    // Trap `get` ở khoá **được phép** không bị bước nào trước đó chạm: bước cấm và bước quét
    // chỉ hỏi descriptor. Chỉ khối dò cuối cùng của bước quét mới bắt được nó.
    const hostile = withThrowingTrap('get', VALID_ENVELOPE, 'delivery_id');
    const outcome = expectRejected(
      rejectionOrEscape(() => validateDeliveryCommand(hostile)),
      'get trên khoá được phép',
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects the envelope when the get trap throws on a nested payload key', () => {
    const hostilePayload = withThrowingTrap('get', { title: 'Tiêu đề', body: 'Nội dung' }, 'title');
    const hostile = { ...VALID_ENVELOPE, payload: hostilePayload } as unknown as DeliveryCommandV1;
    const outcome = expectRejected(
      rejectionOrEscape(() => validateDeliveryCommand(hostile)),
      'get trên khoá payload lồng',
    );
    // Lỗi payload được trả nguyên từ schema payload (bước 7), `invalid_payload` được map thành
    // `invalid_field_type` của envelope — điểm cần assert là **không throw**, không phải lý do.
    expect(outcome).toMatchObject({ ok: false });
  });

  it.each([
    ['getPrototypeOf', 'getPrototypeOf'],
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
    ['get', 'get'],
  ] as const)('rejects the top-level payload when its %s trap throws', (_label, trap) => {
    const hostile = withThrowingTrap(trap, { title: 'Tiêu đề', body: 'Nội dung' });
    const outcome = expectRejected(
      rejectionOrEscape(() => validateNotificationPayload(hostile)),
      `payload trap ${trap}`,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects payload data whose prototype trap throws', () => {
    // `data` là container opaque: `isPlainObject(record.data)` chạm trap `getPrototypeOf`, và
    // ném ở đó phải thành `invalid_field_type`, không phải exception.
    const hostileData = withThrowingTrap('getPrototypeOf', {});
    const outcome = expectRejected(
      rejectionOrEscape(() =>
        validateNotificationPayload({ title: 'Tiêu đề', body: 'Nội dung', data: hostileData }),
      ),
      'getPrototypeOf trên data',
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_field_type' });
  });

  it.each([
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
  ] as const)('rejects payload data when its %s trap throws inside the copy', (_label, trap) => {
    // `copyJsonCompatible` tự duyệt `ownKeys`/descriptor để dựng bản sao sẽ lên wire; một
    // trap ném ở đây từng làm exception thoát thẳng ra ngoài boundary.
    const hostileData = withThrowingTrap(trap, { a: 1 });
    const outcome = expectRejected(
      rejectionOrEscape(() =>
        validateNotificationPayload({ title: 'Tiêu đề', body: 'Nội dung', data: hostileData }),
      ),
      `data trap ${trap}`,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_field_type' });
  });

  it('rejects a nested array whose element descriptor trap throws', () => {
    // Cùng nhánh mảng, nhưng trap ném ở descriptor của một **phần tử**: guard phải bắt và
    // biến nó thành `invalid_field_type` thay vì để exception thoát ra ngoài boundary.
    const hostileArray = withThrowingTrap('descriptor', [1, 2, 3], '0');
    const outcome = expectRejected(
      rejectionOrEscape(() =>
        validateNotificationPayload({
          title: 'Tiêu đề',
          body: 'Nội dung',
          data: { items: hostileArray },
        }),
      ),
      'descriptor trên phần tử mảng lồng',
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_field_type' });
  });

  it('reports a proxy trap, not a Date/Map/Set prototype, for a nested object', () => {
    // Object **lồng** trong `data` chạm `isPlainObject` ở tầng copy (không phải tầng
    // `isPlainObject(record.data)` như object ở chính `data`), nên cần một lần kiểm lại để
    // diagnostic nói đúng nguyên nhân. Gộp hai nguyên nhân này làm một thì metric đọc log
    // không phân biệt được "payload chứa Date" với "payload chứa Proxy thù địch".
    const hostileNested = withThrowingTrap('getPrototypeOf', { a: 1 });
    const outcome = expectRejected(
      rejectionOrEscape(() =>
        validateNotificationPayload({
          title: 'Tiêu đề',
          body: 'Nội dung',
          data: { nested: hostileNested },
        }),
      ),
      'getPrototypeOf trên object lồng',
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_field_type' });
    if (outcome.ok || outcome.reason !== 'invalid_field_type') {
      throw new Error('Expected an invalid_field_type rejection.');
    }
    expect(outcome.detail).toContain('phản chiếu');
    expect(outcome.detail).not.toContain('Date/Map/Set');
  });

  it('copies a nested array whose get trap throws on length without triggering it', () => {
    // Mảng lồng trong `data`: `copyJsonCompatible` đi vào nhánh mảng và phải đọc `length`
    // **qua descriptor** — đọc thẳng `array.length` là một phép `Get` chạy trap `get` của
    // `Proxy`, và exception sẽ thoát ra ngoài boundary. Kết quả đúng ở đây là **nhận**:
    // bản sao dựng từ descriptor nên giá trị vẫn là JSON hợp lệ `[1, 2, 3]`, còn trap
    // không hề bị chạm. (Mảng ở **chính** `data` không đo được nhánh này: `isPlainObject`
    // từ chối nó trước, vì mảng không phải plain object.)
    const hostileArray = withThrowingTrap('get', [1, 2, 3], 'length');
    const outcome = validateNotificationPayload({
      title: 'Tiêu đề',
      body: 'Nội dung',
      data: { items: hostileArray },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error('Expected the nested array to be copied, but it was rejected.');
    }
    expect(outcome.payload.data).toEqual({ items: [1, 2, 3] });
  });

  it('refuses to scan an object with a custom prototype without touching its getters', () => {
    // `scanJsonDataObject` duyệt khoá **vắng** ở khối dò cuối, tức phép đọc đi xuống
    // prototype. Không có guard hình dạng ở đầu hàm thì một object có getter trên prototype
    // sẽ bị kích hoạt — đúng thứ chính sách "không kích hoạt getter của caller" cấm.
    let touched = false;
    const prototypeWithGetter = {
      get delivery_id(): string {
        touched = true;
        return 'dlv_1';
      },
    };
    const record = Object.create(prototypeWithGetter) as Record<string, unknown>;
    const scan = scanJsonDataObject(record, 'Envelope', ['delivery_id']);
    expect(scan.ok).toBe(false);
    expect(touched).toBe(false);
  });

  it.each([
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
    ['get', 'get'],
  ] as const)('rejects the claim 409 when its %s trap throws', (_label, trap) => {
    const hostile = withThrowingTrap(trap, { reason: 'lease_held' });
    const outcome = expectRejected(
      rejectionOrEscape(() => validateClaimRejection(hostile)),
      `claim 409 trap ${trap}`,
    );
    // Reason phải nằm trong vocabulary đã đóng của claim 409 (`invalid_payload` thuộc đó).
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
    ['get', 'get'],
  ] as const)('rejects the lease-fenced 409 when its %s trap throws', (_label, trap) => {
    const hostile = withThrowingTrap(trap, { reason: 'stale_write' });
    const outcome = expectRejected(
      rejectionOrEscape(() => validateLeaseFencedRejection(hostile)),
      `lease-fenced 409 trap ${trap}`,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
    ['get', 'get'],
  ] as const)('rejects the invalidate ack when its %s trap throws', (_label, trap) => {
    const hostile = withThrowingTrap(trap, VALID_INVALIDATE_ACK);
    const outcome = expectRejected(
      rejectionOrEscape(() => validateInvalidateAck(hostile)),
      `invalidate ack trap ${trap}`,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['ownKeys', 'ownKeys'],
    ['descriptor', 'descriptor'],
    ['get', 'get'],
  ] as const)('rejects the outcome request when its %s trap throws', (_label, trap) => {
    const hostile = withThrowingTrap(trap, { dispatch_generation: 1, outcome: 'delivered' });
    const outcome = expectRejected(
      rejectionOrEscape(() => validateOutcomeRequest(hostile)),
      `outcome request trap ${trap}`,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects a revoked proxy passed to a validator (Array.isArray/getPrototypeOf throw)', () => {
    // Proxy revoke khiến **mọi** internal method trên proxy ném `TypeError`, kể cả
    // `[[GetTarget]]` mà `Array.isArray` dùng. `isPlainObject` là lời gọi đầu tiên của mọi
    // validator, nên một Proxy revoked đi thẳng qua `Array.isArray` sẽ ném thay vì trả union
    // phân loại — đúng lỗ hổng mà nhánh phản chiếu này phải khoá lại.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expectRejected(
      rejectionOrEscape(() => validateDeliveryCommand(proxy)),
      'envelope revoked proxy',
    );
    expectRejected(
      rejectionOrEscape(() => validateNotificationPayload(proxy)),
      'payload revoked proxy',
    );
    expectRejected(
      rejectionOrEscape(() => validateInvalidateAck(proxy)),
      'invalidate revoked proxy',
    );
    expectRejected(
      rejectionOrEscape(() => validateOutcomeRequest(proxy)),
      'outcome revoked proxy',
    );
    expectRejected(
      rejectionOrEscape(() => validateClaimRejection(proxy)),
      'claim rejection revoked proxy',
    );
    expectRejected(
      rejectionOrEscape(() => validateLeaseFencedRejection(proxy)),
      'lease-fenced revoked proxy',
    );
    // Chứng minh tiền đề: chính phép phản chiếu thô phải ném, nếu không test này không có
    // nghĩa (một Proxy không revoked sẽ không kích hoạt nhánh bảo vệ nào).
    expect(() => Array.isArray(proxy)).toThrow(TypeError);
  });

  it('rejects a revoked proxy sitting at the payload value inside a plain envelope', () => {
    // `record` ở đây là object lành mạnh, nhưng `record.payload` là revoked proxy: phép đọc
    // thẳng `record.payload` không ném, còn `Array.isArray` thì có. Đây là đường riêng với
    // nhánh top-level.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(
      expectRejected(
        rejectionOrEscape(() => validateDeliveryCommand({ ...VALID_ENVELOPE, payload: proxy })),
        'payload value revoked proxy',
      ).ok,
    ).toBe(false);
  });

  it('rejects a revoked proxy sitting at a nested data value', () => {
    // `data` đi qua `copyJsonCompatibleValue`, nơi `Array.isArray` cũng được gọi trên giá
    // trị lồng — revoked proxy ở đây phải thành `invalid_field_type`, không được thoát.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(
      expectRejected(
        rejectionOrEscape(() =>
          validateNotificationPayload({ title: 'Tiêu đề', body: 'Nội dung', data: proxy }),
        ),
        'data value revoked proxy',
      ).ok,
    ).toBe(false);
  });

  it('keeps accepting ordinary plain objects built from the same keys', () => {
    // Nhóm test trên chỉ có nghĩa nếu object lành mạnh vẫn đi qua: chứng minh khối dò trap
    // không biến mọi object thành từ chối.
    expect(validateDeliveryCommand({ ...VALID_ENVELOPE }).ok).toBe(true);
    expect(validateNotificationPayload({ title: 'Tiêu đề', body: 'Nội dung' }).ok).toBe(true);
    expect(validateClaimRejection({ reason: 'lease_held' }).ok).toBe(true);
    expect(validateLeaseFencedRejection({ reason: 'stale_write' }).ok).toBe(true);
    expect(validateInvalidateAck({ ...VALID_INVALIDATE_ACK }).ok).toBe(true);
    expect(validateOutcomeRequest({ dispatch_generation: 1, outcome: 'delivered' }).ok).toBe(true);
  });
});
