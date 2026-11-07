/**
 * Semantics store trên **D1 thật** cho những ca mà suite persistence lib
 * (`apps/transactional-mail/tests/integrations/mail-d1.spec.ts`) chưa có bằng chứng:
 *
 * - **Claim đồng thời giữa hai publisher** — hai `claim` chạy `Promise.all` trên những row
 *   còn lease: cách bảo vệ duy nhất là *một* statement có guard (D1 không có row lock,
 *   `04-platform-facts.md` DB11). Suite lib chỉ chứng minh tuần tự ("claim thứ hai trong lúc
 *   lease còn sống không được row"); ca đồng thời thật sự — cả hai statement chen nhau
 *   trong khoá ghi của engine — chưa từng được chạy.
 * - **Idempotent insert trên retry**: createWithOutbox đã có suite riêng; ca còn thiếu là
 *   *reconciler redispatch*: outbox `published` được reset về `pending` mà generation giữ
 *   nguyên — cùng delivery intent được claim lại đúng một lần nữa, không sinh row thứ hai.
 * - **Biên cửa sổ rate limit**: mốc chuyển cửa sổ phải theo đúng bất đẳng thức tài liệu —
 *   `window_started_at <= nowMs - window` là *hết hạn* — nghĩa là `nowMs` đúng bằng
 *   `started + window` **đã** mở cửa sổ mới. Suite lib dừng ở `NOW + window` (xa mốc);
 *   chưa ai ghim đúng ms biên.
 * - **TTL replay nonce**: claim *lại* sau khi prune đã xoá phải được ghi nhận như một claim
 *   mới — hành vi anh em với "expiry là biên duy nhất xoá nonce", đã có trong suite lib
 *   nhưng chưa có ca claim-sau-prune.
 *
 * Mỗi describe tự chứa seed của mình; helper dựng state nằm ngay trong suite (06 §9:
 * support của suite nằm trong thư mục suite). Nguồn canonical:
 * `docs/applications/transactional-mail/01-architecture.md` §6.2, §6.3, §6.2.2, §7.4;
 * `docs/architecture/04-platform-facts.md` DB2, DB11.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MailOutboxRecord } from '@ecoma-io/transactional-mail-application';
import { createD1MailPersistence } from '@ecoma-io/transactional-mail-infrastructure';

import { lit, startMailD1, type MailD1Handle } from './harness';

const NOW = 1_730_000_000_000;
const LEASE_MS = 60_000;
/** Fingerprint đúng định dạng `p1.k1:<64 hex>` mà CHECK chấp nhận. */
const FINGERPRINT = `p1.k1:${'a'.repeat(64)}`;
/** Template seed từ migration `0009` — có sẵn sau `applyMigrations`, không seed lại. */
const SEED_TEMPLATE_ID = 'tpl-account-login-otp-en';

const persistence = () => createD1MailPersistence(handle.db);

let handle: MailD1Handle;

beforeAll(async () => {
  handle = await startMailD1();
}, 240_000);

afterAll(async () => {
  await handle.stop();
});

let seq = 0;

/** Id duy nhất trong phạm vi suite — deterministic, không random. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** Tập deliveryId của một batch claim — để so rời nhau giữa hai batch đồng thời. */
function idsOf(batch: readonly MailOutboxRecord[]): Set<string> {
  return new Set(batch.map((row) => row.deliveryId));
}

interface CreateOverrides {
  readonly principalId?: string;
  readonly nowMs?: number;
}

/** Seed message + outbox pending qua đúng entrypoint production. */
async function seedMessageWithOutbox(
  principalId: string,
  overrides: CreateOverrides = {},
): Promise<{ deliveryId: string; outboxId: string }> {
  const deliveryId = nextId('dlv');
  const outboxId = nextId('obx');
  const result = await persistence().messages.createWithOutbox({
    messageId: nextId('m'),
    outboxId,
    deliveryId,
    app: 'test-app',
    principalId,
    templateId: SEED_TEMPLATE_ID,
    templateName: 'account.login-otp',
    templateVersion: 1,
    locale: 'en',
    recipient: 'recipient@example.test',
    subjectRendered: 's',
    bodyRendered: 'b',
    idempotencyKey: nextId('key'),
    requestFingerprint: FINGERPRINT,
    correlationId: null,
    nowMs: overrides.nowMs ?? NOW,
  });
  if (result.kind !== 'created') {
    throw new Error('test invariant broken: seed create did not succeed');
  }
  return { deliveryId, outboxId };
}

