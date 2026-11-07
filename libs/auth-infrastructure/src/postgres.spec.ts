import { describe, expect, it, vi } from 'vitest';

import { AuthConfigurationError } from '@ecoma-io/auth-domain';

import { createPostgresClient, withPostgresClient, type PostgresClientLike } from './postgres';

/**
 * `createPostgresClient` — kiểm **đường ống của option xuống driver**, không cần PostgreSQL.
 *
 * ⚠️ Vì sao vẫn cần một file riêng dù `internal-nonces.spec.ts` đã chạy trên PG thật:
 * mọi lời gọi `createPostgresClient(binding)` ở đó đều **bỏ trống** `options`, nên không có gì
 * bắt được hai lỗi đúng của đoạn spread ở đây:
 *
 *  - ghi sai tên option của driver (`connect_timout` thay vì `connect_timeout`) — driver nhận
 *    một key lạ, im lặng dùng mặc định 30s, và test PG vẫn xanh vì nó chỉ hỏi "kết nối được
 *    không";
 *  - điều kiện `=== undefined` bị đảo, khiến `connect_timeout` **luôn** được đặt, kể cả khi
 *    caller không nêu — tức đường authorization-code bị đổi hành vi ngoài ý muốn.
 *
 * Loại lỗi thứ hai đặc biệt khó thấy: `connect_timeout: undefined` vẫn là một key **có mặt**
 * trong object truyền cho driver, và `postgres.js` bỏ qua nó vì `.filter(([, v]) => v)`. Test
 * vì vậy kiểm **sự vắng mặt của key**, không kiểm "khác `undefined`".
 */

/**
 * Bản ghi các lời gọi `postgres()` — `vi.hoisted` vì factory của `vi.mock` được đẩy lên trên
 * mọi khai báo top-level, nên biến này phải tồn tại trước cả factory.
 *
 * `queuedFakes` là hàng đợi fake client cho ca vòng đời của `withPostgresClient`:
 * khi có fake xếp hàng, factory trả fake đó; hết hàng đợi thì trả object rỗng như
 * trước đây (các ca `createPostgresClient` không đụng method nào).
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
    // Object tối thiểu đủ để `as unknown as PostgresClientLike` ở factory đi qua; không
    // method nào được gọi trong file này.
    const stub: Record<string, unknown> = {};
    return stub;
  },
}));

/** Binding Hyperdrive tối thiểu — factory chỉ đọc `connectionString`. */
const BINDING = { connectionString: 'postgres://hyperdrive.invalid/db-auth' };

/**
 * Options của lời gọi driver gần nhất.
 *
 * Ném khi không có lời gọi nào, để một test lỡ quên gọi factory thất bại ở đúng chỗ đó thay
 * vì trả `undefined` rồi đỏ ở một assert khác khó đọc hơn.
 */
function lastDriverOptions(): Record<string, unknown> {
  const call = driverCalls.at(-1);
  if (call === undefined || call.options === undefined) {
    throw new Error('driver was not called with an options object');
  }
  return call.options;
}

describe('createPostgresClient — plumbing of the connect timeout', () => {
  it('routes connectTimeoutSeconds to the driver option connect_timeout', () => {
    driverCalls.length = 0;
    createPostgresClient(BINDING, { connectTimeoutSeconds: 2 });

    expect(driverCalls).toHaveLength(1);
    // ⚠️ So **đúng tên key**. Một tên sai (`connect_timout`) vẫn "truyền được một số xuống
    // driver" và vẫn xanh ở mọi test khác; chỉ assert theo tên mới bắt được.
    expect(lastDriverOptions()['connect_timeout']).toBe(2);
  });

  it('does not set connect_timeout at all when the caller omits the option', () => {
    driverCalls.length = 0;
    createPostgresClient(BINDING);

    // ⚠️ `in` chứ không `toBeUndefined()`: `connect_timeout: undefined` là một key **có mặt**,
    // và đó chính là hình dạng của lỗi "điều kiện bị đảo" mà test này tồn tại để bắt.
    expect('connect_timeout' in lastDriverOptions()).toBe(false);
  });

  it('rejects a timeout that would silently disable the fail-fast path', () => {
    driverCalls.length = 0;
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createPostgresClient(BINDING, { connectTimeoutSeconds: bad })).toThrow(
        AuthConfigurationError,
      );
    }
    // Không được gọi driver với một giá trị đã biết là sai: `connect_timeout: 0` khiến driver
    // không giới hạn việc mở connection, tức tham số này mất đúng tác dụng của nó.
    expect(driverCalls).toHaveLength(0);
  });

  it('still refuses a binding without a connection string', () => {
    driverCalls.length = 0;
    expect(() => createPostgresClient({ connectionString: '' })).toThrow(AuthConfigurationError);
    expect(driverCalls).toHaveLength(0);
  });

  it('returns the driver client unchanged', () => {
    driverCalls.length = 0;
    const client: PostgresClientLike = createPostgresClient(BINDING);
    expect(client).toBeDefined();
    expect(driverCalls).toHaveLength(1);
  });
});

