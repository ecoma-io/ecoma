import { describe, expect, it, vi } from 'vitest';

import {
  createRemoteCachePostgresClient,
  withRemoteCacheClient,
  type RemoteCacheClient,
  type RemoteCacheQueryable,
} from './postgres';

/**
 * `createRemoteCachePostgresClient` — kiem **duong ong cua option xuong
 * driver**, khong can PostgreSQL. Pattern
 * `libs/staff-access-infrastructure/src/postgres.spec.ts`: vi driver that
 * su mo socket, mot unit test chi co the kiem viec factory truyen dung tham
 * so va tu choi config sai — khong the kiem "ket noi duoc".
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
    // Object toi thieu du de `as unknown as RemoteCacheClient` o factory di
    // qua; khong method nao duoc goi trong file nay.
    return {} as Record<string, unknown>;
  },
}));

/** Binding Hyperdrive toi thieu — factory chi doc `connectionString`. */
const BINDING = { connectionString: 'postgres://hyperdrive.invalid/db-remote-cache' };

describe('createRemoteCachePostgresClient', () => {
  it('passes the connection string, not the binding object, to the driver', () => {
    driverCalls.length = 0;
    createRemoteCachePostgresClient(BINDING);

    // ⚠️ postgres.js chi doc URL tu string (`parseUrl` tra rong cho object);
    // truyen nguyen binding lam driver lang le roi ve localhost:5432.
    expect(driverCalls).toHaveLength(1);
    expect(driverCalls[0]?.binding).toBe(BINDING.connectionString);
  });

  it('disables SQL-level prepared statements for Hyperdrive (HD6)', () => {
    driverCalls.length = 0;
    createRemoteCachePostgresClient(BINDING);

    // ⚠️ So dung key cua driver: `prepare` quyet dinh co SQL-level PREPARE
    // trong duong transaction hay khong; gia tri khac `false` la mo loi HD6.
    const options = driverCalls[0]?.options as Record<string, unknown> | undefined;
    expect(options?.['prepare']).toBe(false);
    expect(options?.['max']).toBe(3);
  });

  it('fails closed before touching the driver when the binding has no connection string', () => {
    driverCalls.length = 0;
    const badBindings: unknown[] = [
      {},
      { connectionString: '' },
      { connectionString: 42 },
      undefined,
      null,
    ];
    for (const bad of badBindings) {
      // `bad` la hinh dang sai co y — cast qua `as never` de goi dung duong
      // fail-closed ma khong lam ro tung hinh trong vong lap.
      expect(() =>
        createRemoteCachePostgresClient(
          bad as never as Parameters<typeof createRemoteCachePostgresClient>[0],
        ),
      ).toThrow('Hyperdrive binding DB_REMOTE_CACHE has no connectionString');
    }
    // Khong co loi config nao duoc phep cham vao driver.
    expect(driverCalls).toHaveLength(0);
  });
});

describe('withRemoteCacheClient', () => {
  it('ends the client even when the callback throws, and rethrows the original error', async () => {
    const ended: boolean[] = [];
    queuedFakes.push({
      end: async () => {
        ended.push(true);
      },
    } satisfies Record<string, unknown>);

    const originalError = new Error('callback failed');
    await expect(
      withRemoteCacheClient({ hyperdrive: BINDING }, async () => {
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

    const result = await withRemoteCacheClient({ hyperdrive: BINDING }, async () => 'ok');
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

    await withRemoteCacheClient({ hyperdrive: BINDING }, async () => undefined);
    await withRemoteCacheClient({ hyperdrive: BINDING }, async () => undefined);

    // Hai lan goi = hai client rieng, moi client dong dung mot lan.
    expect(ended).toEqual([true, true]);
    expect(driverCalls).toHaveLength(2);
  });
});

describe('RemoteCacheClient shape', () => {
  it('keeps the client structurally wider than a transaction queryable', () => {
    // Ky thuat type-level: `RemoteCacheClient` phai gan duoc cho bien co kieu
    // client (begin + end + unsafe), con mot `RemoteCacheQueryable` thuan
    // (chi unsafe) KHONG duoc khop client — nguoc lai voi y muon "client la
    // hop lon nhat, transaction la tap con". Ghi dai dang nay la de mot ngay
    // nao do thay vi tri hai kieu khong lam vo type khac o calling site.
    const client: RemoteCacheClient = {
      unsafe: async () => [],
      begin: async <T>(_fn: (tx: RemoteCacheQueryable) => Promise<T>) => undefined as T,
      end: async () => undefined,
    };
    const asQueryable: RemoteCacheQueryable = client;
    expect(asQueryable).toBeDefined();
  });
});