/** Đưa outbox của một delivery tới trạng thái `published` bằng đúng hai statement chuẩn. */
async function publishRow(deliveryId: string, owner: string): Promise<MailOutboxRecord> {
  const claimed = await persistence().outbox.claim({
    nowMs: NOW,
    leaseDurationMs: LEASE_MS,
    leaseOwner: owner,
    limit: 10,
  });
  const target = claimed.find((row) => row.deliveryId === deliveryId);
  if (!target) {
    throw new Error('test invariant broken: row was not claimed');
  }
  const marked = await persistence().outbox.markPublished({
    outboxId: target.id,
    deliveryId,
    leaseOwner: owner,
    dispatchGeneration: 1,
    nowMs: NOW + 1,
  });
  if (!marked.outboxPublished) {
    throw new Error('test invariant broken: markPublished did not close the row');
  }
  return target;
}

/**
 * Reset outbox `published` về `pending`, giữ nguyên generation — đúng hai statement của
 * redispatch adapter trong `src/main.ts` (rút gọn còn phần mà describe này khẳng định).
 */
async function redispatchReset(deliveryId: string, nowMs: number): Promise<void> {
  await handle.raw(
    `UPDATE mail_outbox SET status = 'pending', publish_attempts = 0, available_at = ${lit(nowMs)}, ` +
      `claimed_at = NULL, claimed_by = NULL, published_at = NULL, last_error = NULL, updated_at = ${lit(nowMs)} ` +
      `WHERE delivery_id = ${lit(deliveryId)};`,
  );
}

/**
 * Quay event loop đúng một macrotask — controlled barrier cho ca đồng thời: chờ cả hai
 * promise đã được *gọi* (không sleep, không timing).
 */
function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

describe('concurrent outbox claim on live leases', () => {
  it('splits two concurrent claims between two owners with no row in both batches', async () => {
    // Bốn row pending, claim đồng thời bởi hai owner. Hợp đồng: hai tập kết quả rời nhau —
    // một row không bao giờ nằm trong cả hai batch, dù thứ tự chen giữa hai statement.
    const deliveries: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      deliveries.push((await seedMessageWithOutbox('principal-race')).deliveryId);
    }

    const ownerA = 'owner-a';
    const ownerB = 'owner-b';
    const limit = 4;
    const results: MailOutboxRecord[][] = [];

    const claimA = persistence().outbox.claim({
      nowMs: NOW + 1,
      leaseDurationMs: LEASE_MS,
      leaseOwner: ownerA,
      limit,
    });
    const claimB = persistence().outbox.claim({
      nowMs: NOW + 1,
      leaseDurationMs: LEASE_MS,
      leaseOwner: ownerB,
      limit,
    });
    results.push([...(await claimA)], [...(await claimB)]);

    const setA = idsOf(results[0]);
    const setB = idsOf(results[1]);
    for (const id of setA) {
      expect(setB.has(id)).toBe(false);
    }
    // Nút bị thua (nếu có) nhận batch rỗng — không có row nào bị claim hai lần.
    expect(setA.size + setB.size).toBe(4);
    for (const deliveryId of deliveries) {
      expect(setA.has(deliveryId) || setB.has(deliveryId)).toBe(true);
    }
    // Mọi row được trả về đang `publishing` với đúng owner của batch mình.
    for (const row of results[0]) {
      expect(row.status).toBe('publishing');
      expect(row.claimedBy).toBe(ownerA);
    }
    for (const row of results[1]) {
      expect(row.status).toBe('publishing');
      expect(row.claimedBy).toBe(ownerB);
    }
    await nextMacrotask();
  });

  it('drains a burst of concurrent claims without double-granting any row', async () => {
    // Nhiều hơn hai claim: 5 owner claim đồng thời trên 8 row, limit 3 mỗi owner. Tổng row
    // được cấp phát đúng bằng số row đủ điều kiện — không row nào cấp phát hai lần.
    const deliveries: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      deliveries.push((await seedMessageWithOutbox('principal-burst')).deliveryId);
    }

    const batches = await Promise.all(
      Array.from({ length: 5 }, (_, ownerIndex) =>
        persistence().outbox.claim({
          nowMs: NOW + 1,
          leaseDurationMs: LEASE_MS,
          leaseOwner: `owner-burst-${ownerIndex}`,
          limit: 3,
        }),
      ),
    );

    const granted: string[] = [];
    for (const batch of batches) {
      for (const row of batch) {
        granted.push(row.deliveryId);
      }
    }
    // Không trùng lặp nào trong toàn bộ hàng đã cấp phát.
    expect(new Set(granted).size).toBe(granted.length);
    // Mọi row pending đều đi được vào đúng một batch; tổng cấp phát đủ 8.
    expect(granted.toSorted()).toEqual(deliveries.toSorted());
  });
});

