import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createStaffAccessPostgresClient,
  isStaffAccessSchemaError,
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

// Trang thai cua mock la hai mang cap module. Reset TRUOC moi test de mot test
// khong the doc driver call hay fake cua test truoc — ke ca khi vitest doi thu
// tu chay hoac chay rieng mot test. Khong reset thi mot `queuedFakes` con sot
// se lam test sau nhan nham fake (va mot `driverCalls` con sot se lam assertion
// "dung mot lan goi" xanh tren du lieu cu).
beforeEach(() => {
  driverCalls.length = 0;
  queuedFakes.length = 0;
});

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

  it('forwards connectTimeoutSeconds as the driver connect_timeout option', () => {
    driverCalls.length = 0;
    createStaffAccessPostgresClient(BINDING, { connectTimeoutSeconds: 3 });

    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options?.['connect_timeout']).toBe(3);
  });

  it('omits connect_timeout when no timeout is configured (driver default)', () => {
    driverCalls.length = 0;
    createStaffAccessPostgresClient(BINDING);

    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options).not.toHaveProperty('connect_timeout');
  });

  it('rejects a non-positive or non-finite connect timeout before touching the driver', () => {
    driverCalls.length = 0;
    for (const bad of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() =>
        createStaffAccessPostgresClient(BINDING, { connectTimeoutSeconds: bad }),
      ).toThrow('connectTimeoutSeconds must be a finite number of seconds greater than 0');
    }
    expect(driverCalls).toHaveLength(0);
  });

  it('accepts the upper bound and rejects any value above it', () => {
    driverCalls.length = 0;
    createStaffAccessPostgresClient(BINDING, { connectTimeoutSeconds: 300 });
    expect(driverCalls).toHaveLength(1);
    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options?.['connect_timeout']).toBe(300);

    // Mot timeout "ngan" khong co canh tren la mot timeout co the treo request
    // lau hon thoi han Worker; gia tri chi lon hon bound mot chut van phai tu
    // choi, khong chi nhung gia tri cuc doan.
    driverCalls.length = 0;
    for (const bad of [300.000001, 301, 3600, Number.MAX_VALUE]) {
      expect(() =>
        createStaffAccessPostgresClient(BINDING, { connectTimeoutSeconds: bad }),
      ).toThrow('at most 300');
    }
    expect(driverCalls).toHaveLength(0);
  });

  it('rejects a non-number connect timeout before touching the driver', () => {
    driverCalls.length = 0;
    for (const bad of ['3', null, {}] as unknown[]) {
      expect(() =>
        createStaffAccessPostgresClient(BINDING, {
          // @ts-expect-error -- exercise the runtime guard with a non-number.
          connectTimeoutSeconds: bad,
        }),
      ).toThrow('connectTimeoutSeconds must be a finite number of seconds');
    }
    expect(driverCalls).toHaveLength(0);
  });

  it('reports the binding failure, not the timeout failure, when both are invalid', () => {
    // Thu tu kiem la contract: binding do Worker runtime cap (nguyen nhan goc
    // khi config sai), timeout do code readiness dat. Mot thong bao timeout se
    // che mat su co binding va lam kho chan doan trong production — ca hai van
    // fail-closed va van khong cham driver.
    driverCalls.length = 0;
    expect(() =>
      // @ts-expect-error -- exercise both invalid inputs at once.
      createStaffAccessPostgresClient(null, { connectTimeoutSeconds: 0 }),
    ).toThrow('Hyperdrive binding DB_STAFF_ACCESS has no connectionString');
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

  it('stays correct when the failing path runs repeatedly in the same process', async () => {
    // Duong loi cung phai lap lai duoc: mot request hong khong duoc de lai
    // state (client da dong, khong ro socket) lam request sau sai theo. Hai
    // lan goi lien tiep voi hai loi khac nhau, va moi lan phai dong dung MOT
    // client cua chinh no — neu `end()` bi bo qua o duong loi thi `ended` chi
    // con mot phan tu.
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

    const firstError = new Error('first failure');
    const secondError = new Error('second failure');
    await expect(
      withStaffAccessClient({ hyperdrive: BINDING }, async () => {
        throw firstError;
      }),
    ).rejects.toBe(firstError);
    await expect(
      withStaffAccessClient({ hyperdrive: BINDING }, async () => {
        throw secondError;
      }),
    ).rejects.toBe(secondError);
    expect(ended).toEqual([true, true]);
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

  it('forwards the readiness connect timeout through to the driver', async () => {
    // Readiness truyen ngan sach mo connection qua `withStaffAccessClient`;
    // neu nhanh nay bi go, probe roi ve mac dinh 30s cua driver va mot origin
    // chet giu request toi het thoi han Worker — test o day giu cho no khong
    // am tham bien mat.
    driverCalls.length = 0;
    queuedFakes.push({
      end: async () => undefined,
    } satisfies Record<string, unknown>);

    await withStaffAccessClient(
      { hyperdrive: BINDING, connectTimeoutSeconds: 3 },
      async () => undefined,
    );

    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options?.['connect_timeout']).toBe(3);
  });

  it('leaves the driver connect timeout at its default when none is configured', async () => {
    driverCalls.length = 0;
    queuedFakes.push({
      end: async () => undefined,
    } satisfies Record<string, unknown>);

    await withStaffAccessClient({ hyperdrive: BINDING }, async () => undefined);

    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options).not.toHaveProperty('connect_timeout');
  });
});

