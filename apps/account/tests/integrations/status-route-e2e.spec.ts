/**
 * `GET /internal/account/status` end-to-end — route thật, middleware thật, envelope
 * thật, PostgreSQL thật (issue #208).
 *
 * ## Vì sao test này tồn tại
 *
 * Contract này là control point fail-closed lúc `auth` phát hành token
 * (`docs/applications/auth/01-architecture.md` §6.0), và nó từng **không bao giờ chạy được**:
 * consumer gửi `?account_id=`, route đọc `query.sub` rồi `isSubject` nó, nên một request
 * ký hoàn hảo nhận `400`. Không có gì đỏ ở đâu: `400` là một nhánh fail-closed hợp lệ, nên
 * triệu chứng duy nhất là "không phát hành được token", đọc ra như một sự cố hạ tầng.
 *
 * Vì vậy suite này phải chạy **đúng đường production đi qua**, không phải một phiên bản
 * thuận tiện của nó:
 *
 * - h3 app thật (`createApp` + `createRouter` + `toWebHandler`), handler import trực tiếp
 *   từ `server/routes/`.
 * - Middleware internal-auth **thật**, không phải một bản `authorized: true`: nếu thay nó
 *   bằng mock thì mọi case dưới đây xanh kể cả khi chữ ký không bao giờ được kiểm — tức
 *   suite mất đúng thứ nó cần chứng minh (task §5(B)).
 * - `signRequest` canonical thật từ `@ecoma-io/internal-auth-contracts`, cùng hàm `auth` dùng.
 * - `db-account` thật (testcontainers) với credential runtime thật, nên `selectAccountStatus`
 *   và `recordNonce` chạy trên schema thật.
 *
 * ⚠️ **Không** gọi thẳng handler với một `event` tự dựng: `event.path` của h3 đã gồm query
 * string, và một `fakeEvent` tự dựng (`path` không query) từng bảo vệ hành vi sai (xem
 * JSDoc của `internal-auth-e2e.spec.ts`).
 *
 * ## Anti-regression: `?account_id=` phải 400
 *
 * Case đó không phải "test thêm cho chắc". Nó là **mutation-check ở phía provider**: nếu
 * consumer quay lại tên tham số cũ, đường này từ chối request — và đó chính là lý do phải
 * sửa consumer chứ không phải nới provider. Cùng lúc nó khoá quyết định #208: provider đọc
 * **một** tên, không nhận alias.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAccountStatusResponse } from '@ecoma-io/account-contracts';
import { createNonce, signRequest } from '@ecoma-io/internal-auth-contracts';

import internalAuthMiddleware from '../../server/middleware/internal-auth';
import statusRoute from '../../server/routes/internal/account/status.get';
import { writeLog } from '../../server/utils/logger';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
/** Secret hợp lệ cho test — không phải secret thật, chỉ để ký/verify. */
const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/** Path của contract, không kèm query. */
const STATUS_ROUTE = '/internal/account/status';

/** `sub` hợp lệ: `sub_` + 32 ký tự base32 viết thường (`isSubject`). */
const SUB_ACTIVE = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_SUSPENDED = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUB_DELETED = 'sub_dddddddddddddddddddddddddddddddd';
const SUB_UNKNOWN = 'sub_cccccccccccccccccccccccccccccccc';

const mockedWriteLog = vi.mocked(writeLog);

/** Path có query — query là một phần của chuỗi ký, nên không được tách rời. */
function statusPath(param: string, value: string): string {
  return `${STATUS_ROUTE}?${param}=${value}`;
}

/**
 * Ký một GET cho `path` **kèm nguyên query string**, như `auth` làm.
 *
 * ⚠️ Không dựng lại path từ các mảnh ở đây: phải ký đúng chuỗi sẽ gửi. Một helper tự ghép
 * query sẽ che mất chính lỗi mà suite này kiểm.
 */
async function signedGetHeaders(path: string, secret = SECRET): Promise<Record<string, string>> {
  return signRequest({
    method: 'GET',
    path,
    body: undefined,
    secret,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: createNonce(),
  });
}

/** Dòng log nào của handler (không phải middleware) đã chạy. */
function handlerHandled(): boolean {
  return mockedWriteLog.mock.calls.some(
    ([entry]) =>
      entry['event'] === 'account_status.read' ||
      entry['event'] === 'account_status.invalid_response' ||
      entry['event'] === 'account_status.failed',
  );
}

/** Phần `runtimeConfig` mà middleware, route và bindings của app này đọc. */
interface AccountRuntimeConfig {
  internalHmacSecret: string;
  internalAuthSkewSeconds: string;
  cloudflare: { env: { DB_ACCOUNT: { connectionString: string } } };
}

