import { defineEventHandler } from 'h3';

/**
 * `GET /health` — kiểm **tính sống** (liveness), không gọi downstream nào.
 *
 * Phân biệt `/health` và `/ready` giống `apps/account`: liveness không được phụ
 * thuộc dịch vụ ngoài — một downstream chết ⇒ `/health` lỗi ⇒ orchestrator restart
 * Worker ⇒ restart loop vô ích, vừa tăng tải vừa che nguyên nhân thật. Đường kiểm
 * phụ thuộc là `/ready`.
 */
export default defineEventHandler(() => {
  return { status: 'ok', service: 'llm-seller' };
});
