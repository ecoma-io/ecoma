/**
 * Kiểm chứng enforcement của `requirePermission` — fail path lần lượt
 * (thiếu permission, revoke, expiry, staff không active, audit hỏng phải
 * propagate) và shape HTTP của deny.
 *
 * ⚠️ Audit KHÔNG được nuốt lỗi là yêu cầu I-08 của issue #86 — test
 * `propagates when the audit insert fails` là mutation evidence: bỏ
 * `await recordDecision` trong `authorization.ts` (hoặc bọc try/catch) là
 * test đó đỏ, đúng nghĩa "phá kiểm soát thì test tương ứng phải đỏ" ở
 * `02-requirements.md` §5.
 *
 * ⚠️ Ba nhóm test dưới đây là **mutation evidence** của S1/F2 (stale trên
 * đường ghi), S4 (audit trước throw) và S2/F4 (scrub + context):
 *   * `stale on a write path` — bỏ nhánh `mode === 'write' && decision.stale`
 *     thì nhóm này đỏ.
 *   * `fail closed on malformed input` — bỏ `recordAuthorizationFailure` thì
 *     "ghi audit trước throw" đỏ.
 *   * `audit fields follow SR-013/SR-014` — bỏ validate `targetSub` / bỏ
 *     `mode` vào context thì nhóm này đỏ.
 */

import { describe, expect, it } from 'vitest';

import type { GrantedAssignment } from '@ecoma-io/backoffice-domain';
import type { recordDecision } from '@ecoma-io/backoffice-infrastructure';

import { requirePermission, type PrincipalAuthorization } from './authorization';

// ⚠️ Độ dài entropy phải khớp `SUBJECT_ENTROPY_LENGTH` của account-domain
// (32 ký tự base32) — `isBackofficeAccountId` từ chối mọi `sub` khác độ dài, và
// một actor 52 ký tự sẽ bị từ chối ở bước validate, tức mọi test ở đây sẽ
// đỏ vì lý do sai.
const ACTOR = 'sub_' + 'a'.repeat(32);
const TARGET = 'sub_' + 'b'.repeat(32);

/**
 * Mốc tương đối so với đồng hồ thật: `requirePermission` tự đọc `new Date()`
 * (policy thuần nhận thời gian từ caller), nên fixture hẹn giờ cố định
 * sẽ chênh theo thời gian chạy — vì mô phỏng bằng offset từ hiện tại.
 */
const HOURS = 3_600_000;

/** TTL của risk class `normal` là 60s — ảnh cũ hơn thế là `stale`. */
const STALE_AGE_MS = 10 * 60_000;

function assignment(overrides: Partial<GrantedAssignment> = {}): GrantedAssignment {
  return {
    permissions: ['delivery.redrive'],
    validUntil: null,
    revokedAt: null,
    fetchedAt: new Date(),
    staffStatus: 'active',
    ...overrides,
  };
}

function principal(overrides: Partial<PrincipalAuthorization> = {}): PrincipalAuthorization {
  return { assignments: [assignment()], actorSub: ACTOR, ...overrides };
}

/**
 * Ảnh assignment đã quá TTL của risk class — `can()` trả `stale: true` nhưng
 * vẫn allow (principal CÓ quyền): chủ đích của S1 là chặn ảnh này trên đường
 * ghi, không phải chặn cả đường đọc.
 */
function stalePrincipal(overrides: Partial<PrincipalAuthorization> = {}): PrincipalAuthorization {
  return principal({
    assignments: [assignment({ fetchedAt: new Date(Date.now() - STALE_AGE_MS) })],
    ...overrides,
  });
}

/**
 * Audit client giả — ghi nhớ INSERT để assert được "denial phải được log
 * rồi mới 403", đồng thời cho phép mô phỏng lỗi DB (I-08).
 */
function fakeAuditClient_impl() {
  const inserts: { text: string; values: readonly unknown[] }[] = [];
  let failure: Error | undefined;
  return {
    inserts,
    failNextWith(error: Error) {
      failure = error;
    },
    // Shape tối thiểu mà `recordDecision` dùng — type của `pg` Client đầy
    // đủ hơn; ở đây chỉ có `query` được gọi.
    client: {
      query: (text: string, values?: readonly unknown[]) => {
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        inserts.push({ text, values: values ?? [] });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    },
  };
}
type FakeAudit = ReturnType<typeof fakeAuditClient_impl>;
// Ép shape Client ở chỗ dùng — caller thật sẽ cắm runtime-role client; test
// chỉ cần hợp đồng `query(text, values)` mà recordDecision gọi.
const asPgClient = (fake: FakeAudit) =>
  fake.client as unknown as Parameters<typeof recordDecision>[0];

/** Đọc `context` jsonb của một bản ghi audit đã ghi. */
function auditContext(values: readonly unknown[]): Record<string, unknown> {
  return JSON.parse(values[7] as string) as Record<string, unknown>;
}

describe('requirePermission — allow path', () => {
  it('returns the decision without writing a deny audit row', async () => {
    const fake = fakeAuditClient_impl();
    const decision = await requirePermission('delivery.redrive', principal(), asPgClient(fake));
    expect(decision.allowed).toBe(true);
    expect(fake.inserts).toHaveLength(0);
  });

  it('denies by default when the assignment set is empty, and logs the denial first', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake)),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(fake.inserts).toHaveLength(1);
    const { text, values } = fake.inserts[0];
    expect(text).toContain('authorization_audit');
    expect(values[1]).toBe(null);
    expect(values[2]).toBe('delivery.redrive');
    expect(values[3]).toBe('denied');
    expect(values[4]).toContain('permission_not_granted');
  });
});

