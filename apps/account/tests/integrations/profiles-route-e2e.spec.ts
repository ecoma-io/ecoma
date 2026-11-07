/**
 * `GET /internal/account/profiles` end-to-end — route thật, middleware thật, envelope
 * thật, PostgreSQL thật (issue #325).
 *
 * Cùng chuẩn với `status-route-e2e.spec.ts`: h3 app thật, middleware internal-auth
 * **thật**, `signRequest`/`createNonce` canonical thật, `db-account` thật qua
 * testcontainers. Một handler mock hóa sẽ làm mọi case dưới đây xanh kể cả khi chữ ký
 * hay batch check không bao giờ chạy.
 *
 * ⚠️ **Không** gọi thẳng handler với một `event` tự dựng — ký đúng chuỗi path sẽ gửi,
 * vì query string là một phần của canonical HMAC.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNonce,
  signRequest,
  validateAccountProfilesResponse,
} from '@ecoma-io/account-contracts';

import internalAuthMiddleware from '../../server/middleware/internal-auth';
import profilesRoute from '../../server/routes/internal/account/profiles.get';
import { writeLog } from '../../server/utils/logger';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
/** Secret hợp lệ cho test — không phải secret thật, chỉ để ký/verify. */
const SECRET = 'test-internal-hmac-secret-0123456789abcdef';

/** Path của contract, không kèm query. */
const PROFILES_ROUTE = '/internal/account/profiles';

/** `sub` hợp lệ: `sub_` + 32 ký tự base32 viết thường (`isSubject`). */
const SUB_NAMED = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_UNNAMED = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SUB_NO_ROW = 'sub_cccccccccccccccccccccccccccccccc';

const mockedWriteLog = vi.mocked(writeLog);

/** Path có query — query là một phần của chuỗi ký, nên không được tách rời. */
function profilesPath(subs: string[]): string {
  return `${PROFILES_ROUTE}?subs=${subs.join(',')}`;
}

/**
 * Ký một GET cho `path` **kèm nguyên query string**, như backoffice làm.
 *
 * ⚠️ Không dựng lại path từ các mảnh ở đây: phải ký đúng chuỗi sẽ gửi.
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
      entry['event'] === 'account_profiles.read' ||
      entry['event'] === 'account_profiles.invalid_response' ||
      entry['event'] === 'account_profiles.failed',
  );
}

/** Phần `runtimeConfig` mà middleware, route và bindings của app này đọc. */
interface ProfilesRuntimeConfig {
  internalHmacSecret: string;
  internalAuthSkewSeconds: string;
  cloudflare: { env: { DB_ACCOUNT: { connectionString: string } } };
}

