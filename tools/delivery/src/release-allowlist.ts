/**
 * Hợp đồng allowlist release/eligibility (issue #362 slice A; hợp đồng
 * `02-delivery.md` §7.2 điều 1–5, §7.5 mục 2):
 *
 * - Parse `config/deploy-eligibility.jsonc` NGHIÊM NGẶT: mọi field sai hình
 *   dạng là lỗi chặn với đúng tên field — không có `as` mù, không value mặc
 *   định ngầm (pattern `requireBoolean` của Pulumi config: bắt buộc typed
 *   value, fail loudly, không đoán).
 * - Evaluate một danh sách project ra quyết định per-project theo ngữ nghĩa
 *   #360: explicit entry trong `projects` thắng mọi rule; nếu không, rule
 *   ĐẦU TIÊN khớp áp dụng (`*` khớp substring bất kỳ); project không khớp gì
 *   là `unclassified` — lỗi chặn, không bao giờ là warning (§7.2: bỏ sót một
 *   project trong im lặng là đúng loại hỏng mà pipeline phải chặn).
 * - `compareReleaseDeclarations`: tập staging-`releaseable` PHẢI BẰNG
 *   `nx.json → release.projects` — hai nơi khai cùng một danh sách là hai
 *   nơi trôi lệch; lệch một phía (bỏ sót hoặc thừa, cả hai chiều) là lỗi chặn.
 *
 * Module là hàm thuần: caller (slice B — workflow caller/CLI) đọc file và
 * `stripJsoncComments` đã có của repo rồi đưa text vào đây. File JSONC hỏng
 * → throw với lý do; mọi thông điệp lỗi nói rõ "block", không suy hành vi.
 */

import { stripJsoncComments } from './worker-secrets.ts';

/** Trạng thái eligibility theo môi trường (quyết định #360 — environment-split). */
export type EligibilityStatus = 'releaseable' | 'excluded';

const ELIGIBILITY_STATUSES: readonly EligibilityStatus[] = ['releaseable', 'excluded'];

/** Phiên bản schema mà parser này hiểu; schema khác là lỗi chặn, không đoán. */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Một rule pattern có thứ tự — rule đầu tiên khớp là rule áp dụng. */
export interface EligibilityRule {
  match: string;
  staging: EligibilityStatus;
  reason: string;
}

/** Entry explicit của một project — thắng mọi rule. */
export interface ProjectEligibilityEntry {
  staging: EligibilityStatus;
  /** Bắt buộc khi `excluded` — mỗi project excluded một lý do riêng (§7.2). */
  reason?: string;
}

/** Shape schemaVersion 1 của deploy-eligibility.jsonc sau validate. */
export interface DeployEligibilityConfig {
  schemaVersion: number;
  production: { status: EligibilityStatus; reason: string };
  rules: EligibilityRule[];
  projects: Record<string, ProjectEligibilityEntry>;
}

/** Quyết định eligibility của MỘT project sau evaluate. */
export interface EligibilityDecision {
  project: string;
  status: EligibilityStatus;
  /** Nguồn của quyết định: entry explicit hoặc rule pattern khớp đầu tiên. */
  source: 'explicit' | 'rule';
  /** Pattern của rule khớp — chỉ có khi `source: 'rule'`. */
  pattern?: string;
  /** Lý do kèm quyết định (từ entry hoặc rule); có thể thiếu khi releaseable. */
  reason?: string;
}

// ---- Validation helpers: mỗi helper ném lỗi với đúng tên field — fail loudly.

function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `deploy-eligibility.jsonc: "${where}" must be an object — blocking, refusing to guess`,
    );
  }
  return value as Record<string, unknown>;
}

function expectStatus(value: unknown, where: string): EligibilityStatus {
  if (typeof value !== 'string' || !(ELIGIBILITY_STATUSES as readonly string[]).includes(value)) {
    throw new Error(
      `deploy-eligibility.jsonc: "${where}" must be one of ${ELIGIBILITY_STATUSES.join('|')}, ` +
        `got ${JSON.stringify(value) ?? 'undefined'} — blocking`,
    );
  }
  return value as EligibilityStatus;
}

function expectNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`deploy-eligibility.jsonc: "${where}" must be a non-empty string — blocking`);
  }
  return value;
}

/**
 * Parse text deploy-eligibility.jsonc (JSONC, comment/trailing comma đã xử lý
 * bởi bộ đọc JSONC của repo) thành config đã validate. Bất kỳ lệch schema
 * nào — sai schemaVersion, status ngoài vocabulary, rule thiếu reason,
 * entry `excluded` thiếu lý do — là lỗi chặn ngay lúc parse, trước khi bất
 * kỳ quyết định deploy nào được suy từ nó.
 */
