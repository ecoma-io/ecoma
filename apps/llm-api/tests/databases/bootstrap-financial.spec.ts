/**
 * Bootstrap runner bước 10 (`db/bootstrap-financial.mts`) trên PostgreSQL thật,
 * qua **runner production** chạy bằng `tsx` — đúng lệnh mà bootstrap command
 * chạy trên lane local (ADR-0020 Quyết định 12, ADR-0028 §6, Issue #24 P3).
 *
 * Phủ tiêu chí slice P3 #24: seed B1–B4 trên database fresh — sponsor
 * `sponsor_ecoma_internal` (env chỉ assert định danh), billing account của
 * tenant consumer (natural key `tenant_ref`), funding authorization (natural
 * key `(sponsor_id, billing_account_id)`, ceiling nullable — chữ `null` là
 * explicit vô trần, `evidence_ref` bắt buộc) và grant khởi tạo kết thúc ở
 * `credited` qua đúng đường domain `creditGrant` (phép kiểm trần duy nhất);
 * rerun là no-op; divergence ceiling/evidence/amount fail-closed không đụng
 * state; vượt trần để grant `pending` bền với đúng mã canonical và rerun sau
 * khi sửa cấu hình hội tụ (ADR-0028 §6 S11).
 *
 * Chuỗi transaction: seed (B1–B3) → register (B4 pending) → credit (B4
 * credited); mỗi transaction ghi một row `llm_financial.bootstrap_audit` —
 * credit thất bại rollback audit row của nó, nên audit phản ánh đúng số
 * transaction đã commit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  migratorUrl,
  runBootstrapCli,
  startLlmApiDatabase,
  type ApplyCliResult,
  type LlmApiDatabase,
} from '../integrations/harness.ts';
import { resetFinancial } from './bootstrap-database-reset.ts';
import {
  CONSUMER_BILLING_ACCOUNT_ID,
  CONSUMER_TENANT_ID,
  SPONSOR_FUNDING_AUTHORIZATION_ID,
  SPONSOR_GRANT_ID,
  SPONSOR_ID,
} from '../../db/bootstrap-shared.mts';

const OWNER_SUB = 'bootstrap-superadmin-sub';
const ACTOR = 'ecoma-bootstrap';
const EVIDENCE_REF = 'budget-decision:2026-Q4';

/** Container PostgreSQL dùng chung cho cả describe (mỗi spec file một container). */
let db: LlmApiDatabase;

/** Env mặc định của một run: trần sponsor 1.000.000, trần per-account 500.000, grant 250.000. */
function financialEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    ECOMA_GATEWAY_DATABASE_URL: migratorUrl('gateway', db.host, db.port),
    ECOMA_CONSUMER_TENANT_ID: CONSUMER_TENANT_ID,
    ECOMA_CONSUMER_TENANT_OWNER_SUB: OWNER_SUB,
    ECOMA_SPONSOR_ID: SPONSOR_ID,
    ECOMA_SPONSOR_CEILING: '1000000',
    ECOMA_SPONSOR_AUTHORIZATION_CEILING: '500000',
    ECOMA_SPONSOR_AUTHORIZATION_EVIDENCE_REF: EVIDENCE_REF,
    ECOMA_SPONSOR_GRANT_AMOUNT: '250000',
    ECOMA_GOVERNANCE_ACTOR: ACTOR,
    ...overrides,
  };
}

function runFinancial(env: Record<string, string>): Promise<ApplyCliResult> {
  return runBootstrapCli({
    script: 'db/bootstrap-financial.mts',
    // DATABASE_URL không nằm trong hợp đồng env của runner bước 10 (URL gateway
    // đi bằng ECOMA_GATEWAY_DATABASE_URL); harness bắt buộc một giá trị — truyền
    // URL gateway.
    databaseUrl: migratorUrl('gateway', db.host, db.port),
    env,
  });
}

/** Trích dòng máy đọc `KEY=value` từ stdout (mỗi key in đúng một dòng). */
function stdoutLine(stdout: string, key: string): string {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  if (line === undefined) {
    throw new Error(`stdout must carry a ${key}= line; got: ${stdout}`);
  }
  return line.slice(key.length + 1);
}

async function fetchSponsors(): Promise<
  {
    sponsor_id: string;
    owner_ref: string;
    ceiling_minor: string;
    ceiling_denomination: string;
    status: string;
    created_by: string;
  }[]
> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query(
      'SELECT sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_by FROM llm_financial.sponsors',
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchBillingAccounts(): Promise<
  {
    billing_account_id: string;
    tenant_ref: string;
    owner_ref: string;
  }[]
> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query(
      'SELECT billing_account_id, tenant_ref, owner_ref FROM llm_financial.billing_accounts',
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchAuthorizations(): Promise<
  {
    authorization_id: string;
    sponsor_id: string;
    billing_account_id: string;
    ceiling_minor: string | null;
    ceiling_denomination: string | null;
    status: string;
    evidence_ref: string;
  }[]
> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query(
      'SELECT authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref FROM llm_financial.sponsor_funding_authorizations',
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function fetchGrants(): Promise<
  {
    grant_id: string;
    authorization_id: string;
    sponsor_id: string;
    billing_account_id: string;
    amount_minor: string;
    amount_denomination: string;
    state: string;
    actor_ref: string;
  }[]
> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query(
      'SELECT grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref FROM llm_financial.sponsor_grants',
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

/** Audit outcome theo đúng thứ tự commit của ba transaction. */
async function fetchAuditOutcomes(): Promise<string[]> {
  const client = await db.connectAsMigrator('gateway');
  try {
    const result = await client.query<{ outcome: string }>(
      'SELECT outcome FROM llm_financial.bootstrap_audit ORDER BY id',
    );
    return result.rows.map((row) => row.outcome);
  } finally {
    await client.end();
  }
}

describe('bootstrap runner step 10 (sponsor funding) on real PostgreSQL', () => {
  beforeAll(async () => {
    db = await startLlmApiDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await resetFinancial(db);
  });

  it('seeds sponsor, billing account, authorization and one credited grant on a fresh database', async () => {
    const result = await runFinancial(financialEnv());
    // Result line: đúng shape, đúng per-step outcome.
    const resultLine = stdoutLine(result.stdout, 'FINANCIAL_RESULT');
    expect(resultLine).toContain('"outcome":"created"');
    expect(resultLine).toContain(`"sponsorId":"${SPONSOR_ID}"`);
    expect(resultLine).toContain(`"grantId":"${SPONSOR_GRANT_ID}"`);
    expect(resultLine).toContain('"sponsor":"created"');
    expect(resultLine).toContain('"billingAccount":"created"');
    expect(resultLine).toContain('"authorization":"created"');
    expect(resultLine).toContain('"grant":"created"');
    expect(resultLine).toContain('"grantCredit":"credited"');

    // Đúng 4 row aggregate, giá trị escrow đúng theo env.
    expect(await fetchSponsors()).toEqual([
      {
        sponsor_id: SPONSOR_ID,
        owner_ref: OWNER_SUB,
        ceiling_minor: '1000000',
        ceiling_denomination: 'UC',
        status: 'active',
        created_by: ACTOR,
      },
    ]);
    expect(await fetchBillingAccounts()).toEqual([
      {
        billing_account_id: CONSUMER_BILLING_ACCOUNT_ID,
        tenant_ref: CONSUMER_TENANT_ID,
        owner_ref: OWNER_SUB,
      },
    ]);
    expect(await fetchAuthorizations()).toEqual([
      {
        authorization_id: SPONSOR_FUNDING_AUTHORIZATION_ID,
        sponsor_id: SPONSOR_ID,
        billing_account_id: CONSUMER_BILLING_ACCOUNT_ID,
        ceiling_minor: '500000',
        ceiling_denomination: 'UC',
        status: 'active',
        evidence_ref: EVIDENCE_REF,
      },
    ]);
    expect(await fetchGrants()).toEqual([
      {
        grant_id: SPONSOR_GRANT_ID,
        authorization_id: SPONSOR_FUNDING_AUTHORIZATION_ID,
        sponsor_id: SPONSOR_ID,
        billing_account_id: CONSUMER_BILLING_ACCOUNT_ID,
        amount_minor: '250000',
        amount_denomination: 'UC',
        // Credit qua domain op đã chạy: state bền là `credited`.
        state: 'credited',
        actor_ref: ACTOR,
      },
    ]);

    // Audit: ba transaction đã commit, đúng thứ tự seed → register → credit.
    expect(await fetchAuditOutcomes()).toEqual(['created', 'created', 'created']);
  });

  it('reruns as a no-op without new rows', async () => {
    await runFinancial(financialEnv());
    const before = {
      sponsors: await fetchSponsors(),
      accounts: await fetchBillingAccounts(),
      authorizations: await fetchAuthorizations(),
      grants: await fetchGrants(),
    };

    const second = await runFinancial(financialEnv());
    const resultLine = stdoutLine(second.stdout, 'FINANCIAL_RESULT');
    expect(resultLine).toContain('"outcome":"no-op"');
    expect(resultLine).toContain('"sponsor":"existing"');
    expect(resultLine).toContain('"billingAccount":"existing"');
    expect(resultLine).toContain('"authorization":"existing"');
    expect(resultLine).toContain('"grant":"existing"');
    expect(resultLine).toContain('"grantCredit":"already-credited"');

    expect(await fetchSponsors()).toEqual(before.sponsors);
    expect(await fetchBillingAccounts()).toEqual(before.accounts);
    expect(await fetchAuthorizations()).toEqual(before.authorizations);
    expect(await fetchGrants()).toEqual(before.grants);
    // Audit: ba row `created` rồi ba row `no-op`.
    expect(await fetchAuditOutcomes()).toEqual([
      'created',
      'created',
      'created',
      'no-op',
      'no-op',
      'no-op',
    ]);
  });

  it('rejects a divergent sponsor ceiling on rerun without touching state', async () => {
    await runFinancial(financialEnv());
    await expect(runFinancial(financialEnv({ ECOMA_SPONSOR_CEILING: '2000000' }))).rejects.toThrow(
      /ceiling is 1000000 UC but bootstrap seeds 2000000 UC/u,
    );
    // Fail-closed: state giữ nguyên — grant vẫn `credited`, vẫn đúng 4 row.
    expect(await fetchGrants()).toHaveLength(1);
    expect((await fetchGrants())[0]?.state).toBe('credited');
  });

  it('rejects a divergent authorization ceiling on rerun', async () => {
    await runFinancial(financialEnv());
    await expect(
      runFinancial(financialEnv({ ECOMA_SPONSOR_AUTHORIZATION_CEILING: '600000' })),
    ).rejects.toThrow(/ceiling differs from the configured input/u);
    expect((await fetchGrants())[0]?.state).toBe('credited');
  });

  it('rejects a divergent evidence_ref on rerun', async () => {
    await runFinancial(financialEnv());
    await expect(
      runFinancial(
        financialEnv({ ECOMA_SPONSOR_AUTHORIZATION_EVIDENCE_REF: 'other-budget-decision' }),
      ),
    ).rejects.toThrow(/evidence_ref is "budget-decision:2026-Q4" but bootstrap seeds/u);
    expect((await fetchGrants())[0]?.state).toBe('credited');
  });

  it('rejects a divergent grant amount on rerun (a registered grant is immutable history)', async () => {
    await runFinancial(financialEnv());
    await expect(
      runFinancial(financialEnv({ ECOMA_SPONSOR_GRANT_AMOUNT: '250001' })),
    ).rejects.toThrow(/immutable history/u);
    expect(await fetchGrants()).toHaveLength(1);
    expect((await fetchGrants())[0]?.amount_minor).toBe('250000');
  });

  it('refuses a sponsor id env that differs from the code constant', async () => {
    // Định danh sponsor nằm trong code (ADR-0020 Quyết định 12): env chỉ
    // assert — giá trị khác bị từ chối trước khi một row nào được ghi.
    await expect(
      runFinancial(financialEnv({ ECOMA_SPONSOR_ID: 'sponsor_someone_else' })),
    ).rejects.toThrow(/the environment asserts the identity, it never defines it/u);
    expect(await fetchSponsors()).toEqual([]);
  });

  it('fails closed when a mandatory env is missing', async () => {
    const { ECOMA_SPONSOR_AUTHORIZATION_EVIDENCE_REF: _omitted, ...rest } = financialEnv();
    await expect(runFinancial(rest)).rejects.toThrow(
      /missing required environment variable ECOMA_SPONSOR_AUTHORIZATION_EVIDENCE_REF/u,
    );
    expect(await fetchSponsors()).toEqual([]);
  });

  it('accepts the literal null as an explicit no per-account ceiling', async () => {
    const result = await runFinancial(
      financialEnv({ ECOMA_SPONSOR_AUTHORIZATION_CEILING: 'null' }),
    );
    expect(stdoutLine(result.stdout, 'FINANCIAL_RESULT')).toContain('"grantCredit":"credited"');
    const authorizations = await fetchAuthorizations();
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]?.ceiling_minor).toBeNull();
    expect(authorizations[0]?.ceiling_denomination).toBeNull();
    // Grant vẫn credit được: sponsor ceiling là phép kiểm còn hiệu lực.
    expect((await fetchGrants())[0]?.state).toBe('credited');
  });

  it('keeps the grant pending and exits non-zero when the amount exceeds the sponsor ceiling', async () => {
    // Trần sponsor 1000 < grant 250000: credit bị từ chối với đúng mã
    // canonical; seed + register đã commit nên grant tồn tại ở state `pending`
    // (ADR-0028 §6 S11), audit chỉ có hai transaction đầu.
    await expect(runFinancial(financialEnv({ ECOMA_SPONSOR_CEILING: '1000' }))).rejects.toThrow(
      /rejected by creditGrant: sponsor_ceiling_exceeded/u,
    );
    const grants = await fetchGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.state).toBe('pending');
    expect(await fetchAuditOutcomes()).toEqual(['created', 'created']);
  });

  it('keeps the grant pending when the amount exceeds the authorization ceiling', async () => {
    await expect(
      runFinancial(financialEnv({ ECOMA_SPONSOR_AUTHORIZATION_CEILING: '1000' })),
    ).rejects.toThrow(/rejected by creditGrant: authorization_ceiling_exceeded/u);
    expect((await fetchGrants())[0]?.state).toBe('pending');
  });

  it('converges on rerun after the administrator raises the authorization ceiling', async () => {
    // Chuỗi recovery của ADR-0028 §6: run đầu fail vì trần per-account thấp hơn
    // grant (grant stays pending durable). Rerun với env trần ĐÃ SỬA nhưng state
    // cũ thì vẫn fail-closed ở phép kiểm drift của seed — bootstrap không bao
    // giờ tự nâng trần. Hội tụ chỉ xảy ra sau khi administrator nâng trần bằng
    // phép kiểm được kiểm soát `updateFundingAuthorizationCeiling` (op đã có
    // unit test ở domain), rồi rerun với env khớp state mới.
    await expect(
      runFinancial(financialEnv({ ECOMA_SPONSOR_GRANT_AMOUNT: '600000' })),
    ).rejects.toThrow(/rejected by creditGrant: authorization_ceiling_exceeded/u);
    expect((await fetchGrants())[0]?.state).toBe('pending');

    // Rerun khi env đổi mà state chưa đổi: drift của seed chặn trước credit.
    await expect(
      runFinancial(
        financialEnv({
          ECOMA_SPONSOR_GRANT_AMOUNT: '600000',
          ECOMA_SPONSOR_AUTHORIZATION_CEILING: '600000',
        }),
      ),
    ).rejects.toThrow(/ceiling differs from the configured input/u);

    // Giả lập kết quả state của `updateFundingAuthorizationCeiling` do
    // administrator chạy ngoài vòng đời bootstrap (fixture cho rerun, không
    // phải đường seed của runner).
    const admin = await db.connectAsMigrator('gateway');
    try {
      await admin.query(
        "UPDATE llm_financial.sponsor_funding_authorizations SET ceiling_minor = '600000', ceiling_denomination = 'UC' WHERE authorization_id = $1",
        [SPONSOR_FUNDING_AUTHORIZATION_ID],
      );
    } finally {
      await admin.end();
    }

    const second = await runFinancial(
      financialEnv({
        ECOMA_SPONSOR_GRANT_AMOUNT: '600000',
        ECOMA_SPONSOR_AUTHORIZATION_CEILING: '600000',
      }),
    );
    const resultLine = stdoutLine(second.stdout, 'FINANCIAL_RESULT');
    expect(resultLine).toContain('"outcome":"created"');
    expect(resultLine).toContain('"sponsor":"existing"');
    expect(resultLine).toContain('"authorization":"existing"');
    expect(resultLine).toContain('"grant":"existing"');
    expect(resultLine).toContain('"grantCredit":"credited"');
    // Không double-credit: vẫn đúng một grant, giờ `credited` với amount gốc.
    const grants = await fetchGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]?.state).toBe('credited');
    expect(grants[0]?.amount_minor).toBe('600000');
  });

  it('rejects a gateway database URL pointing at another database (current_database guard)', async () => {
    await expect(
      runFinancial(
        financialEnv({ ECOMA_GATEWAY_DATABASE_URL: migratorUrl('tenant', db.host, db.port) }),
      ),
    ).rejects.toThrow(/DATABASE_URL points to database/u);
  });
});