describe('GET /internal/account/profiles end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;

  /** runtimeConfig của đường chạy thật: secret + binding tới container của test. */
  function fullRuntimeConfig(): ProfilesRuntimeConfig {
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

  /** Seed hai profile: một có tên, một row tồn tại nhưng display_name NULL. */
  async function seedProfiles(): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.user_profiles (user_sub, display_name, avatar_url) VALUES
           ($1, 'Nguyễn Văn A', NULL), ($2, NULL, NULL)`,
        [SUB_NAMED, SUB_UNNAMED],
      );
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig());

    const app = createApp();
    // Thứ tự đúng như Nitro: middleware phủ `/internal/**` trước, route trả lời sau.
    app.use(internalAuthMiddleware);
    const router = createRouter();
    router.get(PROFILES_ROUTE, profilesRoute);
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
      // FK: `user_profiles.user_sub` tham chiếu `users.sub`, nên truncate cascade cả
      // hai rồi seed lại — mỗi case tự đứng, không rò dữ liệu case trước.
      await client.query(`TRUNCATE account.user_profiles, account.users RESTART IDENTITY CASCADE`);
      // Mọi `user_profiles` cần một `users` row cha (FK `user_profiles_user_sub_fkey`).
      await client.query(
        `INSERT INTO account.users (sub, status) VALUES ($1, 'active'), ($2, 'active'),
           ($3, 'active')`,
        [SUB_NAMED, SUB_UNNAMED, SUB_NO_ROW],
      );
    } finally {
      await client.end();
    }
    await seedProfiles();
  });

  it('returns display names for the requested subs with a correct signature', async () => {
    const response = await sendSigned(profilesPath([SUB_NAMED, SUB_UNNAMED, SUB_NO_ROW]));

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({
      profiles: [
        { sub: SUB_NAMED, displayName: 'Nguyễn Văn A' },
        // Row tồn tại nhưng display_name NULL → null, không phải lỗi.
        { sub: SUB_UNNAMED, displayName: null },
        // Không có row profile → null, cùng nghĩa nghiệp vụ với NULL.
        { sub: SUB_NO_ROW, displayName: null },
      ],
    });
    expect(validateAccountProfilesResponse(body).ok).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('preserves the request order of the subs in the response', async () => {
    const response = await sendSigned(profilesPath([SUB_UNNAMED, SUB_NAMED]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profiles: [
        { sub: SUB_UNNAMED, displayName: null },
        { sub: SUB_NAMED, displayName: 'Nguyễn Văn A' },
      ],
    });
  });

  it('never returns a sub that was not asked, even when it exists', async () => {
    // SUB_NO_ROW không có dữ liệu, dùng sub thứ tư có profile thật để chứng minh "chỉ
    // trả sub được hỏi" — thêm một sub có profile nhưng không nằm trong `subs`.
    const client = await db.connect();
    const SUB_NOT_ASKED = 'sub_dddddddddddddddddddddddddddddddd';
    try {
      // FK `user_profiles_user_sub_fkey` đòi một `users` row cha cho sub này.
      await client.query(`INSERT INTO account.users (sub, status) VALUES ($1, 'active')`, [
        SUB_NOT_ASKED,
      ]);
      await client.query(
        `INSERT INTO account.user_profiles (user_sub, display_name) VALUES ($1, 'Đào E')`,
        [SUB_NOT_ASKED],
      );
    } finally {
      await client.end();
    }

    const response = await sendSigned(profilesPath([SUB_NAMED]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profiles: Array<{ sub: string }> };
    expect(body.profiles.map((entry) => entry.sub)).toEqual([SUB_NAMED]);
  });

  it('deduplicates repeated subs in the query', async () => {
    const response = await sendSigned(profilesPath([SUB_NAMED, SUB_NAMED]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profiles: [{ sub: SUB_NAMED, displayName: 'Nguyễn Văn A' }],
    });
  });

  it('rejects a missing `subs` parameter with 400', async () => {
    const response = await sendSigned(PROFILES_ROUTE);

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects an empty `subs` parameter with 400', async () => {
    const response = await sendSigned(`${PROFILES_ROUTE}?subs=`);

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it.each([
    ['malformed subject', 'not-a-subject'],
    ['missing the prefix', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['uppercase base32', 'sub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['numeric', '12345'],
  ])('rejects an invalid subject in the batch (%s) with 400', async (_label, value) => {
    // Một `sub` sai định dạng trong danh sách là **lỗi của caller** — toàn request bị
    // từ chối, không trả kết quả một phần.
    const response = await sendSigned(profilesPath([SUB_NAMED, value]));

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a batch over the 100-sub ceiling with 400', async () => {
    // 101 sub hợp lệ về định dạng nhưng vượt trần contract.
    const subs = Array.from(
      { length: 101 },
      (_, i) => `sub_${String(i).padStart(2, '0').slice(0, 2)}${'a'.repeat(30)}`,
    );
    const response = await sendSigned(profilesPath(subs));

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a repeated query parameter, never silently taking the first element', async () => {
    // ⚠️ `getQuery` trả mảng khi param lặp lại — cùng đường né kiểm tra mà
    // status-route-e2e.spec.ts đã ghim.
    const response = await sendSigned(`${PROFILES_ROUTE}?subs=${SUB_NAMED}&subs=${SUB_UNNAMED}`);

    expect(response.status).toBe(400);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a request without the envelope with 401', async () => {
    const response = await send(profilesPath([SUB_NAMED]));

    expect(response.status).toBe(401);
    expect(handlerHandled()).toBe(false);
  });

  it('rejects a forged signature with 401, and reads no DB', async () => {
    const response = await sendSigned(profilesPath([SUB_NAMED]), {
      secret: 'wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx',
    });

    expect(response.status).toBe(401);
    expect(handlerHandled()).toBe(false);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'internal_auth.rejected', reason: 'bad_signature' }),
    );
  });

  it('returns no profile field beyond displayName', async () => {
    const response = await sendSigned(profilesPath([SUB_NAMED]));
    const body = (await response.json()) as { profiles: Array<Record<string, unknown>> };

    for (const entry of body.profiles) {
      expect(Object.keys(entry).toSorted()).toEqual(['displayName', 'sub']);
      for (const field of ['email', 'avatar_url', 'status', 'created_at', 'display_name']) {
        expect(entry).not.toHaveProperty(field);
      }
    }
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
