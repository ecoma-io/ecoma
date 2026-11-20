import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Bảng bước bootstrap/seed canonical — nguồn duy nhất là
 * `docs/architecture/02-delivery.md` §3.2 (hợp đồng vận hành), quyết định
 * đường chạy ở ADR-0020 (staff-access). Runner chỉ thực thi các dòng
 * bootstrap/seed của bảng §3.2 (dòng 3, 4, 5a, 5b, 6, 7, 8a, 8b, 9, 10):
 * dòng 1 (provision) thuộc #349/#368,
 * dòng 2 (migrate schemas) thuộc các migration project `deploys/*-db`
 * (#374, #375–#378) — runner không execute DDL, chỉ yêu cầu evidence hoàn
 * tất của hai dòng đó trước khi chạy (§3a.5 mục F: ba lifecycle không trộn).
 */

/** Danh tính canonical — hằng trong code, cấu hình chỉ được assert lại (§3.2). */
export const CANONICAL_TENANT = 'ecoma';
export const CANONICAL_SUPERADMIN_EMAIL = 'superadmin@ecoma.io';

/**
 * Seller tenant first-party của `llm-seller-tenant` mang tên theo provider
 * (ADR-0027 §2): `dronie` đầu tiên — KHÔNG có Seller tenant tên `ecoma`.
 */
export const CANONICAL_SELLER_TENANT = 'dronie';

/** Giá trị đầu ra xuyên bước — tham chiếu opaque, không phải ràng buộc giao dịch. */
export interface StepValues {
  /** `sub` của Superadmin — sinh ở bước account, tiêu thụ từ bước staff trở đi. */
  sub?: string;
  /** `tenant_id` của Consumer tenant `ecoma` — sinh ở dòng §3.2 số 9 (bước `llm-consumer-tenant`), tiêu thụ ở dòng 10 (bước `llm-financial`, ADR-0028 §6). */
  tenantId?: string;
}

/** Một dòng của bảng bước §3.2 (chỉ các dòng bootstrap/seed 3–10, gồm cả 5a/5b và 8a/8b). */
export interface BootstrapStep {
  /** Định danh ổn định của bước — dùng cho `--from` và evidence. */
  readonly id: string;
  /** Sequence chạy của runner (monotonic) — KHÔNG phải số dòng §3.2 (bảng canonical dùng 5a/5b, 8a/8b). */
  readonly order: number;
  /** Số dòng thực trong bảng §3.2 — tham chiếu truy vết cho evidence. */
  readonly canonicalRow: string;
  /** Service sở hữu bước — một bước chỉ được một service ghi (§3.2). */
  readonly service: string;
  /** Database bị ghi — một bước chỉ được ghi đúng một database (ADR-0020 Q4). */
  readonly database: string;
  /** Script CLI mà service tự sở hữu — runner gọi như tiến trình con, không import. */
  readonly argv: readonly string[];
  /** Verify đọc lại đúng bản ghi kỳ vọng — không dựa log, không là smoke (§3.2). */
  readonly verify: string;
}

/**
 * Repo root suy từ vị trí module (src/ → lên hai cấp) — deterministic, không
 * phụ thuộc cwd của process gọi (vitest, nx, CI đều phải ra cùng một root).
 */
export const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Bảng bước theo đúng thứ tự bắt buộc của §3.2. Đường dẫn script được khớp với
 * hiện trạng repo (inventory thư mục `db` của từng app) — đây là các CLI đã tồn tại;
 * bước chưa có CLI sẽ được chặn ở `unresolvedBlockers` thay vì bị giả định có.
 */
export const BOOTSTRAP_STEPS: readonly BootstrapStep[] = [
  {
    id: 'account',
    order: 3,
    canonicalRow: '3',
    service: 'account',
    database: 'db-account',
    argv: ['pnpm', '--filter', '@ecoma-io/account', 'exec', 'node', 'db/bootstrap.mts'],
    verify:
      'address_hash của email khởi tạo trả đúng một Account active + một hàng verified có bootstrap audit event cùng transaction',
  },
  {
    id: 'staff',
    order: 4,
    canonicalRow: '4',
    service: 'staff-access',
    database: 'db-staff-access',
    argv: ['pnpm', '--filter', '@ecoma-io/staff-access', 'exec', 'node', 'db/bootstrap.mts'],
    verify:
      'đúng một staff active theo sub, đúng một role system-administrator, đúng một assignment còn hiệu lực',
  },
  {
    id: 'pact-tenant',
    order: 5,
    canonicalRow: '5a',
    service: 'pact-broker',
    database: 'db-pact-broker',
    argv: [
      'pnpm',
      '--filter',
      '@ecoma-io/pact-broker-api',
      'exec',
      'node',
      'db/bootstrap-tenant.mts',
    ],
    verify:
      "pact.tenants WHERE name = 'ecoma' trả đúng một row active; membership owner của sub đọc lại được",
  },
  {
    id: 'remote-cache-tenant',
    order: 6,
    canonicalRow: '5b',
    service: 'remote-cache',
    database: 'db-remote-cache',
    argv: [
      'pnpm',
      '--filter',
      '@ecoma-io/remote-cache-api',
      'exec',
      'node',
      'db/bootstrap-tenant.mts',
    ],
    verify:
      "remote_cache.tenants WHERE name = 'ecoma' trả đúng một row active; membership owner của sub đọc lại được",
  },
  {
    id: 'pact-machine-token',
    order: 7,
    canonicalRow: '6',
    service: 'pact-broker',
    database: 'db-pact-broker',
    argv: [
      'pnpm',
      '--filter',
      '@ecoma-io/pact-broker-api',
      'exec',
      'node',
      'db/provision-machine-token.mts',
    ],
    verify:
      'đúng một token còn hiệu lực cho (tenant ecoma, token name); revoke hàng cũ khi đổi plaintext, không tạo hàng thứ hai',
  },
  {
    id: 'auth-oauth-client',
    order: 8,
    canonicalRow: '7',
    service: 'auth',
    database: 'db-auth',
    // TODO(352/blocking): script bootstrap OAuth client của `auth` CHƯA TỒN TẠI
    // (apps/auth/db chỉ có migrate.mts) — executing PR của #352 phải đặt CLI
    // này vào `apps/auth/db/` (bề mặt (b) — CLI offline của chính service sở
    // hữu) trước khi runner chạy được bước này. Runner không tự tạo script
    // thay service sở hữu dữ liệu.
    argv: ['pnpm', '--filter', '@ecoma-io/auth', 'exec', 'node', 'db/bootstrap-oauth-clients.mts'],
    verify: 'oauth_clients có client_id kỳ vọng với đúng tập redirect URI; URI cũ đã gỡ không còn',
  },
  {
    id: 'llm-seller-governance',
    order: 9,
    canonicalRow: '8a',
    service: 'llm-api',
    database: 'db-llm-gateway',
    argv: [
      'pnpm',
      '--filter',
      '@ecoma-io/llm-api',
      'exec',
      'node',
      'db/bootstrap-seller-governance.mts',
    ],
    verify:
      'provider + offer đọc lại được qua probe của llm-api; owner membership của sub đọc lại được',
  },
  {
    id: 'llm-marketplace',
    order: 10,
    canonicalRow: '8b',
    service: 'llm-api',
    database: 'db-llm-marketplace',
    argv: ['pnpm', '--filter', '@ecoma-io/llm-api', 'exec', 'node', 'db/bootstrap-marketplace.mts'],
    verify: 'entry marketplace đọc lại được và trỏ đúng offer của bước seller-governance',
  },
  {
    id: 'llm-consumer-tenant',
    order: 11,
    canonicalRow: '9',
    service: 'llm-api',
    database: 'db-llm-tenant',
    argv: [
      'pnpm',
      '--filter',
      '@ecoma-io/llm-api',
      'exec',
      'node',
      'db/bootstrap-consumer-tenant.mts',
    ],
    verify:
      'tenant + owner membership đọc lại được; khởi tạo tài chính là bước llm-financial (ADR-0028 §6)',
  },
  {
    id: 'llm-financial',
    order: 12,
    canonicalRow: '10',
    service: 'llm-api',
    database: 'db-llm-gateway',
    argv: ['pnpm', '--filter', '@ecoma-io/llm-api', 'exec', 'node', 'db/bootstrap-financial.mts'],
    verify:
      'sponsor_ecoma_internal, billing account theo tenant_ref, authorization, grant_ecoma_initial ở trạng thái credited; re-run lệch cấu hình fail-closed',
  },
] as const;

/**
 * Danh sách chặn hiện tại của skeleton — CLI chạy sẽ fail-closed với danh
 * sách này cho tới khi từng điều kiện có evidence thật. Không mục nào được
 * "coi như xong" ngầm.
 */
export function unresolvedBlockers(): readonly string[] {
  const blockers: string[] = [
    // TODO(349/blocking): databases + roles staging phải tồn tại thật qua
    // provisioning (#349) trước khi bất kỳ script nào connect được.
    'TODO(349/blocking): staging databases and roles are not provisioned yet (#349)',
    // TODO(351/blocking): credentials (migrator/owner per database, seed input
    // như token plaintext, redirect URI) chưa có — inventory thuộc #351.
    'TODO(351/blocking): staging credentials and seed inputs are not inventoried yet (#351)',
    // TODO(349/blocking): schema migration của các DB liên quan phải hoàn tất
    // trước bootstrap (§3.2 thứ tự bắt buộc: migrate → bootstrap).
    'TODO(349/blocking): schema migrations for the target databases have not completed yet (#349/#374/#375-#378)',
  ];
  if (!BOOTSTRAP_STEPS.every((step) => existsScript(step.argv))) {
    blockers.push(
      'TODO(352/blocking): some bootstrap CLIs referenced by the step table do not exist yet (auth-oauth-client) — the executing PR must add them in the owning app',
    );
  }
  return blockers;
}

/** Đường dẫn script CLI của bước có tồn tại trên cây repo không. */
export function existsScript(argv: readonly string[]): boolean {
  const script = argv.at(-1);
  if (script === undefined) return false;
  return existsSync(resolve(WORKSPACE_ROOT, 'apps', appNameOf(argv), script));
}

/** Suy tên app Nx từ argv `pnpm --filter <name> ...` — phục vụ kiểm script tồn tại. */
function appNameOf(argv: readonly string[]): string {
  const filterIndex = argv.indexOf('--filter');
  const filter = filterIndex === -1 ? '' : (argv.at(filterIndex + 1) ?? '');
  return filter.replace(/^@ecoma-io\//u, '');
}
