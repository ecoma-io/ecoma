import { apiNotFound } from '../utils/api-not-found';

/**
 * `/api` không kèm dấu `/` phía sau không khớp catch-all `[...path]` — nó cần
 * entry riêng này để không rơi xuống SPA fallback và trả HTML 200.
 */
export default apiNotFound;
