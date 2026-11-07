/**
 * Hình dạng của một **authorization boundary** mà các file route của Application API nhận
 * qua tham số — không import trực tiếp từ `main.ts`.
 *
 * ⚠️ **Vì sao truyền qua tham số thay vì import `authenticateApplication`:** `main.ts` là
 * composition root; nó giữ `RequestContext`, `buildContext` và `sha256HexHasher`. Nếu các
 * file route import trực tiếp thì chúng kéo theo toàn bộ app Hono, và `main.ts` phải export
 * nội bộ chỉ để route dùng — hoặc tệ hơn, route sẽ tự dựng context mà không có key material.
 * Callback bắt buộc đi qua đúng **một** đường xác thực, và một đường là điều có thể test được.
 *
 * ⚠️ **`Response` trong union nghĩa là "đã chặn, trả luôn"** — và kiểu union đó buộc mỗi route
 * kiểm `instanceof Response` **trước** khi đọc bất cứ thứ gì. Đó là hình thành của thứ tự
 * "xác thực trước lookup": không có cách nào gọi use case mà không đi qua nhánh kiểm này.
 *
 * ⚠️ **`deps` mang cả `hasher` vì `endpoint_hash` cần đúng một hàm hash trong toàn repo.**
 * `createNotification` dùng `RequestHasher` cho canonical request hash; nếu route tự gọi
 * `crypto.subtle` cho endpoint thì đó là nguồn sự thật thứ hai cho cùng một phép băm, và nó
 * phải xuất hiện trong `endpoint_hash` của **mọi** hàng đã ghi.
 */

import type { Context } from 'hono';

import type { InventoryDeps } from '@ecoma-io/push-notification-application';

/** Caller đã xác thực + dependency của use case, hoặc `Response` cần trả về ngay. */
export type RequireApplicationResult =
  | { readonly deps: InventoryDeps; readonly principal: string }
  | Response;

/**
 * Xác thực bearer token của Application API và dựng dependency của use case.
 *
 * ⚠️ Trả `principal` chứ **không** trả `app` từ body: `app` của một request là giá trị
 * **dùng**, lấy từ principal đã xác thực (§8.2).
 */
export type RequireApplication = (context: Context) => RequireApplicationResult;
