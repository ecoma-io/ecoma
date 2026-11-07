/**
 * Anchor test cho wiring của issuance gate (issue #61 — finding F5).
 *
 * ## Vì sao suite này tồn tại
 *
 * `mid-flow-state-change.spec.ts` gọi gate TRỰC TIẾP qua `createIssuanceGateFromDeps`
 * — phủ logic `assertIssuable`, KHÔNG phủ wiring: `createAdapterFactory` cùng phần
 * bóc `accountId`/`clientId`/`grantId` từ payload của `PostgresAdapter.upsert`.
 * `oidc-fullflow.spec.ts` đi qua provider thật nhưng CỐ Ý không truyền gate (chỉ
 * composition runtime production ở `oidc/runtime.ts` mới truyền). Khoảng trống:
 * một bug thứ-level ở adapter (đọc sai tên trường payload, sai bóc grantId, sai
 * điều phối kind) sẽ không test nào phát hiện.
 *
 * ⚠️ KHÔNG phải một fullflow thứ hai. Suite này ghim TỔ HỢP (adapter + gate) với
 * chính hình dạng payload mà resume của provider tạo ra, không dựng cả pipeline
 * Koa của provider. Nguồn của payload là `helpers/process_response_types.js:80-96`
 * của oidc-provider 9.12.2 (payload mang accountId + clientId + grantId) qua
 * `base_model.js:82-89` — từng dòng được `mid-flow-state-change.spec.ts:429` căn
 * trong bình luận ("resume gọi adapter.upsert(AuthorizationCode), payload mang
 * accountId") mà tới giờ chưa có test nào thực thi.
 *
 * Hai test, mỗi test là một kịch bản pin-thật:
 *
 *   1. Suspend commit SAU KHI consent được approve-granted — pass #1 (một
 *      code) thành công, suspend được "commit" qua stub `checkStatus` (trong
 *      thật là account/status trả 'suspended' tại lượt resume), rồi resume là
 *      adapter.upsert(AuthorizationCode) với payload như provider dựng: gate
 *      NÉM, KHÔNG hàng oidc_state nào, audit `token_issue_denied` (reason
 *      `account_status`) vẫn được ghi — đúng hành vi fail-closed của §6.0.
 *
 *   2. GHIM (pin): resume TIẾP sau một lần chặn vẫn chặn — một grant existing
 *      + một code đã cấp không mở lại đường phát hành; chặn chỉ thôi khi
 *      status quay về 'active', và mỗi lần chặn là một hàng audit riêng
 *      (append-only) với reason đúng của nó.
 *
 * ⚠️ PostgreSQL THẬT (testcontainers): phần đáng tin cậy là thứ tự ghi trong
 * db-auth — một stub `Queryable` là schema thứ hai, xanh cả khi SQL sai. Thiếu
 * Docker ⇒ ĐỎ (cùng bộ luật với các suite hàng xóm; harness probe fail-loud,
 * không có đường skip).
 */

import postgres from 'postgres';

import { checkRevocationAtIssuance, type PostgresClientLike } from '@ecoma-io/auth-infrastructure';
import type { PostgresAdapter } from '../../src/oidc/adapter';
import { createAdapterFactory } from '../../src/oidc/adapter';
import { createIssuanceGateFromDeps } from '../../src/oidc/issuance-gate';
import { startAuthDatabase, type AuthDatabase } from './harness';

/** Probe Docker một lần ở tầng module — kết quả do globalSetup đăng ký qua env. */
/** Container riêng của file này, dựng một lần trong `beforeAll`. */
let db: AuthDatabase;

const CLIENT_ID = 'client-anchor-gate-pg-test';
/** Marker cleanup — mọi sub của suite này mang marker này. */
const SUB_PREFIX = 'sub-anchor-gate-';
/** Marker cho jti của code trong `auth.oidc_state` — dọn sau mỗi test. */
const CODE_SUFFIX = '-for-anchor-gate-spec-000';

function base() {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    prepare: false,
  } as const;
}

function connectRuntime(max = 10): postgres.Sql {
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max,
  });
}

function connectMigrator(): postgres.Sql {
  return postgres({
    ...base(),
    user: db.migratorUser,
    password: db.migratorPassword,
    max: 1,
  });
}

