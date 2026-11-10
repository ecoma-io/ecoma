import { defineEventHandler, setResponseStatus } from 'h3';

/**
 * Handler trả JSON 404 cho request vào namespace `/api/**` mà không có route thật.
 *
 * ## Vì sao cần
 *
 * `backoffice` là **SPA** (`ssr: false` từ issue #67). Ở chế độ này Nitro cài
 * route catch-all `/**` để trả shell HTML cho client router, nên một path
 * `/api/không-tồn-tại` cũng khớp `/**` và nhận **HTML 200** — đúng hình dạng
 * "thành công" với mọi client chỉ kiểm `response.ok`. Đo trên build thật
 * (`wrangler` `createTestHarness`, preset `cloudflare-module`) trước khi thêm
 * file này: `GET /api` → `200 text/html` (shell SPA).
 *
 * ## Quan hệ với middleware authn — đường này KHÔNG mở bề mặt
 *
 * `server/middleware/authn.ts` chạy trước mọi route handler và chặn mọi path
 * dưới `/api/`. Vì vậy catch-all này **không** phải một đường vòng qua xác
 * thực: request chưa có phiên nhận `401`/`503` từ middleware trước khi tới
 * đây, và chỉ request đã qua authn mới thấy `404`. `/api` (không có dấu `/`
 * phía sau) không khớp tiền tố `/api/` nên đi thẳng vào đây — vẫn là 404 JSON,
 * không phải shell.
 *
 * ## Vì sao route thật, không phải `routeRules` hay middleware
 *
 * `routeRules` chỉ áp được cho path đã có handler; middleware phải tự phân biệt
 * "route chưa khớp" với "route đã khớp" — thứ chỉ router của Nitro biết.
 * Catch-all trong `server/api/` khớp **sau** mọi route cụ thể, nên nó chỉ chạy
 * khi thật sự không có handler nào; các route `/api/**` hiện có không bị ảnh
 * hưởng.
 *
 * ## Vì sao cần hai file trỏ cùng handler
 *
 * Catch-all `[...path]` của Nitro không khớp chính tiền tố khi không có dấu
 * `/` phía sau, nên `/api` rơi vào `server/api/index.ts`. Hai lối vào, một
 * body — client không phải phân biệt hai hình dạng 404.
 *
 * ## Vì sao không `createError`
 *
 * Hình dạng response của `createError` **phụ thuộc request**: middleware lỗi
 * của Nitro chỉ bỏ qua error renderer khi request trông giống JSON (`Accept`
 * không phải `text/html`), nên cùng một lỗi có thể ra JSON ở một request và ra
 * trang HTML ở request do trình duyệt gửi. Một hợp đồng BFF phải tất định:
 * `setResponseStatus` + object trả JSON ở mọi request, không phụ thuộc header
 * của client.
 */
export const apiNotFound = defineEventHandler((event) => {
  setResponseStatus(event, 404);
  return { statusCode: 404, statusMessage: 'Not Found' };
});
