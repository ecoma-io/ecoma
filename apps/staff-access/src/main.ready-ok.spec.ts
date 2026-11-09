import { describe, expect, it, vi } from 'vitest';

/**
 * Duong THANH CONG cua `/ready`, tach file vi phai mock tang infrastructure.
 *
 * `vi.mock` duoc hoist cho ca file, nen dat no trong `main.spec.ts` se bien
 * cac test `db_unreachable` o do thanh test cua mock thay vi cua driver.
 * File rieng giu moi thu trong pham vi mot file.
 *
 * Vi sao can test nay o cap unit du integration da co test 200 tren
 * PostgreSQL that: mot hoi quy khien `/ready` LUON 503 (vi du mot cau probe
 * tham cot khong ton tai) van lam 6 test that bai xanh — chung chi khang dinh
 * 503 — trong khi Docker healthcheck se khong bao gio `healthy`. Test nay
 * ghim chieu 200 va dong log `ready.ok`.
 */

type ProbeFn = (config: unknown, fn: (db: unknown) => Promise<void>) => Promise<void>;

const withClient = vi.hoisted(() => ({
  probe: vi.fn<ProbeFn>(async (_config: unknown, fn: (db: unknown) => Promise<void>) => {
    await fn({ unsafe: async () => [] });
  }),
}));

vi.mock('@ecoma-io/staff-access-infrastructure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/staff-access-infrastructure')>();
  return {
    ...actual,
    withStaffAccessClient: withClient.probe,
  };
});

const { buildApp, resetCachedConfig } = await import('./main');

const ENV = {
  DB_STAFF_ACCESS: { connectionString: 'postgresql://runtime@127.0.0.1:1/db-staff-access' },
  AUTH_INTERNAL_SECRET: 'internal-secret-test',
};

describe('/ready — ready outcome', () => {
  it('returns 200 and logs ready.ok when config loads and every serving query is accepted', async () => {
    resetCachedConfig();
    withClient.probe.mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = buildApp();
      const response = await app.request('/ready', {}, ENV);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ service: 'staff-access', status: 'ready' });
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'ready.ok', status: 200 }));
    } finally {
      log.mockRestore();
    }
  });

  it('runs every probe statement through the runtime client, including the write-shaped ones', async () => {
    resetCachedConfig();
    withClient.probe.mockClear();
    const statements: string[] = [];
    withClient.probe.mockImplementationOnce(async (_config, fn) => {
      await fn({
        unsafe: async (sql: string) => {
          statements.push(sql);
          return [];
        },
      });
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await buildApp().request('/ready', {}, ENV);
      expect(response.status).toBe(200);
    } finally {
      log.mockRestore();
    }

    // Ba cau, moi cau dai dien cho mot duong serving that. Chi read (`SELECT`)
    // se bo lot grant INSERT/DELETE cua nonce; chi `staff` se bo lot migration
    // 0006. Assertion theo noi dung, khong theo so luong, de mot lan doi cau
    // truy van khong am tham lam mat mot duong.
    const joined = statements.join('\n');
    expect(joined).toMatch(/FROM staff_access\.staff/u);
    expect(joined).toMatch(/INSERT INTO staff_access\.internal_nonces/u);
    expect(joined).toMatch(/DELETE FROM staff_access\.internal_nonces/u);
    expect(joined).toMatch(/UPDATE staff_access\.entitlement_outbox_events/u);
    expect(joined).toMatch(/settled_at/u);
    // Khong cau nao duoc phep ghi du lieu that: moi cau phai zero-row.
    expect(statements.filter((statement) => !/WHERE false/u.test(statement))).toEqual([]);
  });
});
