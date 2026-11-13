/**
 * Lỗi HTTP có trạng thái từ một route `/api/**` của BFF — do adapter thật ném.
 *
 * ## Vì sao cần class riêng thay vì `Error` trần
 *
 * `useAsyncState` chỉ giữ `message`, nên đến trước #182 mọi lỗi HTTP đều đổ về
 * UI như nhau: người dùng hết phiên (401) và người dùng thiếu quyền (403) thấy
 * cùng một trạng thái lỗi chung. ADR-0011 §4 giao **hành vi client theo
 * status**: `401` → đường đăng nhập lại, `403` → không đăng nhập lại (đó là
 * denial quyền), `503` → thử lại. Để UI phân nhánh được, lỗi phải mang status
 * dưới dạng dữ liệu có kiểu, không phải chuỗi phải `match`.
 *
 * `useAsyncState` đọc `status` từ nhánh `instanceof` này vào
 * `AsyncState.error.status`; mọi lỗi khác (mạng, `BackofficeBackendUnavailable`)
 * không mang `status` và UI giữ hành vi cũ.
 *
 * Không chuyển status thành chuỗi trong `message`: `message` là **chi tiết kỹ
 * thuật** hiển thị cho support (xem `BackofficeErrorState`), giữ nguyên hình
 * dạng cũ chỉ thêm dữ liệu có cấu trúc bên cạnh.
 */

/** Lỗi từ một route `/api/**` — `status` là mã HTTP thật của response. */
export class BackofficeRouteError extends Error {
  /** Mã HTTP của response không-OK đã nhận (2xx không bao giờ tạo lỗi này). */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'BackofficeRouteError';
    this.status = status;
  }
}
