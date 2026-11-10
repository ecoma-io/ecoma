import { apiNotFound } from '../utils/api-not-found';

/**
 * Route bắt mọi path dưới `/api/` không có handler thật — xem
 * `server/utils/api-not-found.ts` cho lý do tồn tại và vì sao không dùng
 * `createError`.
 */
export default apiNotFound;
