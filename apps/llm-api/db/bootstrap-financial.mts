/**
 * Bootstrap runner bước 10 — sponsor funding bootstrap (ADR-0028 §6 B1–B4,
 * slice P3 của Issue #24): seed sponsor, billing account, funding authorization
 * và grant khởi tạo cho tenant consumer trên `db-llm-gateway`, schema
 * `llm_financial`.
 *
 * Source of truth: ADR-0028 §3–§6, ADR-0020 (Quyết định 4, 12, 13 — hình dạng
 * bootstrap giữ nguyên, Quyết định 13 đọc thêm hàng khởi tạo tài chính),
 * domain-model `llm-financial` §3. Chạy sau `db:migrate` gateway và sau bước 9
 * trên lane local; chạy lại là no-op theo natural key; divergence dữ liệu là
 * fail-closed — không bao giờ ghi đè cấu hình đã thiết lập (ADR-0028 §6 drift).
 *
 * Bốn bước seed, MỘT database, BA transaction trong cùng tiến trình (ADR-0020
 * Quyết định 4: một write surface một database; tách transaction để state
 * `pending` của B4 là durable khi credit thất bại — ADR-0028 §6 S11: register
 * xong, credit fail, rerun hội tụ bằng credit retry):
 * 1. Tx1 — B1 sponsor (`sponsor_id` hằng trong code, env chỉ assert; ceiling là
 *    input env bắt buộc) + B2 billing account (natural key `tenant_ref`, nhận
 *    `tenant_id` từ kết quả bước 9) + B3 funding authorization (natural key
 *    `(sponsor_id, billing_account_id)`; ceiling nullable — chữ `null` là
 *    explicit vô trần; `evidence_ref` bắt buộc).
 * 2. Tx2 — B4 register: grant `grant_ecoma_initial` state `pending` (không post
 *    bút toán — pending không phải tiền trong ví).
 * 3. Tx3 — B4 credit: CHẠY QUA DOMAIN OP `creditGrant` — phép kiểm duy nhất của
 *    cả hai trần (sponsor + authorization) trong cùng một phép gọi, ngay trước
 *    khi post (ADR-0028 §5/§6: bootstrap không validate riêng ngoài creditGrant).
 *    Vượt trần ⇒ exit khác 0 với đúng mã canonical, grant giữ `pending` bền.
 *
 * Bút toán `sponsor_funding_clearing → wallet_available` thực thi in-memory
 * trên book hydrate từ các bảng aggregate; các bảng projection ledger/wallet
 * thuộc slice serving kế tiếp — net credited của sponsor/authorization tái
 * dựng được từ `sponsor_grants.state` (Σ `credited`), nên phép kiểm trần đọc
 * đúng state bền.
 *
 * stdout giữ máy đọc: `FINANCIAL_RESULT=<json>` — dòng cuối; mọi log người đọc
 * đi stderr. Runner không sinh và không in credential nào (không có plaintext
 * trong slice này).
 */

import { Client } from 'pg';
import {
  authorizeFunding,
  createBillingAccount,
  createWallet,
  creditGrant,
  isSponsor,
  isSponsorFundingAuthorization,
  isSponsorGrant,
  openFinancialBook,
  readMoney,
  registerGrant,
  registerSponsor,
  type BillingAccount,
  type FinancialBook,
  type FinancialResult,
  type Money,
  type Sponsor,
  type SponsorFundingAuthorization,
  type SponsorGrant,
} from '@ecoma-io/llm-financial-domain';

import {
  BOOTSTRAP_ACTOR_ENV,
  CONSUMER_BILLING_ACCOUNT_ID,
  CONSUMER_GATEWAY_DATABASE_URL_ENV,
  CONSUMER_TENANT_ID,
  CONSUMER_TENANT_ID_ENV,
  CONSUMER_TENANT_OWNER_SUB_ENV,
  SPONSOR_AUTHORIZATION_CEILING_ENV,
  SPONSOR_AUTHORIZATION_EVIDENCE_REF_ENV,
  SPONSOR_CEILING_ENV,
  SPONSOR_FUNDING_AUTHORIZATION_ID,
  SPONSOR_FUNDING_DENOMINATION,
  SPONSOR_GRANT_AMOUNT_ENV,
  SPONSOR_GRANT_ID,
  SPONSOR_ID,
  SPONSOR_ID_ENV,
  assertBootstrapDatabase,
  fail,
  log,
  printResultJson,
  requireEnv,
  type BootstrapRunResult,
} from './bootstrap-shared.mts';

/** Ví UC in-memory của billing account trong run — chỉ sống trong tiến trình. */
const BOOTSTRAP_WALLET_ID = 'wallet-ecoma-uc-bootstrap';

