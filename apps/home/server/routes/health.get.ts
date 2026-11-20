import { defineEventHandler } from 'h3';

/**
 * `GET /health` — kiểm tính sống (liveness), không gọi downstream nào.
 *
 * Cùng hợp đồng với `apps/account/server/routes/health.get.ts`: `/health` là
 * điểm kiểm sau deploy mà smoke staging assertion (`02-delivery.md` §7.4) và
 * orchestrator dùng — nó chỉ chứng minh Worker đã khởi động và route chạy
 * được, KHÔNG chứng minh readiness.
 *
 * ⚠️ **Vì sao không được query bất kỳ downstream nào ở đây.** Nếu liveness phụ
 * thuộc một dịch vụ ngoài thì dịch vụ đó chết ⇒ `/health` lỗi ⇒ orchestrator
 * restart Worker ⇒ Worker mới lại hỏi vẫn chết ⇒ restart loop vô ích, tạo thêm
 * tải cho đúng thành phần đang hỏng và che mất nguyên nhân thật. Đường kiểm phụ
 * thuộc (nếu cần sau này) là `/ready`, không phải `/health`.
 */
export default defineEventHandler(() => {
  return { status: 'ok' };
});
