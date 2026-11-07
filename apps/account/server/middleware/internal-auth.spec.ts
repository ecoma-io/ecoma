import { createApp, toWebHandler, type WebHandler } from 'h3';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNonce,
  INTERNAL_KID_HEADER,
  signRequest,
  type VerifyRequestInput,
} from '@ecoma-io/internal-auth-contracts';

import internalAuthMiddleware, { makeNonceGuard } from './internal-auth';
import { withRequestPool } from '../utils/db';
import { writeLog } from '../utils/logger';

/**
 * Test middleware internal-auth ở hai điểm nó có thể sai âm thầm.
 *
 * ⚠️ Phần lớn logic xác thực nằm trong `verifyRequest` của `@ecoma-io/internal-auth-contracts`
 * và **đã** có test ở lib đó. Viết lại nó ở đây là sao chép logic có thể trôi lệch với
 * lib — nên test này chỉ kiểm những gì thuộc **app**: hợp đồng của callback `claimNonce`
 * mà app cấp cho lib, và cách middleware hành xử khi DB chết. Đường đi end-to-end
 * (h3 app thật + `signRequest` thật + PostgreSQL thật) nằm ở
 * `tests/integrations/internal-auth-e2e.spec.ts` — ở đó chứ không ở đây vì unit test
 * không có container, và vì chính sự vắng mặt của đường end-to-end đã từng
 * làm lọt hai lỗi critical (pool bị `end()` trước khi `claimNonce` chạy; `event.path`
 * bị ghép query lần thứ hai).
 */

vi.mock('../utils/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/db')>();
  // `recordNonce` (dùng bởi `makeNonceGuard`) giữ bản thật; chỉ `withRequestPool`
  // bị mock để unit test điều khiển được lỗi DB mà middleware phải nuốt.
  return { ...actual, withRequestPool: vi.fn<() => Promise<unknown>>() };
});