/** Fencing token của ví in-memory — khớp token của chính ví đó, không phải state bền. */
const BOOTSTRAP_WALLET_FENCING_TOKEN = 'fence-ecoma-uc-bootstrap';

/** Input cấu hình của run bước 10 — env là kênh cấu hình duy nhất. */
interface FinancialSeedInput {
  readonly actor: string;
  /** `tenant_id` đầu ra của bước 9 (được assert khớp hằng trong code). */
  readonly tenantId: string;
  /** Owner của billing account — `sub` Superadmin bootstrap của Consumer tenant. */
  readonly ownerSub: string;
  readonly sponsorCeiling: Money;
  /** `null` = explicit không trần per-account (ADR-0028 §6 B3). */
  readonly authorizationCeiling: Money | null;
  readonly evidenceRef: string;
  readonly grantAmount: Money;
}

/** Row shape của `llm_financial.sponsors` (bigint đọc về string qua pg). */
interface SponsorRow {
  sponsor_id: string;
  owner_ref: string;
  ceiling_minor: string;
  ceiling_denomination: string;
  status: string;
  created_at: string | number;
  created_by: string;
}

/** Row shape của `llm_financial.billing_accounts`. */
interface BillingAccountRow {
  billing_account_id: string;
  tenant_ref: string;
  owner_ref: string;
  created_at: string | number;
}

/** Row shape của `llm_financial.sponsor_funding_authorizations`. */
interface AuthorizationRow {
  authorization_id: string;
  sponsor_id: string;
  billing_account_id: string;
  ceiling_minor: string | null;
  ceiling_denomination: string | null;
  status: string;
  evidence_ref: string;
  created_at: string | number;
  created_by: string;
}

/** Row shape của `llm_financial.sponsor_grants`. */
interface GrantRow {
  grant_id: string;
  authorization_id: string;
  sponsor_id: string;
  billing_account_id: string;
  amount_minor: string;
  amount_denomination: string;
  state: string;
  actor_ref: string;
  created_at: string | number;
}

/** Outcome mỗi bước seed — cùng vocabulary `created` | `existing` của bước 9. */
type StepOutcome = 'created' | 'existing';

/** Outcome của phép credit — `already-credited` là replay, không post lại. */
type CreditOutcome = 'credited' | 'already-credited';

// ---------------------------------------------------------------------------
// Đọc env — fail-closed, không có mặc định ngầm (ADR-0020 Quyết định 12)
// ---------------------------------------------------------------------------

/** Đọc env số tiền minor units; sai dạng là lỗi triển khai, không sửa hộ. */
function requireMoneyEnv(name: string, minimum: bigint): Money {
  const raw = requireEnv(name);
  const money = readMoney({ denomination: SPONSOR_FUNDING_DENOMINATION, minor: raw });
  if (!money.ok) {
    fail(
      `environment variable ${name} must be a non-negative integer in minor units within the ${SPONSOR_FUNDING_DENOMINATION} denomination (domain rejected it: ${money.error.code})`,
    );
  }
  if (money.value.minor < minimum) {
    fail(`environment variable ${name} must be at least ${minimum} minor units`);
  }
  return money.value;
}

/**
 * Đọc trần per-account của authorization: số nguyên ≥ 0 hoặc chữ `null` nghĩa
 * là explicit không trần per-account (ADR-0028 §6 B3). Thiếu env là fail-closed.
 */
function requireAuthorizationCeilingEnv(): Money | null {
  const raw = requireEnv(SPONSOR_AUTHORIZATION_CEILING_ENV);
  if (raw === 'null') {
    return null;
  }
  const money = readMoney({ denomination: SPONSOR_FUNDING_DENOMINATION, minor: raw });
  if (!money.ok) {
    fail(
      `environment variable ${SPONSOR_AUTHORIZATION_CEILING_ENV} must be a non-negative integer in minor units or the literal "null" for no per-account ceiling (domain rejected it: ${money.error.code})`,
    );
  }
  return money.value;
}

