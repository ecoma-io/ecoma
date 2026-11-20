import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  auditResourceBindings,
  checkTopLevelReDeclaration,
  isPlaceholderIdentifier,
  type ResourceBindingConfig,
} from './resource-bindings.ts';
import { parseWranglerConfig } from './worker-secrets.ts';

/** Config fixture: một unit có đủ resource, khai lại đúng ở lane. */
function cleanConfig(): ResourceBindingConfig {
  return {
    d1_databases: [{ binding: 'DB_APP', database_id: 'd1-real-id' }],
    kv_namespaces: [{ binding: 'KV_APP', id: 'kv-real-id' }],
    hyperdrive: [{ binding: 'DB_HD', id: '11111111-2222-3333-4444-555555555555' }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'real-bucket' }],
    queues: { producers: [{ binding: 'QUEUE_SEND', queue: 'real-queue' }] },
    env: {
      staging: {
        d1_databases: [{ binding: 'DB_APP', database_id: 'd1-staging-id' }],
        kv_namespaces: [{ binding: 'KV_APP', id: 'kv-staging-id' }],
        hyperdrive: [{ binding: 'DB_HD', id: 'aaaa0000-0000-4000-8000-000000000001' }],
        r2_buckets: [{ binding: 'BUCKET', bucket_name: 'staging-bucket' }],
        queues: { producers: [{ binding: 'QUEUE_SEND', queue: 'staging-queue' }] },
      },
    },
  };
}

describe('isPlaceholderIdentifier', () => {
  it('flags missing, empty and all-zero ids as placeholders', () => {
    expect(isPlaceholderIdentifier(undefined)).toBe(true);
    expect(isPlaceholderIdentifier(123)).toBe(true);
    expect(isPlaceholderIdentifier('')).toBe(true);
    expect(isPlaceholderIdentifier('   ')).toBe(true);
    expect(isPlaceholderIdentifier('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isPlaceholderIdentifier('000')).toBe(true);
  });

  it('accepts real identifiers, including ids that merely contain zeros', () => {
    expect(isPlaceholderIdentifier('11111111-2222-3333-4444-555555555555')).toBe(false);
    expect(isPlaceholderIdentifier('aaaa0000-0000-4000-8000-000000000001')).toBe(false);
    expect(isPlaceholderIdentifier('real-bucket')).toBe(false);
  });
});

describe('checkTopLevelReDeclaration', () => {
  it('flags a top-level binding the lane does not re-declare', () => {
    const problems = checkTopLevelReDeclaration(
      { hyperdrive: [{ binding: 'DB_ACCOUNT', id: '11111111-2222-3333-4444-555555555555' }] },
      {},
      'staging',
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['top-level-not-redeclared']);
    expect(problems[0]).toMatchObject({ resource: 'hyperdrive', binding: 'DB_ACCOUNT' });
    expect(problems[0]?.message).toMatch(/does not inherit bindings/u);
  });

  it('reports the placeholder side of a top-level binding alongside the missing re-declaration', () => {
    // Đúng tìm thấy đã đo trên apps/account: hyperdrive top level vừa không
    // được khai lại vừa mang id toàn số 0 — cả hai vế đều là problem.
    const problems = checkTopLevelReDeclaration(
      { hyperdrive: [{ binding: 'DB_ACCOUNT', id: '00000000-0000-0000-0000-000000000000' }] },
      {},
      'staging',
    );
    expect(problems.map((problem) => problem.kind)).toEqual([
      'identifier-placeholder',
      'top-level-not-redeclared',
    ]);
  });

  it('accepts a top-level binding the lane re-declares in the same group', () => {
    const problems = checkTopLevelReDeclaration(
      { kv_namespaces: [{ binding: 'KV_APP', id: 'top-id' }] },
      { kv_namespaces: [{ binding: 'KV_APP', id: 'lane-id' }] },
      'production',
    );
    expect(problems).toEqual([]);
  });

  it('requires the re-declaration in the SAME resource group, not just any group', () => {
    const problems = checkTopLevelReDeclaration(
      { kv_namespaces: [{ binding: 'KV_APP', id: 'top-id' }] },
      { d1_databases: [{ binding: 'KV_APP', database_id: 'lane-id' }] },
      'staging',
    );
    expect(problems.map((problem) => problem.kind)).toEqual(['top-level-not-redeclared']);
  });

  it('flags a queue producer binding the lane does not re-declare', () => {
    const problems = checkTopLevelReDeclaration(
      { queues: { producers: [{ binding: 'SEND', queue: 'q' }] } },
      {},
      'staging',
    );
    expect(problems.map((problem) => problem.binding)).toEqual(['SEND']);
  });
});

describe('auditResourceBindings', () => {
  it('passes a config whose lane re-declares every top-level binding with real ids', () => {
    expect(auditResourceBindings(cleanConfig(), 'staging')).toEqual([]);
  });

  it('audits each lane independently — production problems do not leak into staging', () => {
    const config = cleanConfig();
    // env.production thiếu hoàn toàn: audit staging vẫn sạch, audit production
    // đỏ — khối lane thiếu cộng với mọi binding top level không được khai lại.
    expect(auditResourceBindings(config, 'staging')).toEqual([]);
    const productionKinds = auditResourceBindings(config, 'production').map((p) => p.kind);
    expect(productionKinds[0]).toBe('lane-env-missing');
    expect(productionKinds.slice(1)).toHaveLength(5);
    expect(productionKinds.slice(1).every((kind) => kind === 'top-level-not-redeclared')).toBe(
      true,
    );
  });

  it('flags a lane-declared entry whose identifier is a placeholder', () => {
    const config = cleanConfig();
    const env = config.env?.staging;
    if (env === undefined) throw new Error('fixture is missing env.staging');
    env.kv_namespaces = [{ binding: 'KV_APP', id: '00000000-0000-0000-0000-000000000000' }];
    const problems = auditResourceBindings(config, 'staging');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      kind: 'identifier-placeholder',
      resource: 'kv_namespaces',
      binding: 'KV_APP',
    });
  });

  it('flags a lane entry missing its required identifier field', () => {
    const config: ResourceBindingConfig = {
      env: { staging: { d1_databases: [{ binding: 'DB_APP' }] } },
    };
    const problems = auditResourceBindings(config, 'staging');
    expect(problems.map((problem) => problem.kind)).toEqual(['identifier-placeholder']);
    expect(problems[0]?.message).toContain('"database_id"');
  });

  it('fails closed on a malformed entry instead of skipping it', () => {
    const config: ResourceBindingConfig = {
      env: { staging: { kv_namespaces: ['not-an-object'] } },
    };
    const problems = auditResourceBindings(config, 'staging');
    expect(problems.map((problem) => problem.kind)).toEqual(['entry-shape-invalid']);
  });

  it('fails closed on a group declared with a wrong shape', () => {
    const config: ResourceBindingConfig = {
      env: { staging: { hyperdrive: { binding: 'DB_HD', id: 'x' } } },
    };
    const problems = auditResourceBindings(config, 'staging');
    expect(problems.map((problem) => problem.kind)).toEqual(['entry-shape-invalid']);
  });

  it('fails closed when the lane env block is not an object', () => {
    const config = { env: { staging: 'broken' } } as unknown as ResourceBindingConfig;
    const problems = auditResourceBindings(config, 'staging');
    expect(problems.map((problem) => problem.kind)).toEqual(['entry-shape-invalid']);
  });

  it('reports a missing lane env block as a problem (nothing may be inherited)', () => {
    const config: ResourceBindingConfig = { kv_namespaces: [] };
    const problems = auditResourceBindings(config, 'production');
    expect(problems.map((problem) => problem.kind)).toEqual(['lane-env-missing']);
  });

  it('throws when the config root is not an object at all', () => {
    expect(() =>
      auditResourceBindings('broken' as unknown as ResourceBindingConfig, 'staging'),
    ).toThrowError(/not an object.*blocking/u);
  });
});

