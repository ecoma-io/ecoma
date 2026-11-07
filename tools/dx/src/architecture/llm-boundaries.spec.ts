import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KNOWN_SCOPES, type ArchProjectNode } from './arch-tags.js';
import {
  LLM_INTER_CONTEXT_EDGES,
  LLM_SCOPES,
  validateLlmBoundaries,
  validateLlmEdgeAllowlist,
} from './llm-boundaries.js';
import { ROOT_DIR } from '../utils.js';

const TENANT = '@ecoma-io/llm-seller-tenant-domain';
const GOVERNANCE = '@ecoma-io/llm-seller-governance-domain';
const MARKETPLACE = '@ecoma-io/llm-marketplace-domain';
const PRICING = '@ecoma-io/llm-seller-pricing-domain';
const CONSUMER_TENANT = '@ecoma-io/llm-consumer-tenant-domain';
const ROUTING = '@ecoma-io/llm-consumer-routing-domain';
const FINANCIAL = '@ecoma-io/llm-financial-domain';
const USAGE = '@ecoma-io/llm-usage-domain';

/** Node LLM domain: tag theo đúng scope thật của library. */
function llmNode(name: string, scope: string, deps: string[] = []): ArchProjectNode {
  return { name, tags: [`scope:${scope}`, 'type:domain', 'runtime:universal'], dependencies: deps };
}

/** Workspace đủ cả chín library để allowlist không bị báo stale. */
function fullWorkspace(overrides: ArchProjectNode[] = []): Map<string, ArchProjectNode> {
  const nodes: ArchProjectNode[] = [
    llmNode(CONSUMER_TENANT, 'llm-consumer'),
    llmNode(ROUTING, 'llm-consumer'),
    llmNode(TENANT, 'llm-seller'),
    llmNode(GOVERNANCE, 'llm-seller'),
    llmNode(MARKETPLACE, 'llm-seller'),
    llmNode(PRICING, 'llm-seller'),
    llmNode(FINANCIAL, 'llm-shared'),
    llmNode(USAGE, 'llm-shared'),
  ];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  for (const override of overrides) byName.set(override.name, override);
  return byName;
}

function violationsFor(source: ArchProjectNode): string[] {
  return validateLlmBoundaries(fullWorkspace([source]))
    .filter((v) => v.project === source.name)
    .map((v) => v.kind);
}