/** Đọc + validate toàn bộ input env của run. */
function readInput(): FinancialSeedInput {
  const sponsorIdEnv = requireEnv(SPONSOR_ID_ENV);
  if (sponsorIdEnv !== SPONSOR_ID) {
    fail(
      `environment variable ${SPONSOR_ID_ENV} is "${sponsorIdEnv}" but the sponsor identity is held in code as "${SPONSOR_ID}" (ADR-0020 decision 12): the environment asserts the identity, it never defines it`,
    );
  }
  const tenantId = requireEnv(CONSUMER_TENANT_ID_ENV);
  if (tenantId !== CONSUMER_TENANT_ID) {
    fail(
      `environment variable ${CONSUMER_TENANT_ID_ENV} is "${tenantId}" but the canonical consumer tenant id held in code is "${CONSUMER_TENANT_ID}"; the wiring diverged from the step-9 output contract`,
    );
  }
  return {
    actor: requireEnv(BOOTSTRAP_ACTOR_ENV),
    tenantId,
    ownerSub: requireEnv(CONSUMER_TENANT_OWNER_SUB_ENV),
    sponsorCeiling: requireMoneyEnv(SPONSOR_CEILING_ENV, 0n),
    authorizationCeiling: requireAuthorizationCeilingEnv(),
    evidenceRef: requireEnv(SPONSOR_AUTHORIZATION_EVIDENCE_REF_ENV),
    grantAmount: requireMoneyEnv(SPONSOR_GRANT_AMOUNT_ENV, 1n),
  };
}

// ---------------------------------------------------------------------------
// Rehydration — đọc row thành record domain; hình dạng sai là divergence
// ---------------------------------------------------------------------------

/** Đọc Money từ cột (denomination, minor) của một row; sai là fail-closed. */
function rowMoney(denomination: string, minor: string | null, where: string): Money | null {
  if (minor === null) {
    return null;
  }
  const money = readMoney({ denomination, minor });
  if (!money.ok) {
    fail(`stored ${where} failed the domain money shape guard; divergent provisioning state`);
  }
  return money.value;
}

/** Đọc row sponsor thành record; type guard domain là ranh giới fail-closed. */
function rehydrateSponsor(row: SponsorRow): Sponsor {
  const ceiling = rowMoney(
    row.ceiling_denomination,
    row.ceiling_minor,
    `sponsor "${row.sponsor_id}" ceiling`,
  );
  if (ceiling === null) {
    fail(
      `stored sponsor "${row.sponsor_id}" has no ceiling; an uncapped sponsor must never exist (ADR-0028 section 5)`,
    );
  }
  const candidate: Sponsor = {
    sponsor_id: row.sponsor_id,
    owner_ref: row.owner_ref,
    ceiling,
    status: row.status as Sponsor['status'],
    created_at: Number(row.created_at),
    created_by: row.created_by,
  };
  if (!isSponsor(candidate)) {
    fail(
      `stored sponsor "${row.sponsor_id}" failed the domain shape guard; divergent provisioning state`,
    );
  }
  return candidate;
}

/** Đọc row authorization thành record. */
function rehydrateAuthorization(row: AuthorizationRow): SponsorFundingAuthorization {
  let ceiling: Money | null = null;
  if (row.ceiling_denomination !== null) {
    if (row.ceiling_minor === null) {
      fail(
        `stored authorization "${row.authorization_id}" ceiling pair is inconsistent; divergent provisioning state`,
      );
    }
    ceiling = rowMoney(
      row.ceiling_denomination,
      row.ceiling_minor,
      `authorization "${row.authorization_id}" ceiling`,
    );
  }
  const candidate: SponsorFundingAuthorization = {
    authorization_id: row.authorization_id,
    sponsor_id: row.sponsor_id,
    billing_account_id: row.billing_account_id as BillingAccount['billing_account_id'],
    ceiling,
    status: row.status as SponsorFundingAuthorization['status'],
    evidence_ref: row.evidence_ref,
    created_at: Number(row.created_at),
    created_by: row.created_by,
  };
  if (!isSponsorFundingAuthorization(candidate)) {
    fail(
      `stored authorization "${row.authorization_id}" failed the domain shape guard; divergent provisioning state`,
    );
  }
  return candidate;
}

/** Đọc row grant thành record. */
function rehydrateGrant(row: GrantRow): SponsorGrant {
  const amount = rowMoney(
    row.amount_denomination,
    row.amount_minor,
    `grant "${row.grant_id}" amount`,
  );
  if (amount === null) {
    fail(
      `stored grant "${row.grant_id}" amount failed the domain money shape guard; divergent provisioning state`,
    );
  }
  const candidate: SponsorGrant = {
    grant_id: row.grant_id,
    authorization_id: row.authorization_id,
    sponsor_id: row.sponsor_id,
    billing_account_id: row.billing_account_id as BillingAccount['billing_account_id'],
    amount,
    state: row.state as SponsorGrant['state'],
    actor_ref: row.actor_ref,
    created_at: Number(row.created_at),
  };
  if (!isSponsorGrant(candidate)) {
    fail(
      `stored grant "${row.grant_id}" failed the domain shape guard; divergent provisioning state`,
    );
  }
  return candidate;
}