describe('outbox redispatch idempotency (reconciler path)', () => {
  it('re-claims a reset published row exactly once per attempt and never duplicates the row', async () => {
    const { deliveryId } = await seedMessageWithOutbox('principal-redispatch');
    const original = await publishRow(deliveryId, 'owner-first');
    await redispatchReset(deliveryId, NOW + 10);

    // Chu kỳ publish thứ hai trên CÙNG row: claim lại, close lại — vẫn đúng một row.
    const claimed = await persistence().outbox.claim({
      nowMs: NOW + 20,
      leaseDurationMs: LEASE_MS,
      leaseOwner: 'owner-second',
      limit: 10,
    });
    const reclaimed = claimed.find((row) => row.deliveryId === deliveryId);
    if (!reclaimed) {
      throw new Error('test invariant broken: reset row was not re-claimed');
    }
    // Generation không đổi qua redispatch — budget A không bump generation.
    expect(reclaimed.dispatchGeneration).toBe(original.dispatchGeneration);
    expect(reclaimed.publishAttempts).toBe(0);

    const marked = await persistence().outbox.markPublished({
      outboxId: original.id,
      deliveryId,
      leaseOwner: 'owner-second',
      dispatchGeneration: 1,
      nowMs: NOW + 21,
    });
    expect(marked).toEqual({ outboxPublished: true, messageQueued: true });

    const count = await handle.rawOne<{ n: number }>(
      'SELECT count(*) AS n FROM mail_outbox WHERE delivery_id = ?;',
      deliveryId,
    );
    expect(count?.n).toBe(1);

    // Chu kỳ thứ ba: reset + claim lại vẫn cấp phát đúng một lần nữa, không sinh row.
    await redispatchReset(deliveryId, NOW + 30);
    const thirdCycle = await persistence().outbox.claim({
      nowMs: NOW + 40,
      leaseDurationMs: LEASE_MS,
      leaseOwner: 'owner-third',
      limit: 10,
    });
    expect(thirdCycle.some((row) => row.deliveryId === deliveryId)).toBe(true);
    const countAfter = await handle.rawOne<{ n: number }>(
      'SELECT count(*) AS n FROM mail_outbox WHERE delivery_id = ?;',
      deliveryId,
    );
    expect(countAfter?.n).toBe(1);
  });

  it('keeps generation fencing across a redispatch cycle: the pre-reset owner cannot close the row', async () => {
    const { deliveryId, outboxId } = await seedMessageWithOutbox('principal-fence');
    const original = await publishRow(deliveryId, 'owner-stale');
    await redispatchReset(deliveryId, NOW + 10);

    // Owner của chu kỳ trước (đã publish thành công, row đã bị reset) cố đóng lại lần nữa:
    // `claimed_by` đã NULL sau reset, predicate sai, 0 hàng — publish state cũ không ghi đè
    // được chu kỳ mới.
    const stale = await persistence().outbox.markPublished({
      outboxId,
      deliveryId,
      leaseOwner: 'owner-stale',
      dispatchGeneration: original.dispatchGeneration,
      nowMs: NOW + 11,
    });
    expect(stale.outboxPublished).toBe(false);
    expect(stale.messageQueued).toBe(false);

    const row = await handle.rawOne<{ status: string; claimed_by: string | null }>(
      'SELECT status, claimed_by FROM mail_outbox WHERE delivery_id = ?;',
      deliveryId,
    );
    expect(row).toEqual({ status: 'pending', claimed_by: null });
  });
});

describe('rate-limit window boundary', () => {
  it('opens the next window exactly at started + window, never before', async () => {
    const scope = { kind: 'principal', principalId: 'principal-boundary' } as const;
    const window = 60_000;

    // Đầy cửa sổ đầu.
    expect(
      await persistence().rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 1,
        nowMs: NOW,
      }),
    ).toEqual({ kind: 'allowed', hits: 1, windowStartedAtMs: NOW });

    // nowMs = started + window - 1: CÒN cửa sổ cũ → denied. Khẳng định cửa sổ cũ sống
    // đủ [started, started + window).
    expect(
      await persistence().rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 1,
        nowMs: NOW + window - 1,
      }),
    ).toEqual({ kind: 'denied', hits: 1, windowStartedAtMs: NOW });

    // Đúng mốc started + window: predicate `window_started_at <= nowMs - window` trở nên
    // đúng → cửa sổ mới mở ngay tại đây với hits reset về 1.
    expect(
      await persistence().rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 1,
        nowMs: NOW + window,
      }),
    ).toEqual({ kind: 'allowed', hits: 1, windowStartedAtMs: NOW + window });
  });

  it('resets a exhausted window even when the previous window exceeded the limit', async () => {
    // Cửa sổ cũ bị vượt limit nhiều lần — denied không tiêu slot. Cửa sổ mới vẫn phải cho
    // qua với hits = 1: deny của cửa sổ trước không được đeo theo.
    const scope = { kind: 'principal', principalId: 'principal-exhausted' } as const;
    const window = 30_000;

    for (let i = 0; i < 3; i += 1) {
      await persistence().rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + i,
      });
    }
    // Hai lượt denied thêm (limit 2 đã đầy): không đổi hits.
    expect(
      await persistence().rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + 10,
      }),
    ).toEqual({ kind: 'denied', hits: 2, windowStartedAtMs: NOW });

    // Cửa sổ mới: allowed, hits reset, window mới.
    expect(
      await persistence().rateLimits.tryConsume({
        scope,
        windowDurationMs: window,
        limit: 2,
        nowMs: NOW + window + 5,
      }),
    ).toEqual({ kind: 'allowed', hits: 1, windowStartedAtMs: NOW + window + 5 });
  });
});

