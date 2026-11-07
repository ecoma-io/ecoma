/**
 * Transport priority và chọn subscription để tạo delivery — phạm vi theo **Device**.
 *
 * Source of truth:
 * - `docs/applications/push-notification/02-requirements.md` FR-010 (mặc định `app > web`;
 *   priority **chỉ** áp dụng giữa các subscription thuộc **cùng một** logical `Device`;
 *   **MUST NOT** áp dụng giữa hai `Device` khác nhau của cùng `User`), FR-011
 *   (`MUST NOT` coi hai subscription cùng `User` là cùng `Device`; `MUST NOT` dùng IP,
 *   User-Agent, network, browser name để xác định device equality), FR-002 (mỗi
 *   `Device` có thể có nhiều `Push Subscription`; device identity không suy luận bằng
 *   IP/User-Agent).
 * - `docs/applications/push-notification/01-architecture.md` §5.3–§5.4 (routing:
 *   resolve → filter → policy → transport → provider), §8.1 (`ineligible_subscription`
 *   khi subscription `disabled`/`expired`).
 *
 * Quyết định domain suy ra:
 * - Hàm ở đây nhận **hai** tham số định danh — `app` và `deviceId` — và chỉ xét
 *   subscription khớp **cả hai**: `deviceId` khớp tuyệt đối, và `app` khớp để giữ
 *   cô lập namespace giữa các `App` (§4.3, §8.2). Không có tham số `userId` nào tham
 *   gia vào quyết định này: cùng `user_id` không bao giờ làm hai subscription trở
 *   thành cùng device. Đây là cách thực thi FR-011 ở tầng type — không có đường dẫn
 *   code nào so sánh `user_id`.
 * - Subscription `disabled`/`expired` không tham gia tranh priority (FR-004: chỉ
 *   `active` đủ điều kiện tạo delivery). Vì vậy một `app` subscription bị disable
 *   **không** "thắng" rồi bị loại — nó không tham gia ngay từ đầu, và `web` hợp lệ
 *   vẫn được chọn.
 * - Không có fallback cross-provider ở tầng này: hàm chỉ chọn subscription, và
 *   provider được resolve riêng bởi `selectPrimaryProvider`.
 */

import {
  type DomainOk,
  type DomainRejection,
  isNonEmptyString,
  isTransport,
  TRANSPORT,
  type Transport,
} from './shared';
import { isSubscriptionStatus, SUBSCRIPTION_STATUS, type SubscriptionStatus } from './subscription';

/**
 * Một subscription như routing cần biết: danh tính subscription, `App` sở hữu, device
 * sở hữu, và transport. **Không** có trường `userId` — vắng mặt có chủ đích để không
 * có cách nào suy ra device equality từ user identity (FR-011).
 *
 * `app` có mặt vì priority chỉ định nghĩa **trong cùng một `App`** (§5.5) và mỗi `App`
 * là một namespace cô lập (§4.3, §8.2): một hàm chỉ lọc theo `deviceId` có thể chọn
 * subscription của `App` khác cho cùng device và gửi payload của `App` A tới endpoint
 * của `App` B.
 */
export type RoutingSubscriptionFact = {
  readonly subscriptionId: string;
  readonly app: string;
  readonly deviceId: string;
  readonly transport: Transport;
  readonly status: SubscriptionStatus;
};

/**
 * Hạng ưu tiên transport trong v1: `app` thắng `web` (FR-010).
 *
 * Khai báo dưới dạng `Record<Transport, number>` để bổ sung một transport mới vào
 * `TRANSPORT` mà quên khai hạng ở đây là **lỗi compile**, chứ không phải một delivery
 * bị loại bỏ âm thầm: nếu `TRANSPORT_PRIORITY_ORDER` thiếu transport mới, subscription
 * thuộc transport đó trượt qua `isTransport` nhưng không khớp vòng lặp nào và bị báo
 * `no_eligible_subscription` — không phân biệt được với "device thật sự không có
 * subscription", nên metric/alert không bắt được.
 */