describe('requirePermission — deny reasons through HTTP shape', () => {
  it('denies a revoked assignment with 403 and writes assignment_revoked to audit', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission(
        'delivery.redrive',
        principal({
          assignments: [assignment({ revokedAt: new Date(Date.now() - 24 * HOURS) })],
        }),
        asPgClient(fake),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fake.inserts[0].values[4]).toContain('assignment_revoked');
  });

  it('denies an expired assignment with 403 and writes assignment_expired to audit', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission(
        'delivery.redrive',
        principal({
          assignments: [assignment({ validUntil: new Date(Date.now() - 1 * HOURS) })],
        }),
        asPgClient(fake),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fake.inserts[0].values[4]).toContain('assignment_expired');
  });

  it('denies a suspended staff member with 403 and writes staff_not_active to audit', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission(
        'delivery.redrive',
        principal({ assignments: [assignment({ staffStatus: 'suspended' })] }),
        asPgClient(fake),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fake.inserts[0].values[4]).toContain('staff_not_active');
  });
});

describe('requirePermission — stale on a write path (S1, F2)', () => {
  it('blocks a write when the authorization snapshot is stale, and logs the block', async () => {
    // Mutation evidence: bỏ nhánh `mode === 'write' && decision.stale` trong
    // `authorization.ts` thì test này đỏ — allow+stale sẽ lọt qua trên đường
    // ghi, tức đúng lỗi S1 (TOCTOU, SR-008).
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', stalePrincipal(), asPgClient(fake), {
        mode: 'write',
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    // Block phải để lại dấu vết: một request bị chặn mà không audit là mất tín
    // hiệu điều tra (SR-018).
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].values[3]).toBe('denied');
    expect(fake.inserts[0].values[4]).toContain('stale_write_blocked');
  });

  it('does not block a read when the snapshot is stale, but still marks the decision', async () => {
    // Đường đọc giữ nguyên cửa sổ mà ADR-0002 chốt cho lớp `normal`; chặn nó ở
    // đây sẽ biến mọi request thành 503 vì ảnh batch-sync vốn già hơn TTL.
    const fake = fakeAuditClient_impl();
    const decision = await requirePermission(
      'delivery.redrive',
      stalePrincipal(),
      asPgClient(fake),
      { mode: 'read' },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.stale).toBe(true);
    expect(fake.inserts).toHaveLength(0);
  });

  it('treats a missing mode as a read path (no silent behaviour change for existing routes)', async () => {
    // Call-site cũ không truyền `mode` phải chạy y hệt trước S1 — nếu mặc định
    // là `'write'`, mọi route đã merge (#99) sẽ bị chặn bởi ảnh stale.
    const fake = fakeAuditClient_impl();
    const decision = await requirePermission(
      'delivery.redrive',
      stalePrincipal(),
      asPgClient(fake),
    );

    expect(decision.allowed).toBe(true);
    expect(fake.inserts).toHaveLength(0);
  });

  it('blocks a write on a fresh snapshot (the control itself still works)', async () => {
    // Đường ghi với ảnh **tươi** vẫn phải đi qua — nếu nhánh chặn nuốt luôn
    // allow thì đường ghi chết hẳn, và "chặn stale" trở thành "cấm ghi".
    const fake = fakeAuditClient_impl();
    const decision = await requirePermission('delivery.redrive', principal(), asPgClient(fake), {
      mode: 'write',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.stale).toBe(false);
    expect(fake.inserts).toHaveLength(0);
  });

  it('records the risk class and the write mode in the audit context of a stale block', async () => {
    // F4: context phải mang đủ marker để audit đọc được quyết định được đánh
    // giá trên đường nào, với lớp rủi ro nào.
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', stalePrincipal(), asPgClient(fake), {
        mode: 'write',
        riskClass: 'high',
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    const context = auditContext(fake.inserts[0].values);
    expect(context).toEqual({ riskClass: 'high', stale: true, mode: 'write' });
  });
});

