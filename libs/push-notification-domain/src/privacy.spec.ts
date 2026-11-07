import { describe, expect, it } from 'vitest';

import {
  DELIVERY_STATUS,
  PROVIDER_STATUS,
  PROVIDER_TYPE,
  SUBSCRIPTION_DISABLE_CAUSE,
  SUBSCRIPTION_STATUS,
  TRANSPORT,
  DELIVERY_TRANSITION_ACTOR,
  canCreateOutboxIntent,
  canRetireEncryptionKey,
  checkPayloadPlaintextBudget,
  decideDeliveryClaim,
  decideFencedWrite,
  decideOutboxClaim,
  disableSubscription,
  evaluateProviderRoutingEligibility,
  expireSubscription,
  planAdministrativeRetry,
  planDeliveryRepublish,
  resolveSubscriptionSigningKeyId,
  selectPrimaryProvider,
  selectSubscriptionsForDevice,
  validateDeliveryTransition,
} from './index';

/**
 * Bất biến privacy: mọi `detail` trong `DomainRejection` là **hằng số** của domain.
 *
 * Nguồn: `docs/applications/push-notification/02-requirements.md` FR-013 ("error không
 * leak payload/secret") và tiêu chí chấp nhận của issue #238 ("không leak
 * payload/secret trong error"). Payload, endpoint, key id và các identifier do caller
 * gửi vào là dữ liệu nhạy cảm — chúng có mặt trong rejection reason theo hợp đồng,
 * nhưng **không bao giờ** được nối vào `detail`.
 *
 * Cách kiểm: gieo một chuỗi canary vào mọi trường string mà caller kiểm soát, ép các
 * hàm đi vào nhánh từ chối, rồi khẳng định canary không xuất hiện ở đâu trong giá
 * trị trả về. Nếu một commit sau này đổi `detail` thành chuỗi nội suy, test này đỏ.
 */

const CANARY = 'CANARY_5f3a1b';

/** `App` bình thường (không mang canary) cho những ca chỉ cần một scope hợp lệ. */
const APP = 'app-a';

/**
 * Số "đáng nhớ" để phân biệt một tham số số bị nội suy vào `detail` — mọi nhánh từ chối
 * dùng số đều dùng giá trị này, nên nếu `detail` nối tham số vào thì chuỗi `'-4242'`
 * sẽ xuất hiện trong giá trị trả về và bị `expect` bắt.
 */
const NUMERIC_CANARY = -4242;

/**
 * Nhận mọi kiểu decision của library (mỗi hàm có kiểu trả về riêng nên không gom
 * được thành một union gọn), ép kiểm tra trên `unknown` thay vì khai `any` để không
 * mất kiểm soát kiểu ở phần còn lại của file.
 */
function expectRejectionWithoutCanary(result: unknown): void {
  const decision = result as { readonly ok?: unknown; readonly detail?: unknown };
  expect(decision?.ok).toBe(false);
  expect(typeof decision?.detail).toBe('string');
  // Toàn bộ giá trị trả về (kể cả `reason` và `detail`) không được chứa giá trị nào
  // của caller — cả canary chuỗi lẫn canary số.
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(CANARY);
  expect(serialized).not.toContain(String(NUMERIC_CANARY));
}

