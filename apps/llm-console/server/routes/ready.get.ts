import { defineEventHandler } from 'h3';

/**
 * `GET /ready` — readiness cho một scaffold **chưa có downstream**.
 *
 * Phân biệt với `/health` (xem `health.get.ts`): readiness trả lời "Worker có
 * phục vụ request thật được không". Ở giai đoạn scaffold, câu trả lời là có:
 * app chỉ phục vụ static asset (SPA) và chính route này, không cần cấu hình hay
 * secret nào để làm việc đó.
 *
 * ⚠️ Readiness **cố ý không** phụ thuộc vào `llm-api`, marketplace, financial
 * hay bất kỳ service chưa hiện thực nào. Một phụ thuộc như vậy sẽ biến readiness
 * của deploy unit này thành serving-path dependency của một service khác — đúng
 * thứ invariant "observability/khả năng kiểm tra không được trở thành
 * serving-path dependency" cấm — và làm `/ready` đỏ vì một service không tồn tại.
 *
 * ⚠️ Khi một phụ thuộc cấu hình thật được đưa vào (downstream base URL, OIDC
 * issuer, session signing key), route này phải **fail closed**: thiếu cấu hình
 * ⇒ 503 kèm mã ổn định (`setResponseStatus`, code dạng `*_not_configured`), chứ
 * **không** mặc định trả ready. Thêm runtime config hay secret giả để "có cái mà
 * kiểm" là làm hỏng chính bất biến đó.
 */
export default defineEventHandler(() => {
  return { status: 'ready' };
});