/**
 * Binding trỏ vào một cổng không có listener.
 *
 * `ECONNREFUSED` ngay, không phải một lần chờ timeout — test fail-closed phải đo **nhánh
 * xử lý lỗi**, không đo độ kiên nhẫn của driver.
 */
function unreachableRuntimeConfig(): AccountRuntimeConfig {
  return {
    internalHmacSecret: SECRET,
    internalAuthSkewSeconds: '',
    cloudflare: {
      env: { DB_ACCOUNT: { connectionString: 'postgres://nobody:nobody@127.0.0.1:1/nothing' } },
    },
  };
}

describe('GET /internal/account/status end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;

  /** runtimeConfig của đường chạy thật: secret + binding tới container của test. */
  function fullRuntimeConfig(): AccountRuntimeConfig {
    return {
      internalHmacSecret: SECRET,
      internalAuthSkewSeconds: '',
      cloudflare: {
        env: {
          DB_ACCOUNT: {
            connectionString: `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`,
          },
        },
      },
    };
  }

  async function send(path: string, headers?: Record<string, string>): Promise<Response> {
    return handler(
      new Request(`http://localhost${path}`, headers === undefined ? {} : { headers }),
    );
  }

  /** Gửi một request đã ký cho `path`. */
  async function sendSigned(path: string, overrides: { secret?: string } = {}): Promise<Response> {
    return send(path, await signedGetHeaders(path, overrides.secret));
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig());

    const app = createApp();
    // Thứ tự đúng như Nitro: middleware phủ `/internal/**` trước, route trả lời sau.
    app.use(internalAuthMiddleware);
    const router = createRouter();
    router.get(STATUS_ROUTE, statusRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig());
    mockedWriteLog.mockClear();
    const client = await db.connect();
    try {
      await client.query(
        `TRUNCATE account.internal_nonces, account.users RESTART IDENTITY CASCADE`,
      );
      // `deleted` phải kèm `deleted_at` — ràng buộc `users_deleted_at_check` của schema.
      await client.query(
        `INSERT INTO account.users (sub, status, deleted_at) VALUES
           ($1, 'active', NULL), ($2, 'suspended', NULL), ($3, 'deleted', now())`,
        [SUB_ACTIVE, SUB_SUSPENDED, SUB_DELETED],
      );
    } finally {
      await client.end();
    }
  });

  it('returns the contract for a valid subject with a correct signature — not 400', async () => {
    // Case gốc của #208: trước khi sửa consumer, **đúng** request này trả 400 vì thiếu
    // `sub`. Assert `200` ở đây là assert "tên tham số khớp", không phải "chữ ký đúng" —
    // chữ ký đã đúng cả trước khi sửa.
    const path = statusPath('sub', SUB_ACTIVE);
    const response = await sendSigned(path);

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ status: 'active' });

    // FR-011b: body đúng một trường, và validator canonical chấp nhận nó.
    expect(Object.keys(body as Record<string, unknown>)).toEqual(['status']);
    expect(validateAccountStatusResponse(body).ok).toBe(true);

    // FR-011e: response này là authority, không tầng cache nào được giữ.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['suspended', SUB_SUSPENDED, 'suspended'],
    ['deleted', SUB_DELETED, 'deleted'],
    // `not_found` là một trong bốn giá trị hợp lệ, không phải lỗi: trả nó như một lỗi
    // riêng sẽ tạo thêm một oracle đo sự tồn tại của account (FR-011b).
    ['not found', SUB_UNKNOWN, 'not_found'],
  ])('keeps the status mapping: %s', async (_label, sub, expected) => {
    const path = statusPath('sub', sub);
    const response = await sendSigned(path);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: expected });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects `?account_id=` with 400 — the provider-side mutation check', async () => {
    // ⚠️ Đây là bản ghim của quyết định #208: provider đọc `sub` và **chỉ** `sub`.
    // Request dưới đây được ký hoàn hảo cho đúng path nó gửi; nó bị từ chối vì tên tham
    // số, không vì chữ ký. Nếu case này chuyển sang 200 thì provider đã nhận thêm một
    // alias, và consumer có thể lệch lại mà không có gì đỏ.
    const path = statusPath('account_id', SUB_ACTIVE);
    const response = await sendSigned(path);

    expect(response.status).toBe(400);
    // Handler không chạy: `400` đến từ bước kiểm tham số, không phải từ một lần đọc DB
    // rồi tự từ chối.
    expect(handlerHandled()).toBe(false);
  });

  it.each([
    ['malformed subject', 'not-a-subject'],
    ['missing the prefix', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['one character too many', 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab'],
    ['uppercase base32', 'sub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['empty', ''],
    ['numeric', '12345'],
  ])('rejects an invalid subject (%s) with 400', async (_label, value) => {
    // Subject không hợp lệ là **lỗi của caller**, không phải "account không tồn tại":
    // hai sự kiện đó khác nhau, và gộp chúng lại là nới `isSubject` (task §6).
    const path = statusPath('sub', value);
    const response = await sendSigned(path);

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a request that carries no `sub` parameter at all with 400', async () => {
    // `sub` vắng mặt hoàn toàn — không có query string nào. Khác case `?account_id=` ở chỗ:
    // đó là một tham số **sai tên**, còn đây không có tham số nào. Cả hai đều phải `400`, và
    // cả hai đều không được rơi xuống `not_found` (đó sẽ là "không có account" — một kết
    // luận nghiệp vụ — thay vì "caller gửi sai" — một lỗi của caller).
    const response = await sendSigned(STATUS_ROUTE);

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a repeated query parameter, never silently taking the first element', async () => {
    // ⚠️ `getQuery` trả mảng khi param lặp lại. Cả hai giá trị ở đây đều là subject hợp
    // lệ và đều tồn tại trong DB (một `active`, một `suspended`), nên nếu route lấy phần
    // tử đầu thì request này trả `200 {status:'active'}` — và đó là đường né kiểm tra:
    // caller đọc được trạng thái của một `sub` khác với `sub` nó ký.
    const path = `${STATUS_ROUTE}?sub=${SUB_ACTIVE}&sub=${SUB_SUSPENDED}`;
    const response = await sendSigned(path);

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a request without the envelope with 401', async () => {
    const response = await send(statusPath('sub', SUB_ACTIVE));

    expect(response.status).toBe(401);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a forged signature with 401, and reads no DB', async () => {
    const path = statusPath('sub', SUB_ACTIVE);
    const response = await sendSigned(path, { secret: 'wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx' });

    expect(response.status).toBe(401);
    expect(handlerHandled()).toBe(false);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected', reason: 'bad_signature' }),
    );
  });

  it('fails closed with 401 when the binding is absent, never falling back to a status', async () => {
    // Không có binding ⇒ không có kho nonce ⇒ không xác minh được replay ⇒ từ chối. Nhánh
    // này **không** được trả `not_found`, và cũng không được bỏ qua kiểm tra: "chưa cấu
    // hình" không bao giờ là "cho phép".
    setRuntimeConfig({ internalHmacSecret: SECRET, internalAuthSkewSeconds: '' });
    const response = await sendSigned(statusPath('sub', SUB_ACTIVE));

    expect(response.status).toBe(401);
    expect(handlerHandled()).toBe(false);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected', reason: 'no_binding' }),
    );
  });

  it('fails closed with 503 when the database is unreachable', async () => {
    // ⚠️ Với middleware thật ở trước, `503 db_unreachable` đến từ **kho nonce**, không
    // phải từ `selectAccountStatus`: cả hai dùng chung một binding và cùng chết. Đó là
    // hành vi đúng của đường này (hai tầng đều fail-closed), nhưng nó cũng có nghĩa nhánh
    // `503 binding_missing` / `503 db_unreachable` bên trong route chỉ chạy khi binding
    // sống cho tầng này và chết cho tầng kia — một cửa sổ hẹp, không phải đường chính.
    // Điều quan trọng ở đây là **không** có trạng thái nào được trả về.
    setRuntimeConfig(unreachableRuntimeConfig());
    const response = await sendSigned(statusPath('sub', SUB_ACTIVE));

    expect(response.status).toBe(503);
    expect(handlerHandled()).toBe(false);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected', reason: 'db_unreachable' }),
    );
  }, 30_000);

  it('returns no identity field beyond the contract', async () => {
    // FR-011b ở tầng response thật: `account.users` không có cột định danh nào, nhưng một
    // `SELECT *` hay một lần thêm field vào payload sẽ biến endpoint này thành đường đọc
    // hồ sơ. Assert trên body đã qua `JSON` là lớp phòng thủ cuối.
    const path = statusPath('sub', SUB_ACTIVE);
    const response = await sendSigned(path);
    const body = (await response.json()) as Record<string, unknown>;

    for (const field of [
      'email',
      'name',
      'display_name',
      'profile',
      'session',
      'roles',
      'permissions',
      'created_at',
      'deleted_at',
    ]) {
      expect(body).not.toHaveProperty(field);
    }
    expect(validateAccountStatusResponse(body)).toEqual({
      ok: true,
      payload: { status: 'active' },
    });
  });
});
