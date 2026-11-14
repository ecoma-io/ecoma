/**
 * Route surface của composition root `src/main.ts` — colocated unit spec
 * (06-testing.md §4: `test` = colocated unit, không chạm DB).
 *
 * Ghim đúng bề mặt công khai của Worker `remote-cache-api`: mọi route mà
 * `buildApp()` đăng ký — không thừa route nào lộ ra ngoài hợp đồng, không
 * thiếu route nào của control plane (P4.1) hay data plane (P4.2). Một route
 * mới chỉ được xuất hiện khi một hợp đồng route được thêm có chủ đích.
 */
import { describe, expect, it } from 'vitest';

import { buildApp } from './main';

/** Bề mặt route dạng "METHOD path", sắp thứ tự để so như một tập xác định. */
function routeSurface(app: ReturnType<typeof buildApp>): string[] {
  type RouteEntry = { method: string; path: string };
  const routes = (app as unknown as { routes: RouteEntry[] }).routes;
  return routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path}`)
    .toSorted();
}

describe('composition root route surface (unit)', () => {
  it('exposes exactly /health, /ready, the machine control plane, the portal control plane and the /v1/cache/:hash pair', () => {
    const app = buildApp();
    // Middleware (method ALL, path *) bị loại: chúng không phải bề mặt công khai.
    // Bề mặt portal (#202): địa chỉ tenant theo NAME trên path, đúng sáu workflow R19.
    expect(routeSurface(app)).toEqual(
      [
        'GET /health',
        'GET /ready',
        'POST /projects',
        'GET /projects',
        'GET /tenants/:tenantName/projects',
        'POST /tenants/:tenantName/projects',
        'GET /tenants/:tenantName/projects/:projectName',
        'POST /tenants/:tenantName/projects/:projectName/api-keys',
        'GET /tenants/:tenantName/projects/:projectName/api-keys',
        'POST /tenants/:tenantName/projects/:projectName/api-keys/:keyId/revoke',
        'GET /v1/cache/:hash',
        'PUT /v1/cache/:hash',
      ].toSorted(),
    );
  });

  it('serves /health without any environment binding (infra probe never depends on config)', async () => {
    const app = buildApp();
    // /health đăng ký TRƯỚC middleware config — không env, không DB vẫn 200.
    const res = await app.request('http://localhost/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'remote-cache-api' });
  });
});
