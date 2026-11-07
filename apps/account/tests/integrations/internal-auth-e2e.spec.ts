/**
 * End-to-end cho middleware internal-auth: h3 app thật, middleware thật,
 * `signRequest` thật, PostgreSQL thật.
 *
 * ## Vì sao test này tồn tại
 *
 * Hai lỗi CRITICAL từng lọt qua toàn bộ suite 86 test mà không một unit test
 * nào bắt, và cả hai đều là lỗi **đường đi** chứ không phải lỗi hàm thuần:
 *
 * 1. Pool bị `end()` trong `finally` của `withRequestPool` trước khi
 *    `verifyRequest` kịp gọi `claimNonce` ⇒ mọi request internal 500 thay vì
 *    401. Unit test với `fakePool` không có lifecycle nên không thấy được.
 * 2. Hàm "ghép query string trở lại" ký `path?query?query` vì `event.path`
 *    của h3 **đã** gồm query ⇒ mọi request có query `bad_signature`. Unit test
 *    với `fakeEvent` tự dựng cho `path` **không** có query — sai hình dạng,
 *    bảo vệ hành vi sai.
 * 3. Middleware không truyền `body` vào `verifyRequest` ⇒ `hashBody` luôn so
 *    hash chuỗi rỗng: chữ ký không phủ payload, và contract nội bộ có body sẽ
 *    mãi `bad_signature`. Unit test không có đường body nào để bắt điều đó.
 *
 * Vì vậy guard của hai điều đó phải đi qua đúng các lớp mà production đi qua:
 * `createApp`/`createRouter`/`toWebHandler` của h3, middleware import trực tiếp
 * từ `server/middleware/`, chữ ký sinh bởi `signRequest` của lib, và kho nonce
 * là bảng `account.internal_nonces` thật với credential runtime thật.
 */

import { createApp, createRouter, defineEventHandler, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNonce, signRequest } from '@ecoma-io/internal-auth-contracts';

import internalAuthMiddleware from '../../server/middleware/internal-auth';
import { writeLog } from '../../server/utils/logger';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
/** Secret hợp lệ cho test — độ dài >= 32 như validation của app. */
const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/** Path thật của probe — có query string, vì query là một phần của chữ ký. */
const PROBE_PATH = '/internal/e2e-probe?sub=sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Route stub cho middleware pass-through — handler contract thật nằm ở route khác. */
const PROBE_ROUTE = '/internal/e2e-probe';

const mockedWriteLog = vi.mocked(writeLog);

/**
 * Ký một request cho `path` (kèm query) với secret cho trước.
 *
 * ⚠️ `body` nhận **chuỗi** ở đây vì đó là thứ `fetch`/`Request` nhận, nhưng phải được encode
 * thành byte TRƯỚC khi ký: `signRequest` ký `bodyHash` của đúng byte trên dây (F-01). Truyền
 * thẳng chuỗi vào tham số `Uint8Array` là lỗi kiểu, và ở runtime `new Uint8Array('<chuỗi>')`
 * cho ra một mảng số 0 cùng độ dài — tức chữ ký phủ một thân khác hẳn thân được gửi, và
 * middleware từ chối bằng `bad_signature`. Test "passes a request signed with its JSON body"
 * dưới đây chính là ca bắt được điều đó.
 */
async function signedHeaders(
  path: string,
  secret: string,
  nonce = createNonce(),
  options: { readonly method?: string; readonly body?: string } = {},
): Promise<{ headers: Record<string, string>; nonce: string }> {
  const headers = await signRequest({
    method: options.method ?? 'GET',
    path,
    // `body` tham gia chuỗi ký (`bodyHash` trong `canonicalString`); không truyền
    // là ký trên hash thân rỗng — đúng cho GET và cho POST không body.
    body: options.body === undefined ? undefined : new TextEncoder().encode(options.body),
    secret,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce,
  });
  return { headers, nonce };
}

