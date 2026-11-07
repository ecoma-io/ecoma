/**
 * Unavailable adapter — trạng thái không có backend thật với ý nghĩa chủ động.
 *
 * Mục đích: khi deployment configuration không cho phép mock (`'prototype'`),
 * backoffice phải vào trạng thái "không khả dụng" có kiểm soát, không tự sinh
 * dữ liệu giả để che lấp việc backend chưa triển khai. Điều này có nghĩa mọi
 * thao tác đọc dữ liệu nghiệp vụ bị **rejected** với mã lỗi ổn định.
 *
 * Hành vi bắt buộc:
 * - `isPreview = false`. Không đánh dấu là "preview" chỉ vì chưa có backend.
 * - Mọi phương thức đọc: `listStaff`, `listRoles`, `listPermissions` trả `never`
 *   (tức thực tế là Promise bị reject). Không bao giờ trả `[]` hoặc object giả.
 * - Lỗi là `BackofficeBackendUnavailableError` với `code` cố định, để tầng gọi
 *   phân biệt được "backend chưa sẵn sàng" với lỗi mạng/lỗi nghiệp vụ khác.
 *
 * ⚠️ Giới hạn hiện tại (đo được, không phải suy đoán): `code` **chưa** đi tới UI.
 * Cả ba page nạp qua `useAsyncState`, và hàm đó ép lỗi thành
 * `{ kind: 'error', message }` — `code` bị rơi lại. Vì vậy hiện tại UI không phân
 * nhánh được theo `code`; `message` mặc định (tiếng Anh) được truyền thẳng vào
 * `:detail` của `BackofficeErrorState` và hiện ra cho người dùng. Muốn có thông
 * điệp "tạm không khả dụng" đã dịch thì phải cho `AsyncState` mang `code` rồi map
 * `code -> i18n key`; việc đó nằm ngoài phạm vi PR gating này.
 *
 * Không thêm logic retry/fallback ở đây; quyết định bật mock đã nằm ở layer
 * selection. Fixture không được import vào file này.
 */
import type { BackofficeDataAdapter } from './types';

export const BACKOFFICE_BACKEND_UNAVAILABLE_CODE = 'backoffice_backend_unavailable' as const;

export class BackofficeBackendUnavailableError extends Error {
  readonly code: typeof BACKOFFICE_BACKEND_UNAVAILABLE_CODE;

  constructor(message = 'Backoffice backend is temporarily unavailable') {
    super(message);
    this.name = 'BackofficeBackendUnavailableError';
    this.code = BACKOFFICE_BACKEND_UNAVAILABLE_CODE;
  }
}

/**
 * `async` là phần của hợp đồng, không phải trang trí: một hàm ném đồng bộ sẽ làm
 * `adapter.listStaff().catch(...)` nổ ngay tại call-site thay vì đi vào nhánh
 * `.catch`. Kiểu trả về của adapter là `Promise`, nên lỗi phải đến dưới dạng
 * **promise bị reject**.
 *
 * Khai ở phạm vi module: hàm không đóng trên biến nào, nên tạo lại nó mỗi lần gọi
 * factory là vô nghĩa (`unicorn/consistent-function-scoping`).
 */
async function unavailable(): Promise<never> {
  throw new BackofficeBackendUnavailableError();
}

export function createUnavailableBackofficeAdapter(): BackofficeDataAdapter {
  return {
    isPreview: false,
    listStaff: unavailable,
    listRoles: unavailable,
    listPermissions: unavailable,
    listEntitlements: unavailable,
    listAuditEntries: unavailable,
  };
}
