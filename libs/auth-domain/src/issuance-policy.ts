/**
 * Policy cấp phát token theo trạng thái account (§6.0).
 *
 * ⚠️ **Policy, không phải wire contract.** Hàm này thuộc tầng domain vì nó mã hoá một
 * quyết định nghiệp vụ — mọi trạng thái không phải `active` đều dẫn tới không cấp token
 * — trong khi contract của service `account` (`@ecoma-io/account-contracts`) chỉ đóng
 * gói shape của wire message. Đặt policy vào contracts là đi ngược chiều phụ thuộc:
 * contract là thứ provider publish, không phải tầng để chứa logic gating của consumer.
 *
 * Type nhận vào là giá trị canonical của contract `GET /internal/account/status`
 * (nhập từ `@ecoma-io/account-contracts`), nên thêm một trạng thái mới ở contract sẽ
 * chảy tới đây mà không cần sửa file này.
 */

import type { AccountStatusResponseValue } from '@ecoma-io/account-contracts';

/**
 * Mọi trạng thái không phải `active` đều dẫn tới không cấp token.
 */
export function allowsIssuance(status: AccountStatusResponseValue): boolean {
  return status === 'active';
}
