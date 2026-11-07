import { describe, expect, it } from 'vitest';

import {
  CLAIM_REJECTION_REASON_WITH_STATE,
  CLAIM_REJECTION_REASONS,
  FORBIDDEN_CLAIM_REJECTION_FIELDS,
  claimRejection,
  deliveryClaim,
  isClaimRejectionReason,
  validateClaimRejection,
  validateClaimRequest,
  validateDeliveryClaim,
  type ClaimRejectionReason,
  type ClaimResponseRejectionReason,
  type ClaimValidation,
  type ClaimRejectionValidation,
  type ClaimResult,
  type DeliveryClaim,
} from './claim';
import { PROVIDER_TYPE_VALUES, TERMINAL_DELIVERY_STATUS_VALUES } from './shared';
import { withPrototypeKeys } from './testing/prototype-pollution';

/** Body `200` hợp lệ — mọi test âm bản sao từ đây rồi phá đúng một điểm. */
const VALID: DeliveryClaim = {
  delivery_id: 'dlv_123',
  notification_id: 'ntf_123',
  app: 'example-app',
  status: 'processing',
  expires_at: '2026-01-01T00:00:00Z',
  dispatch_generation: 1,
  lease_expires_at: '2026-01-01T00:05:00Z',
  transport: 'web',
  provider_id: 'prv_123',
  subscription_id: 'sub_123',
  subscription: {
    endpoint: 'https://push.example.com/sub_123',
    p256dh: 'BNcRflwZu0Z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0',
    auth: 'dGVzdC1hdXRo',
    vapid_key_id: 'vk_1',
  },
  provider: {
    type: 'web-push',
    configuration: { generator: 'ecoma' },
    credential: { public_key: 'public', private_key: 'private' },
  },
};

/** Field bắt buộc của body `200` (mọi field trừ `payload_digest`). */
const REQUIRED_200_FIELDS = [
  'delivery_id',
  'notification_id',
  'app',
  'status',
  'expires_at',
  'dispatch_generation',
  'lease_expires_at',
  'transport',
  'provider_id',
  'subscription_id',
  'subscription',
  'provider',
] as const;

/** Field bắt buộc của `subscription`. */
const REQUIRED_SUBSCRIPTION_FIELDS = ['endpoint', 'p256dh', 'auth', 'vapid_key_id'] as const;

/** Field bắt buộc của `provider`. */
const REQUIRED_PROVIDER_FIELDS = ['type', 'configuration', 'credential'] as const;

/**
 * Assert validation thất bại với `reason` và `detail` chứa `needle`.
 *
 * Gộp vào một hàm để không phải bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: ClaimValidation | ClaimRejectionValidation,
  reason: ClaimResponseRejectionReason,
  needle: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the body to be rejected, but it was accepted.');
  }
  // `needle` là **tên field** bị từ chối — `detail` chỉ được nêu tên, không bao giờ nối giá
  // trị caller gửi vào (xem `detail never echoes` bên dưới).
  expect(result.detail).toContain(needle);
}

/** Bóc claim `200` khi hợp lệ, ném lỗi khi bị từ chối. */
function unwrap(result: ClaimValidation): DeliveryClaim {
  if (!result.ok) {
    throw new Error(`Expected a valid claim, got ${result.reason}: ${result.detail}`);
  }
  return result.claim;
}