describe('LLM bounded-context boundaries', () => {
  it('allows the single declared inter-context edge', () => {
    expect(violationsFor(llmNode(GOVERNANCE, 'llm-seller', [TENANT]))).toEqual([]);
  });

  it('blocks the reverse edge from tenant to governance', () => {
    // ADR-0018: governance phụ thuộc tenant một chiều. Tenant import governance
    // sẽ tạo chu trình và biến authorization ladder thành consumer của
    // governance implementation.
    expect(violationsFor(llmNode(TENANT, 'llm-seller', [GOVERNANCE]))).toEqual([
      'cross-context-domain-edge',
    ]);
  });

  it('blocks marketplace importing governance implementation', () => {
    // Marketplace tiêu thụ eligibility verdict như giá trị khai báo tại biên;
    // import implementation là đọc thẳng evidence/restriction.
    expect(violationsFor(llmNode(MARKETPLACE, 'llm-seller', [GOVERNANCE]))).toEqual([
      'cross-context-domain-edge',
    ]);
  });

  it('blocks financial importing any seller context', () => {
    expect(violationsFor(llmNode(FINANCIAL, 'llm-shared', [TENANT]))).toEqual([
      'cross-context-domain-edge',
    ]);
    expect(violationsFor(llmNode(FINANCIAL, 'llm-shared', [GOVERNANCE]))).toEqual([
      'cross-context-domain-edge',
    ]);
    expect(violationsFor(llmNode(FINANCIAL, 'llm-shared', [PRICING]))).toEqual([
      'cross-context-domain-edge',
    ]);
  });

  it('blocks consumer contexts from importing seller contexts', () => {
    expect(violationsFor(llmNode(ROUTING, 'llm-consumer', [MARKETPLACE]))).toEqual([
      'cross-context-domain-edge',
    ]);
    expect(violationsFor(llmNode(CONSUMER_TENANT, 'llm-consumer', [TENANT]))).toEqual([
      'cross-context-domain-edge',
    ]);
  });

  it('blocks shared contexts from importing consumer contexts', () => {
    expect(violationsFor(llmNode(USAGE, 'llm-shared', [ROUTING]))).toEqual([
      'cross-context-domain-edge',
    ]);
  });

  it('ignores edges to projects outside the LLM domain scopes', () => {
    // Contract/shared/platform edge do constraint tag và contract-edge ownership
    // quyết định, không phải lượt này.
    const node = llmNode(MARKETPLACE, 'llm-seller', ['@ecoma-io/llm-marketplace-contracts']);
    const projects = fullWorkspace([node]);
    projects.set('@ecoma-io/llm-marketplace-contracts', {
      name: '@ecoma-io/llm-marketplace-contracts',
      tags: ['scope:llm-seller', 'type:contracts', 'runtime:universal'],
      dependencies: [],
    });
    expect(validateLlmBoundaries(projects)).toEqual([]);
  });

  it('reports a stale allowlist entry instead of passing silently', () => {
    // Một allowlist trỏ project không tồn tại là edge chết: nếu không báo, nó
    // che mất việc tên project đã đổi mà policy chưa cập nhật.
    const only = new Map([[GOVERNANCE, llmNode(GOVERNANCE, 'llm-seller')]]);
    expect(validateLlmEdgeAllowlist(only).map((v) => v.kind)).toEqual([
      'stale-llm-edge-allowlist-entry',
    ]);
    // Workspace đủ chín library thì không có entry chết.
    expect(validateLlmEdgeAllowlist(fullWorkspace())).toEqual([]);
  });

  it('keeps every allowlist entry inside the LLM scopes declared in ADR-0019', () => {
    for (const [from, to] of LLM_INTER_CONTEXT_EDGES) {
      expect(from.startsWith('@ecoma-io/llm-')).toBe(true);
      expect(to.startsWith('@ecoma-io/llm-')).toBe(true);
    }
    // `scope:llm` là giá trị duy nhất bị xoá; ba scope mới phải có mặt đồng thời
    // trong validator và trong .oxlintrc.json (test hai nguồn bằng một fixture).
    for (const scope of LLM_SCOPES) {
      expect(KNOWN_SCOPES).toContain(scope);
    }
    expect(KNOWN_SCOPES).not.toContain('llm');
  });

  it('declares one source-scope constraint per LLM scope in .oxlintrc.json', () => {
    const jsoncParse = createRequire(resolve(ROOT_DIR, 'node_modules/nx/package.json'))(
      'jsonc-parser',
    ).parse as (text: string) => {
      rules: Record<string, [number, { depConstraints?: unknown[] }]>;
    };
    const config = jsoncParse(readFileSync(resolve(ROOT_DIR, '.oxlintrc.json'), 'utf8'));
    const constraints = (config.rules['@nx/enforce-module-boundaries']?.[1]?.depConstraints ??
      []) as { sourceTag?: string; onlyDependOnLibsWithTags?: string[] }[];
    for (const scope of LLM_SCOPES) {
      const constraint = constraints.find((c) => c.sourceTag === `scope:${scope}`);
      expect(constraint, `scope:${scope} must have its own sourceTag constraint`).toBeDefined();
      // Mỗi scope LLM chỉ được phụ thuộc chính nó + nền tảng + contract, không
      // được trỏ chéo sang scope LLM khác.
      const crossScope = (constraint?.onlyDependOnLibsWithTags ?? []).filter(
        (t) => LLM_SCOPES.includes(t.slice('scope:'.length)) && t !== `scope:${scope}`,
      );
      expect(crossScope, `scope:${scope} must not allow other LLM scopes`).toEqual([]);
    }
    expect(constraints.some((c) => c.sourceTag === 'scope:llm')).toBe(false);
  });
});
