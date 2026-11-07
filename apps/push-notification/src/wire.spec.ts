/**
 * Unit test cho `wire.ts` — biên HTTP dùng chung của mọi route.
 *
 * ⚠️ **Ba hàm ánh xạ reason → status là ba hợp đồng với ba consumer khác nhau**, và mỗi giá
 * trị status là một quyết định đã được tài liệu hoá (ví dụ `no_eligible_subscription` là 400
 * chứ không phải 404 — caller gửi notification hợp lệ, chỉ là không ai nhận). Test dưới đây
 * ghim **từng** reason của từng tập, nên việc thêm một reason mà quên quyết định status là
 * đỏ ngay tại CI, không phải lúc production trả 400 cho một lỗi chưa phân loại.
 *
 * ⚠️ **Body rỗng → `{}` của `readJsonObject` và bắt buộc rỗng của `readEmptyRequestBody` là
 * hai hợp đồng tách biệt.** Gộp chúng lại thì một request mang dữ liệu thật mà thiếu body
 * bị âm thầm coi là `{}` — client nhận 400 với lý do không đúng nguyên nhân.
 */

import { describe, expect, it } from 'vitest';

import {
  CREATE_NOTIFICATION_REJECTION,
  INVENTORY_REJECTION,
} from '@ecoma-io/push-notification-application';

import {
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  adminRejectionStatus,
  inventoryRejectionStatus,
  isPlainRecord,
  json,
  notificationRejectionStatus,
  problem,
  readEmptyRequestBody,
  readJsonObject,
  readLimit,
  readNonEmptyString,
  readRequiredString,
} from './wire';

function requestWithBody(body: string): Request {
  return new Request('https://push.internal/v1/whatever', { method: 'POST', body });
}

describe('json and problem — the two response builders', () => {
  it('serializes a JSON body with the content-type header and default status 200', async () => {
    const response = json({ ok: true });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('honors an explicit status and extra headers', async () => {
    const response = json({ error: 'x' }, 503, { 'retry-after': '5' });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('problem puts reason and detail in the documented body shape', async () => {
    const response = problem(404, 'not_found', 'Không có route này.');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'not_found',
      detail: 'Không có route này.',
    });
  });
});

describe('isPlainRecord — the object gate before every body parse', () => {
  it('accepts plain objects and rejects arrays, null and primitives', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord([1, 2])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord('x')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
  });
});

describe('readJsonObject — JSON object body with empty meaning "{}"', () => {
  it('treats an empty body as an empty object (Worker callers often POST without a body)', async () => {
    const result = await readJsonObject(requestWithBody(''));

    expect(result).toEqual({ ok: true, value: {} });
  });

  it('treats a whitespace-only body as empty', async () => {
    const result = await readJsonObject(requestWithBody('   \n\t'));

    expect(result).toEqual({ ok: true, value: {} });
  });

  it('parses a JSON object body', async () => {
    const result = await readJsonObject(requestWithBody('{"app":"ecoma-io"}'));

    expect(result).toEqual({ ok: true, value: { app: 'ecoma-io' } });
  });

  it('rejects an unparseable body with a detail for the 400', async () => {
    const result = await readJsonObject(requestWithBody('{not json'));

    expect(result).toEqual({ ok: false, detail: 'Body không parse được thành JSON.' });
  });

  it('rejects a JSON array or scalar as "must be an object"', async () => {
    const asArray = await readJsonObject(requestWithBody('[1,2]'));
    const asNumber = await readJsonObject(requestWithBody('42'));

    expect(asArray).toEqual({ ok: false, detail: 'Body phải là object JSON.' });
    expect(asNumber).toEqual({ ok: false, detail: 'Body phải là object JSON.' });
  });
});

describe('readEmptyRequestBody — endpoints whose contract requires an empty body', () => {
  it('accepts an absent body and an empty JSON object', async () => {
    expect(await readEmptyRequestBody(requestWithBody(''))).toEqual({ ok: true });
    expect(await readEmptyRequestBody(requestWithBody('{}'))).toEqual({ ok: true });
  });

  it('rejects a body carrying any field so claim cannot be steered by the caller', async () => {
    // §8.1: claim không nhận tham số điều khiển state nào — nhận chúng biến lease thành thứ
    // caller điều khiển được và phá "predicate claim là nguồn duy nhất của thắng/thua".
    const result = await readEmptyRequestBody(requestWithBody('{"lease_duration":999999}'));

    expect(result).toEqual({ ok: false, detail: 'Body phải rỗng.' });
  });

  it('rejects non-object bodies with the empty-body detail', async () => {
    const result = await readEmptyRequestBody(requestWithBody('"text"'));

    expect(result).toEqual({ ok: false, detail: 'Body phải là object JSON rỗng.' });
  });

  it('rejects an unparseable body instead of pretending it was empty', async () => {
    const result = await readEmptyRequestBody(requestWithBody('garbage'));

    expect(result).toEqual({ ok: false, detail: 'Body phải là object JSON rỗng.' });
  });
});

describe('notificationRejectionStatus — Application API contract', () => {
  it('maps every declared rejection to its documented status', () => {
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.AppMismatch)).toBe(403);
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.IdempotencyKeyMissing)).toBe(
      400,
    );
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.IdempotencyKeyTooLong)).toBe(
      400,
    );
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.IdempotencyKeyConflict)).toBe(
      409,
    );
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.RateLimited)).toBe(429);
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.StorageFailure)).toBe(503);
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.InvalidPayload)).toBe(400);
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.PayloadOverBudget)).toBe(400);
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.FanoutLimitExceeded)).toBe(
      400,
    );
    // `no_eligible_subscription` là 400, KHÔNG phải 404: caller gửi notification hợp lệ,
    // chỉ là không có ai nhận — 404 sẽ bảo caller rằng endpoint không tồn tại.
    expect(notificationRejectionStatus(CREATE_NOTIFICATION_REJECTION.NoEligibleSubscription)).toBe(
      400,
    );
  });

  it('throws on an unknown reason instead of returning a silent 200/400', () => {
    // Một reason mới mà chưa có status là một khoảng trống của contract — guard lúc chạy
    // bắt nó thay vì trả một status mặc định sai.
    expect(() =>
      notificationRejectionStatus(
        'brand_new_reason' as Parameters<typeof notificationRejectionStatus>[0],
      ),
    ).toThrow(/reason chưa khai báo status/u);
  });

  it('covers every value of the application vocabulary so a new one fails the throw-guard test', () => {
    // Nhân bản tường minh tập hằng: thêm một giá trị ở lib mà quên mapping thì test "maps
    // every declared rejection" sẽ không biết; test này đỏ để buộc quyết định status mới.
    expect(Object.keys(CREATE_NOTIFICATION_REJECTION)).toHaveLength(10);
  });
});