describe('rejection details never echo caller-supplied values', () => {
  it('leaves the canary out of every rejection produced with canary-carrying input', () => {
    const subscription = Object.freeze({
      subscriptionId: `${CANARY}_sub`,
      app: `${CANARY}_sub_app`,
      deviceId: `${CANARY}_device`,
      transport: TRANSPORT.Web,
      status: SUBSCRIPTION_STATUS.Disabled,
    });
    const provider = Object.freeze({
      providerId: `${CANARY}_provider`,
      app: `${CANARY}_app`,
      transport: TRANSPORT.Web,
      type: PROVIDER_TYPE.WebPush,
      status: PROVIDER_STATUS.Disabled,
      emergencyHold: true,
    });
    // State **hợp lệ về shape** — cố ý, để mỗi lời gọi bên dưới đi vào đúng nhánh mà nó
    // định kiểm. Một state dị dạng (ví dụ `dispatchGeneration: -1`) sẽ bị chặn ở
    // `malformed_delivery` trước khi tới nhánh cần kiểm, khiến test "xanh" mà không
    // thực sự chạm tới code đang muốn kiểm — đúng lỗi mà mutation ở `delivery.ts` đã
    // phát hiện trong lần chạy đầu.
    const deliveryState = Object.freeze({
      status: DELIVERY_STATUS.Expired,
      dispatchGeneration: 0,
      // Shape hợp lệ: `leaseExpiresAt` null hoặc hữu hạn, `expiresAt` hữu hạn. Nếu để
      // `NaN` ở đây thì state bị coi là dị dạng và mọi lời gọi dừng ở nhánh đầu tiên.
      leaseExpiresAt: null,
      expiresAt: 0,
    });
    const outboxState = Object.freeze({
      status: `${CANARY}_outbox` as never,
      attempts: -1,
      availableAt: Number.NaN,
      leaseExpiresAt: Number.NaN,
    });

    // Mỗi case là một nhánh từ chối khác nhau, mang ít nhất một trường string do
    // caller kiểm soát. Không case nào được trả về `ok: true`.
    const rejections: readonly unknown[] = [
      // subscription.ts
      disableSubscription(`${CANARY}_status` as never, SUBSCRIPTION_DISABLE_CAUSE.AdminDisable),
      disableSubscription(SUBSCRIPTION_STATUS.Active, `${CANARY}_cause` as never),
      expireSubscription(`${CANARY}_status` as never),

      // provider.ts
      evaluateProviderRoutingEligibility(provider, 'other-app', TRANSPORT.Web),
      evaluateProviderRoutingEligibility(provider, provider.app, TRANSPORT.App),
      selectPrimaryProvider([], provider.app, TRANSPORT.Web),
      selectPrimaryProvider(
        [provider, { ...provider, providerId: `${CANARY}_provider_2` }],
        provider.app,
        TRANSPORT.Web,
      ),

      // routing.ts
      selectSubscriptionsForDevice(provider.app, `${CANARY}_device`, [subscription]),
      selectSubscriptionsForDevice(provider.app, 'other-device', [subscription]),

      // delivery.ts
      validateDeliveryTransition(`${CANARY}_status` as never, DELIVERY_STATUS.Queued, 'claim'),
      decideDeliveryClaim(deliveryState, {
        now: NUMERIC_CANARY,
        leaseDuration: NUMERIC_CANARY,
        // Hai trường status là chuỗi ngoài vocabulary nên mang canary trực tiếp.
        subscriptionStatus: `${CANARY}_subscription_status` as never,
        providerStatus: `${CANARY}_provider_status` as never,
        providerEmergencyHold: false,
      }),
      decideFencedWrite(deliveryState, NUMERIC_CANARY, DELIVERY_TRANSITION_ACTOR.Outcome),
      decideFencedWrite(deliveryState, NUMERIC_CANARY, `${CANARY}_operation` as never),
      planAdministrativeRetry(deliveryState, {
        subscriptionStatus: `${CANARY}_subscription_status` as never,
        providerStatus: `${CANARY}_provider_status` as never,
        providerEmergencyHold: false,
        now: NUMERIC_CANARY,
        hasOpenOutboxIntent: false,
      }),
      planDeliveryRepublish(deliveryState, {
        subscriptionStatus: `${CANARY}_subscription_status` as never,
        providerStatus: `${CANARY}_provider_status` as never,
        providerEmergencyHold: false,
        now: NUMERIC_CANARY,
        hasOpenOutboxIntent: false,
      }),

      // outbox.ts
      decideOutboxClaim(outboxState, NUMERIC_CANARY),
      canCreateOutboxIntent(NUMERIC_CANARY),

      // notification.ts — payload đầy đủ canary ở cả bốn trường.
      checkPayloadPlaintextBudget({
        title: CANARY.repeat(400),
        body: CANARY.repeat(400),
        url: `https://example.com/${CANARY}`,
        data: { secret: CANARY },
      }),
    ];

    expect(rejections.length).toBeGreaterThan(0);
    for (const rejection of rejections) {
      expectRejectionWithoutCanary(rejection);
    }
  });

  it('returns a plain negative for the scalar-returning guard APIs, never the caller value', () => {
    // Ba API này không trả `DomainOk`/`DomainRejection` mà trả scalar (`null` / `false`)
    // vì chúng là cửa chặn cho một quyết định, không phải một quyết định có lý do.
    // Bất biến vẫn là: giá trị caller gửi vào không được xuất hiện ở đầu ra.
    //
    // Ca đầu tiên cố ý phá kiểu: `availableVapidKeys` là `readonly AppVapidKeyRef[]`,
    // nhưng dữ liệu tới từ row DB vẫn có thể null, và `resolveSubscriptionSigningKeyId`
    // tự phòng bằng guard runtime. Đây là ca "input dị dạng" — điều cần khẳng định
    // không phải là kiểu, mà là hàm trả `null` thay vì ném hoặc trả lại giá trị caller.
    expect(
      resolveSubscriptionSigningKeyId(`${CANARY}_app`, `${CANARY}_vapid_key`, null as never),
    ).toBeNull();
    expect(
      resolveSubscriptionSigningKeyId(`${CANARY}_app`, `${CANARY}_vapid_key`, [
        { app: `${CANARY}_app`, vapidKeyId: `${CANARY}_other` },
      ]),
    ).toBeNull();
    // Row DB có thể trả phần tử null trong danh sách key: cũng phải là `null`, không ném.
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [null as never])).toBeNull();
    expect(canRetireEncryptionKey(`${CANARY}_key`, [`${CANARY}_key`])).toBe(false);
    expect(canRetireEncryptionKey('', [`${CANARY}_key`])).toBe(false);
  });

  it('accepts an over-budget payload without echoing its content in the rejection', () => {
    // Tách riêng vì đây là nhánh có nhiều dữ liệu caller-controlled nhất: title,
    // body, url và data đều nằm hoàn toàn trong tay caller.
    const result = checkPayloadPlaintextBudget({ title: CANARY.repeat(400), body: 'x' });
    expect(result).toMatchObject({ ok: false, reason: 'payload_over_budget' });
    expectRejectionWithoutCanary(result);
  });

  it('accepts a non-serializable payload without echoing its content in the rejection', () => {
    const cyclic: Record<string, unknown> = { label: CANARY };
    cyclic['self'] = cyclic;
    const result = checkPayloadPlaintextBudget({
      title: CANARY,
      body: 'x',
      data: cyclic,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_serializable' });
    expectRejectionWithoutCanary(result);
  });
});
