/**
 * Nạp cấu hình của `push-notification` **một lần** cho mỗi Worker isolate — và chỉ ở đây.
 *
 * ⚠️ **Vì sao cache sống ở composition root mà không sống trong application layer.** Cache là
 * một quyết định về **vòng đời isolate** của Workers runtime, không phải về hình dạng cấu
 * hình: `resolvePushNotificationConfig` thuần và không giữ state, còn một Worker isolate
 * được tái sử dụng qua nhiều request. Giữ cache ở application layer sẽ làm test không kiểm
 * soát được nó, và dễ dẫn tới một promise bị cache **cùng rejection** — xem `cached` bên dưới.
 *
 * ⚠️ **Vì sao rejection KHÔNG được cache.** Đây là điểm quan trọng nhất của file. Nếu
 * rejection được cache, thì sau khi operator sửa cấu hình (`wrangler deploy --var`, hoặc set
 * lại Worker Secret) mà Worker isolate **chưa** bị recycle, service vẫn ném lỗi cũ vô
 * hạn — một cấu hình đã sửa vẫn không chạy được, và log chỉ lặp lại một thông điệp đã lỗi
 * thời. Cache chỉ giữ **giá trị thành công**: `pending` bị xoá trong `catch`, nên lần gọi kế
 * tiếp thử nạp lại từ `env` và ném lại nếu cấu hình vẫn sai (hoặc thành công nếu đã sửa).
 *
 * ⚠️ **Vì sao `requireSecret` không `trim()`** ở đây: đó là bất biến của `config-port.ts`
 * (`requireSecret` phải phát hiện "chưa set", không phải "set hơi sai"). File này **không**
 * có `trim()` nào trên đường secret, và `PushNotificationConfig` được trả về nguyên trạng.
 *
 * ⚠️ **Vì sao thông điệp lỗi không bao giờ chứa giá trị.** `PushConfigError` do
 * `config-load.ts` dựng và chỉ nêu **tên biến**; file này không bọc lại message, cũng không
 * nối thêm `String(env.X)` vào. Giá trị của một biến cấu hình có thể là secret và log Worker
 * là nơi mọi người đọc được.
 */

import {
  resolvePushNotificationConfig,
  type ConfigEnvironment,
  type PushNotificationConfig,
} from '@ecoma-io/push-notification-application';
import type { D1DatabaseLike, QueueBinding } from '@ecoma-io/push-notification-infrastructure';

/**
 * Bundle của Worker mà composition root dựng một lần.
 *
 * ⚠️ Binding được khai bằng **bề mặt hẹp** của infrastructure (`D1DatabaseLike`,
 * `QueueBinding`) chứ không phải global `D1Database`/`Queue` của `@cloudflare/workers-types`.
 * Hai lý do: (1) đó đúng là hợp đồng adapter cần — adapter chỉ dùng `prepare`/`batch` và
 * `send`, nên phụ thuộc phần còn lại của binding là một dependency thừa; (2) khai đúng **ba**
 * binding ở đây làm việc "thiếu một binding" thành lỗi **compile** thay vì lỗi runtime ở
 * request đầu tiên. Binding thật của Workers thỏa hai interface này theo hình thức, nên khai
 * bằng chúng không mất gì khi deploy.
 */
export interface PushWorkerEnv extends ConfigEnvironment {
  /** D1 `push` — authoritative storage của control plane (binding `push`). */
  readonly push: D1DatabaseLike;
  /** Queue producer `ecoma-push-delivery` (binding `QUEUE`). */
  readonly QUEUE: QueueBinding;
}

/** Cấu hình đã resolve của isolate hiện tại — `null` khi chưa nạp lần nào. */
let resolved: PushNotificationConfig | null = null;

/**
 * Cấu hình của isolate hiện tại.
 *
 * ⚠️ **Ném** khi chưa cấu hình đủ (fail closed — `02-requirements.md` FR-008, `03-operations.md`
 * §11): sáu tham số SLA là quyết định của service owner + business owner và là **launch
 * gate**, nên service không có hành vi đúng để phục vụ bất kỳ request nào khi chúng thiếu.
 * Thông điệp nêu **tên biến**, không bao giờ nêu giá trị.
 *
 * ⚠️ Không có `await` trên đường này khi đã cache: sau lần nạp thành công đầu tiên, mọi
 * request chỉ đọc một object đã resolve — đúng mục tiêu của cache. Lần nạp đầu là **đồng
 * bộ** (mọi binding của Worker đã có mặt trước khi `fetch` chạy), nên không có await nào
 * để mất và không có race giữa hai request đầu tiên.
 */
/**
 * ⚠️ Ném** khi chưa cấu hình đủ (fail closed — `02-requirements.md` FR-008, `03-operations.md`
 * §11): sáu tham số SLA là quyết định của service owner + business owner và là **launch
 * gate**, nên service không có hành vi đúng để phục vụ bất kỳ request nào khi chúng thiếu.
 * Thông điệp nêu **tên biến**, không bao giờ nêu giá trị.
 *
 * ⚠️ **Không có `try`/`catch` quanh `resolvePushNotificationConfig`**, dù tên bộ nhớ là
 * `resolved` và lý do của việc không cache rejection rất quan trọng. Lý do: assignment chỉ
 * hoàn tất khi hàm **trả về**, nên một lần ném còn lại `resolved === null` — rejection đã
 * không được cache **bởi cấu trúc ngôn ngữ**, chứ không phải bởi một `catch` phải nhớ viết.
 * Một `catch (error) { throw error }` ở đây chỉ là một hành vi đã đúng được viết lại thành
 * một hành vi có vẻ sai: ai đọc `catch` sẽ tưởng nó thay đổi gì đó. `resetConfigCacheForTest`
 * tồn tại để một test quan sát cache từ bên ngoài.
 *
 * ⚠️ Không có `await` trên đường này khi đã cache: sau lần nạp thành công đầu tiên, mọi
 * request chỉ đọc một object đã resolve — đúng mục tiêu của cache. Lần nạp đầu là **đồng
 * bộ** (mọi binding của Worker đã có mặt trước khi `fetch` chạy), nên không có await nào
 * để mất và không có race giữa hai request đầu tiên.
 */
export function pushConfig(env: PushWorkerEnv): PushNotificationConfig {
  if (resolved !== null) {
    return resolved;
  }
  resolved = resolvePushNotificationConfig(env);
  return resolved;
}

/**
 * Xoá cache cấu hình — **chỉ dùng trong test**.
 *
 * ⚠️ Có mặt là để một test có thể chứng minh hai điều độc lập: (1) config thành công được
 * cache, và (2) config lỗi **không** được cache. Không có cách nào khác để quan sát cache
 * từ bên ngoài mà không đi qua một entry point nằm trên đường serving của production.
 */
export function resetConfigCacheForTest(): void {
  resolved = null;
}