describe('validateClaimRequest — empty body, no caller-controlled lease', () => {
  it('accepts an empty object', () => {
    expect(validateClaimRequest({})).toEqual({ ok: true });
  });

  it.each([
    ['a lease duration', { lease_duration: 300 }],
    ['a timestamp', { now: '2026-01-01T00:00:00Z' }],
    ['a generation', { dispatch_generation: 3 }],
    ['a payload', { payload: { title: 'x' } }],
  ])('rejects a body carrying %s', (_label, body) => {
    const result = validateClaimRequest(body);
    expect(result).toMatchObject({ ok: false, reason: 'unexpected_field' });
  });

  it.each([
    ['null', null],
    ['a string', ''],
    ['an array', []],
  ])('rejects %s as the whole request', (_label, body) => {
    expect(validateClaimRequest(body)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });
});

describe('validateDeliveryClaim — accept (§8.1, worker §7)', () => {
  it('accepts a well-formed claim body without payload_digest', () => {
    expect(unwrap(validateDeliveryClaim({ ...VALID }))).toEqual(VALID);
  });

  it('accepts payload_digest as an optional consistency field', () => {
    const claim = unwrap(validateDeliveryClaim({ ...VALID, payload_digest: 'sha256-abc' }));
    expect(claim.payload_digest).toBe('sha256-abc');
  });

  it('accepts a body produced by deliveryClaim, with and without digest', () => {
    expect(validateDeliveryClaim(deliveryClaim({ ...VALID })).ok).toBe(true);
    expect(
      validateDeliveryClaim(deliveryClaim({ ...VALID, payload_digest: 'sha256-abc' })).ok,
    ).toBe(true);
  });

  it('forces status to "processing" in the builder', () => {
    // Ép kiểu qua unknown để mô phỏng caller cố ghi status khác — builder phải chuẩn hoá.
    const built = deliveryClaim({ ...VALID, status: 'delivered' } as unknown as DeliveryClaim);
    expect(built.status).toBe('processing');
  });

  it.each([...TERMINAL_DELIVERY_STATUS_VALUES])(
    'rejects %s as claim status — only "processing" wins a claim',
    (status) => {
      expect(validateDeliveryClaim({ ...VALID, status })).toMatchObject({
        ok: false,
        reason: 'invalid_field_type',
      });
    },
  );
});

describe('validateDeliveryClaim — no second payload source (§3.1 invariant)', () => {
  it('rejects a 200 body carrying payload as a runtime material leak', () => {
    const result = validateDeliveryClaim({
      ...VALID,
      payload: { title: 'Tiêu đề', body: 'Nội dung' },
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'runtime_material_leak', 'payload');
  });

  it('rejects payload_digest carrying a payload-shaped object', () => {
    // Digest là chuỗi; một object ở đây nghĩa là caller đã gửi nhầm payload qua đường digest.
    expect(validateDeliveryClaim({ ...VALID, payload_digest: { title: 'Tiêu đề' } })).toMatchObject(
      { ok: false, reason: 'invalid_field_type' },
    );
  });

  it('rejects an empty payload_digest string', () => {
    expect(validateDeliveryClaim({ ...VALID, payload_digest: '' })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });

  it('does not require payload_digest — a missing digest is not a rejection', () => {
    // Thuật toán digest là open item; từ chối response thiếu digest là sai contract.
    const result = validateDeliveryClaim({ ...VALID });
    expect(result.ok).toBe(true);
  });
});

describe('validateDeliveryClaim — closed body', () => {
  it.each(['retry_after', 'lease_remaining', 'queue_message_id'] as const)(
    'rejects a 200 carrying out-of-contract field %s',
    (field) => {
      const checked7 = validateDeliveryClaim({ ...VALID, [field]: 'x' });
      expect(checked7.ok).toBe(false);
      expectRejectedBy(checked7, 'unexpected_field', field);
    },
  );

  it.each(REQUIRED_200_FIELDS)('rejects a 200 missing %s', (field) => {
    const body: Record<string, unknown> = { ...VALID };
    Reflect.deleteProperty(body, field);
    const checked6 = validateDeliveryClaim(body);
    expect(checked6.ok).toBe(false);
    expectRejectedBy(checked6, 'missing_field', field);
  });

  it.each([
    ['null', null],
    ['a string', 'claim'],
    ['an array', [VALID]],
  ])('rejects %s as the whole body', (_label, body) => {
    expect(validateDeliveryClaim(body)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });
});

describe('validateDeliveryClaim — field types', () => {
  it.each([
    ['expires_at', '2026-01-01'],
    ['expires_at', 'not-a-date'],
    ['lease_expires_at', '2026-01-01T00:00:00'],
    ['dispatch_generation', 0],
    ['dispatch_generation', -1],
    ['dispatch_generation', 1.5],
    ['dispatch_generation', '1'],
    ['delivery_id', ''],
    ['app', ''],
  ])('rejects invalid value for %s', (field, value) => {
    expect(validateDeliveryClaim({ ...VALID, [field]: value })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });

  it.each([...REQUIRED_SUBSCRIPTION_FIELDS])('rejects a subscription with invalid %s', (field) => {
    const result = validateDeliveryClaim({
      ...VALID,
      subscription: { ...VALID.subscription, [field]: '' },
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_field_type', `subscription.${field}`);
  });

  it.each([...REQUIRED_SUBSCRIPTION_FIELDS])('rejects a subscription missing %s', (field) => {
    const sub = { ...VALID.subscription } as Record<string, unknown>;
    Reflect.deleteProperty(sub, field);
    const result = validateDeliveryClaim({ ...VALID, subscription: sub });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'missing_field', `subscription thiếu field: ${field}`);
  });

  it.each(REQUIRED_PROVIDER_FIELDS)('rejects a provider missing %s', (field) => {
    const provider = { ...VALID.provider } as Record<string, unknown>;
    Reflect.deleteProperty(provider, field);
    const checked5 = validateDeliveryClaim({ ...VALID, provider });
    expect(checked5.ok).toBe(false);
    expectRejectedBy(checked5, 'missing_field', `provider thiếu field: ${field}`);
  });

  it.each([...PROVIDER_TYPE_VALUES])(
    'rejects transport %s — transport is Transport, never a provider type',
    (providerType) => {
      expect(validateDeliveryClaim({ ...VALID, transport: providerType })).toMatchObject({
        ok: false,
        reason: 'invalid_field_type',
      });
    },
  );

  it('rejects provider.type = "web" — provider type is never a Transport', () => {
    expect(
      validateDeliveryClaim({
        ...VALID,
        provider: { ...VALID.provider, type: 'web' },
      }),
    ).toMatchObject({ ok: false, reason: 'invalid_field_type' });
  });

  it('rejects non-object subscription and provider', () => {
    expect(validateDeliveryClaim({ ...VALID, subscription: 'sub_123' })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
    expect(validateDeliveryClaim({ ...VALID, provider: 'web-push' })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });

  it('rejects a fifth key inside subscription — the four-field set is closed', () => {
    // `subscription` là tập ĐÓNG (bảng §8.1). Một khoá thứ năm là field ngoài contract,
    // không phải field mở rộng — cùng policy unknown-field "reject" của envelope.
    const checked = validateDeliveryClaim({
      ...VALID,
      subscription: { ...VALID.subscription, expires_at: '2026-01-01T00:00:00Z' },
    });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'unexpected_field', 'expires_at');
  });

  it('rejects a fourth key inside provider — the three-field set is closed', () => {
    const checked = validateDeliveryClaim({
      ...VALID,
      provider: { ...VALID.provider, vapid_private_key: 'x' },
    });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'unexpected_field', 'vapid_private_key');
  });

  it('still accepts opaque extra keys inside configuration and credential', () => {
    // Closure dừng ở `provider`; `configuration`/`credential` là opaque nên khoá bên trong
    // chúng không bị kiểm — nếu không, mọi provider mới sẽ phải sửa contract.
    expect(
      validateDeliveryClaim({
        ...VALID,
        provider: {
          ...VALID.provider,
          configuration: { ttl_seconds: 60, endpoint_template: 'x' },
          credential: { vapid_private_key: 'x', vapid_public_key: 'y' },
        },
      }).ok,
    ).toBe(true);
  });
});

describe('detail never leaks runtime values', () => {
  it('names subscription.auth without echoing its value', () => {
    const result = validateDeliveryClaim({
      ...VALID,
      subscription: { ...VALID.subscription, auth: 1234567890 },
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_field_type', 'subscription.auth');
    if (result.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('1234567890');
  });

  it('does not echo a payload object when payload leaks into the 200', () => {
    const result = validateDeliveryClaim({
      ...VALID,
      payload: { title: 'Nội dung nhạy cảm' },
    });
    if (result.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('Nội dung nhạy cảm');
  });
});

describe('validateClaimRejection — closed 409 body (§8.1)', () => {
  it.each(CLAIM_REJECTION_REASONS.filter((reason) => reason !== 'terminal'))(
    'accepts reason %s without state',
    (reason) => {
      const result = validateClaimRejection({ reason });
      expect(result).toMatchObject({ ok: true, rejection: { reason } });
    },
  );

  it.each([...TERMINAL_DELIVERY_STATUS_VALUES])(
    'accepts reason terminal with state %s',
    (state) => {
      expect(validateClaimRejection({ reason: 'terminal', state })).toMatchObject({
        ok: true,
        rejection: { reason: 'terminal', state },
      });
    },
  );

  it('accepts a body built by claimRejection', () => {
    expect(validateClaimRejection(claimRejection('lease_held')).ok).toBe(true);
    expect(validateClaimRejection(claimRejection('terminal', 'expired')).ok).toBe(true);
  });

  it('rejects a reason outside the closed set', () => {
    const checked4 = validateClaimRejection({ reason: 'retry_later' });
    expect(checked4.ok).toBe(false);
    expectRejectedBy(checked4, 'unknown_reason', 'reason');
    if (checked4.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    // Không nối giá trị caller gửi vào `detail`: reason là chuỗi do bên ngoài kiểm soát và
    // `detail` có thể bị log — một giá trị nhạy cảm đặt vào `reason` sẽ theo đó vào log.
    expect(checked4.detail).not.toContain('retry_later');
  });

  it('rejects claim reasons that belong to no 409 contract', () => {
    for (const reason of ['stale_write', 'ineligible', 'in_progress']) {
      expect(validateClaimRejection({ reason }).ok).toBe(false);
    }
  });

  it('requires state when reason is terminal', () => {
    const checked3 = validateClaimRejection({ reason: 'terminal' });
    expect(checked3.ok).toBe(false);
    expectRejectedBy(checked3, 'state_required', 'terminal');
  });

  it('rejects a non-terminal delivery state as terminal state', () => {
    expect(validateClaimRejection({ reason: 'terminal', state: 'processing' })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
    expect(validateClaimRejection({ reason: 'terminal', state: 'queued' })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });

  it('rejects state on any reason other than terminal', () => {
    const checked2 = validateClaimRejection({ reason: 'lease_held', state: 'failed' });
    expect(checked2.ok).toBe(false);
    expectRejectedBy(checked2, 'state_not_allowed', 'state');
  });

  it('rejects an unexpected field even when reason is valid', () => {
    const checked1 = validateClaimRejection({ reason: 'lease_held', retry_after: 5 });
    expect(checked1.ok).toBe(false);
    expectRejectedBy(checked1, 'unexpected_field', 'retry_after');
  });

  it.each([...FORBIDDEN_CLAIM_REJECTION_FIELDS])(
    'rejects a 409 carrying %s as runtime material leak',
    (field) => {
      const checked = validateClaimRejection({ reason: 'lease_held', [field]: 'x' });
      expect(checked.ok).toBe(false);
      expectRejectedBy(checked, 'runtime_material_leak', field);
    },
  );

  // Tên **cứng** chứ không lấy từ hằng: `it.each(LIST)` tự mất case khi ai đó gỡ một entry
  // khỏi `LIST`, nên không chứng minh được rằng nhóm alias secret protocol
  // (`authorization`/`secret`/`token`/`access_token`) thực sự thuộc danh sách. Trước đây
  // response chặn `auth` nhưng **không** chặn các alias này — cùng một secret báo
  // `runtime_material_leak` ở envelope nhưng chỉ `unexpected_field` ở 409, làm alert lọc theo
  // `runtime_material_leak` bỏ sót đúng thứ lớp kia chặn.
  it.each(['authorization', 'secret', 'token', 'access_token'])(
    'classifies the secret alias %s as a runtime material leak, not an unexpected field',
    (field) => {
      const checked = validateClaimRejection({ reason: 'lease_held', [field]: 'x' });
      expect(checked.ok).toBe(false);
      expectRejectedBy(checked, 'runtime_material_leak', field);
    },
  );

  it('reports runtime material leak before reading reason', () => {
    // Dù reason cũng sai, lỗi nghiêm trọng hơn (rò material) phải được báo trước.
    const result = validateClaimRejection({ reason: 'nope', payload: { title: 'x' } });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'runtime_material_leak', 'payload');
  });

  it.each([
    ['null', null],
    ['a string', 'terminal'],
    ['an array', []],
  ])('rejects %s as the whole 409', (_label, body) => {
    expect(validateClaimRejection(body)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('classifies a missing reason as missing, not as an unknown reason', () => {
    // Ba lỗi khác nhau của cùng một field: vắng hẳn / sai kiểu / ngoài tập đóng. Gộp chúng
    // vào `unknown_reason` làm metric không phân biệt được body thiếu field với lệch version
    // vocabulary — thứ cần hai alert khác nhau.
    const checked = validateClaimRejection({});
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'missing_field', 'reason');
  });

  it('classifies a non-string reason as a wrong type, not as an unknown reason', () => {
    const checked = validateClaimRejection({ reason: 409 });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'reason');
  });
});

describe('claim success and claim rejection are not confusable', () => {
  it('exposes exactly six closed rejection reasons', () => {
    expect(CLAIM_REJECTION_REASONS).toEqual([
      'pending',
      'lease_held',
      'terminal',
      'expired',
      'ineligible_subscription',
      'ineligible_provider_hold',
    ]);
  });

  it.each([
    ['pending', true],
    ['lease_held', true],
    ['terminal', true],
    ['expired', true],
    ['ineligible_subscription', true],
    ['ineligible_provider_hold', true],
    ['stale_write', false],
    ['retry_later', false],
    ['', false],
  ] as const)('isClaimRejectionReason(%o) === %s', (value, expected) => {
    expect(isClaimRejectionReason(value)).toBe(expected);
  });

  it('keeps success and rejection on disjoint shapes', () => {
    // `DeliveryClaim` là body 200; `ClaimResult` mới là union thắng/thua mà worker đọc.
    const success: ClaimResult = { ok: true, claim: deliveryClaim({ ...VALID }) };
    const rejection: ClaimResult = { ok: false, rejection: claimRejection('lease_held') };
    expect(Object.keys(success)).toEqual(['ok', 'claim']);
    expect(Object.keys(rejection)).toEqual(['ok', 'rejection']);
    expect('claim' in rejection).toBe(false);
    expect('rejection' in success).toBe(false);
  });

  it('cannot validate a success body as a rejection, or the reverse', () => {
    // Hai nhánh phải bị chặn lẫn nhau ở tầng parse, không chỉ ở tầng type.
    expect(validateClaimRejection({ ...VALID }).ok).toBe(false);
    expect(validateDeliveryClaim({ reason: 'lease_held' }).ok).toBe(false);
  });

  it('never lets a rejection body carry the claim fields', () => {
    for (const reason of CLAIM_REJECTION_REASONS) {
      const body: Record<string, unknown> =
        reason === 'terminal' ? { reason, state: 'failed' } : { reason };
      const result = validateClaimRejection(body);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`Expected ${reason} to be accepted, got ${result.reason}`);
      }
      expect(
        Object.keys(result.rejection).every((key) => key === 'reason' || key === 'state'),
      ).toBe(true);
      expect('claim' in result.rejection).toBe(false);
      expect('payload' in result.rejection).toBe(false);
    }
  });

  it('rejects a claimRejection built with a state on a non-terminal reason', () => {
    expect(() => claimRejection('lease_held', 'failed')).toThrow(/không được kèm state/u);
  });

  it('rejects a claimRejection built without state on terminal', () => {
    expect(() => claimRejection('terminal')).toThrow(/bắt buộc có state/u);
  });

  // Regress F4: nhánh `state !== undefined` nối `reason` vào message. Trước khi kiểm tập
  // ĐÓNG thì một reason ép kiểu từ JSON chứa xuống dòng sẽ lọt thẳng vào log (log injection).
  it('throws the closed-set message instead of echoing an unvalidated reason', () => {
    let thrown: string | undefined;
    try {
      claimRejection('lease_held\nFAKE LOG LINE' as ClaimRejectionReason, 'failed');
    } catch (error: unknown) {
      thrown = (error as Error).message;
    }

    expect(thrown).toBeDefined();
    expect(thrown).not.toContain('FAKE LOG LINE');
    expect(thrown).toContain('tập đóng');
  });
});

/** Guard ngầm: mẫu `reason`/`state` của ClaimRejectionReason phải khớp hằng đóng. */
describe('ClaimRejectionReason stays in sync with CLAIM_REJECTION_REASONS', () => {
  it('accepts every member of the closed set', () => {
    for (const reason of CLAIM_REJECTION_REASONS) {
      const typedReason: ClaimRejectionReason = reason;
      expect(isClaimRejectionReason(typedReason)).toBe(true);
    }
  });
});

describe('deliveryClaim returns only what validateDeliveryClaim accepts (A3)', () => {
  it('throws when subscription.auth is empty instead of returning a rejected body', () => {
    expect(() =>
      deliveryClaim({
        ...VALID,
        subscription: { ...VALID.subscription, auth: '' },
      }),
    ).toThrow(/invalid_field_type/u);
  });

  it('builds only from named contract fields — extra input keys never reach the body', () => {
    // Builder dựng object mới từ từng field có tên, không spread input: key lạ bị loại ngay
    // ở construction nên không bao giờ tới validator — assert cả hai vế để giữ hành vi này.
    const withExtra = { ...VALID, anything_else: 1 };
    const built = deliveryClaim(withExtra);
    expect(validateDeliveryClaim(built).ok).toBe(true);
    expect(Object.hasOwn(built, 'anything_else')).toBe(false);
  });

  it('returns a body that its own validator accepts', () => {
    expect(validateDeliveryClaim(deliveryClaim({ ...VALID }))).toMatchObject({ ok: true });
  });
});

describe('claim response object shape policy (A1)', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map<string, string>()],
    ['a Set', new Set<string>()],
  ] as const)('rejects a 200 body that is %s', (_label, value) => {
    const checked = validateDeliveryClaim(value);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a class instance 200 body', () => {
    class FakeClaim {
      delivery_id = 'dlv_123';
    }
    const checked = validateDeliveryClaim(new FakeClaim());
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a getter on an allowed 200 field without invoking it', () => {
    let invoked = 0;
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'delivery_id', {
      get() {
        invoked += 1;
        return 'dlv_123';
      },
      enumerable: true,
      configurable: true,
    });
    expectRejectedBy(validateDeliveryClaim(record), 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('rejects a non-enumerable 200 field — JSON.stringify would drop it silently', () => {
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'notification_id', {
      value: 'ntf_123',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const nonEnumerableChecked = validateDeliveryClaim(record);
    expect(nonEnumerableChecked.ok).toBe(false);
    expectRejectedBy(nonEnumerableChecked, 'invalid_payload', 'non-enumerable');
  });

  it('rejects a symbol key on the 200 body — symbols are not JSON keys', () => {
    const record: Record<string | symbol, unknown> = { ...VALID };
    record[Symbol('extra')] = 1;
    const symbolChecked = validateDeliveryClaim(record);
    expect(symbolChecked.ok).toBe(false);
    expectRejectedBy(symbolChecked, 'invalid_payload', 'symbol');
  });

  it('treats Object.prototype keys as not present (own keys only)', () => {
    // `state` của 409 và `delivery_id` của 200: mỗi khoá một giá trị độc để một định nghĩa
    // "có mặt" bằng `in` sẽ vừa lọt qua closed schema vừa kéo giá trị từ prototype vào kết quả.
    withPrototypeKeys({ state: 0, delivery_id: 'dlv_polluted' }, () => {
      const rejection = validateClaimRejection({ reason: CLAIM_REJECTION_REASON_WITH_STATE });
      expect(rejection.ok).toBe(false);
      expectRejectedBy(rejection, 'state_required', 'state');

      const { delivery_id: _dropped, ...withoutDeliveryId } = VALID;
      const claim = validateDeliveryClaim(withoutDeliveryId);
      expect(claim.ok).toBe(false);
      expectRejectedBy(claim, 'missing_field', 'delivery_id');
    });
  });
});

describe('claim result is detached from its source (A4)', () => {
  it('does not change when the caller mutates the source afterwards', () => {
    // `subscription` được dựng lại từng field, còn `configuration`/`credential` là opaque —
    // opaque **không** có nghĩa là chia sẻ tham chiếu với caller.
    const source = {
      ...VALID,
      // Bản sao riêng cho `subscription`: test này **sửa** object nguồn, nên nó không được
      // sửa fixture `VALID` dùng chung của cả file (một spread nông sẽ chia sẻ tham chiếu).
      subscription: { ...VALID.subscription },
      provider: {
        type: 'web-push',
        configuration: { generator: 'ecoma' },
        credential: { public_key: 'public', private_key: 'private' },
      },
    };
    const claim = unwrap(validateDeliveryClaim(source));
    source.subscription.endpoint = 'https://evil.example.com';
    source.provider.configuration.generator = 'CHANGED';
    source.provider.credential.private_key = 'CHANGED';

    expect(claim.subscription.endpoint).toBe(VALID.subscription.endpoint);
    expect(claim.provider.configuration.generator).toBe('ecoma');
    expect(claim.provider.credential.private_key).toBe('private');
  });

  it('does not reach back into the source when the caller mutates the result', () => {
    const source = {
      ...VALID,
      provider: {
        type: 'web-push',
        configuration: { generator: 'ecoma' },
        credential: { public_key: 'public', private_key: 'private' },
      },
    };
    const claim = unwrap(validateDeliveryClaim(source));
    (claim.provider.credential as Record<string, unknown>).injected = 'leak';

    expect('injected' in source.provider.credential).toBe(false);
    expect('injected' in claim.provider.credential).toBe(true);
  });

  it('rejects material that is not JSON-compatible instead of copying it silently', () => {
    // Runtime material đi qua JSON trên wire, nên một giá trị không serialize được nghĩa là
    // response không biểu diễn đúng cái đã gửi — từ chối, không bỏ qua.
    const checked = validateDeliveryClaim({
      ...VALID,
      provider: {
        type: 'web-push',
        configuration: { generator: 'ecoma' },
        credential: { signing_key: new Date(0) },
      },
    });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'provider.credential');
  });

  it('rejects a getter inside opaque material without invoking it', () => {
    let invoked = 0;
    const credential: Record<string, unknown> = { public_key: 'public' };
    Object.defineProperty(credential, 'private_key', {
      get() {
        invoked += 1;
        return 'private';
      },
      enumerable: true,
      configurable: true,
    });
    const checked = validateDeliveryClaim({
      ...VALID,
      provider: { type: 'web-push', configuration: {}, credential },
    });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_field_type', 'provider.credential');
    expect(invoked).toBe(0);
  });
});

describe('claim diagnostics are safe to log (C1)', () => {
  it('sanitizes control characters out of an unexpected 200 field name', () => {
    const checked = validateDeliveryClaim({ ...VALID, ['evil\nInjected']: 1 });
    expectRejectedBy(checked, 'unexpected_field', 'Claim response');
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('evil?Injected');
  });

  it('sanitizes control characters out of a claim request field name', () => {
    const checked = validateClaimRequest({ ['probe\nkey']: 1 });
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('Expected the request to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('probe?key');
  });

  it('sanitizes control characters out of an unexpected 409 field name', () => {
    const checked = validateClaimRejection({ reason: 'busy', ['probe\nkey']: 1 });
    expectRejectedBy(checked, 'unexpected_field', 'Claim 409');
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('probe?key');
  });

  it('never echoes an unknown rejection reason value', () => {
    const checked = validateClaimRejection({ reason: 'leaked-reason-value' });
    expectRejectedBy(checked, 'unknown_reason', 'closed reason set');
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('leaked-reason-value');
  });
});
