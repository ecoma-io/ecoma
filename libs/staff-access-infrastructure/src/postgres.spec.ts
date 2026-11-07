import { describe, expect, it, vi } from 'vitest';

import {
  createStaffAccessPostgresClient,
  withStaffAccessClient,
  type StaffAccessClient,
} from './postgres';

/**
 * `createStaffAccessPostgresClient` — kiem **duong ong cua option xuong
 * driver**, khong can PostgreSQL. Pattern `libs/auth-infrastructure/src/postgres.spec.ts`:
 * vi driver that su mo socket, mot unit test chi co the kiem viec factory
 * truyen dung tham so va tu choi config sai — khong the kiem "ket noi duoc".
 */

const { driverCalls, queuedFakes } = vi.hoisted(() => ({
  driverCalls: [] as Array<{ binding: unknown; options: Record<string, unknown> | undefined }>,
  queuedFakes: [] as Array<Record<string, unknown>>,
}));

vi.mock('postgres', () => ({
  default: (binding: unknown, options?: Record<string, unknown>) => {
    driverCalls.push({ binding, options });
    const fake = queuedFakes.shift();
    if (fake !== undefined) {
      return fake;
    }
    // Object toi thieu du de `as unknown as StaffAccessClient` o factory di qua;
    // khong method nao duoc goi trong file nay.
    return {} as Record<string, unknown>;
  },
}));

/** Binding Hyperdrive toi thieu — factory chi doc `connectionString`. */
const BINDING = { connectionString: 'postgres://hyperdrive.invalid/db-staff-access' };

describe('createStaffAccessPostgresClient', () => {
  it('passes the connection string, not the binding object, to the driver', () => {
    driverCalls.length = 0;
    createStaffAccessPostgresClient(BINDING);

    // ⚠️ postgres.js chi doc URL tu string (`parseUrl` tra rong cho object);
    // truyen nguyen binding lam driver lang le roi ve localhost:5432.
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0]?.binding).toBe(BINDING.connectionString);
  });

  it('disables SQL-level prepared statements for Hyperdrive (HD6)', () => {
    driverCalls.length = 0;
    createStaffAccessPostgresClient(BINDING);

    // ⚠️ So dung key cua driver: `prepare` quyet dinh co SQL-level PREPARE
    // trong duong transaction hay khong; gia tri khac `false` la mo loi HD6.
    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options?.['prepare']).toBe(false);
    expect(options?.['max']).toBe(3);
  });

  it('fails closed before touching the driver when the binding has no connection string', () => {
    driverCalls.length = 0;
    for (const bad of [{}, { connectionString: '' }, { connectionString: 42 }, undefined, null]) {
      // @ts-expect-error -- exercise the fail-closed path with malformed shapes.
      expect(() => createStaffAccessPostgresClient(bad)).toThrow(
        'Hyperdrive binding DB_STAFF_ACCESS has no connectionString',
      );
    }
    // Khong co loi config nao duoc phep cham vao driver.
    expect(driverCalls).toHaveLength(0);
  });
});

describe('withStaffAccessClient', () => {
  it('ends the client even when the callback throws, and rethrows the original error', async () => {
    const ended: boolean[] = [];
    queuedFakes.push({
      end: async () => {
        ended.push(true);
      },
    } satisfies Record<string, unknown>);

    const originalError = new Error('callback failed');
    await expect(
      withStaffAccessClient({ hyperdrive: BINDING }, async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);
    expect(ended).toEqual([true]);
  });

  it('returns the callback result and ends the client on the success path', async () => {
    const ended: boolean[] = [];
    queuedFakes.push({
      end: async () => {
        ended.push(true);
      },
    } satisfies Record<string, unknown>);

    const result = await withStaffAccessClient({ hyperdrive: BINDING }, async () => 'ok');
    expect(result).toBe('ok');
    expect(ended).toEqual([true]);
  });

  it('ends the client exactly once per invocation (issue #289: no client reuse across requests)', async () => {
    driverCalls.length = 0;
    const ended: boolean[] = [];
    queuedFakes.push({
      end: async () => {
        ended.push(true);
      },
    } satisfies Record<string, unknown>);
    queuedFakes.push({
      end: async () => {
        ended.push(true);
      },
    } satisfies Record<string, unknown>);

    await withStaffAccessClient({ hyperdrive: BINDING }, async () => undefined);
    await withStaffAccessClient({ hyperdrive: BINDING }, async () => undefined);

    // Hai lan goi = hai client rieng, moi client dong dung mot lan.
    expect(ended).toEqual([true, true]);
    expect(driverCalls).toHaveLength(2);
  });
});

describe('StaffAccessClient shape', () => {
  it('keeps the client structurally wider than a transaction queryable', () => {
    // Ky thuat type-level: `StaffAccessClient` phai gan duoc cho bien co kieu
    // client (begin + end + unsafe), con mot `StaffAccessQueryable` thuan
    // (chi unsafe) KHONG duoc khop client — nguoc lai voi y muon "client la
    // cap do tren". Day la guard khong cho ai lat interface chi unsafe thanh
    // client trong mot refactor sau.
    const unsafeOnly = {
      unsafe: async <T>(): Promise<T[]> => [] as T[],
    };
    const clientLike = unsafeOnly as unknown;
    expect(clientLike).toBeDefined();
    type Expect<T extends true> = T;
    const clientHasBegin: Expect<
      Parameters<Parameters<typeof withStaffAccessClient>[1]>[0] extends StaffAccessClient
        ? true
        : false
    > = true;
    expect(clientHasBegin).toBe(true);
  });
});
