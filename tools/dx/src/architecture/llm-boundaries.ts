/**
 * Ranh giới giữa các bounded context LLM **trong cùng một scope ownership**.
 *
 * ADR-0019 chia LLM domain library thành ba scope (`llm-consumer`,
 * `llm-seller`, `llm-shared`) và dùng tag để chặn phụ thuộc chéo phía. Tag
 * KHÔNG phân biệt bounded context bên trong một scope: `llm-marketplace-domain`
 * và `llm-seller-governance-domain` cùng mang `scope:llm-seller`, nên
 * `onlyDependOnLibsWithTags` cho chúng import lẫn nhau.
 *
 * Lượt kiểm này lấp đúng khoảng đó: nó làm việc trên project graph thật, đọc
 * tên project, và chỉ cho phép những cặp context đã được quyết định tường minh.
 * Mọi edge khác giữa hai project LLM khác context là vi phạm — fail-closed,
 * không dựa vào việc ai đó nhớ thêm rule khi tạo library mới.
 *
 * Bất biến:
 * 1. Chỉ cạnh có trong `LLM_INTER_CONTEXT_EDGES` mới được phép.
 * 2. Entry trong allowlist mà không còn project tương ứng là entry chết, phải
 *    xoá — cùng lý do với các stale-allowlist check khác trong `tools/dx`.
 */

import type { ArchProjectNode, ArchTagViolation } from './arch-tags.js';

/** Ba scope ownership của LLM domain library (ADR-0019). */
export const LLM_SCOPES: readonly string[] = ['llm-consumer', 'llm-seller', 'llm-shared'];

/**
 * Cạnh được phép giữa hai bounded context LLM khác nhau.
 *
 * `llm-seller-governance-domain` → `llm-seller-tenant-domain`: governance giữ
 * tham chiếu `SellerTenantId`/`MembershipId` và đọc tenant/membership để đánh
 * giá restriction và appeal (ADR-0018). Chiều ngược lại bị cấm.
 *
 * Không có cặp nào khác. Đặc biệt:
 * - Marketplace tiêu thụ eligibility verdict như giá trị khai báo tại biên, nên
 *   không có cạnh tới governance.
 * - Financial tiêu thụ restriction/eligibility verdict và legal/tax profile qua
 *   hợp đồng, nên không có cạnh tới Seller context nào.
 * - Consumer context không có cạnh tới Seller context, và Routing không import
 *   Tenant: alias/policy là dữ liệu, tenant là ownership khác.
 */
export const LLM_INTER_CONTEXT_EDGES: readonly (readonly [string, string])[] = [
  ['@ecoma-io/llm-seller-governance-domain', '@ecoma-io/llm-seller-tenant-domain'],
];

/**
 * Scope ownership của một LLM **domain** project, hoặc `undefined`.
 *
 * Chỉ `type:domain` mới thuộc lượt này: contract/shared/platform của cùng một
 * scope là lối đi hợp lệ do tag và contract-edge ownership quy định, không phải
 * một cạnh xuyên bounded context.
 */
function llmScopeOf(project: ArchProjectNode): string | undefined {
  if (!project.tags.includes('type:domain')) return undefined;
  for (const tag of project.tags) {
    if (!tag.startsWith('scope:')) continue;
    const value = tag.slice('scope:'.length);
    if (LLM_SCOPES.includes(value)) return value;
  }
  return undefined;
}

/**
 * Entry allowlist trỏ tới project không tồn tại.
 *
 * Tách khỏi lượt edge vì nó chỉ có nghĩa trên workspace THẬT: state tổng hợp
 * của unit test không chứa đủ project, nên chạy nó trong `validateArchitecture`
 * sẽ báo lỗi ảo cho mọi fixture. Cùng lý do `validateDeploymentMap` và
 * `validateTestTargets` chỉ được nối ở `main()`.
 */
export function validateLlmEdgeAllowlist(
  projects: Map<string, ArchProjectNode>,
): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  for (const [from, to] of LLM_INTER_CONTEXT_EDGES) {
    if (!projects.has(from) || !projects.has(to)) {
      violations.push({
        project: from,
        kind: 'stale-llm-edge-allowlist-entry',
        detail: `${from} -> ${to} names a project that does not exist in the workspace`,
      });
    }
  }
  return violations;
}

/**
 * Kiểm mọi cạnh giữa hai project LLM domain khác nhau.
 *
 * Cạnh tới project ngoài LLM (contracts, shared, platform, app) không thuộc
 * lượt này — chúng do `onlyDependOnLibsWithTags` và `validateContractEdgeOwnership`
 * quyết định.
 */
export function validateLlmBoundaries(projects: Map<string, ArchProjectNode>): ArchTagViolation[] {
  const violations: ArchTagViolation[] = [];
  const allowed = new Set(LLM_INTER_CONTEXT_EDGES.map(([from, to]) => `${from}->${to}`));

  for (const project of projects.values()) {
    const sourceScope = llmScopeOf(project);
    if (sourceScope === undefined) continue;
    for (const dep of project.dependencies) {
      const target = projects.get(dep);
      if (!target) continue;
      const targetScope = llmScopeOf(target);
      if (targetScope === undefined) continue;
      if (dep === project.name) continue; // self-edge không phải phụ thuộc liên context
      if (allowed.has(`${project.name}->${dep}`)) continue;
      // Cùng context nhưng khác project (hoặc allowlist chưa có) vẫn là vi phạm:
      // một bounded context chỉ nên có đúng một domain library.
      violations.push({
        project: project.name,
        kind: 'cross-context-domain-edge',
        detail:
          `${project.name} (scope:${sourceScope}) depends on ${dep} (scope:${targetScope}); ` +
          `allowed inter-context edges: ${LLM_INTER_CONTEXT_EDGES.map(([f, t]) => `${f} -> ${t}`).join(', ') || 'none'}`,
      });
    }
  }

  return violations;
}