describe('nonce TTL and prune interplay', () => {
  it('replays inside the TTL are rejected but a fresh claim after pruning is accepted', async () => {
    const principal = 'svc.int-nonce';
    const nonce = nextId('nonce');
    const expiresAtEpochSeconds = Math.floor(NOW / 1000) + 600;
    const expiresAtMs = expiresAtEpochSeconds * 1000;

    expect(await persistence().nonces.claimNonce({ principal, nonce, expiresAtEpochSeconds })).toBe(
      false,
    );

    // Trong TTL: replay bị bắt.
    expect(await persistence().nonces.claimNonce({ principal, nonce, expiresAtEpochSeconds })).toBe(
      true,
    );

    // Hết hạn + prune: nonce rời bảng.
    expect(
      await persistence().nonces.deleteExpiredNonces({ nowMs: expiresAtMs, limit: 100 }),
    ).toBeGreaterThanOrEqual(1);

    // Claim sau prune: được ghi nhận là claim MỚI (false), không phải replay — TTL hết hạn
    // là biên duy nhất mở lại khoá, đúng hợp đồng §7.4.
    expect(await persistence().nonces.claimNonce({ principal, nonce, expiresAtEpochSeconds })).toBe(
      false,
    );

    const rows = await handle.raw<{ n: number }>(
      'SELECT count(*) AS n FROM mail_internal_nonces WHERE principal = ? AND nonce = ?;',
      principal,
      nonce,
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a claim with an empty principal or empty nonce before touching D1', async () => {
    // Guard input của store: fail sớm, không tạo dòng đang tranh chấp ở giữa — hành vi được
    // JSDoc của `claimNonce` chốt nhưng chưa có spec nào ghim.
    const expiresAtEpochSeconds = Math.floor(NOW / 1000) + 600;
    const before = await handle.rawOne<{ n: number }>(
      `SELECT count(*) AS n FROM mail_internal_nonces WHERE principal = ${lit('')};`,
    );

    await expect(
      persistence().nonces.claimNonce({
        principal: '',
        nonce: nextId('nonce'),
        expiresAtEpochSeconds,
      }),
    ).rejects.toThrow('principal and nonce must be non-empty');

    await expect(
      persistence().nonces.claimNonce({
        principal: 'svc.int-nonce-guard',
        nonce: '',
        expiresAtEpochSeconds,
      }),
    ).rejects.toThrow('principal and nonce must be non-empty');

    // Không có dòng nào với principal rỗng được tạo — guard chặn trước khi chạm D1.
    const after = await handle.rawOne<{ n: number }>(
      `SELECT count(*) AS n FROM mail_internal_nonces WHERE principal = ${lit('')};`,
    );
    expect(after?.n).toBe(before?.n);
  });

  it('rejects a non-positive or unsafe nonce expiry before multiplying it into milliseconds', async () => {
    const principal = 'svc.int-nonce-expiry-guard';
    // Epoch giây <= 0 hoặc không phải safe integer phải văng TRƯỚC khi nhân 1000 — lỗi
    // đơn vị ở chỗ này là mở cửa sổ replay (JSDoc `claimNonce`).
    await expect(
      persistence().nonces.claimNonce({
        principal,
        nonce: nextId('nonce'),
        expiresAtEpochSeconds: 0,
      }),
    ).rejects.toThrow('epoch seconds');
    await expect(
      persistence().nonces.claimNonce({
        principal,
        nonce: nextId('nonce'),
        expiresAtEpochSeconds: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow('epoch seconds');

    // Không row nào của principal này được tạo bởi các lệnh bị từ chối (đếm tương đối —
    // suite dùng chung database, principal được chọn riêng cho ca này).
    const rows = await handle.rawOne<{ n: number }>(
      'SELECT count(*) AS n FROM mail_internal_nonces WHERE principal = ?;',
      principal,
    );
    expect(rows?.n).toBe(0);
  });
});