describe('the committed apps/account/wrangler.jsonc contract (real file)', () => {
  // Hợp đồng §9.1 chốt bằng file thật: DB_ACCOUNT khai hyperdrive top level
  // với id placeholder toàn số 0, không env nào khai lại — bị chặn ở cả hai
  // lane cho tới khi provisioning điền id theo từng env.
  //
  // ⚠️ Strip hai pha ở spec (comment rồi trailing comma) thay vì
  // `stripJsoncComments`: bộ đọc dùng chung của repo quét MỘT lượt nên lookahead
  // của trailing comma không bỏ qua được comment nằm giữa dấu phẩy và `}`/`]` —
  // đúng hình dạng file `apps/account` có, khiến reader dùng chung từ chối
  // config này ("not valid JSON(C)"). Sửa reader là ngoài phạm vi slice này —
  // theo dõi riêng; helper dưới chỉ phục vụ spec đọc file thật.
  const configText = readFileSync(
    new URL('../../../apps/account/wrangler.jsonc', import.meta.url),
    'utf8',
  );
  const withoutComments = configText
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/gu, '$1');
  const config = parseWranglerConfig(withoutTrailingCommas) as unknown as ResourceBindingConfig;

  it.each(['staging', 'production'] as const)(
    'blocks the %s lane on the unre-declared and placeholder DB_ACCOUNT hyperdrive binding',
    (lane) => {
      const problems = auditResourceBindings(config, lane);
      const kinds = problems.map((problem) => problem.kind);
      expect(kinds).toContain('top-level-not-redeclared');
      expect(kinds).toContain('identifier-placeholder');
      const redeclaration = problems.find((problem) => problem.kind === 'top-level-not-redeclared');
      expect(redeclaration).toMatchObject({ resource: 'hyperdrive', binding: 'DB_ACCOUNT' });
    },
  );
});

describe('auditResourceBindings — null lane env block (fail closed, no crash)', () => {
  it('reports the malformed null lane block instead of crashing on it', () => {
    // `env: { staging: null }` từng xuyên qua điều kiện shape (typeof null
    // === 'object') và gán scope lane = null, làm audit crash khi đọc binding.
    // Phải là problem machine-readable, không phải throw.
    const config = {
      kv_namespaces: [{ binding: 'KV_APP', id: 'top-id' }],
      env: { staging: null },
    } as unknown as ResourceBindingConfig;
    const problems = auditResourceBindings(config, 'staging');
    expect(problems.map((problem) => problem.kind)).toEqual([
      'entry-shape-invalid',
      'top-level-not-redeclared',
    ]);
    expect(problems[0]?.message).toContain('env.staging');
  });
});