/**
 * Fake client tối thiểu cho ca vòng đời của `withPostgresClient`: ba method mà
 * helper hoặc fn test đụng vào, với `end` là `vi.fn` để mỗi ca đếm được số lời
 * gọi. Fake được xếp vào `queuedFakes` để factory tầng driver trả nó — helper
 * nhận client QUA `createPostgresClient` thật, nên toàn bộ đường (config →
 * factory → client) đi đúng như runtime.
 */
function enqueueFakeClient(endImpl: () => Promise<void> = async () => undefined): {
  readonly end: ReturnType<typeof vi.fn>;
  readonly unsafe: ReturnType<typeof vi.fn>;
  readonly begin: ReturnType<typeof vi.fn>;
} {
  const unsafe = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
  const begin = vi
    .fn<(fn: () => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation(async (fn) => await fn());
  const end = vi.fn<() => Promise<void>>().mockImplementation(endImpl);
  queuedFakes.push({ unsafe, begin, end });
  return { unsafe, begin, end };
}

/**
 * `withPostgresClient` — hợp đồng vòng đời của issue #289.
 *
 * ⚠️ Scope của test này trong môi trường CI: ngữ nghĩa request-context của workerd
 * (socket gắn request đã tạo nó) KHÔNG tái lập được ở Node — phần đó được chứng minh
 * bằng tái lập live trong issue #289 và được verify lại trên stack thật sau merge.
 * Test ở đây ghim đúng nửa có thể ghim ở CI: `end()` đúng một lần trên mọi nhánh,
 * lỗi của `fn` lan nguyên trạng, và một client MỚI cho mỗi lần chạy (không tái sử
 * dụng instance nào giữa các lần gọi).
 */
describe('withPostgresClient — request-scoped client lifecycle (#289)', () => {
  it('creates a fresh client per call and ends it exactly once on success', async () => {
    driverCalls.length = 0;
    const first = enqueueFakeClient();
    const second = enqueueFakeClient();

    const output = await withPostgresClient({ hyperdrive: BINDING }, async (client) => {
      await client.unsafe('SELECT 1');
      return 'value';
    });
    // Lần chạy thứ hai trên cùng config — phải là client MỚI, không tái sử dụng.
    const secondOutput = await withPostgresClient({ hyperdrive: BINDING }, async () => 'again');

    expect(output).toBe('value');
    expect(secondOutput).toBe('again');
    expect(first.unsafe).toHaveBeenCalledTimes(1);
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(second.end).toHaveBeenCalledTimes(1);
    expect(second.unsafe).not.toHaveBeenCalled();
    // Hai lần chạy ⇒ hai lời gọi driver ⇒ hai client riêng. Tái sử dụng instance
    // giữa hai lần chạy chính là lỗi mà helper này tồn tại để xoá bỏ.
    expect(driverCalls).toHaveLength(2);
    // Driver nhận `binding.connectionString` (string), không phải nguyên object —
    // cùng bất biến mà các ca `createPostgresClient` ghim.
    expect(driverCalls[0]?.binding).toBe(BINDING.connectionString);
    expect(driverCalls[1]?.binding).toBe(BINDING.connectionString);
  });

  it('ends the client exactly once when fn throws, and propagates the original error', async () => {
    const fake = enqueueFakeClient();
    const fnError = new Error('fn failed');

    await expect(
      withPostgresClient({ hyperdrive: BINDING }, async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);

    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it('the original fn error wins when end() also throws on the failure path', async () => {
    const fake = enqueueFakeClient(async () => {
      throw new Error('end failed');
    });
    const fnError = new Error('fn failed');

    await expect(
      withPostgresClient({ hyperdrive: BINDING }, async () => {
        throw fnError;
      }),
    ).rejects.toBe(fnError);
    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid config before any driver call — same validation as createPostgresClient', async () => {
    driverCalls.length = 0;
    await expect(
      withPostgresClient({ hyperdrive: { connectionString: '' } }, async () => 'unused'),
    ).rejects.toThrow(AuthConfigurationError);
    await expect(
      withPostgresClient({ hyperdrive: BINDING, connectTimeoutSeconds: 0 }, async () => 'unused'),
    ).rejects.toThrow(AuthConfigurationError);
    // Validation fail-closed trước khi mở socket: driver không được gọi với config
    // đã biết là sai.
    expect(driverCalls).toHaveLength(0);
  });
});
