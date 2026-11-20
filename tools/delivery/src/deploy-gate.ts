/**
 * Cổng deploy duy nhất cho đường chạy trực tiếp — LỚP QUYẾT ĐỊNH (issue #362
 * slice A; hợp đồng `02-delivery.md` §7.4.3). Slice B (caller CLI/Nx target)
 * sẽ nối cổng này vào lệnh; slice này chỉ chốt allow/deny và lý do.
 *
 * Ngữ nghĩa fail-closed của cổng:
 * - `--lane` là tham số BẮT BUỘC, không có giá trị mặc định: `wrangler deploy`
 *   thiếu `--env` nhắm top-level Worker name — tên production của mọi app
 *   trong repo — nên một mặc định "tiện" ở đây chính là đường ghi đè
 *   production (§7.4.3). Thiếu lane là deny, không đoán.
 * - `production` bị từ chối thẳng thắn kèm chỉ dẫn tới vòng lifecycle
 *   promotion: bằng chứng staging, release identity và Environment approval
 *   là ba thứ một process trên máy người dùng không tự cấp.
 * - Project phải `releaseable` theo eligibility VÀ có trong
 *   `nx.json release.projects` — khai một phía là deny (`compareReleaseDeclarations`
 *   chốt drift ở lớp audit; cổng tự chặn per-unit).
 * - Unit identity (`stg-<name>`, tên Worker staging của unit) và ref SHA
 *   40-hex là readiness input bắt buộc; thiếu hoặc sai hình dạng là deny.
 *
 * Deny là DEFAULT: bất kỳ input thiếu/sai nào cho ra deny với lý do
 * machine-readable (`code`), không bao giờ default-allow. Cổng gom MỌI lý do
 * trong một lần evaluate để caller in đủ trạng thái, không chỉ lỗi đầu tiên.
 */

import { isFullCommitSha } from './staging-deploy.ts';
import { classifyWorkerName } from './worker-secrets.ts';
import type { EligibilityDecision } from './release-allowlist.ts';

/** Lane của đường chạy trực tiếp. */
export type DeployLane = 'staging' | 'production';

/** Input của cổng — mọi field trừ `project` đều có thể thiếu và thiếu là deny. */
export interface DeployGateInput {
  /** Nx project name của deploy unit được yêu cầu deploy. */
  project: string;
  /** Lane yêu cầu — bắt buộc tường minh, thiếu/sai là deny (§7.4.3). */
  lane?: string;
  /** Quyết định eligibility của `project` (từ release-allowlist.evaluateEligibility). */
  eligibility?: EligibilityDecision;
  /** Project có trong `nx.json → release.projects` không. */
  inReleaseProjects?: boolean;
  /** Unit identity `stg-<name>` (tên Worker staging của unit). */
  unitIdentity?: string;
  /** Ref SHA đầy đủ (40-hex) của revision sắp deploy. */
  refSha?: string;
}

/** Lý do deny machine-readable — caller in verbatim vào log/gate output. */
export interface DeployGateReason {
  code:
    | 'lane-missing'
    | 'lane-invalid'
    | 'production-lane-forbidden'
    | 'eligibility-missing'
    | 'project-unclassified'
    | 'project-not-releaseable'
    | 'not-in-release-projects'
    | 'unit-identity-missing'
    | 'unit-identity-invalid'
    | 'ref-sha-missing'
    | 'ref-sha-invalid';
  /** Thông điệp tiếng Anh — tooling phát verbatim vào log (language policy). */
  message: string;
}

/** Quyết định của cổng cho MỘT yêu cầu deploy. */
export interface DeployGateDecision {
  allowed: boolean;
  project: string;
  /** Lane đã chuẩn hoá — chỉ có khi lane hợp lệ. */
  lane?: DeployLane;
  /** Rỗng khi và chỉ khi `allowed` — mọi lý do deny được gom cùng lúc. */
  reasons: DeployGateReason[];
}