async function setup(): Promise<{ runtime: postgres.Sql; migrator: postgres.Sql }> {
  return { runtime: connectRuntime(), migrator: connectMigrator() };
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

async function seedClient(migrator: postgres.Sql): Promise<void> {
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${CLIENT_ID}, 'anchor gate pg test client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;
}

/**
 * Seed grant active cho (sub, client) — snapshot consent đã approve-granted
 * (decide CAS thắng): grant tồn tại, gate pass #1 đã đi qua. `consent_decision_id`
 * NULL tại đây vì fixture này chỉ tập trung vào PHẦN SAU decide (resume cấp
 * code); decide của §5.1.5b có ba kịch bản riêng của mid-flow suite.
 */
async function seedGrant(migrator: postgres.Sql, sub: string): Promise<string> {
  const rows = await migrator<{ id: string }[]>`
    INSERT INTO auth.oauth_grants (sub, client_id, status, granted_at)
    VALUES (${sub}, ${CLIENT_ID}, 'active', now())
    RETURNING id
  `;
  const grantId = rows[0]?.id;
  if (grantId === undefined) {
    throw new Error('seed grant khong tra ve id');
  }
  await migrator`
    INSERT INTO auth.client_grant_scopes (grant_id, scope)
    VALUES (${grantId}, 'openid')
  `;
  return grantId;
}

/**
 * Cleanup những hàng mang marker của SUITE NÀY, theo thứ tự con trước cha.
 *
 * ⚠️ `authorization_audit_events` KHÔNG dọn: append-only cả ở test (0009 thu
 * DELETE khỏi runtime; migrator thì đủ quyền, nhưng dọn audit là xoá bằng chứng
 * — các assert đếm/truy vấn đều bám theo `sub` marker riêng nên không nhiễu).
 */
async function cleanup(migrator: postgres.Sql): Promise<void> {
  await migrator.unsafe(
    `DELETE FROM auth.client_grant_scopes
      WHERE grant_id IN (SELECT id FROM auth.oauth_grants WHERE sub LIKE '${SUB_PREFIX}%')`,
  );
  await migrator.unsafe(`DELETE FROM auth.oauth_grants WHERE sub LIKE '${SUB_PREFIX}%'`);
  await migrator.unsafe(`DELETE FROM auth.oidc_state WHERE id LIKE '%${CODE_SUFFIX}%'`);
  await migrator.unsafe(
    `DELETE FROM auth.token_revocations WHERE subject_ref LIKE '${SUB_PREFIX}%'`,
  );
}

/**
 * TỔ HỢP của issue #61: gate thật (`createIssuanceGateFromDeps`) + adapter thật
 * (`PostgresAdapter` của 'AuthorizationCode') ráp qua `createAdapterFactory` —
 * đúng cách composition root ở `oidc/runtime.ts` ghép hai mảnh.
 *
 * `checkStatus` là stub của test —_AccountClient thật là một mảnh có spec riêng;
 * stub cho phép thay đổi account status GIỮA CHỪNG test (suspend giữa decide và
 * resume) không cần dựng service account. Cùng hình dạng stub với mid-flow suite.
 */
function wiredAdapter(
  runtime: postgres.Sql,
  checkStatus: (accountId: string) => Promise<'active' | 'suspended'>,
): PostgresAdapter {
  const gate = createIssuanceGateFromDeps({
    postgresClient: runtime as unknown as PostgresClientLike,
    checkStatus,
  });
  // Adapter production nhận CONFIG (giá trị thuần) và tự mở client cho từng
  // thao tác (issue #289); lane test này giữ lane `postgresClient` của gate
  // (client pool dài hạn của testcontainers) và chỉ đổi lane của adapter.
  // Connection string dựng lại từ options đã parse của client pool — host đầu
  // + port + database + credential là đủ cho client một-lần của adapter.
  const o = runtime.options;
  const auth =
    o.pass === null || o.pass === undefined
      ? String(o.user)
      : `${String(o.user)}:${String(o.pass)}`;
  const connectionString = `postgres://${auth}@${String(o.host[0])}:${String(o.port[0])}/${o.database}`;
  const factory = createAdapterFactory({ hyperdrive: { connectionString } }, gate);
  return factory('AuthorizationCode');
}

/**
 * Payload AuthorizationCode như provider 9.12.2 dựng tại
 * `helpers/process_response_types.js:80-96` rồi `base_model.js:82-89` đưa vào
 * `adapter.upsert(jti, payload, ttl)`. Ba trường làm việc với gate là
 * `accountId` + `clientId` + `grantId`; các trường còn lại khớp IN_PAYLOAD của
 * model AuthorizationCode — giữ nguyên để payload có đúng HÌNH DẠNG thật của
 * provider (mọi schema drift của jsonb đều qua đây bị phát hiện).
 */
function authorizationCodePayload(params: {
  readonly sub: string;
  readonly grantId: string;
}): Record<string, unknown> {
  return {
    accountId: params.sub,
    acr: 'urn:ecoma:acr:email-otp',
    amr: ['otp'],
    authTime: Math.floor(Date.now() / 1000) - 10,
    claims: {},
    clientId: CLIENT_ID,
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    codeChallengeMethod: 'S256',
    grantId: params.grantId,
    nonce: 'n-anchor-gate-1',
    redirectUri: 'https://app.example.com/cb',
    scope: 'openid',
    sessionUid: 'uid-anchor-gate-00000000000000000000000000',
  };
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  db = await startAuthDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('issuance gate via adapter.upsert wiring — provider-resume anchor', () => {
  it('account suspended between a granted pass and resume: adapter.upsert(AuthorizationCode) throws, records no row, and the token_issue_denied audit carries reason account_status', async () => {
    const { runtime, migrator } = await setup();
    try {
      const sub = `${SUB_PREFIX}susp-0000000000000000000000000000`;
      await seedClient(migrator);
      const grantId = await seedGrant(migrator, sub);

      // (1) Pass #1 — resume cấp code THÀNH CÔNG: status 'active' ⇒ gate cho
      //     phép, hàng oidc_state được ghi. Đây là "gate pass #1 với grant
      //     existing" mà pin của issue #61 yêu cầu phải hoàn tất trước.
      const passing = wiredAdapter(runtime, async () => 'active');
      const okId = `ac-ok${CODE_SUFFIX}`;
      await passing.upsert(okId, authorizationCodePayload({ sub, grantId }), 60);
      const okRows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state
           WHERE kind = 'AuthorizationCode' AND id = ${okId}
        `;
      expect(okRows).toHaveLength(1);

      // (2) Suspend commit phía account (projection §7): auth không ghi hàng
      //     nào. Negative control: `token_revocations` sạch — chặn sau này
      //     phải đến từ account status, không từ một kiện revocation nào
      //     (cùng anti-drift với kịch본 1 của mid-flow suite).
      const preResumeRevocation = await checkRevocationAtIssuance(
        runtime as unknown as PostgresClientLike,
        { sub, clientId: CLIENT_ID, grantId },
      );
      expect(preResumeRevocation).toBe('not_revoked');

      // (3) Resume — adapter.upsert(AuthorizationCode) đúng cách provider
      //     gọi: gate NÉM (§5.1.0 điều kiện 3), code KHÔNG được cấp — không
      //     có hàng oidc_state nào với jti của pass này.
      const blocking = wiredAdapter(runtime, async () => 'suspended');
      const blockedId = `ac-blocked${CODE_SUFFIX}`;
      await expect(
        blocking.upsert(blockedId, authorizationCodePayload({ sub, grantId }), 60),
      ).rejects.toThrow('account status');
      const blockedRows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state
           WHERE kind = 'AuthorizationCode' AND id = ${blockedId}
        `;
      expect(blockedRows).toHaveLength(0);

      // (4) Audit giữ bằng chứng: hàng `token_issue_denied` với reason
      //     'account_status' — cùng quy ước unwrapping jsonb của mid-flow
      //     suite (details đi qua postgres.js là một chuỗi JSON string).
      const denyRows = await runtime<
        { details: unknown; outcome: string | null; grant_id: string | null }[]
      >`
          SELECT details AS details, outcome, grant_id
            FROM auth.authorization_audit_events
           WHERE subject_ref = ${sub}
             AND event_type = 'token_issue_denied'
           ORDER BY occurred_at DESC
           LIMIT 1
        `;
      expect(denyRows).toHaveLength(1);
      const denialPayload = JSON.parse(denyRows[0]?.details as unknown as string) as {
        reason: string;
      };
      expect(denialPayload.reason).toBe('account_status');
      expect(denyRows[0]?.outcome).toBe('denied');
      expect(denyRows[0]?.grant_id).toBe(grantId);

      // (5) Đếm audit theo loại: đúng MỘT hàng `token_issued` (pass #1) và
      //     đúng MỘT hàng `token_issue_denied` (pass #2) — chặn và cấp được
      //     phân biệt bằng chính audit, không lẫn.
      const issuedCount = await runtime<{ count: string }[]>`
          SELECT count(*)::text AS count FROM auth.authorization_audit_events
           WHERE subject_ref = ${sub}
             AND event_type = 'token_issued'
        `;
      expect(issuedCount[0]?.count).toBe('1');
      const deniedCount = await runtime<{ count: string }[]>`
          SELECT count(*)::text AS count FROM auth.authorization_audit_events
           WHERE subject_ref = ${sub}
             AND event_type = 'token_issue_denied'
        `;
      expect(deniedCount[0]?.count).toBe('1');
    } finally {
      await cleanup(migrator);
      await runtime.end({ timeout: 1 });
      await migrator.end({ timeout: 1 });
    }
  });

  it('pin: a second resume after suspension stays blocked until status returns to active, every denial its own audit row', async () => {
    const { runtime, migrator } = await setup();
    try {
      const sub = `${SUB_PREFIX}pin-0000000000000000000000000000`;
      await seedClient(migrator);
      const grantId = await seedGrant(migrator, sub);

      // Pass #1 — một code được cấp (grant existing, gate pass thật).
      const passing = wiredAdapter(runtime, async () => 'active');
      const firstId = `ac-pass1${CODE_SUFFIX}`;
      await passing.upsert(firstId, authorizationCodePayload({ sub, grantId }), 60);
      const firstRows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state
           WHERE kind = 'AuthorizationCode' AND id = ${firstId}
        `;
      expect(firstRows).toHaveLength(1);

      // Pass #2 — suspend: chặn, không hàng oidc_state nào.
      const blocking = wiredAdapter(runtime, async () => 'suspended');
      const secondId = `ac-pass2${CODE_SUFFIX}`;
      await expect(
        blocking.upsert(secondId, authorizationCodePayload({ sub, grantId }), 60),
      ).rejects.toThrow('account status');
      const secondRows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state
           WHERE kind = 'AuthorizationCode' AND id = ${secondId}
        `;
      expect(secondRows).toHaveLength(0);

      // Pass #3 — GHIM (pin của issue #61): resume TIẾP sau một lần chặn
      //     vẫn chặn. Một grant existing + "đã từng cấp code" không mở lại
      //     đường phát hành — chỉ status trở lại 'active' mới mở được.
      const thirdId = `ac-pass3${CODE_SUFFIX}`;
      await expect(
        blocking.upsert(thirdId, authorizationCodePayload({ sub, grantId }), 60),
      ).rejects.toThrow('account status');
      const thirdRows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state
           WHERE kind = 'AuthorizationCode' AND id = ${thirdId}
        `;
      expect(thirdRows).toHaveLength(0);

      // Pass #4 — khôi phục (account unsuspend): gate lại cho phép. Chặn là
      //     fail-closed theo trạng thái, KHÔNG vĩnh viễn: pass này chứng minh
      //     "chỉ status quyết định" chứ không phải "một lần chặn là kẹt".
      const recovered = wiredAdapter(runtime, async () => 'active');
      const fourthId = `ac-pass4${CODE_SUFFIX}`;
      await recovered.upsert(fourthId, authorizationCodePayload({ sub, grantId }), 60);
      const fourthRows = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oidc_state
           WHERE kind = 'AuthorizationCode' AND id = ${fourthId}
        `;
      expect(fourthRows).toHaveLength(1);

      // Hai lần chặn là hai hàng audit riêng (append-only — hai lần thử là
      // hai hàng bằng chứng), và CẢ HAI đều đúng reason `account_status`:
      // grant vẫn active, revocation sạch, không có lý do khác nào lọt vào.
      const denyRows = await runtime<{ details: unknown }[]>`
          SELECT details FROM auth.authorization_audit_events
           WHERE subject_ref = ${sub}
             AND event_type = 'token_issue_denied'
           ORDER BY occurred_at ASC
        `;
      expect(denyRows).toHaveLength(2);
      for (const row of denyRows) {
        const payload = JSON.parse(row.details as unknown as string) as {
          reason: string;
        };
        expect(payload.reason).toBe('account_status');
      }
    } finally {
      await cleanup(migrator);
      await runtime.end({ timeout: 1 });
      await migrator.end({ timeout: 1 });
    }
  });
});
