/**
 * Bất biến vòng đời của `otp_challenges` dưới tải đồng thời — PostgreSQL thật
 * (testcontainers), đúng route `verify` production đi qua.
 *
 * ## Vì sao suite này tách khỏi `otp-flow-e2e`
 *
 * `otp-flow-e2e` phủ luồng tuần tự: sai mã, trần 5 lần thử tuần tự, cooldown,
 * rate limit cấp mã. Suite này phủ phần còn lại — **nhiều request cùng lúc
 * trên một challenge**:
 *
 * - Brute-force đồng thời không được vượt trần hiệu lực của `MAX_OTP_ATTEMPTS`:
 *   việc khoá phải nằm TRONG câu UPDATE tăng `attempts` (`recordFailedAttemptAndLock`
 *   — điều kiện khoá là cột `CASE`, không phải quyết định sau ở route); nếu khoá
 *   là UPDATE riêng chạy sau, hai request cạnh nhau có khoảng trống giữa tăng
 *   và khoá — trần 5 chạy được lên 10. Suite này chứng minh hành vi cuối cùng,
 *   không chỉ câu lệnh.
 * - Replay đồng thời của mã đúng chỉ phát hành đúng một session:
 *   `consumeChallenge` là CAS (`WHERE consumed_at IS NULL`), và nhiều request
 *   mang cùng mã đúng phải cho ra đúng một `200` + một session.
 * - Verify trên challenge đã hết hạn: từ chối bằng `400` chung chung VÀ khoá
 *   hàng (`expireChallengeIfExpired` — hygiene vòng đời), không có đường nào
 *   hồi sinh hàng đã khoá.
 * - Verify trên challenge đã consume ở ngoài route: vẫn `400`, không session.
 *
 * Mọi nhánh từ chối của verify là `400` chung chung — suite cũng neo phần
 * anti-enumeration của THÂN response: lý do (`code_mismatch`, `challenge_expired`,
 * `already_consumed`) sống ở log, không bao giờ ra ngoài.
 */

import { createHash } from 'node:crypto';

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import verifyRoute from '../../server/api/auth/verify.post';
import {
  expireChallengeIfExpired,
  findActiveChallenge,
  MAX_OTP_ATTEMPTS,
  normalizeAndHashEmail,
  OTP_PURPOSE_LOGIN,
  otpDigest,
} from '../../server/lib/otp';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
/** Secret OTP của test — phải khớp giữa config và phép tính digest của seed. */
const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';

/** `sub` hợp lệ theo `isSubject` — prefix `sub_` + 32 base32 thường. */
const SUB_MAIN = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMAIL_MAIN = 'user@example.com';
const WRONG_CODE = '00000000';
const CORRECT_CODE = '24680135';

function fullRuntimeConfig(connectionString: string): AccountTestRuntimeConfig {
  return {
    internalHmacSecret: 'test-internal-hmac-secret-0123456789abcdef',
    otpHmacSecret: OTP_SECRET,
    mailServiceUrl: 'https://mail.test',
    mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
    cloudflare: { env: { DB_ACCOUNT: { connectionString } } },
  };
}

