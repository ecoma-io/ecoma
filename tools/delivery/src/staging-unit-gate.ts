/**
 * Cổng per-unit của job build coordinator staging (#362 slice B; hợp đồng
 * `02-delivery.md` §7.4.3): lớp QUYẾT ĐỊNH là `evaluateDeployGate` (slice A)
 * — module này là caller đọc input thật rồi đưa vào cổng, cộng thêm audit
 * resource bindings của lane staging (§9.1): bindings còn problem là deny,
 * không deploy tới khi sạch.
 *
 * Deny in machine-readable: CLI phát từng `reason.code`/`problem.kind` verbatim
 * rồi exit khác 0 — deny là default, không bao giờ default-allow. Eligibility
 * không đọc/evaluate được (file hỏng, project unclassified) là deny với lý do;
 * còn config wrangler hay nx.json không đọc được là blocking throw — không suy
 * hành vi từ dữ liệu thiếu.
 */

import {
  auditResourceBindings,
  type BindingAuditProblem,
  type ResourceBindingConfig,
} from './resource-bindings.ts';
import {
  parseDeployEligibility,
  evaluateEligibility,
  type EligibilityDecision,
} from './release-allowlist.ts';
import {
  evaluateDeployGate,
  type DeployGateDecision,
  type DeployGateReason,
} from './deploy-gate.ts';
import { deployEligibilityPath, type StagingDeployDeps } from './staging-deploy.ts';
import { planNxJsonPath, readNxReleaseProjects } from './staging-plan.ts';
import { parseWranglerConfig, stagingWorkerNameFromParsed } from './worker-secrets.ts';

/** Input gate của MỘT unit — ba tham số CLI bắt buộc. */
export interface StagingUnitGateInput {
  project: string;
  configPath: string;
  refSha: string;
}

/** Kết quả gate một unit — CLI in và map ra exit code. */
export interface StagingUnitGateResult {
  allowed: boolean;
  /** Quyết định của cổng deploy (mọi lý do deny gom một lần). */
  decision: DeployGateDecision;
  /** Problem bindings lane staging — rỗng khi sạch; không rỗng là deny. */
  bindingProblems: BindingAuditProblem[];
}

/**
 * Evaluate gate cho một unit bằng dữ liệu THẬT: eligibility inventory + nx.json
 * + wrangler config đọc từ disk. Throw ở input không đọc được (file hỏng là
 * blocking, không phải deny có lý do); trả decision + binding problems để
 * caller in đủ trạng thái.
 */
export function evaluateStagingUnitGate(
  input: StagingUnitGateInput,
  deps: Pick<StagingDeployDeps, 'readTextFile'>,
): StagingUnitGateResult {
  // Eligibility: evaluate ĐÚNG project này; unclassified là throw của
  // evaluateEligibility — map thành deny có code, giữ nguyên message chặn.
  let eligibility: EligibilityDecision | undefined;
  let eligibilityReason: DeployGateReason | undefined;
  try {
    const config = parseDeployEligibility(deps.readTextFile(deployEligibilityPath()));
    eligibility = evaluateEligibility(config, [input.project])[0];
  } catch (error) {
    eligibility = undefined;
    eligibilityReason = {
      code: 'project-unclassified',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const nxRelease = readNxReleaseProjects(planNxJsonPath(), deps);

  const configText = deps.readTextFile(input.configPath);
  const parsed = parseWranglerConfig(configText);
  // Unit identity thiếu (config không khai env.staging.name) là deny của cổng,
  // không phải throw — cổng gom lý do rồi in một lần.
  let unitIdentity: string | undefined;
  try {
    unitIdentity = stagingWorkerNameFromParsed(parsed);
  } catch {
    unitIdentity = undefined;
  }

  const decision = evaluateDeployGate({
    project: input.project,
    lane: 'staging',
    eligibility,
    inReleaseProjects: nxRelease.includes(input.project),
    unitIdentity,
    refSha: input.refSha,
  });
  if (eligibilityReason !== undefined) {
    decision.reasons.unshift(eligibilityReason);
    decision.allowed = false;
  }

  // Audit bindings lane staging trên CÙNG config đã parse — problem là deny.
  const bindingProblems = auditResourceBindings(
    parsed as unknown as ResourceBindingConfig,
    'staging',
  );

  return { allowed: decision.allowed && bindingProblems.length === 0, decision, bindingProblems };
}