vi.mock('../utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

const mockedWriteLog = vi.mocked(writeLog);
const mockedWithRequestPool = vi.mocked(withRequestPool);

/**
 * Pool giả — chỉ cần `connect()` trả client có `query` và `release`.
 *
 * ⚠️ Ghi vào `mock.calls` để test đọc được SQL và tham số mà `recordNonce` thực
 * sự gửi xuống, thay vì chỉ kiểm "có gọi hay không".
 */
function fakePool(rowCount: number): Pool {
  const client = {
    query: vi.fn<
      (text: string, values?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>
    >(() => Promise.resolve({ rowCount, rows: [] })),
    release: vi.fn<() => void>(),
  };
  return {
    connect: vi.fn<() => Promise<typeof client>>(() => Promise.resolve(client)),
  } as unknown as Pool;
}

/**
 * Timestamp envelope cố định — test neo TTL theo mốc này chứ không theo đồng hồ.
 *
 * Chọn một epoch xa trong quá khứ là có chủ đích: nếu callback fallback về
 * `Date.now()` thì kết quả lệch T cố định này ngay, kể cả khi đồng hồ đúng.
 */
const ENVELOPE_TIMESTAMP = 1_700_000_000;

describe('makeNonceGuard', () => {
  it('reports a fresh nonce as unseen and a repeated one as seen', async () => {
    // `rowCount === 0` của `INSERT … ON CONFLICT DO NOTHING` nghĩa là đụng ràng buộc
    // UNIQUE ⇒ nonce đã có ⇒ đã thấy trước đó. `rowCount === 1` là nonce mới.
    const fresh = makeNonceGuard(fakePool(1), 300);
    const repeated = makeNonceGuard(fakePool(0), 300);

    await expect(fresh('nonce-a', ENVELOPE_TIMESTAMP)).resolves.toBe(false);
    await expect(repeated('nonce-a', ENVELOPE_TIMESTAMP)).resolves.toBe(true);
  });

  it('matches the widened claimNonce signature of the contract library', async () => {
    // `verifyRequest` gọi `claimNonce(nonce, timestampSeconds)` với timestamp đã qua
    // kiểm skew (hợp đồng mở rộng trong `libs/internal-auth-contracts`). Gán guard vào
    // kiểu của lib và gọi với hai tham số: sai kiểu trả về hay sai kiểu tham số
    // (ví dụ `nonce: number`) đỏ lúc typecheck. ⚠️ TypeScript cho phép hàm **ít**
    // tham số gán vào kiểu **nhiều** tham số, nên việc thiếu tham số thứ hai không
    // bắt được ở đây — tham số đó được chứng minh ở test neo TTL bên dưới, nơi
    // giá trị lưu phải đúng theo đúng timestamp truyền vào.
    const guard: VerifyRequestInput['claimNonce'] = makeNonceGuard(fakePool(1), 300);
    await expect(guard('nonce-shape', ENVELOPE_TIMESTAMP)).resolves.toBe(false);
  });

  it('anchors expires_at to the envelope timestamp, not the verifier clock', async () => {
    // TTL = timestamp của envelope + skew + buffer — đúng công thức trong JSDoc của
    // `recordNonce` (`server/utils/db.ts`) và của `nonceExpiry` (`db/migrate.mts`).
    // Cửa sổ replay của envelope kết thúc tại `timestamp + skew`, nên mốc hết hạn
    // phải là mốc đó cộng buffer (prune chạy theo lô). Vì T ở đây cố định và không
    // đụng đồng hồ, assert **chính xác** được: fallback về `Date.now()` cho một giá
    // trị khác T + skew + buffer, và bỏ buffer cho giá trị thấp hơn đúng 60s.
    const pool = fakePool(1);
    await makeNonceGuard(pool, 300)('nonce-b', ENVELOPE_TIMESTAMP);

    const client = await pool.connect();
    const [sql, params] = client.query.mock.calls[0] ?? [];
    expect(sql).toContain('ON CONFLICT (nonce) DO NOTHING');
    expect(sql).toContain('account.internal_nonces');

    expect(Number(params?.[1])).toBe(ENVELOPE_TIMESTAMP + 300 + 60);
  });

  it('is a single statement, because check-then-insert loses atomicity', async () => {
    // Đọc-rồi-ghi cho hai request cùng nonce cùng thắng dưới tải đồng thời, tức
    // replay guard trở thành trang trí. Một `query` duy nhất là hình thức nguyên tử
    // mà `recordNonce` hứa; `connect` một lần chứng minh không có vòng SELECT trước.
    const pool = fakePool(1);
    await makeNonceGuard(pool, 300)('nonce-c', ENVELOPE_TIMESTAMP);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const client = await pool.connect();
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});

/** Secret hợp lệ cho test — chỉ cần khác rỗng, middleware không soi nội dung. */
const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/**
 * Khoá thứ hai — đại diện cho khoá MỚI sau khi xoay secret.
 *
 * ⚠️ Hai giá trị này KHÁC NHAU một cách có chủ đích: nếu chúng trùng nhau thì `kid` mất
 * hết ý nghĩa làm selector, và test "khoá được chọn theo `kid`" sẽ xanh dù cơ chế
 * chọn khoá hỏng hoàn toàn.
 */
const ROTATED_SECRET = 'test-internal-hmac-secret-rotated-9876543210';

/** `kid` hợp lệ: 8 hex chữ thường (đúng hình dạng lib chấp nhận). */
const KID = '0123abcd';
const PREVIOUS_KID = 'abcd0123';

/**
 * Connection string giả trong message lỗi driver — không host thật nào bị chạm.
 *
 * `pg` thật có thể đặt connection string vào message lỗi (ví dụ khi auth fail),
 * và đúng thứ SR-001/invariant 9 cấm là thứ đó lọt vào log. Test dưới đây dùng
 * chuỗi này làm "mồi" để chứng minh middleware không bao giờ nối message lỗi
 * vào dòng log.
 */
const FAKE_CONNECTION_STRING =
  'postgres://ecoma_account_runtime:leaked-pw@10.0.0.9:5432/db-account';

describe('internal-auth middleware when the pool fails', () => {
  let handler: WebHandler;

  beforeAll(() => {
    const app = createApp();
    app.use(internalAuthMiddleware);
    handler = toWebHandler(app);
  });

  beforeEach(() => {
    // Config đủ cả secret lẫn binding để request đi tới được khối `withRequestPool`
    // — fail-closed ở hai nhánh config sẽ chặn trước và test này không còn kiểm
    // được gì về lỗi DB.
    vi.stubGlobal('useRuntimeConfig', () => ({
      internalHmacSecret: SECRET,
      internalAuthSkewSeconds: '',
      cloudflare: { env: { DB_ACCOUNT: { connectionString: 'postgres://stub-binding' } } },
    }));
    mockedWriteLog.mockClear();
    mockedWithRequestPool.mockReset();
  });

  it('answers 503 with a stable reason and never logs the driver message', async () => {
    // `withRequestPool` (toàn bộ `verifyRequest`, gồm cả `claimNonce` chạm DB) ném
    // lỗi driver thô — đúng thứ sẽ thoát ra h3 và bị Nitro `console.error` nguyên
    // object nếu middleware không bắt: message `pg` có thể chứa connection string,
    // và response thành 500 chứ không phải 503 như mọi call site DB khác.
    mockedWithRequestPool.mockRejectedValueOnce(
      new Error(`connect ECONNREFUSED ${FAKE_CONNECTION_STRING}`),
    );

    const response = await handler(new Request('http://localhost/internal/account/status'));

    // 503 + mã ổn định — khớp contract của `status.get.ts`/`ready.get.ts` với cùng
    // một sự cố ("DB không gọi được"), không phải 500 "lỗi server".
    expect(response.status).toBe(503);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal_auth.rejected',
        status: 503,
        reason: 'db_unreachable',
      }),
    );

    // Không một dòng log nào được chứa connection string từ message lỗi driver —
    // đó là toàn bộ mục đích của nhánh catch này.
    const allLogged = JSON.stringify(mockedWriteLog.mock.calls);
    expect(allLogged).not.toContain(FAKE_CONNECTION_STRING);
    expect(allLogged).not.toContain('leaked-pw');

    // Response cũng không được chứa nó (createError chỉ mang statusMessage).
    expect(await response.text()).not.toContain(FAKE_CONNECTION_STRING);
  });
});

/**
 * Phía nhận chọn khoá theo `kid` (issue #64).
 *
 * ⚠️ Đây là phần **thuộc app** của hợp đồng `kid`: registry `kid` → secret và cách
 * fail-closed khi `kid` lạ. Phần thuộc lib (hình dạng `kid`, thứ tự kiểm, việc `kid`
 * không nằm trong canonical string) đã có test ở `@ecoma-io/internal-auth-contracts`.
 *
 * ⚠️ `withRequestPool` bị mock ở suite này nên **không có DB thật** — `claimNonce`
 * không chạy, và `recordNonce` được giữ bản thật. Cái cần kiểm ở đây là quyết định
 * accept/reject của middleware, không phải hành vi replay guard (phần đó thuộc e2e
 * với PostgreSQL thật).
 */
describe('internal-auth middleware — key selection by kid', () => {
  let handler: WebHandler;

  beforeAll(() => {
    const app = createApp();
    app.use(internalAuthMiddleware);
    handler = toWebHandler(app);
  });

  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({
      internalHmacSecret: SECRET,
      internalHmacKid: KID,
      internalHmacPreviousKid: PREVIOUS_KID,
      internalHmacPreviousSecret: ROTATED_SECRET,
      internalAuthSkewSeconds: '',
      cloudflare: { env: { DB_ACCOUNT: { connectionString: 'postgres://stub-binding' } } },
    }));
    mockedWriteLog.mockClear();
    // Pool giả: `recordNonce` trả `false` (nonce mới) ⇒ verify thành công.
    mockedWithRequestPool.mockImplementation(
      async (_hyperdrive, callback) => (await callback(fakePool(1) as never)) as unknown,
    );
  });

  it('accepts an envelope whose kid selects the current key', async () => {
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
      kid: KID,
    });

    const response = await handler(
      new Request('http://localhost/internal/account/status', { headers }),
    );

    expect(response.status).toBe(404);
    // 404 = middleware ĐÃ cho qua, request rơi xuống route handler (không có route
    // trong app test này). 401 mới là "middleware từ chối".
    expect(mockedWriteLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected' }),
    );
  });

  it('accepts an envelope whose kid selects the previous key, during the rotation overlap', async () => {
    // Đây là toàn bộ điểm của `kid`: sau khi đổi secret, sender ký bằng khoá MỚI
    // trong khi receiver vẫn giữ cả hai — không có khoảng chết dịch vụ.
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: ROTATED_SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
      kid: PREVIOUS_KID,
    });

    const response = await handler(
      new Request('http://localhost/internal/account/status', { headers }),
    );

    expect(response.status).toBe(404);
    expect(mockedWriteLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected' }),
    );
  });

  it('rejects an envelope whose kid is outside the registry', async () => {
    // Fail-closed: `kid` lạ ⇒ không có khoá nào để khớp ⇒ 401, KHÔNG phải "chấp nhận
    // bằng secret mặc định".
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
      kid: 'ffffffff',
    });

    const response = await handler(
      new Request('http://localhost/internal/account/status', { headers }),
    );

    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal_auth.rejected',
        status: 401,
        reason: 'bad_signature',
      }),
    );
  });

  it('rejects an envelope signed with the key its kid does not select', async () => {
    // `kid` KHÔNG phải một claim tự thuyết phục: nó chỉ là chỉ dẫn chọn khoá, còn HMAC
    // mới là bằng chứng. Chữ ký bằng khoá B trong khi `kid` trỏ tới khoá A ⇒ 401.
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: ROTATED_SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
      kid: KID,
    });

    const response = await handler(
      new Request('http://localhost/internal/account/status', { headers }),
    );

    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal_auth.rejected',
        status: 401,
        reason: 'bad_signature',
      }),
    );
  });

  it('rejects a malformed kid as invalid_field, without consulting the registry', async () => {
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
    });

    const response = await handler(
      new Request('http://localhost/internal/account/status', {
        headers: { ...headers, [INTERNAL_KID_HEADER]: 'NOT-HEX' },
      }),
    );

    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal_auth.rejected',
        status: 401,
        reason: 'invalid_field',
      }),
    );
  });

  it('still accepts an envelope without a kid, using the current secret', async () => {
    // Phase transition: sender chưa bật `kid` ⇒ không có header `kid` ⇒ dùng secret
    // hiện hành, đúng như trước khi có `kid`.
    const headers = await signRequest({
      method: 'GET',
      path: '/internal/account/status',
      secret: SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
      nonce: createNonce(),
    });

    const response = await handler(
      new Request('http://localhost/internal/account/status', { headers }),
    );

    expect(response.status).toBe(404);
    expect(mockedWriteLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected' }),
    );
  });

  /**
   * Pha **nạp trước** (preload) của runbook xoay secret — bước 2 trong
   * `docs/applications/auth/03-operations.md` §3.3.
   *
   * ⚠️ Ở pha này slot `previous` chứa khoá **MỚI**, không phải khoá cũ: Worker đã
   * verify được khoá mới (đối tác sắp ký bằng nó) nhưng **vẫn ký bằng khoá hiện hành**.
   * Test này khóa đúng cái hành vi đó, vì nhầm hai nghĩa của slot `previous` là lỗi
   * khiến runbook hướng dẫn người vận hành làm sai.
   */
  describe('preload phase — the previous slot holds the NEW key', () => {
    beforeEach(() => {
      // current = (K1, S1) — vẫn ký bằng khoá cũ.
      // previous = (K2, S2) — khoá MỚI, chỉ dùng để verify.
      vi.stubGlobal('useRuntimeConfig', () => ({
        internalHmacSecret: SECRET,
        internalHmacKid: KID,
        internalHmacPreviousKid: PREVIOUS_KID,
        internalHmacPreviousSecret: ROTATED_SECRET,
        internalAuthSkewSeconds: '',
        cloudflare: { env: { DB_ACCOUNT: { connectionString: 'postgres://stub-binding' } } },
      }));
    });

    it('verifies an envelope signed with the preloaded new key', async () => {
      const headers = await signRequest({
        method: 'GET',
        path: '/internal/account/status',
        secret: ROTATED_SECRET,
        timestamp: String(Math.floor(Date.now() / 1000)),
        nonce: createNonce(),
        kid: PREVIOUS_KID,
      });

      const response = await handler(
        new Request('http://localhost/internal/account/status', { headers }),
      );

      expect(response.status).toBe(404);
      expect(mockedWriteLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'internal_auth.rejected' }),
      );
    });

    it('still verifies an envelope signed with the current key', async () => {
      // Worker chưa chuyển `current` nên vẫn phải verify được cả hai bên trong lúc
      // nạp trước — đây là điều kiện cho phép hai Worker đi qua bước 2 ở hai thời điểm
      // khác nhau mà không gián đoạn.
      const headers = await signRequest({
        method: 'GET',
        path: '/internal/account/status',
        secret: SECRET,
        timestamp: String(Math.floor(Date.now() / 1000)),
        nonce: createNonce(),
        kid: KID,
      });

      const response = await handler(
        new Request('http://localhost/internal/account/status', { headers }),
      );

      expect(response.status).toBe(404);
      expect(mockedWriteLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'internal_auth.rejected' }),
      );
    });

    it('rejects an envelope whose kid is outside both slots', async () => {
      const headers = await signRequest({
        method: 'GET',
        path: '/internal/account/status',
        secret: SECRET,
        timestamp: String(Math.floor(Date.now() / 1000)),
        nonce: createNonce(),
        kid: 'ffffffff',
      });

      const response = await handler(
        new Request('http://localhost/internal/account/status', { headers }),
      );

      expect(response.status).toBe(401);
      expect(mockedWriteLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'internal_auth.rejected',
          status: 401,
          reason: 'bad_signature',
        }),
      );
    });
  });
});