describe('internal-auth middleware end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;

  /** runtimeConfig đầy đủ: secret + binding tới container thật của test. */
  function fullRuntimeConfig(): {
    internalHmacSecret: string;
    internalAuthSkewSeconds: string;
    cloudflare: { env: { DB_ACCOUNT: { connectionString: string } } };
  } {
    return {
      internalHmacSecret: SECRET,
      // Rỗng ⇒ middleware dùng `DEFAULT_SKEW_SECONDS` của lib — đúng mặc định
      // production (runtimeConfig để trống, không đặt số ở nuxt.config).
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

  async function nonceStored(nonce: string): Promise<boolean> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ nonce: string }>(
        `SELECT nonce FROM account.internal_nonces WHERE nonce = $1`,
        [nonce],
      );
      return rows.length === 1;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    db = await startAccountDatabase();

    // Stub config: middleware gọi `useRuntimeConfig(event)` — auto-import của
    // Nitro, không tồn tại ngoài runtime Nitro (xem `nuxt-globals.ts`).
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig());

    const app = createApp();
    // Middleware trước, route sau — đúng thứ tự Nitro dùng: middleware phủ mọi
    // path, route trả lời sau khi middleware cho qua.
    app.use(internalAuthMiddleware);
    const router = createRouter();
    router.get(
      PROBE_ROUTE,
      defineEventHandler(() => ({ ok: true })),
    );
    // POST cũng cần một route: body chỉ tồn tại ở payload method, nên test ký
    // body phải đi POST để tới được đoạn middleware đọc raw body.
    router.post(
      PROBE_ROUTE,
      defineEventHandler(() => ({ ok: true })),
    );
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
      await client.query('DELETE FROM account.internal_nonces');
    } finally {
      await client.end();
    }
  });

  it('passes a correctly signed internal request and records its nonce', async () => {
    const { headers, nonce } = await signedHeaders(PROBE_PATH, SECRET);

    const response = await handler(new Request(`http://localhost${PROBE_PATH}`, { headers }));

    // 200 nghĩa là middleware cho qua và route trả lời — bao gồm cả việc
    // `claimNonce` ghi nonce bằng pool đang sống (lỗi S1: pool đã `end()` thì
    // nhánh này ném `Cannot use a pool after calling end on the pool` ⇒ 500).
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // Chữ ký phủ nguyên path có query (lỗi S2: ghép query lần hai ⇒ 401
    // `bad_signature`), và nonce phải nằm trong kho bền của `db-account`.
    expect(await nonceStored(nonce)).toBe(true);
  });

  it('rejects a replay of the same signed request with 401', async () => {
    const { headers } = await signedHeaders(PROBE_PATH, SECRET);
    const request = (): Promise<Response> =>
      handler(new Request(`http://localhost${PROBE_PATH}`, { headers }));

    const first = await request();
    const replay = await request();

    expect(first.status).toBe(200);
    // Lần thứ hai của **cùng** nonce: kho nonce thật trả "đã thấy" ⇒ 401.
    // Đây là bằng chứng kép: pool sống đủ lâu để `claimNonce` chạy (S1) và
    // store thật chống replay, không phải mock.
    expect(replay.status).toBe(401);
  });

  it('rejects a forged signature with 401 and does not store the nonce', async () => {
    const nonce = createNonce();
    const { headers } = await signedHeaders(
      PROBE_PATH,
      'wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx',
      nonce,
    );

    const response = await handler(new Request(`http://localhost${PROBE_PATH}`, { headers }));

    expect(response.status).toBe(401);
    // ⚠️ Assert này đòi `verifyRequest` của `@ecoma-io/internal-auth-contracts` chỉ
    // gọi `claimNonce` **sau** khi chữ ký đã đúng: trước khi reorder, một request
    // ký sai vẫn ghi mất nonce của chính nó, vô tình "đốt" nonce hợp lệ nếu
    // attacker đoán được. Lib đã reorder — assert này giữ cho lần tái phạm.
    expect(await nonceStored(nonce)).toBe(false);
  });

  it('passes a request signed with its JSON body', async () => {
    // Chữ ký phủ `bodyHash` của payload: middleware phải đọc raw body và truyền
    // vào `verifyRequest`. Thiếu body, `hashBody(undefined)` so hash chuỗi rỗng
    // với chữ ký ký trên body thật ⇒ 401 `bad_signature` cho mọi contract có body.
    const body = JSON.stringify({ action: 'probe', sub: 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const { headers, nonce } = await signedHeaders(PROBE_PATH, SECRET, createNonce(), {
      method: 'POST',
      body,
    });

    const response = await handler(
      new Request(`http://localhost${PROBE_PATH}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(await nonceStored(nonce)).toBe(true);
  });

  it('rejects with 401 bad_signature when the body is swapped after signing', async () => {
    // Chữ ký không phủ payload là lỗ hổng thật: người quan sát một envelope hợp
    // lệ (method + path + body) có thể thay body rồi burn nonce đó. Ký trên body
    // A nhưng gửi body B ⇒ hash khác ⇒ `bad_signature`.
    const signedBody = JSON.stringify({ action: 'probe', amount: 1 });
    const tamperedBody = JSON.stringify({ action: 'probe', amount: 999 });
    const { headers, nonce } = await signedHeaders(PROBE_PATH, SECRET, createNonce(), {
      method: 'POST',
      body: signedBody,
    });

    const response = await handler(
      new Request(`http://localhost${PROBE_PATH}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: tamperedBody,
      }),
    );

    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'internal_auth.rejected',
        reason: 'bad_signature',
      }),
    );
    // Chữ ký sai ⇒ `claimNonce` không chạy ⇒ nonce không bị đốt.
    expect(await nonceStored(nonce)).toBe(false);
  });

  it('keeps a bodyless signed request working unchanged', async () => {
    // Regression: POST không body ký không body phải qua — `readRawBody` trả
    // `undefined` (không content-length), `hashBody(undefined)` == hash chuỗi
    // rỗng, đúng chuỗi mà `signRequest` không truyền `body` đã ký.
    const { headers, nonce } = await signedHeaders(PROBE_PATH, SECRET, createNonce(), {
      method: 'POST',
    });

    const response = await handler(
      new Request(`http://localhost${PROBE_PATH}`, { method: 'POST', headers }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(await nonceStored(nonce)).toBe(true);
  });

  it('rejects with 401 no_secret when the HMAC secret is not configured', async () => {
    setRuntimeConfig({ ...fullRuntimeConfig(), internalHmacSecret: '' });
    const { headers } = await signedHeaders(PROBE_PATH, SECRET);

    const response = await handler(new Request(`http://localhost${PROBE_PATH}`, { headers }));

    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected', reason: 'no_secret' }),
    );
  });

  it('rejects with 401 no_binding when the Hyperdrive binding is absent', async () => {
    setRuntimeConfig({ internalHmacSecret: SECRET, internalAuthSkewSeconds: '' });
    const { headers } = await signedHeaders(PROBE_PATH, SECRET);

    const response = await handler(new Request(`http://localhost${PROBE_PATH}`, { headers }));

    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected', reason: 'no_binding' }),
    );
  });

  it('leaves non-internal paths alone', async () => {
    const response = await handler(new Request('http://localhost/health'));
    // Không có route nào ngoài probe ⇒ 404 từ h3, không phải 401 từ middleware:
    // middleware không chạm gì tới path ngoài `/internal/`.
    expect(response.status).toBe(404);
    expect(mockedWriteLog).not.toHaveBeenCalled();
  });
});