describe('inventoryRejectionStatus — Device/Subscription contract', () => {
  it('maps every declared rejection to its documented status', () => {
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.AppMismatch)).toBe(403);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.DeviceNotFound)).toBe(404);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.SubscriptionNotFound)).toBe(404);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.DeviceOwnedByAnotherUser)).toBe(409);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.EndpointOwnedByAnotherDevice)).toBe(409);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.SubscriptionExpired)).toBe(409);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.NoProviderForScope)).toBe(409);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.VapidKeyUnavailable)).toBe(409);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.StorageFailure)).toBe(503);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.InvalidPayload)).toBe(400);
    expect(inventoryRejectionStatus(INVENTORY_REJECTION.EndpointRejected)).toBe(400);
  });

  it('defaults unknown reasons to 400 instead of throwing (inventory vocabulary is closed)', () => {
    expect(
      inventoryRejectionStatus(
        'brand_new_reason' as Parameters<typeof inventoryRejectionStatus>[0],
      ),
    ).toBe(400);
  });
});

describe('adminRejectionStatus — Admin API contract', () => {
  it('maps every admin rejection string to its documented status', () => {
    expect(adminRejectionStatus('provider_not_found')).toBe(404);
    expect(adminRejectionStatus('subscription_not_found')).toBe(404);
    expect(adminRejectionStatus('delivery_not_found')).toBe(404);
    expect(adminRejectionStatus('app_mismatch')).toBe(403);
    expect(adminRejectionStatus('state_mismatch')).toBe(409);
    expect(adminRejectionStatus('open_outbox_intent')).toBe(409);
    expect(adminRejectionStatus('provider_held')).toBe(409);
    expect(adminRejectionStatus('recovery_precondition_failed')).toBe(409);
    expect(adminRejectionStatus('storage_failure')).toBe(503);
  });

  it('defaults unknown reasons to 400', () => {
    expect(adminRejectionStatus('transport_out_of_scope')).toBe(400);
    expect(adminRejectionStatus('anything_else')).toBe(400);
  });
});

describe('string and limit readers — the last guard before SQL', () => {
  it('readRequiredString returns null for an empty string so the route answers 400, not SQL CHECK', () => {
    expect(readRequiredString({ deviceId: 'device-1' }, 'deviceId')).toBe('device-1');
    expect(readRequiredString({ deviceId: '' }, 'deviceId')).toBeNull();
    expect(readRequiredString({}, 'deviceId')).toBeNull();
    expect(readRequiredString({ deviceId: 42 }, 'deviceId')).toBeNull();
  });

  it('readNonEmptyString is the same guard for path params', () => {
    expect(readNonEmptyString('sub-1')).toBe('sub-1');
    expect(readNonEmptyString('')).toBeNull();
    expect(readNonEmptyString(undefined)).toBeNull();
  });

  it('readLimit defaults to 50 when the parameter is absent or malformed', () => {
    expect(readLimit(new URL('https://push.internal/admin/v1/notifications'))).toBe(
      ADMIN_LIST_LIMIT_DEFAULT,
    );
    expect(readLimit(new URL('https://x/?limit=abc'))).toBe(ADMIN_LIST_LIMIT_DEFAULT);
    expect(readLimit(new URL('https://x/?limit=-5'))).toBe(ADMIN_LIST_LIMIT_DEFAULT);
    expect(readLimit(new URL('https://x/?limit=0'))).toBe(ADMIN_LIST_LIMIT_DEFAULT);
  });

  it('readLimit clamps oversized values to the table-scan ceiling', () => {
    // `limit` đi thẳng vào LIMIT của SQL — 1e9 là một câu quét bảng do client quyết định.
    expect(readLimit(new URL('https://x/?limit=1000000'))).toBe(ADMIN_LIST_LIMIT_MAX);
    expect(readLimit(new URL('https://x/?limit=200'))).toBe(200);
    expect(readLimit(new URL('https://x/?limit=199'))).toBe(199);
    expect(readLimit(new URL('https://x/?limit=1'))).toBe(1);
  });
});
