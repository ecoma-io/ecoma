/**
 * Bản đồ deployment canonical — nguồn sự thật duy nhất trả lời câu hỏi
 * "runtime này do deployment unit nào sở hữu".
 *
 * Mỗi app trong `apps/` có đúng một entry; `platform-deploy` là entry loại
 * `platform` (hạ tầng prerequisite chung, không owner app nào). `arch-check`
 * đối chiếu bản đồ này với ba nguồn trên workspace thật:
 *
 * 1. Danh sách thư mục `apps/` trên đĩa — app thiếu entry là lỗi.
 * 2. Project graph (`type:deployment` trong `deploys/`) — owner phải là một
 *    deployment project thật.
 * 3. Marker machine-readable `ecoma.deployment.status` trong `package.json`
 *    của từng deploy project — marker phải khớp status của entry mà deploy
 *    project đó sở hữu.
 *
 * Chỉ sửa bản đồ này khi ownership thay đổi thật; arch-check sẽ bắt mọi lệch
 * giữa bản đồ, marker và project graph. Xem `validateDeploymentMap` trong
 * `deployment-map-check.ts` và `docs/architecture/05-code-architecture.md` §2.1.
 *
 * Quy tắc cấu trúc: `apps/` chỉ chứa project có đường triển khai production —
 * bây giờ hoặc theo kế hoạch (status `implemented`/`scaffold` ở trên, tức có
 * entry trong bản đồ này). Project local-only/internal-only (shim, script nội
 * bộ, worker chỉ chạy trong topology local platform) sống ở `tools/` và KHÔNG
 * có entry ở đây — thêm một project như vậy vào `apps/` là lỗi cấu trúc, vì
 * bản đồ buộc mọi thư mục `apps/` phải có owner deployment hoặc `reason`
 * không-deploy, trong khi project internal-only không thuộc cả hai dạng đó.
 */

/** Status của một app trong bản đồ deployment. */
export type AppDeploymentStatus = 'implemented' | 'scaffold' | 'absorbed' | 'none';

/**
 * Entry của một app trong `apps/`.
 *
 * - `implemented` / `scaffold`: `owner` là deploy project provision runtime,
 *   và `deploys/<owner>/package.json` phải mang marker `ecoma.deployment.status`
 *   bằng đúng status này.
 * - `absorbed` / `none`: không có deploy project riêng (owner `null`), nên
 *   không có marker tương ứng — `reason` bắt buộc để người đọc biết vì sao.
 */
export interface AppDeploymentEntry {
  kind: 'app';
  /** Deploy project sở hữu app; `null` khi app không có deployment unit riêng. */
  owner: string | null;
  status: AppDeploymentStatus;
  /** Bắt buộc khi `absorbed`/`none`; giải thích vì sao app không sở hữu deploy project. */
  reason?: string;
}

/**
 * Entry của `platform-deploy`: hạ tầng prerequisite dùng chung cho mọi deploy
 * unit, không phải owner của app nào — nên nó không nằm trong quy tắc
 * reverse-ownership (mọi deploy project khác phải sở hữu ít nhất một app).
 */
export interface PlatformDeploymentEntry {
  kind: 'platform';
  reason: string;
}

export type DeploymentMapEntry = AppDeploymentEntry | PlatformDeploymentEntry;

/** Khóa bản đồ của entry platform — giữ cùng giá trị với `PLATFORM_DEPLOY_PROJECT`. */
const PLATFORM_DEPLOY_PROJECT_KEY = 'platform-deploy';

/** Bản đồ canonical: 12 app + 1 entry platform. Không thêm entry nào khác. */
export const DEPLOYMENT_MAP: Readonly<Record<string, DeploymentMapEntry>> = {
  account: { kind: 'app', owner: 'account-deploy', status: 'implemented' },
  auth: { kind: 'app', owner: 'auth-deploy', status: 'implemented' },
  // Cron Worker chạy hoàn toàn qua wrangler (không có resource Pulumi nào),
  // nên không có deploy project nào provision nó.
  'auth-nonce-prune-job': {
    kind: 'app',
    owner: null,
    status: 'none',
    reason: 'cron Worker, wrangler-only deployment; no Pulumi project owns it',
  },
  backoffice: { kind: 'app', owner: 'backoffice-deploy', status: 'implemented' },
  home: { kind: 'app', owner: 'home-deploy', status: 'implemented' },
  'pact-broker-api': { kind: 'app', owner: 'pact-broker-api-deploy', status: 'scaffold' },
  'pact-broker-app': { kind: 'app', owner: 'pact-broker-app-deploy', status: 'scaffold' },
  'push-notification': { kind: 'app', owner: 'push-notification-deploy', status: 'scaffold' },
  // Control plane của bounded context remote-cache (ADR-0015): skeleton P4.1,
  // deploy unit mới dựng cùng milestone (issue #442).
  'remote-cache': { kind: 'app', owner: 'remote-cache-deploy', status: 'scaffold' },
  'staff-access': { kind: 'app', owner: 'staff-access-deploy', status: 'scaffold' },
  'staff-access-relay': {
    kind: 'app',
    owner: null,
    status: 'none',
    reason: 'cron/queue Worker, wrangler-only deployment; no Pulumi project owns it',
  },
  'transactional-mail': { kind: 'app', owner: 'transactional-mail-deploy', status: 'scaffold' },
  'transactional-mailer-job': {
    kind: 'app',
    owner: 'transactional-mailer-job-deploy',
    status: 'scaffold',
  },
  'web-push-notification-job': {
    kind: 'app',
    owner: 'web-push-notification-job-deploy',
    status: 'scaffold',
  },
  // Entry platform duy nhất: prerequisite của mọi deploy unit, không owner app.
  [PLATFORM_DEPLOY_PROJECT_KEY]: {
    kind: 'platform',
    reason: 'prerequisite infrastructure shared by every deploy unit; owns no app',
  },
};

/**
 * Allowlist cho lượt kiểm invalid target reference: một đường dẫn repo được
 * tham chiếu từ `command` của nx target nhưng không tồn tại trên đĩa.
 *
 * Mỗi entry PHẢI có `reason`; reason ghi rõ việc dọn dẹp thuộc phase nào, để
 * allowlist là trạng thái tạm thời có chủ đích chứ không phải bãi rác vĩnh viễn.
 * Entry không khớp tham chiếu hỏng nào trên cây sẽ bị arch-check báo
 * `stale-allowlist-entry` — dọn entry ngay khi target nó che bị xóa, không để
 * trước.
 */
export interface InvalidTargetAllowlistEntry {
  /** Đường dẫn tương đối so với repo root xuất hiện trong `command`. */
  ref: string;
  reason: string;
}

/**
 * Hiện tại MẢNG RỖNG: 7 target `deploy` trỏ `tools/delivery/src/deploy-gate.mts`
 * (file không tồn tại) đã bị xóa CÙNG entry allowlist che chúng trong Phase 3
 * của deployment graph normalization (#216), nên cây không còn dangling ref
 * nào. Export vẫn được giữ vì allowlist là cơ chế cho ref hỏng TƯƠNG LAI có
 * chủ đích — thêm entry mới thì phải kèm reason và entry đó phải khớp ít nhất
 * một ref hỏng thật trên cây, nếu không arch-check báo `stale-allowlist-entry`.
 */
export const knownInvalidTargets: readonly InvalidTargetAllowlistEntry[] = [];