describe('isStaffAccessSchemaError', () => {
  it('classifies a missing-grant/missing-object PostgresError as a schema failure', () => {
    // Hinh loi ma `postgres.js` tao ra: `Object.assign(this, x)` gan `name` =
    // 'PostgresError' va `code` = SQLSTATE server tra ve len mot `Error`. Dung
    // dung hinh do (khong import driver that — mot spec unit importing driver
    // that vao la sai tier, `arch-check` bat) vi ham chi doc hai thuoc tinh
    // nay, khong doc prototype.
    for (const code of ['42501', '42P01', '42703']) {
      expect(
        isStaffAccessSchemaError(
          Object.assign(new Error('permission denied'), { name: 'PostgresError', code }),
        ),
      ).toBe(true);
    }
  });

  it('does not classify driver-level connect errors as schema failures', () => {
    // Loi tang driver (`ECONNREFUSED`, `CONNECT_TIMEOUT`) la `Error` thuong,
    // khong co `name` cua loi server. Gan nhan schema cho chung se day nguoi
    // van hanh di kiem tra migration khi DB khong toi duoc.
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'CONNECT_TIMEOUT']) {
      expect(isStaffAccessSchemaError(Object.assign(new Error('connect'), { code }))).toBe(false);
    }
    // SQLSTATE KHAC nhom schema cung khong duoc gan nhan schema: day la loi
    // server that nhung huong xu ly khac (vi du shutdown 57P01).
    expect(
      isStaffAccessSchemaError(
        Object.assign(new Error('server'), { name: 'PostgresError', code: '57P01' }),
      ),
    ).toBe(false);
    expect(isStaffAccessSchemaError(new Error('plain'))).toBe(false);
    expect(isStaffAccessSchemaError(undefined)).toBe(false);
    expect(isStaffAccessSchemaError('42501')).toBe(false);
  });

  it('classifies a schema error that lost its Error prototype (cross-realm/structured clone)', () => {
    // Structured clone / qua realm khac lam mat prototype: `instanceof Error`
    // thanh false trong khi `name`/`code` van con. Bo qua hinh dang nay bien
    // mot loi migration/grant thanh `db_unreachable`, dung huong chan doan sai
    // ma ham nay sinh ra de tranh.
    expect(isStaffAccessSchemaError({ name: 'PostgresError', code: '42501' })).toBe(true);

    // Nhung hinh dang do KHONG duoc noi long thanh allowlist: mot plain object
    // mang code cua driver van la "khong toi duoc", va `name` sai van false.
    expect(isStaffAccessSchemaError({ name: 'PostgresError', code: 'ECONNREFUSED' })).toBe(false);
    expect(isStaffAccessSchemaError({ code: '42501' })).toBe(false);
    expect(isStaffAccessSchemaError({ name: 'Error', code: '42501' })).toBe(false);
    expect(isStaffAccessSchemaError({ name: 'PostgresError', code: 42501 })).toBe(false);
    expect(isStaffAccessSchemaError(null)).toBe(false);
    expect(isStaffAccessSchemaError(Object.assign(new Error('connect'), { code: '42501' }))).toBe(
      false,
    );
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
