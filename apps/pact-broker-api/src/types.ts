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
  /** Pool mỗi isolate — middleware config gắn vào. */
  pool: import('pg').Pool;
  /** Config đã kiểm — middleware config gắn vào. */
  config: import('./config').PactBrokerConfig;
}
