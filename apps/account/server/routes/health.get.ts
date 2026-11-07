import { defineEventHandler } from 'h3';

/**
 * `GET /health` — kiểm **tiết lệ chính**, không query database.
 *
 * `03-operations.md` §2 liệt kê `GET /health → 200` là bước kiểm sau deploy, và
 * liveness là kiểm mà orchestrator dùng để quyết định có restart Worker hay không.
 *
 * ⚠️ **Vì sao tuyệt đối không query DB ở đây.** Nếu `/health` phụ thuộc `db-account` thì
 * `db-account` chết ⇒ `/health` trả lỗi ⇒ orchestrator restart Worker ⇒ Worker mới
 * lại hỏi DB vẫn chết ⇒ **restart loop vô ích**, vừa tạo thêm tải lên database đang
 * chết vừa che mất nguyên nhân thật (DB hỏng, không phải Worker hỏng). Đúng như
 * failure mode `db-account down` trong `03-operations.md` §8: lỗi nằm ở DB, không
 * phải ở Worker, và restart Worker không sửa được.
 *
 * Hệ quả thiết kế: `/health` chỉ chứng minh **Worker đã khởi động và route chạy
 * được** — mà điều đó đã bao gồm `server/plugins/config.ts` chạy fail-closed, tức
 * Worker chỉ khởi động được khi config internal đã hợp lệ. Đường kiểm phụ thuộc là
 * `/ready`, không phải `/health`.
 *
 * @see `./ready.get.ts` cho readiness (có query DB, fail-closed).
 */
export default defineEventHandler(() => {
  return { status: 'ok' };
});