const TRANSPORT_PRIORITY_RANK = {
  [TRANSPORT.App]: 0,
  [TRANSPORT.Web]: 1,
} satisfies Record<Transport, number>;

/**
 * Suy thứ tự ưu tiên (hạng nhỏ trước) từ một map hạng — hàm thuần, tách riêng để
 * kiểm được bằng những map hạng đối kháng.
 *
 * Vì sao không sắp bằng `sort`/`order[rank]`:
 * - `Array#sort` bị repo cấm (`unicorn/no-array-sort`) và `lib` của workspace là
 *   `es2022` nên chưa có `toSorted`.
 * - Ghi thẳng theo index (`order[rank] = transport`) phá im lặng với hai map hạng
 *   hợp lệ về type: hạng **trùng** làm transport sau ghi đè transport trước (nó biến
 *   mất khỏi thứ tự, và subscription của nó không bao giờ thắng — đọc lên y hệt
 *   "device không có subscription"), hạng **cách quãng** để lại lỗ `undefined`.
 *
 * Chèn theo so sánh giữ **mọi** transport, không phụ thuộc hạng có liên tục hay
 * không, và ổn định khi hạng trùng (thứ tự khai báo được giữ).
 */
export function deriveTransportPriorityOrder(
  ranks: Record<Transport, number>,
): readonly Transport[] {
  return (Object.keys(ranks) as Transport[]).reduce<Transport[]>((order, transport) => {
    const rank = ranks[transport];
    const insertAt = order.findIndex((existing) => ranks[existing] > rank);
    if (insertAt === -1) {
      order.push(transport);
    } else {
      order.splice(insertAt, 0, transport);
    }
    return order;
  }, []);
}

/**
 * Thứ tự ưu tiên transport giảm dần, suy ra từ `TRANSPORT_PRIORITY_RANK` — thứ tự
 * không được khai báo lần thứ hai ở dạng mảng để hai nguồn không thể lệch nhau.
 */
export const TRANSPORT_PRIORITY_ORDER: readonly Transport[] =
  deriveTransportPriorityOrder(TRANSPORT_PRIORITY_RANK);

/**
 * Chọn các subscription sẽ nhận delivery cho **một** device.
 *
 * Trả về mọi subscription `active` thuộc transport ưu tiên cao nhất có mặt trong
 * device đó. Nhiều subscription cùng transport trong cùng device là hợp lệ (FR-002:
 * một device có thể có nhiều subscription) — vì vậy kết quả là một **tập**, không
 * phải một phần tử.
 *
 * Bất biến: kết quả không bao giờ chứa subscription của device khác, và không bao
 * giờ chứa subscription không `active`.
 *
 * Vocabulary reason tách đôi theo **nguồn của lỗi**: `malformed_subscription` là
 * subscription fact sai shape (row DB/input bên ngoài), còn `malformed_selector` là
 * **tham số của caller** sai (`app`/`deviceId` rỗng). Gộp hai loại vào một reason làm
 * một lỗi cấu hình — ví dụ worker quên truyền `app` — bị đọc như dữ liệu dị dạng và
 * biến mất khỏi metric, trong khi đó lại đúng là loại lỗi cần người vận hành thấy.
 */
export type SelectDeviceSubscriptionsResult =
  | DomainOk<{ readonly subscriptions: readonly RoutingSubscriptionFact[] }>
  | DomainRejection<'malformed_subscription' | 'malformed_selector' | 'no_eligible_subscription'>;