describe('otp challenge lifecycle invariants', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  /** POST verify qua route thật — caller tự assert status. */
  function post(code: string): Promise<Response> {
    return handler(
      new Request('http://localhost/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL_MAIN, code }),
      }),
    );
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig(connectionString));

    const app = createApp();
    const router = createRouter();
    router.post('/api/auth/verify', verifyRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString));
    await db.truncateData();
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ($1)`, [SUB_MAIN]);
      const normalized = EMAIL_MAIN.trim().toLowerCase();
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now())`,
        [SUB_MAIN, normalized, createHash('sha256').update(normalized).digest('hex')],
      );
    } finally {
      await client.end();
    }
  });

  /**
   * Ghi một challenge với digest, TTL và mốc tạo vuột kiểm soát — test điều
   * khiển tuổi thọ.
   *
   * ⚠️ `created_at` của DB là `DEFAULT now()` và CHECK `expires_at > created_at`
   * chặn insert một hàng hết hạn sẵn (expires_at < created_at). Muốn seed hàng
   * "đã hết hạn" phải đẩy `created_at` về quá khứ — đó là hành vi test hợp lệ
   * (mô phỏng một hàng đã tồn tại TTL giây trước), không phải nới ràng buộc.
   */
  async function seedChallenge(
    digest: string,
    expiresAt: Date,
    createdAt: Date = new Date(Date.now() - 60_000),
  ): Promise<void> {
    const pool = await db.createRuntimePool();
    try {
      await pool.query(
        `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          await (await normalizeAndHashEmail(EMAIL_MAIN)).hash,
          digest,
          OTP_PURPOSE_LOGIN,
          expiresAt,
          createdAt,
        ],
      );
    } finally {
      await pool.end();
    }
  }

  /** Seed challenge cho mã đúng — digest tính bằng cùng secret của config. */
  async function seedCorrectCodeChallenge(): Promise<void> {
    await seedChallenge(
      await otpDigest(OTP_SECRET, OTP_PURPOSE_LOGIN, CORRECT_CODE),
      new Date(Date.now() + 600_000),
    );
  }

  /** Seed challenge cho mã sai — hàng CHỨA digest của mã đúng, request sẽ nộp mã sai. */
  async function seedWrongCodeChallenge(): Promise<void> {
    await seedChallenge(
      await otpDigest(OTP_SECRET, OTP_PURPOSE_LOGIN, CORRECT_CODE),
      new Date(Date.now() + 600_000),
    );
  }

  /** Số hàng chưa consume trong bảng. */
  async function activeCount(): Promise<number> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) FILTER (WHERE consumed_at IS NULL) AS count
           FROM account.otp_challenges`,
      );
      return Number(rows[0]?.count ?? 0);
    } finally {
      await client.end();
    }
  }

  /** Số lần thử và trạng thái khoá của hàng duy nhất trong bảng. */
  async function challengeState(): Promise<{ attempts: number; locked: boolean }> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ attempts: number; locked: number }>(
        `SELECT attempts, (consumed_at IS NOT NULL)::int AS locked FROM account.otp_challenges`,
      );
      return { attempts: rows[0]?.attempts ?? 0, locked: (rows[0]?.locked ?? 0) === 1 };
    } finally {
      await client.end();
    }
  }

  /** Số session đã phát hành. */
  async function sessionCount(): Promise<number> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.account_sessions`,
      );
      return Number(rows[0]?.count ?? 0);
    } finally {
      await client.end();
    }
  }

  it('concurrent wrong-code verifies cannot exceed the effective attempt cap', async () => {
    // 12 verify sai ĐỒNG THỜI trên một challenge còn đủ lượt. Trần hiệu lực là
    // MAX_OTP_ATTEMPTS: việc khoá nằm TRONG câu UPDATE tăng `attempts`
    // (`recordFailedAttemptAndLock`), nên có bao nhiêu request cạnh nhau chen
    // vào đoạn "tăng rồi mới khoá" cũng không mua được một lần dư — trước khi
    // sửa, khoá là UPDATE riêng ở route và trần chạy lên 10.
    await seedWrongCodeChallenge();

    const responses = await Promise.all(Array.from({ length: 12 }, () => post(WRONG_CODE)));
    for (const response of responses) {
      expect(response.status).toBe(400);
      // Thân không phân biệt lý do — anti-enumeration của verify. Đọc một lần:
      // body của một Response chỉ đọc được một lần.
      const body = await response.text();
      expect(body).not.toContain('limit');
      expect(body).not.toContain('lock');
    }

    const state = await challengeState();
    expect(state.attempts).toBe(MAX_OTP_ATTEMPTS);
    expect(state.locked).toBe(true);
    expect(await sessionCount()).toBe(0);
  });

  it('concurrent correct-code verifies mint at most one session', async () => {
    await seedCorrectCodeChallenge();

    const responses = await Promise.all(Array.from({ length: 8 }, () => post(CORRECT_CODE)));
    const statusCounts = responses.reduce<Record<number, number>>((acc, response) => {
      acc[response.status] = (acc[response.status] ?? 0) + 1;
      return acc;
    }, {});
    // Đúng một request phát hành session; 7 request còn lại nhận 400 — thua
    // consume mang cùng thân như mọi nhánh từ chối khác.
    expect(statusCounts[200]).toBe(1);
    expect(statusCounts[400]).toBe(7);
    expect(await sessionCount()).toBe(1);
    expect(await activeCount()).toBe(0);
  });

  it('a correct code after the attempt cap was hit is rejected without a session', async () => {
    // Trần đã khoá challenge bằng mã sai; mã ĐÚNG không hồi sinh hàng đã khoá —
    // khoá của trần chặn cả đường mã đúng, không chỉ đường mã sai.
    await seedCorrectCodeChallenge();

    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
      const response = await post(WRONG_CODE);
      expect(response.status).toBe(400);
    }
    expect((await challengeState()).locked).toBe(true);

    const correctAfterLock = await post(CORRECT_CODE);
    expect(correctAfterLock.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });

  it('verify of an expired challenge locks the row and answers the generic 400', async () => {
    // Hàng hết hạn: là hàng "chưa consume mới nhất" của (address, purpose) nhưng
    // đã qua TTL. Verify phải từ chối VÀ khoá — nếu không khoá, hàng chết nằm
    // ở trạng thái "active theo ràng buộc" vĩnh viễn, và `consumed_at IS NULL`
    // mất nghĩa "chưa đi qua vòng đời".
    await seedChallenge('a'.repeat(64), new Date(Date.now() - 1000), new Date(Date.now() - 60_000));
    expect(await activeCount()).toBe(1);

    const response = await post(CORRECT_CODE);
    expect(response.status).toBe(400);
    expect(await activeCount()).toBe(0);
    expect(await sessionCount()).toBe(0);
  });

  it('locking an expired challenge is idempotent and cannot resurrect the row', async () => {
    // Khoá lần hai trên hàng đã consume đổi 0 hàng — hết hạn-khoá không đảo
    // ngược vòng đời của hàng.
    await seedChallenge('b'.repeat(64), new Date(Date.now() - 1000), new Date(Date.now() - 60_000));
    const pool = await db.createRuntimePool();
    try {
      const hash = await (await normalizeAndHashEmail(EMAIL_MAIN)).hash;
      const first = await expireChallengeIfExpired(pool, hash, OTP_PURPOSE_LOGIN, Date.now());
      expect(first).toBe(1);
      const second = await expireChallengeIfExpired(pool, hash, OTP_PURPOSE_LOGIN, Date.now());
      expect(second).toBe(0);
    } finally {
      await pool.end();
    }
    expect(await activeCount()).toBe(0);
  });

  it('a new challenge after the expired one was locked works untouched by the lock', async () => {
    // Khoá của hàng hết hạn không đụng hàng KHÁC của cùng địa chỉ: seed hết hạn
    // → verify (khoá) → seed mới còn hạn → verify phải phát hành session.
    await seedChallenge('c'.repeat(64), new Date(Date.now() - 1000), new Date(Date.now() - 60_000));
    expect(await post(CORRECT_CODE).then((response) => response.status)).toBe(400);
    expect(await activeCount()).toBe(0);

    await seedCorrectCodeChallenge();
    const response = await post(CORRECT_CODE);
    expect(response.status).toBe(200);
    expect(await sessionCount()).toBe(1);
  });

  it('a challenge consumed outside the route answers 400 and mints no session', async () => {
    // Consume tại chỗ rồi verify: hàng không còn active nên verify về 400 —
    // single-use áp dụng cả khi consume không qua đường route.
    await seedCorrectCodeChallenge();
    const pool = await db.createRuntimePool();
    try {
      const hash = await (await normalizeAndHashEmail(EMAIL_MAIN)).hash;
      const challenge = await findActiveChallenge(pool, hash, OTP_PURPOSE_LOGIN);
      expect(challenge).not.toBeNull();
      await pool.query(`UPDATE account.otp_challenges SET consumed_at = now() WHERE id = $1`, [
        challenge?.id,
      ]);
    } finally {
      await pool.end();
    }

    const response = await post(CORRECT_CODE);
    expect(response.status).toBe(400);
    expect(await sessionCount()).toBe(0);
  });
});
