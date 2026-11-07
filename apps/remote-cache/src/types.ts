import type { RemoteCacheConfig } from './config';

/**
 * Context Hono cua Worker — bien do composition root set vao context sau khi
 * config da duoc kiem (middleware config). Route doc tu day thay vi doc `env`
 * truc tiep, de duong config khong ro lech giua cac route.
 */
export interface AppEnv {
  readonly Variables: {
    config: RemoteCacheConfig;
    requestId: string;
  };
  readonly Bindings: {
    DB_REMOTE_CACHE?: { connectionString: string };
  };
}