/**
 * Evaluate cổng cho một yêu cầu deploy. Hàm thuần, không đọc file, không gọi
 * wrangler: caller (slice B) đọc eligibility/config rồi đưa kết quả vào đây.
 * Gom mọi lý do deny trong MỘT lần chạy — lần đầu vấp lỗi cũng không giấu
 * các input sai còn lại.
 */
export function evaluateDeployGate(input: DeployGateInput): DeployGateDecision {
  const reasons: DeployGateReason[] = [];
  let lane: DeployLane | undefined;

  // Lane: bắt buộc tường minh, sai giá trị là deny — không có lane mặc định.
  if (input.lane === undefined || input.lane.trim().length === 0) {
    reasons.push({
      code: 'lane-missing',
      message:
        'lane is a required explicit parameter — a bare deploy without --lane would target ' +
        'the top-level worker name, which is the production identity (§7.4.3)',
    });
  } else if (input.lane !== 'staging' && input.lane !== 'production') {
    reasons.push({
      code: 'lane-invalid',
      message: `unknown lane "${input.lane}" — expected "staging" or "production"`,
    });
  } else {
    lane = input.lane;
    if (lane === 'production') {
      reasons.push({
        code: 'production-lane-forbidden',
        message:
          'the direct deploy path never targets production — promotion goes through the ' +
          'release lifecycle (staging evidence, release identity, Environment approval; §7.2)',
      });
    }
  }

  // Eligibility: phải có quyết định và quyết định phải là releaseable.
  if (input.eligibility === undefined) {
    reasons.push({
      code: 'eligibility-missing',
      message:
        'no eligibility decision was provided — the gate refuses to deploy a project whose ' +
        'classification it has not seen (fail closed)',
    });
  } else if (input.eligibility.project !== input.project) {
    reasons.push({
      code: 'project-unclassified',
      message: `eligibility decision is for project "${input.eligibility.project}", not "${input.project}"`,
    });
  } else if (input.eligibility.status !== 'releaseable') {
    reasons.push({
      code: 'project-not-releaseable',
      message:
        `project "${input.project}" is not staging-releaseable in deploy-eligibility.jsonc` +
        (input.eligibility.reason === undefined ? '' : `: ${input.eligibility.reason}`),
    });
  }

  // Membership release.projects: khai một phía là deny (§7.4.3).
  if (input.inReleaseProjects !== true) {
    reasons.push({
      code: 'not-in-release-projects',
      message:
        `project "${input.project}" is not confirmed in nx.json release.projects — a project ` +
        'declared on one side only must not pass (compareReleaseDeclarations blocks the audit; ' +
        'the gate blocks the unit)',
    });
  }

  // Unit identity `stg-<name>`: bắt buộc, đúng hình dạng identity staging.
  if (input.unitIdentity === undefined || input.unitIdentity.trim().length === 0) {
    reasons.push({
      code: 'unit-identity-missing',
      message:
        'no staging unit identity was provided — deploying without a confirmed `stg-<name>` ' +
        'identity could target the production worker (§6.12)',
    });
  } else if (classifyWorkerName(input.unitIdentity) !== 'staging') {
    reasons.push({
      code: 'unit-identity-invalid',
      message: `unit identity "${input.unitIdentity}" is not a staging identity (expected "stg-<name>")`,
    });
  }

  // Ref SHA: bằng chứng exact-SHA của lane — 40-hex đầy đủ (§7.3).
  if (input.refSha === undefined || input.refSha.trim().length === 0) {
    reasons.push({
      code: 'ref-sha-missing',
      message:
        'no ref SHA was provided — the lane proves exact-SHA (§7.3); a deploy without one ' +
        'has no identity to record evidence against',
    });
  } else if (!isFullCommitSha(input.refSha)) {
    reasons.push({
      code: 'ref-sha-invalid',
      message: `ref SHA "${input.refSha}" is not a full 40-hex commit SHA`,
    });
  }

  return { allowed: reasons.length === 0, project: input.project, lane, reasons };
}