describe('requirePermission — fail closed on malformed input', () => {
  it('rejects a malformed actor with 503 and never reaches policy', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ actorSub: 'not-a-sub' }), asPgClient(fake)),
    ).rejects.toMatchObject({ statusCode: 503 });
    // Bản ghi audit cho lần kiểm tra này KHÔNG mang `actor_sub` (không bịa danh
    // tính) — nên "không chạm policy" được kiểm bằng việc cột actor rỗng, chứ
    // không phải bằng việc không có bản ghi nào (S4 bắt buộc có bản ghi).
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0].values[0]).toBe(null);
  });

  it('logs the malformed actor as a failure with a null actor before throwing (S4)', async () => {
    // Mutation evidence: bỏ `recordAuthorizationFailure` trước throw thì test
    // này đỏ — lần kiểm tra authorization không để lại dấu vết nào, đúng đường
    // "deny im lặng" mà SR-018 cấm.
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ actorSub: 'not-a-sub' }), asPgClient(fake)),
    ).rejects.toMatchObject({ statusCode: 503 });

    expect(fake.inserts).toHaveLength(1);
    const { values } = fake.inserts[0];
    expect(values[0]).toBe(null);
    expect(values[2]).toBe('delivery.redrive');
    expect(values[3]).toBe('failure');
    expect(values[4]).toBe('invalid_actor');
  });
});

describe('requirePermission — audit failure propagates (I-08)', () => {
  it('propagates when the audit insert fails instead of letting the deny pass silently', async () => {
    const fake = fakeAuditClient_impl();
    const dbFailure = new Error('audit insert failed');
    fake.failNextWith(dbFailure);

    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake)),
    ).rejects.toBe(dbFailure);
  });

  it('propagates when the failure audit of a malformed actor fails', async () => {
    // Lỗi audit ở đường S4 cũng phải propagate: nuốt nó thì request chết
    // trong im lặng mà không có cả tín hiệu điều tra lẫn thông báo lỗi.
    const fake = fakeAuditClient_impl();
    const dbFailure = new Error('audit insert failed');
    fake.failNextWith(dbFailure);

    await expect(
      requirePermission('delivery.redrive', principal({ actorSub: 'not-a-sub' }), asPgClient(fake)),
    ).rejects.toBe(dbFailure);
  });
});

describe('requirePermission — audit fields follow SR-013/SR-014', () => {
  it('writes the seven-field audit row for a target-scoped denial without secrets', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake), {
        targetSub: TARGET,
        requestId: 'req-1',
        correlationId: 'corr-1',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const { values } = fake.inserts[0];
    expect(values[0]).toBe(ACTOR);
    expect(values[1]).toBe(TARGET);
    expect(values[2]).toBe('delivery.redrive');
    expect(values[3]).toBe('denied');
    expect(values[5]).toBe('req-1');
    expect(values[6]).toBe('corr-1');
    // Context chỉ mang marker risk class / stale / mode — không payload nào lạ.
    const context = auditContext(values);
    expect(Object.keys(context).toSorted()).toEqual(['mode', 'riskClass', 'stale']);
  });

  it('records the read mode by default in the audit context (F4)', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake)),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(auditContext(fake.inserts[0].values)).toEqual({
      riskClass: 'normal',
      stale: false,
      mode: 'read',
    });
  });

  it('records the write mode of a policy denial on a write path (F4)', async () => {
    // Deny của policy xảy ra TRÊN ĐƯỜNG GHI (mode 'write') phải được ghi đúng
    // đường đó — bỏ truyền `mode` vào `recordDecision` thì context ghi 'read'
    // và test này đỏ (mutation evidence của F4). Không tin được context thì
    // người điều tra phân không được "bị chặn khi ĐỌC trên ảnh cũ" với "bị từ
    // chối khi chuẩn bị GHI".
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake), {
        mode: 'write',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(auditContext(fake.inserts[0].values)).toEqual({
      riskClass: 'normal',
      stale: false,
      mode: 'write',
    });
  });

  it('rejects a malformed target instead of writing it into the audit row (S2)', async () => {
    // `target_sub` là Account ID mà operation tác động, không phải chuỗi tự do
    // — ghi nó vào audit mà không validate là biến audit thành kênh rò dữ liệu.
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake), {
        targetSub: 'target-with-a-payload',
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(fake.inserts).toHaveLength(0);
  });

  it('rejects a correlation id longer than the audit cap (S2)', async () => {
    const fake = fakeAuditClient_impl();
    await expect(
      requirePermission('delivery.redrive', principal({ assignments: [] }), asPgClient(fake), {
        requestId: 'r'.repeat(129),
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(fake.inserts).toHaveLength(0);
  });
});

describe('module boundary (mutation evidence)', () => {
  it('does not import any business handler from server/api', async () => {
    // Mutation control: nếu ai đó cấu trúc lại enforcement thành middleware
    // import trực tiếp handler, test này đỏ — guard cho "module này chỉ là
    // checkpoint, không đụng handler".
    const module = await import('./authorization');
    const source = String(module.requirePermission);
    expect(source).not.toContain('greet');
    expect(source).not.toContain('server/api');
  });
});
