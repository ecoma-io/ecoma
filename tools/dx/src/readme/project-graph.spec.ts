import { describe, expect, it } from 'vitest';

import {
  collectReadmeTargets,
  selectReadmeTargets,
  ReadmeGraphError,
  type NxGraphJson,
} from './project-graph.js';

const node = (root?: string): NxGraphJson['graph']['nodes'][string] => ({
  name: 'x',
  data: root === undefined ? {} : { root },
});

const graph = (nodes: Record<string, NxGraphJson['graph']['nodes'][string]>): NxGraphJson => ({
  graph: { nodes },
});

describe('selectReadmeTargets', () => {
  it('accepts a consistent workspace/project graph', () => {
    const targets = selectReadmeTargets(
      ['a', 'b'],
      graph({
        a: node('libs/a'),
        b: node('apps/b'),
      }),
    );

    expect(targets).toEqual([
      { name: 'a', root: 'libs/a' },
      { name: 'b', root: 'apps/b' },
    ]);
  });

  it('fails closed when a project is missing from the graph', () => {
    let thrown: unknown;
    try {
      selectReadmeTargets(['a', 'ghost'], graph({ a: node('libs/a') }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReadmeGraphError);
    expect((thrown as ReadmeGraphError).missingProjects).toEqual(['ghost']);
    expect((thrown as ReadmeGraphError).message).toContain('ghost');
  });

  it('fails closed when a project has no root in the graph', () => {
    let thrown: unknown;
    try {
      selectReadmeTargets(['a'], graph({ a: node(undefined) }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ReadmeGraphError);
    expect((thrown as ReadmeGraphError).message).toContain('a');
  });

  it('keeps nested project roots as separate targets', () => {
    // Project root là ancestor của project root khác: mỗi project có README
    // riêng ở root của nó, không dùng chung.
    const targets = selectReadmeTargets(
      ['parent', 'child'],
      graph({
        parent: node('parent'),
        child: node('parent/child'),
      }),
    );

    expect(targets).toEqual([
      { name: 'parent', root: 'parent' },
      { name: 'child', root: 'parent/child' },
    ]);
  });
});

describe('collectReadmeTargets (real Nx invocation)', () => {
  it('discovers every project of the real workspace with a non-empty root', () => {
    // Đây là kiểm duy nhất trong spec suite đụng vào Nx thật: hai subprocess
    // đọc-only cho TOÀN workspace, không spawn theo từng project. Nó là bằng
    // chứng cơ chế khám phá project hoạt động trên repo này; các kiểm còn
    // lại của readme-check dùng targets giả để không phụ thuộc trạng thái
    // workspace.
    const targets = collectReadmeTargets();

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.name).toBeTruthy();
      expect(target.root).toBeTruthy();
    }
    // Tên project không trùng lặp.
    const names = targets.map((target) => target.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