/**
 * Billing account hydrate từ row kèm ví UC in-memory (wallet projection chưa có
 * bảng trong slice này). Wallet chỉ sống trong tiến trình run — đủ cho
 * `creditGrant` thực thi bút toán trên book.
 */
function bootstrapAccount(row: BillingAccountRow): BillingAccount {
  const account = createBillingAccount({
    billingAccountId: row.billing_account_id,
    ownerRef: row.owner_ref,
    createdAt: Number(row.created_at),
  });
  if (!account.ok) {
    fail(
      `stored billing account "${row.billing_account_id}" failed the domain shape guard: ${account.error.code}`,
    );
  }
  const wallet = createWallet({
    walletId: BOOTSTRAP_WALLET_ID,
    billingAccountId: row.billing_account_id,
    denomination: SPONSOR_FUNDING_DENOMINATION,
    fencingToken: BOOTSTRAP_WALLET_FENCING_TOKEN,
  });
  if (!wallet.ok) {
    fail(`bootstrap wallet construction rejected by domain: ${wallet.error.code}`);
  }
  return { ...account.value, wallets: [wallet.value] };
}

/** Kết quả domain thất bại là fail-closed của runner — bọc trực tiếp. */
function unwrapDomain<Value>(result: FinancialResult<Value>, what: string): Value {
  if (!result.ok) {
    fail(`${what} rejected by domain: ${result.error.code}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Audit — một row mỗi transaction thành công (ADR-0020)
// ---------------------------------------------------------------------------

/** Ghi một dòng `llm_financial.bootstrap_audit` cho transaction đang chạy. */
async function writeBootstrapAudit(
  client: Client,
  outcome: 'created' | 'no-op',
  detail: Record<string, string>,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO llm_financial.bootstrap_audit (runner, outcome, detail, actor, occurred_at)
     VALUES ('financial', $1, $2::jsonb, $3, $4)`,
    [outcome, JSON.stringify(detail), actor, Date.now()],
  );
}

// ---------------------------------------------------------------------------
// Tx1 — B1 sponsor + B2 billing account + B3 funding authorization
// ---------------------------------------------------------------------------

/** Outcome của Tx1 cho result line. */
interface SeedOutcome {
  readonly sponsor: StepOutcome;
  readonly billingAccount: StepOutcome;
  readonly authorization: StepOutcome;
}

/**
 * Seed B1–B3 insert-if-absent theo natural key; divergence (ceiling khác,
 * evidence_ref khác, owner khác, id bị chiếm) là fail-closed — bootstrap không
 * bao giờ update cấu hình đã thiết lập (ADR-0028 §6 drift).
 */
async function seedSponsorFunding(client: Client, input: FinancialSeedInput): Promise<SeedOutcome> {
  // --- B1 sponsor ---------------------------------------------------------
  const sponsorRows = await client.query<SponsorRow>(
    'SELECT sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_at, created_by FROM llm_financial.sponsors WHERE sponsor_id = $1',
    [SPONSOR_ID],
  );
  let sponsorOutcome: StepOutcome;
  let sponsorRecord: Sponsor;
  const existingSponsor = sponsorRows.rows[0];
  if (existingSponsor !== undefined) {
    const stored = rehydrateSponsor(existingSponsor);
    if (stored.owner_ref !== input.ownerSub) {
      fail(
        `sponsor "${SPONSOR_ID}" is held with owner "${stored.owner_ref}" but bootstrap seeds owner "${input.ownerSub}"; divergent provisioning state`,
      );
    }
    if (
      stored.ceiling.denomination !== input.sponsorCeiling.denomination ||
      stored.ceiling.minor !== input.sponsorCeiling.minor
    ) {
      fail(
        `sponsor "${SPONSOR_ID}" ceiling is ${stored.ceiling.minor} ${stored.ceiling.denomination} but bootstrap seeds ${input.sponsorCeiling.minor} ${input.sponsorCeiling.denomination}; the ceiling is administrator-managed and bootstrap never updates it — change it through updateSponsorCeiling, then rerun (ADR-0028 sections 5-6)`,
      );
    }
    sponsorOutcome = 'existing';
    sponsorRecord = stored;
  } else {
    const seeded = unwrapDomain(
      registerSponsor(openFinancialBook(), {
        sponsorId: SPONSOR_ID,
        ownerRef: input.ownerSub,
        ceiling: input.sponsorCeiling,
        createdAt: Date.now(),
        createdBy: input.actor,
      }),
      'sponsor seed',
    );
    await client.query(
      `INSERT INTO llm_financial.sponsors
         (sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        seeded.sponsor.sponsor_id,
        seeded.sponsor.owner_ref,
        seeded.sponsor.ceiling.minor.toString(),
        seeded.sponsor.ceiling.denomination,
        seeded.sponsor.status,
        seeded.sponsor.created_at,
        seeded.sponsor.created_by,
      ],
    );
    sponsorOutcome = 'created';
    sponsorRecord = seeded.sponsor;
  }

  // --- B2 billing account ---------------------------------------------------
  const accountRows = await client.query<BillingAccountRow>(
    'SELECT billing_account_id, tenant_ref, owner_ref, created_at FROM llm_financial.billing_accounts WHERE tenant_ref = $1',
    [input.tenantId],
  );
  let accountOutcome: StepOutcome;
  let accountRecord: BillingAccount;
  const existingAccount = accountRows.rows[0];
  if (existingAccount !== undefined) {
    if (existingAccount.billing_account_id !== CONSUMER_BILLING_ACCOUNT_ID) {
      fail(
        `tenant "${input.tenantId}" already holds billing account "${existingAccount.billing_account_id}" but bootstrap seeds "${CONSUMER_BILLING_ACCOUNT_ID}"; divergent provisioning state`,
      );
    }
    if (existingAccount.owner_ref !== input.ownerSub) {
      fail(
        `billing account "${CONSUMER_BILLING_ACCOUNT_ID}" is held with owner "${existingAccount.owner_ref}" but bootstrap seeds owner "${input.ownerSub}"; divergent provisioning state`,
      );
    }
    accountOutcome = 'existing';
    accountRecord = bootstrapAccount(existingAccount);
  } else {
    const idHolders = await client.query<{ tenant_ref: string }>(
      'SELECT tenant_ref FROM llm_financial.billing_accounts WHERE billing_account_id = $1',
      [CONSUMER_BILLING_ACCOUNT_ID],
    );
    if (idHolders.rows.length > 0) {
      fail(
        `billing account id "${CONSUMER_BILLING_ACCOUNT_ID}" is already held by tenant "${idHolders.rows[0]?.tenant_ref}" but bootstrap seeds tenant "${input.tenantId}"; divergent provisioning state`,
      );
    }
    const account = unwrapDomain(
      createBillingAccount({
        billingAccountId: CONSUMER_BILLING_ACCOUNT_ID,
        ownerRef: input.ownerSub,
        createdAt: Date.now(),
      }),
      'billing account seed',
    );
    await client.query(
      `INSERT INTO llm_financial.billing_accounts (billing_account_id, tenant_ref, owner_ref, created_at)
       VALUES ($1, $2, $3, $4)`,
      [account.billing_account_id, input.tenantId, account.owner_ref, account.created_at],
    );
    accountOutcome = 'created';
    // Book cần account có ví khi authorization seed; ví in-memory dùng chung.
    accountRecord = { ...account, wallets: [] };
  }

  // --- B3 funding authorization --------------------------------------------
  const authorizationRows = await client.query<AuthorizationRow>(
    'SELECT authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by FROM llm_financial.sponsor_funding_authorizations WHERE sponsor_id = $1 AND billing_account_id = $2',
    [SPONSOR_ID, CONSUMER_BILLING_ACCOUNT_ID],
  );
  let authorizationOutcome: StepOutcome;
  const existingAuthorization = authorizationRows.rows[0];
  if (existingAuthorization !== undefined) {
    const stored = rehydrateAuthorization(existingAuthorization);
    if (stored.authorization_id !== SPONSOR_FUNDING_AUTHORIZATION_ID) {
      fail(
        `the (sponsor, billing account) pair already holds authorization "${stored.authorization_id}" but bootstrap seeds "${SPONSOR_FUNDING_AUTHORIZATION_ID}"; divergent provisioning state`,
      );
    }
    if (stored.evidence_ref !== input.evidenceRef) {
      fail(
        `authorization "${SPONSOR_FUNDING_AUTHORIZATION_ID}" evidence_ref is "${stored.evidence_ref}" but bootstrap seeds "${input.evidenceRef}"; the evidence reference is administrator-managed and bootstrap never updates it (ADR-0028 section 6)`,
      );
    }
    const storedCeiling = stored.ceiling;
    const inputCeiling = input.authorizationCeiling;
    if (
      storedCeiling === null
        ? inputCeiling !== null
        : inputCeiling === null ||
          storedCeiling.denomination !== inputCeiling.denomination ||
          storedCeiling.minor !== inputCeiling.minor
    ) {
      fail(
        `authorization "${SPONSOR_FUNDING_AUTHORIZATION_ID}" ceiling differs from the configured input; the ceiling is administrator-managed and bootstrap never updates it — change it through updateFundingAuthorizationCeiling, then rerun (ADR-0028 sections 5-6)`,
      );
    }
    authorizationOutcome = 'existing';
  } else {
    const idHolders = await client.query<{ sponsor_id: string; billing_account_id: string }>(
      'SELECT sponsor_id, billing_account_id FROM llm_financial.sponsor_funding_authorizations WHERE authorization_id = $1',
      [SPONSOR_FUNDING_AUTHORIZATION_ID],
    );
    if (idHolders.rows.length > 0) {
      fail(
        `authorization id "${SPONSOR_FUNDING_AUTHORIZATION_ID}" is already held by the pair (${idHolders.rows[0]?.sponsor_id}, ${idHolders.rows[0]?.billing_account_id}) but bootstrap seeds (${SPONSOR_ID}, ${CONSUMER_BILLING_ACCOUNT_ID}); divergent provisioning state`,
      );
    }
    // Domain op kiểm sponsor active + account tồn tại trên book hydrate từ
    // state vừa seed/đọc ở B1–B2.
    const book: FinancialBook = {
      ...openFinancialBook(),
      accounts: [accountRecord],
      sponsors: [sponsorRecord],
    };
    const seeded = unwrapDomain(
      authorizeFunding(book, {
        authorizationId: SPONSOR_FUNDING_AUTHORIZATION_ID,
        sponsorId: SPONSOR_ID,
        billingAccountId: CONSUMER_BILLING_ACCOUNT_ID,
        ceiling: input.authorizationCeiling,
        evidenceRef: input.evidenceRef,
        createdAt: Date.now(),
        createdBy: input.actor,
      }),
      'funding authorization seed',
    );
    await client.query(
      `INSERT INTO llm_financial.sponsor_funding_authorizations
         (authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        seeded.authorization.authorization_id,
        seeded.authorization.sponsor_id,
        seeded.authorization.billing_account_id,
        seeded.authorization.ceiling === null
          ? null
          : seeded.authorization.ceiling.minor.toString(),
        seeded.authorization.ceiling === null ? null : seeded.authorization.ceiling.denomination,
        seeded.authorization.status,
        seeded.authorization.evidence_ref,
        seeded.authorization.created_at,
        seeded.authorization.created_by,
      ],
    );
    authorizationOutcome = 'created';
  }

  return {
    sponsor: sponsorOutcome,
    billingAccount: accountOutcome,
    authorization: authorizationOutcome,
  };
}

// ---------------------------------------------------------------------------
// Tx2 — B4 register (pending, không post bút toán)
// ---------------------------------------------------------------------------

/**
 * Đăng ký grant khởi tạo `grant_ecoma_initial` ở state `pending`. Drift: grant
 * đã tồn tại với amount/authorization khác là lịch sử bất biến — fail-closed,
 * không "cập nhật grant" (ADR-0028 §6).
 */
async function registerInitialGrant(
  client: Client,
  input: FinancialSeedInput,
): Promise<StepOutcome> {
  const grantRows = await client.query<GrantRow>(
    'SELECT grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref, created_at FROM llm_financial.sponsor_grants WHERE grant_id = $1',
    [SPONSOR_GRANT_ID],
  );
  const existing = grantRows.rows[0];
  if (existing !== undefined) {
    if (
      existing.authorization_id !== SPONSOR_FUNDING_AUTHORIZATION_ID ||
      existing.amount_denomination !== input.grantAmount.denomination ||
      existing.amount_minor !== input.grantAmount.minor.toString()
    ) {
      fail(
        `initial grant "${SPONSOR_GRANT_ID}" exists with authorization "${existing.authorization_id}" and amount ${existing.amount_minor} ${existing.amount_denomination} but bootstrap seeds authorization "${SPONSOR_FUNDING_AUTHORIZATION_ID}" and amount ${input.grantAmount.minor} ${input.grantAmount.denomination}; a registered grant is immutable history and bootstrap never rewrites it (ADR-0028 section 6)`,
      );
    }
    return 'existing';
  }
  // Domain op kiểm authorization active + sponsor active; provenance
  // (sponsor_id, billing_account_id) suy từ authorization và ghi kèm row.
  const book = await hydrateAuthorizationBook(client);
  const registered = unwrapDomain(
    registerGrant(book, {
      grantId: SPONSOR_GRANT_ID,
      authorizationId: SPONSOR_FUNDING_AUTHORIZATION_ID,
      amount: input.grantAmount,
      actorRef: input.actor,
      createdAt: Date.now(),
    }),
    'initial grant registration',
  );
  await client.query(
    `INSERT INTO llm_financial.sponsor_grants
       (grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      registered.grant.grant_id,
      registered.grant.authorization_id,
      registered.grant.sponsor_id,
      registered.grant.billing_account_id,
      registered.grant.amount.minor.toString(),
      registered.grant.amount.denomination,
      registered.grant.state,
      registered.grant.actor_ref,
      registered.grant.created_at,
    ],
  );
  return 'created';
}

/**
 * Book hydrate đủ sponsor + authorization cho `registerGrant` (Tx2) — đọc lại
 * từ database, mọi hình dạng sai là fail-closed.
 */
async function hydrateAuthorizationBook(client: Client): Promise<FinancialBook> {
  const sponsorRows = await client.query<SponsorRow>(
    'SELECT sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_at, created_by FROM llm_financial.sponsors WHERE sponsor_id = $1',
    [SPONSOR_ID],
  );
  const authorizationRows = await client.query<AuthorizationRow>(
    'SELECT authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by FROM llm_financial.sponsor_funding_authorizations WHERE authorization_id = $1',
    [SPONSOR_FUNDING_AUTHORIZATION_ID],
  );
  const sponsorRow = sponsorRows.rows[0];
  const authorizationRow = authorizationRows.rows[0];
  if (sponsorRow === undefined || authorizationRow === undefined) {
    fail(
      'sponsor or funding authorization rows are missing while seeding the initial grant; rerun converges through the seed transaction first',
    );
  }
  return {
    ...openFinancialBook(),
    sponsors: [rehydrateSponsor(sponsorRow)],
    fundingAuthorizations: [rehydrateAuthorization(authorizationRow)],
  };
}

// ---------------------------------------------------------------------------
// Tx3 — B4 credit (qua domain op `creditGrant` — phép kiểm trần duy nhất)
// ---------------------------------------------------------------------------

/**
 * Credit grant khởi tạo. Vượt trần ⇒ exit khác 0 với đúng mã canonical, grant
 * giữ `pending` bền (ADR-0028 §6: recovery = đổi trần qua operation có kiểm
 * rồi replay credit cùng identity). Replay khi đã `credited` là no-op.
 */
async function creditInitialGrant(client: Client): Promise<CreditOutcome> {
  const grantRows = await client.query<GrantRow>(
    'SELECT grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref, created_at FROM llm_financial.sponsor_grants WHERE grant_id = $1',
    [SPONSOR_GRANT_ID],
  );
  const grantRow = grantRows.rows[0];
  if (grantRow === undefined) {
    fail(
      `initial grant "${SPONSOR_GRANT_ID}" row is missing at credit time; rerun converges through the register transaction first`,
    );
  }
  const grant = rehydrateGrant(grantRow);
  if (grant.state === 'credited') {
    return 'already-credited';
  }
  if (grant.state === 'reversed') {
    fail(
      `initial grant "${SPONSOR_GRANT_ID}" was reversed outside the provisioning surface; bootstrap never re-credits a reversed grant (ADR-0028 section 4)`,
    );
  }
  // Book hydrate: sponsor + authorization + billing account (kèm ví in-memory)
  // + TOÀN BỘ grant của sponsor — net credited của cả hai trần tính trên state
  // bền này (ADR-0028 §5).
  const book = await hydrateCreditBook(client);
  const credited = creditGrant(book, {
    grantId: SPONSOR_GRANT_ID,
    creditedAt: Date.now(),
    fencingToken: BOOTSTRAP_WALLET_FENCING_TOKEN,
  });
  if (!credited.ok) {
    fail(
      `the initial grant was rejected by creditGrant: ${credited.error.code}; the grant stays pending and the bootstrap converges only after the ceiling or authorization configuration is corrected through the controlled operations, then rerun (ADR-0028 sections 5-6)`,
    );
  }
  const updated = await client.query<{ state: string }>(
    'UPDATE llm_financial.sponsor_grants SET state = $2 WHERE grant_id = $1 RETURNING state',
    [SPONSOR_GRANT_ID, credited.value.grant.state],
  );
  const readBack = updated.rows[0];
  if (readBack === undefined || readBack.state !== 'credited') {
    fail('initial grant credit read-back diverged from the domain outcome; fail-closed');
  }
  return 'credited';
}

/**
 * Book đầy đủ cho `creditGrant`: sponsor, authorization, billing account (kèm
 * ví UC in-memory) và toàn bộ grant của sponsor — nguồn của hai phép kiểm trần.
 */
async function hydrateCreditBook(client: Client): Promise<FinancialBook> {
  const sponsorRows = await client.query<SponsorRow>(
    'SELECT sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_at, created_by FROM llm_financial.sponsors WHERE sponsor_id = $1',
    [SPONSOR_ID],
  );
  const authorizationRows = await client.query<AuthorizationRow>(
    'SELECT authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by FROM llm_financial.sponsor_funding_authorizations WHERE authorization_id = $1',
    [SPONSOR_FUNDING_AUTHORIZATION_ID],
  );
  const accountRows = await client.query<BillingAccountRow>(
    'SELECT billing_account_id, tenant_ref, owner_ref, created_at FROM llm_financial.billing_accounts WHERE billing_account_id = $1',
    [CONSUMER_BILLING_ACCOUNT_ID],
  );
  const grantRows = await client.query<GrantRow>(
    'SELECT grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref, created_at FROM llm_financial.sponsor_grants WHERE sponsor_id = $1',
    [SPONSOR_ID],
  );
  const sponsorRow = sponsorRows.rows[0];
  const authorizationRow = authorizationRows.rows[0];
  const accountRow = accountRows.rows[0];
  if (sponsorRow === undefined || authorizationRow === undefined || accountRow === undefined) {
    fail(
      'sponsor, authorization or billing account rows are missing at credit time; rerun converges through the seed transaction first',
    );
  }
  return {
    ...openFinancialBook(),
    accounts: [bootstrapAccount(accountRow)],
    sponsors: [rehydrateSponsor(sponsorRow)],
    fundingAuthorizations: [rehydrateAuthorization(authorizationRow)],
    grants: grantRows.rows.map(rehydrateGrant),
  };
}

// ---------------------------------------------------------------------------
// CLI entry — ba transaction, mỗi transaction một audit row, một result line
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const input = readInput();
  const databaseUrl = requireEnv(CONSUMER_GATEWAY_DATABASE_URL_ENV);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  // Tx1 — B1 + B2 + B3.
  let seed: SeedOutcome;
  try {
    await assertBootstrapDatabase(client, 'db-llm-gateway');
    await client.query('BEGIN');
    seed = await seedSponsorFunding(client, input);
    const created =
      seed.sponsor === 'created' ||
      seed.billingAccount === 'created' ||
      seed.authorization === 'created';
    await writeBootstrapAudit(
      client,
      created ? 'created' : 'no-op',
      {
        sponsor: seed.sponsor,
        billingAccount: seed.billingAccount,
        authorization: seed.authorization,
        sponsorId: SPONSOR_ID,
        billingAccountId: CONSUMER_BILLING_ACCOUNT_ID,
      },
      input.actor,
    );
    await client.query('COMMIT');
    log(
      `sponsor funding seed done: sponsor=${seed.sponsor} billingAccount=${seed.billingAccount} authorization=${seed.authorization}`,
    );
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  }

  // Tx2 — B4 register (pending durable).
  let grantOutcome: StepOutcome;
  try {
    await client.query('BEGIN');
    grantOutcome = await registerInitialGrant(client, input);
    await writeBootstrapAudit(
      client,
      grantOutcome === 'created' ? 'created' : 'no-op',
      { grant: grantOutcome, grantId: SPONSOR_GRANT_ID },
      input.actor,
    );
    await client.query('COMMIT');
    log(`initial grant register done: grant=${grantOutcome}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  }

  // Tx3 — B4 credit. Thất bại ở đây sau khi register đã commit là một tiền tố
  // hợp lệ: grant giữ `pending` bền, rerun hội tụ bằng credit retry (S11).
  let creditOutcome: CreditOutcome;
  try {
    await client.query('BEGIN');
    creditOutcome = await creditInitialGrant(client);
    await writeBootstrapAudit(
      client,
      creditOutcome === 'credited' ? 'created' : 'no-op',
      { grantCredit: creditOutcome, grantId: SPONSOR_GRANT_ID },
      input.actor,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
    fail(error instanceof Error ? error.message : String(error));
  }
  await client.end();

  const outcome: BootstrapRunResult['outcome'] =
    seed.sponsor === 'created' ||
    seed.billingAccount === 'created' ||
    seed.authorization === 'created' ||
    grantOutcome === 'created' ||
    creditOutcome === 'credited'
      ? 'created'
      : 'no-op';
  // Result line là dòng cuối của stdout (hợp đồng máy đọc); không giá trị nào
  // ở đây là credential-like.
  printResultJson('FINANCIAL_RESULT', {
    outcome,
    detail: {
      sponsorId: SPONSOR_ID,
      grantId: SPONSOR_GRANT_ID,
      sponsor: seed.sponsor,
      billingAccount: seed.billingAccount,
      authorization: seed.authorization,
      grant: grantOutcome,
      grantCredit: creditOutcome,
    },
  });
  log(`sponsor funding bootstrap done: ${outcome}`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