export function selectSubscriptionsForDevice(
  app: string,
  deviceId: string,
  subscriptions: readonly RoutingSubscriptionFact[],
): SelectDeviceSubscriptionsResult {
  if (!isNonEmptyString(app)) {
    return {
      ok: false,
      reason: 'malformed_selector',
      detail: 'app rỗng — không xác định được namespace của App.',
    };
  }
  if (!isNonEmptyString(deviceId)) {
    return {
      ok: false,
      reason: 'malformed_selector',
      detail: 'deviceId rỗng — không xác định được device.',
    };
  }
  // Collection hỏng là dữ liệu đầu vào (DB rows), không phải lỗi selector — nằm trong
  // nhóm `malformed_subscription` để không lẫn với lỗi cấu hình của caller.
  if (!Array.isArray(subscriptions)) {
    return {
      ok: false,
      reason: 'malformed_subscription',
      detail: 'Danh sách subscription không hợp lệ — không chọn được device subscriptions.',
    };
  }
  // Một pass cho cả hai quyết định: shape và scope. Không thể tách thành
  // `filter(shape)` rồi `filter(scope)` vì `filter` đọc `subscription.app` **trước** khi
  // biết phần tử đó là object — một phần tử `null` trong collection (row DB hỏng) sẽ ném
  // `TypeError` ra khỏi domain, vi phạm đúng hợp đồng mà `Array.isArray` ở trên đã bảo vệ.
  //
  // Phần tử dị dạng **ngoài** scope của selector này (device khác, `App` khác) bị bỏ qua
  // một cách im lặng và đúng đắn: nó thuộc quyết định khác, và caller chỉ hỏi về một
  // device. Phần tử dị dạng **trong** scope thì không được nuốt: `no_eligible_subscription`
  // khiến người vận hành đi tìm một device không có subscription, trong khi sự thật là có
  // subscription hỏng — hai lỗi khác nhau với cách sửa khác nhau. Vì vậy một record thuộc
  // đúng `(app, deviceId)` mà sai shape được báo `malformed_subscription`, **không** biến
  // thành "không tìm thấy" (§6: "malformed input không được … âm thầm biến thành 'không tìm
  // thấy'").
  const forDeviceAndApp: RoutingSubscriptionFact[] = [];
  for (const subscription of subscriptions) {
    if (!subscription || typeof subscription !== 'object') {
      // Phần tử không đọc được: không thể biết nó thuộc scope nào, nên nó làm hỏng cả
      // quyết định — báo `malformed_subscription` là fail-safe, không phải bỏ qua.
      return {
        ok: false,
        reason: 'malformed_subscription',
        detail: 'Danh sách subscription chứa phần tử không phải record — không chọn được.',
      };
    }
    // Device identity vẫn CHỈ theo `deviceId` — không tín hiệu nào khác tham gia.
    // `app` là điều kiện **scope**, không phải tín hiệu device identity: priority chỉ
    // định nghĩa trong cùng `App` (§5.5) và namespace các `App` là cô lập (§4.3, §8.2).
    if (subscription.deviceId !== deviceId || subscription.app !== app) {
      continue;
    }
    if (
      !isNonEmptyString(subscription.subscriptionId) ||
      !isTransport(subscription.transport) ||
      !isSubscriptionStatus(subscription.status)
    ) {
      return {
        ok: false,
        reason: 'malformed_subscription',
        detail: 'Subscription thuộc app và device đang chọn nhưng record sai shape.',
      };
    }
    forDeviceAndApp.push(subscription);
  }

  const eligible = forDeviceAndApp.filter(
    (subscription) => subscription.status === SUBSCRIPTION_STATUS.Active,
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: 'no_eligible_subscription',
      detail: 'Device không có subscription active nào.',
    };
  }

  for (const transport of TRANSPORT_PRIORITY_ORDER) {
    const sameTransport = eligible.filter((subscription) => subscription.transport === transport);
    if (sameTransport.length > 0) {
      return { ok: true, subscriptions: sameTransport };
    }
  }

  // Không thể tới đây: `eligible` không rỗng và mọi phần tử có transport thuộc
  // vocabulary, tức là thuộc `TRANSPORT_PRIORITY_ORDER`. Giữ nhánh này để hàm là
  // total function thay vì dựa vào bất biến ngầm.
  return {
    ok: false,
    reason: 'no_eligible_subscription',
    detail: 'Không có transport nào trong thứ tự ưu tiên khớp subscription eligible.',
  };
}
