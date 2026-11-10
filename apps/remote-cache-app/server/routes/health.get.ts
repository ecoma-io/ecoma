import { defineEventHandler } from 'h3';

/**
 * `GET /health` — kiểm **tính sống** (liveness), không gọi dịch vụ nào bên ngoài.
 *
 * Phân biệt `/health` và `/ready` giống `apps/account` và `apps/pact-broker-app`:
 * liveness không được phụ thuộc dịch vụ ngoài — một downstream chết ⇒ `/health`
 * lỗi ⇒ orchestrator restart Worker ⇒ restart loop vô ích, vừa tăng tải vừa che
 * nguyên nhân thật. Đường kiểm phụ thuộc là `/ready`.
 *
 * `remote-cache-app` hiện là scaffold: chưa có downstream nào để gọi, nên route này
 * chỉ khẳng định process đang phục vụ request.
 */
export default defineEventHandler(() => {
  return { status: 'ok', service: 'remote-cache-app' };
});
