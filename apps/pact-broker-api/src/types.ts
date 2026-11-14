/**
 * Kiểu Hono env dùng chung trong app entry — phần còn lại của port cũ
 * `src/domain/types.ts` (phần domain thuần đã về
 * `@ecoma-io/pact-broker-api-domain`). File này thuộc app entry nên được
 * phép gắn Hono, `pg` và config của app vào `Variables`.
 */

// Kiểu Hono env dùng chung trong app.
export type AppEnv = {
  Bindings: Record<string, unknown>;
  Variables: AppVariables;
};

export interface AppVariables {
  requestId: string;
  /** Tenant đã xác thực (middleware auth gắn vào). */
  tenantId?: string;
  /** Tenant name đã xác thực. */
  tenantName?: string;
  /** Scopes của machine token (khi dùng token). */
  scopes?: string[];
  /** ID của machine token đang gọi (auth middleware gắn vào). */
  tokenId?: string;
  /**
   * `sub` đã verify của user token (đường BFF forward, ADR-0031).
   *
   * ⚠️ Ràng buộc ADR-0032 §3 (đường user M1 chỉ đọc): mọi code đọc
   * `principalSub` chỉ được dùng cho xác thực/membership — KHÔNG BAO GIỜ làm
   * `actorId`/`createdBy` cho mutation (publish, verify, environment-CRUD,
   * token-admin). Actor ghi vẫn là machine token (`tokenId`).
   */
  principalSub?: string;
  /** Pool của request — middleware config tạo mới mỗi request và `end()` sau khi request hoàn tất (issue #118). */
  pool: import('pg').Pool;
  /** Config đã kiểm — middleware config gắn vào. */
  config: import('./config').PactBrokerConfig;
}
