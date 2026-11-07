/**
 * Index (root) endpoint — port từ upstream `src/routes/index.ts` (ADAPT):
 * bỏ DO health check (health ở main.ts, không DB), giữ nguyên HAL surface.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { HalBuilder, getBaseUrl } from '@ecoma-io/pact-broker-api-domain';
import type { MiddlewareHandler } from 'hono';

/**
 * Pact-Broker-API compatibility version mà index báo. Reference Ruby broker
 * dùng field này làm marker feature protocol, và Pact CLI chính thống
 * (`pact-broker-client`) gate điều hướng HAL feature theo nó — publish với
 * `--branch`/`--build-url` đòi broker báo ≥ 2.86.0, không thì CLI in
 *   WARN: This version of the Pact Broker does not support versions
 *         with branches or build URLs.
 *
 * Worker này cài HAL surface, branch/build-URL publish, deployed-versions,
 * environments và matrix query có ở reference broker tới 2.107.0, nên báo
 * đúng mức đó. Đây là version SPEC thỏa mãn, KHÔNG phải semver của Worker
 * — giữ version riêng trong `package.json`.
 */
export const PACT_BROKER_API_COMPATIBILITY_VERSION = '2.107.0';

export function indexRoutes(readAuth: () => MiddlewareHandler<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Root/index — cần auth read: index liệt kê capability nhưng không lộ data.
  app.get('/', readAuth(), (c) => {
    const hal = new HalBuilder(getBaseUrl(c.req.raw));

    return c.json({
      name: 'Pact Broker (Ecoma)',
      version: PACT_BROKER_API_COMPATIBILITY_VERSION,
      _links: hal.index(),
    });
  });

  return app;
}
