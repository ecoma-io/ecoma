import { defineEventHandler } from 'h3';

/**
 * `GET /health` — kiểm **tiết lệ chính**, không gọi broker API.
 *
 * Phân biệt `/health` và `/ready` giống `apps/account`: liveness không được phụ
 * thuộc dịch vụ ngoài — broker API chết ⇒ `/health` lỗi ⇒ orchestrator restart
 * Worker ⇒ restart loop vô ích, vừa tăng tải vừa che nguyên nhân thật. Đường kiểm
 * phụ thuộc là `/ready`.
 */
export default defineEventHandler(() => {
  return { status: 'ok', service: 'pact-broker-app' };
});
