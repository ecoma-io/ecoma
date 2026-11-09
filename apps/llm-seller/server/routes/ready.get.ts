import { defineEventHandler } from 'h3';

/**
 * `GET /ready` — readiness của một scaffold chưa có downstream.
 *
 * Phân biệt với `/health` (xem `health.get.ts`): readiness trả lời "Worker có
 * phục vụ request thật được không". Ở giai đoạn scaffold này app **không có**
 * cấu hình runtime, secret hay phụ thuộc downstream nào, nên câu trả lời là
 * `ready` — không có gì để kiểm.
 *
 * ⚠️ Readiness **cố ý không** phụ thuộc `llm-api`, marketplace, financial hay bất
 * kỳ service nào chưa hiện thực. Một lần gọi HTTP thật biến readiness thành
 * serving-path dependency của downstream — đúng thứ mà invariant
 * "observability/khả năng kiểm tra không được trở thành serving-path dependency"
 * cấm; và readiness của seller portal sẽ rung theo một service khác, phủ hết ý
 * nghĩa phân tầng của hai route.
 *
 * ⚠️ Khi app có **phụ thuộc cấu hình thật** (ví dụ base URL của BFF downstream),
 * readiness phải **fail closed**: trả `503` kèm một mã lỗi ổn định để người vận
 * hành thấy ngay, thay vì mặc định `ready`. Không thêm runtime config hay secret
 * giả chỉ để có thứ mà kiểm.
 */
export default defineEventHandler(() => {
  return { status: 'ready' };
});
