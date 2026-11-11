/**
 * Membership policy: nạp + validate `config/membership-policy.json`, và định
 * nghĩa semantics loại trừ. Validation fail-closed: key lạ, type sai, thiếu
 * key đều là lỗi — pipeline không đoán policy.
 */

import { readFile } from 'node:fs/promises';

import type { NormalizedIssue, PolicyConfig } from './types.js';

/** Lý do một issue bị loại trừ khỏi desired membership. */
export type ExclusionReason = 'explicit' | 'bot-author' | 'title-prefix';

/** Policy file thiếu, JSON hỏng, hoặc vi phạm schema. */
export class PolicyValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid membership policy:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
    this.name = 'PolicyValidationError';
    this.problems = problems;
  }
}

const ROOT_KEYS: readonly string[] = ['projectNumber', 'exclusions'];
const EXCLUSION_KEYS: readonly string[] = ['issueNumbers', 'botAuthorSuffix', 'titlePrefixes'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((element) => isPositiveInteger(element));
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((element) => isNonEmptyString(element));
}

/**
 * Validate JSON thô thành PolicyConfig. Gom TẤT CẢ problem rồi ném một lần,
 * để người sửa policy thấy đầy đủ lỗi thay vì sửa-một-lỗi-chạy-lại.
 */
export function validatePolicy(raw: unknown): PolicyConfig {
  if (!isPlainObject(raw)) {
    throw new PolicyValidationError(['policy must be a JSON object']);
  }
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!ROOT_KEYS.includes(key)) {
      problems.push(
        `unknown key "${key}" at the policy root; allowed keys: ${ROOT_KEYS.join(', ')}`,
      );
    }
  }
  if (!isPositiveInteger(raw['projectNumber'])) {
    problems.push('"projectNumber" must be a positive integer');
  }
  const exclusions = raw['exclusions'];
  if (!isPlainObject(exclusions)) {
    problems.push('"exclusions" must be a JSON object');
  } else {
    for (const key of Object.keys(exclusions)) {
      if (!EXCLUSION_KEYS.includes(key)) {
        problems.push(
          `unknown key "${key}" inside "exclusions"; allowed keys: ${EXCLUSION_KEYS.join(', ')}`,
        );
      }
    }
    if (!isPositiveIntegerArray(exclusions['issueNumbers'])) {
      problems.push('"exclusions.issueNumbers" must be an array of positive integers');
    }
    if (!isNonEmptyString(exclusions['botAuthorSuffix'])) {
      problems.push('"exclusions.botAuthorSuffix" must be a non-empty string');
    }
    if (!isNonEmptyStringArray(exclusions['titlePrefixes'])) {
      problems.push('"exclusions.titlePrefixes" must be an array of non-empty strings');
    }
  }
  if (problems.length > 0) {
    throw new PolicyValidationError(problems);
  }
  // Sau validation ở trên, hình dạng đã đúng schema; xây lại object tường minh
  // thay vì cast để type nằm dưới cùng một nguồn sự thật với validator.
  return {
    projectNumber: raw['projectNumber'] as number,
    exclusions: {
      issueNumbers: (exclusions as Record<string, unknown>)['issueNumbers'] as number[],
      botAuthorSuffix: (exclusions as Record<string, unknown>)['botAuthorSuffix'] as string,
      titlePrefixes: (exclusions as Record<string, unknown>)['titlePrefixes'] as string[],
    },
  };
}

/** Nạp policy từ đường dẫn; lỗi đọc file/JSON đều quy về PolicyValidationError. */
export async function loadPolicy(path: string): Promise<PolicyConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyValidationError([`cannot read policy file "${path}": ${message}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new PolicyValidationError([`policy file "${path}" is not valid JSON`]);
  }
  return validatePolicy(raw);
}

/**
 * Semantics loại trừ. Issue bị loại khi: số nằm trong `issueNumbers`, HOẶC
 * `authorLogin` kết thúc bằng `botAuthorSuffix`, HOẶC `title` bắt đầu bằng một
 * prefix trong `titlePrefixes`. Trả về lý do đầu tiên khớp theo thứ tự
 * explicit → bot-author → title-prefix để kết quả luôn deterministic.
 */
export function exclusionReason(
  issue: NormalizedIssue,
  policy: PolicyConfig,
): ExclusionReason | null {
  if (policy.exclusions.issueNumbers.includes(issue.number)) {
    return 'explicit';
  }
  if (issue.authorLogin.endsWith(policy.exclusions.botAuthorSuffix)) {
    return 'bot-author';
  }
  for (const prefix of policy.exclusions.titlePrefixes) {
    if (issue.title.startsWith(prefix)) {
      return 'title-prefix';
    }
  }
  return null;
}