export function parseDeployEligibility(text: string): DeployEligibilityConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsoncComments(text));
  } catch (error) {
    throw new Error(
      `deploy-eligibility.jsonc is not valid JSON(C): ` +
        `${error instanceof Error ? error.message : String(error)} — blocking`,
      { cause: error },
    );
  }
  const root = expectObject(raw, '(root)');

  const schemaVersion = root.schemaVersion;
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `deploy-eligibility.jsonc: "schemaVersion" must be ${SUPPORTED_SCHEMA_VERSION}, ` +
        `got ${JSON.stringify(schemaVersion) ?? 'undefined'} — this parser refuses a schema it does not know`,
    );
  }

  const productionRaw = expectObject(root.production, 'production');
  const production = {
    status: expectStatus(productionRaw.status, 'production.status'),
    reason: expectNonEmptyString(productionRaw.reason, 'production.reason'),
  };

  if (!Array.isArray(root.rules)) {
    throw new Error('deploy-eligibility.jsonc: "rules" must be an array — blocking');
  }
  const rules: EligibilityRule[] = root.rules.map((entry, index) => {
    const rule = expectObject(entry, `rules[${index}]`);
    return {
      match: expectNonEmptyString(rule.match, `rules[${index}].match`),
      staging: expectStatus(rule.staging, `rules[${index}].staging`),
      reason: expectNonEmptyString(rule.reason, `rules[${index}].reason`),
    };
  });

  const projectsRaw = expectObject(root.projects, 'projects');
  const projects: Record<string, ProjectEligibilityEntry> = {};
  for (const [project, entryRaw] of Object.entries(projectsRaw)) {
    // Key "//" là comment theo quy ước JSONC của repo — không phải project.
    if (project === '//') continue;
    const entry = expectObject(entryRaw, `projects["${project}"]`);
    const status = expectStatus(entry.staging, `projects["${project}"].staging`);
    if (status === 'excluded') {
      // Lý do là BẮT BUỘC cho excluded — "không ai nhớ" không được là trạng
      // thái mặc định (§7.2: mỗi project excluded một câu lý do riêng).
      const reason = expectNonEmptyString(entry.reason, `projects["${project}"].reason`);
      projects[project] = { staging: status, reason };
    } else {
      // releaseable: reason tùy chọn (hiện diện trong file là để giải thích, không bắt buộc).
      const reason =
        typeof entry.reason === 'string' && entry.reason.trim().length > 0
          ? entry.reason
          : undefined;
      projects[project] = { staging: status, reason };
    }
  }

  return { schemaVersion, production, rules, projects };
}

/**
 * Pattern khớp `project`: `*` khớp substring bất kỳ (kể cả rỗng), phần còn
 * lại khớp literal, neo cả hai đầu — `*-db` khớp chuỗi kết thúc bằng `-db`,
 * `@ecoma-io/*-domain` khớp prefix `@ecoma-io/` + đuôi `-domain`, `*` khớp
 * tất cả.
 */
export function matchEligibilityPattern(pattern: string, project: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(project);
}

/**
 * Evaluate một danh sách project theo ngữ nghĩa #360 (explicit > rule đầu
 * tiên khớp). Project không được entry nào và không khớp rule nào là
 * `unclassified` — ném lỗi chặn liệt kê ĐẦY ĐỦ các project đó: evaluate là
 * all-or-nothing, không trả về "kết quả một phần" cho một danh sách có
 * project chưa phân loại (§7.2 điều 4).
 */
export function evaluateEligibility(
  config: DeployEligibilityConfig,
  projects: readonly string[],
): EligibilityDecision[] {
  const unclassified: string[] = [];
  const decisions: EligibilityDecision[] = [];
  for (const project of projects) {
    const explicit = config.projects[project];
    if (explicit !== undefined) {
      decisions.push({
        project,
        status: explicit.staging,
        source: 'explicit',
        reason: explicit.reason,
      });
      continue;
    }
    const rule = config.rules.find((candidate) =>
      matchEligibilityPattern(candidate.match, project),
    );
    if (rule !== undefined) {
      decisions.push({
        project,
        status: rule.staging,
        source: 'rule',
        pattern: rule.match,
        reason: rule.reason,
      });
      continue;
    }
    unclassified.push(project);
  }
  if (unclassified.length > 0) {
    throw new Error(
      `deploy-eligibility.jsonc classifies none of: ${unclassified.join(', ')} — an ` +
        'unclassified project is a BLOCKING error, never a warning; silently skipping a ' +
        'project is the failure mode 7.2 forbids (§7.2 item 4)',
    );
  }
  return decisions;
}

/**
 * So tập staging-`releaseable` với `nx.json → release.projects` — hai danh
 * sách phải BẰNG NHAU, drift một phía nào (thừa bên eligibility, thiếu bên
 * eligibility) cũng là lỗi chặn kèm đúng tên project lệch (§7.2 điều 5,
 * `compareReleaseDeclarations` ở §7.4.3). Thêm một deploy unit = thêm nó vào
 * CẢ HAI; bỏ sót một thì audit đỏ, không phải deploy im lặng.
 */
export function compareReleaseDeclarations(
  releaseableProjects: readonly string[],
  nxReleaseProjects: readonly string[],
): void {
  const eligibility = new Set(releaseableProjects);
  const nxRelease = new Set(nxReleaseProjects);
  const onlyInEligibility = releaseableProjects.filter((project) => !nxRelease.has(project));
  const onlyInNxRelease = nxReleaseProjects.filter((project) => !eligibility.has(project));
  if (onlyInEligibility.length > 0 || onlyInNxRelease.length > 0) {
    const parts: string[] = [];
    if (onlyInEligibility.length > 0) {
      parts.push(
        `staging-releaseable in deploy-eligibility.jsonc but missing from nx.json release.projects: ` +
          onlyInEligibility.join(', '),
      );
    }
    if (onlyInNxRelease.length > 0) {
      parts.push(
        `listed in nx.json release.projects but not staging-releaseable in deploy-eligibility.jsonc: ` +
          onlyInNxRelease.join(', '),
      );
    }
    throw new Error(`release declaration drift — the two lists must be equal: ${parts.join('; ')}`);
  }
}
