import { defineEventHandler, setResponseStatus } from 'h3';

/**
 * Handler trả JSON 404 cho request vào namespace `/api/**` mà không có route thật.
 *
 * Vì sao cần: app này là **SPA** (`ssr: false`). Nitro cài route catch-all `/**`
 * để render shell HTML cho client router, nên `/api/không-tồn-tại` cũng khớp
 * `/**` và nhận **HTML 200** — đúng hình dạng "thành công" với mọi client chỉ
 * kiểm `response.ok`. Đo trên build thật trước khi thêm file này (`wrangler dev`,
 * preset `cloudflare-module`): `GET /api/anything` → `200 text/html`.
 *
 * Vì sao là route thật thay vì `routeRules` hay middleware: `routeRules` chỉ áp
 * được cho path đã có handler, còn middleware sẽ phải tự phân biệt "route chưa
 * khớp" với "route đã khớp" — thứ chỉ router của Nitro biết. Catch-all trong
 * `server/api/` khớp **sau** mọi route cụ thể, nên nó chỉ chạy khi thật sự không
 * có handler nào; `/health`, `/ready` và mọi BFF route thêm sau này không bị ảnh
 * hưởng.
 *
 * Vì sao cần **hai** file trỏ cùng handler này: catch-all `[...path]` của Nitro
 * không khớp chính tiền tố khi không có dấu `/` phía sau, nên `/api` rơi vào
 * `server/api/index.ts`. Hai lối vào, một body — client không phải phân biệt hai
 * hình dạng 404.
 *
 * Không `createError`: hình dạng response của nó **phụ thuộc request**. Middleware
 * xử lý lỗi của Nitro chỉ bỏ qua error renderer khi request trông giống JSON
 * (`Accept` không phải `text/html` **và** path bắt đầu bằng `/api/` hoặc kết thúc
 * bằng `.json`), nên cùng một lỗi có thể ra JSON ở `/api/x` và ra trang HTML ở
 * `/api` hoặc ở request do trình duyệt gửi. Một hợp đồng BFF phải tất định:
 * `setResponseStatus` + object trả JSON ở mọi request, không phụ thuộc header của
 * client.
 */
export const apiNotFound = defineEventHandler((event) => {
  setResponseStatus(event, 404);
  return { statusCode: 404, statusMessage: 'Not Found' };
});
