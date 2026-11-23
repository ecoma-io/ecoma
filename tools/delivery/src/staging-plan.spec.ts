import { describe, expect, it } from 'vitest';

import {
  planNxJsonPath,
  planStagingBatch,
  readNxReleaseProjects,
  type StagingPlanDeps,
} from './staging-plan.ts';
import { deployEligibilityPath } from './staging-deploy.ts';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const ELIGIBILITY_TEXT = `
// Inventory thật của repo: home releaseable, db project excluded khỏi lane app.
{
  "schemaVersion": 1,
  "production": { "status": "excluded", "reason": "promotion lane only" },
  "rules": [{ "match": "*", "staging": "excluded", "reason": "default closed" }],
  "projects": {
    "@ecoma-io/home": { "staging": "releaseable" },
    "@ecoma-io/auth-nonce-prune-job": { "staging": "releaseable" },
    "databases/account-db": { "staging": "excluded", "reason": "db infra migrates via db-migrate" },
    "@ecoma-io/*-domain": { "staging": "excluded", "reason": "domain libs do not deploy" }
  }
}
`;

const NX_JSON = JSON.stringify({
  release: { projects: ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job'] },
});

const HOME_PACKAGE = JSON.stringify({
  nx: { implicitDependencies: ['databases/account-db'] },
});
const PRUNE_PACKAGE = JSON.stringify({ name: '@ecoma-io/auth-nonce-prune-job' });

/** Deps giả: file map + danh sách project + affected set do test quyết định. */
function fakeDeps(
  files: Record<string, string>,
  workspace: string[],
  affected: string[],
): StagingPlanDeps {
  return {
    readTextFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file: ${path}`);
      return text;
    },
    listProjects: () => workspace,
    affectedProjects: (base, head) => {
      if (base !== BASE || head !== SHA) throw new Error(`unexpected base/head: ${base}..${head}`);
      return affected;
    },
  };
}

function happyDeps(affected: string[]): StagingPlanDeps {
  return fakeDeps(
    {
      [deployEligibilityPath()]: ELIGIBILITY_TEXT,
      [planNxJsonPath()]: NX_JSON,
      // Module đọc package.json theo đường TƯƠNG ĐỐI `apps/<slug>/package.json`.
      ['apps/home/package.json']: HOME_PACKAGE,
      ['apps/auth-nonce-prune-job/package.json']: PRUNE_PACKAGE,
    },
    [
      '@ecoma-io/home',
      '@ecoma-io/auth-nonce-prune-job',
      'databases/account-db',
      '@ecoma-io/account-domain',
    ],
    affected,
  );
}

describe('readNxReleaseProjects', () => {
  it('reads release.projects through the shared JSONC reader', () => {
    expect(
      readNxReleaseProjects('/repo/nx.json', fakeDeps({ '/repo/nx.json': NX_JSON }, [], [])),
    ).toEqual(['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job']);
  });

  it('fails closed when nx.json is not valid JSON(C)', () => {
    expect(() =>
      readNxReleaseProjects('/repo/nx.json', fakeDeps({ '/repo/nx.json': 'not json' }, [], [])),
    ).toThrowError(/nx\.json is not valid JSON/u);
  });

  it('fails closed when release.projects is not a string list', () => {
    expect(() =>
      readNxReleaseProjects(
        '/repo/nx.json',
        fakeDeps({ '/repo/nx.json': JSON.stringify({ release: { projects: 'home' } }) }, [], []),
      ),
    ).toThrowError(/release\.projects/u);
  });
});

describe('planStagingBatch', () => {
  it('maps the affected releaseable set into units with slug, config path and environment', () => {
    const plan = planStagingBatch({ deploySha: SHA, baseSha: BASE }, happyDeps(['@ecoma-io/home']));
    expect(plan.deploySha).toBe(SHA);
    expect(plan.units).toEqual([
      {
        project: '@ecoma-io/home',
        slug: 'home',
        configPath: 'apps/home/wrangler.jsonc',
        environment: 'staging-home',
      },
    ]);
    expect(plan.migrations).toEqual([]);
  });

  it('keeps non-releaseable and unrelated affected projects out of the batch', () => {
    const plan = planStagingBatch(
      { deploySha: SHA, baseSha: BASE },
      happyDeps(['@ecoma-io/home', 'databases/account-db', '@ecoma-io/account-domain']),
    );
    expect(plan.units.map((unit) => unit.project)).toEqual(['@ecoma-io/home']);
    expect(plan.affected).toContain('databases/account-db');
  });

  it('derives ONE migration step per consumed affected db project (§3a.1 edge)', () => {
    const plan = planStagingBatch(
      { deploySha: SHA, baseSha: BASE },
      happyDeps(['@ecoma-io/home', 'databases/account-db']),
    );
    expect(plan.migrations).toEqual([
      { dbProject: 'databases/account-db', target: 'db-migrate', units: ['@ecoma-io/home'] },
    ]);
  });

  it('migrates each affected db project exactly once even when several units consume it', () => {
    const deps = happyDeps([
      '@ecoma-io/home',
      '@ecoma-io/auth-nonce-prune-job',
      'databases/account-db',
    ]);
    // Cả hai unit khai cùng một db — step gom các unit lại nhưng không nhân bản.
    const shared: StagingPlanDeps = {
      ...deps,
      readTextFile: (path) =>
        path === 'apps/auth-nonce-prune-job/package.json' ? HOME_PACKAGE : deps.readTextFile(path),
    };
    const plan = planStagingBatch({ deploySha: SHA, baseSha: BASE }, shared);
    expect(plan.migrations).toEqual([
      {
        dbProject: 'databases/account-db',
        target: 'db-migrate',
        units: ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job'],
      },
    ]);
  });

  it('emits no migration step when the db project is not affected', () => {
    const plan = planStagingBatch({ deploySha: SHA, baseSha: BASE }, happyDeps(['@ecoma-io/home']));
    expect(plan.migrations).toEqual([]);
  });

  it('emits an empty valid plan when nothing releaseable is affected (§7.5 item 2)', () => {
    const plan = planStagingBatch(
      { deploySha: SHA, baseSha: BASE },
      happyDeps(['@ecoma-io/account-domain']),
    );
    expect(plan.units).toEqual([]);
    expect(plan.migrations).toEqual([]);
  });

  it('blocks on an unclassified workspace project — all-or-nothing (§7.5 item 2)', () => {
    const deps = happyDeps(['@ecoma-io/home']);
    // Bỏ rule catch-all để mystery-app THẬT SỰ không được phân loại.
    const noCatchAll: StagingPlanDeps = {
      ...deps,
      readTextFile: (path) =>
        path === deployEligibilityPath()
          ? ELIGIBILITY_TEXT.replace(
              '"rules": [{ "match": "*", "staging": "excluded", "reason": "default closed" }],',
              '"rules": [],',
            )
          : deps.readTextFile(path),
      listProjects: () => ['@ecoma-io/mystery-app'],
    };
    expect(() => planStagingBatch({ deploySha: SHA, baseSha: BASE }, noCatchAll)).toThrowError(
      /classifies none of: @ecoma-io\/mystery-app .*BLOCKING/u,
    );
  });

  it('blocks on release declaration drift in either direction (§7.2 item 5)', () => {
    const deps = happyDeps(['@ecoma-io/home']);
    const drifted: StagingPlanDeps = {
      ...deps,
      readTextFile: (path) =>
        path === planNxJsonPath()
          ? JSON.stringify({ release: { projects: ['@ecoma-io/home', '@ecoma-io/ghost'] } })
          : deps.readTextFile(path),
    };
    expect(() => planStagingBatch({ deploySha: SHA, baseSha: BASE }, drifted)).toThrowError(
      /release declaration drift .*@ecoma-io\/ghost/u,
    );
  });

  it('blocks on an unparseable eligibility inventory before any mapping', () => {
    const deps = happyDeps(['@ecoma-io/home']);
    const broken: StagingPlanDeps = {
      ...deps,
      readTextFile: (path) =>
        path === deployEligibilityPath() ? '{ "schemaVersion": 99 }' : deps.readTextFile(path),
    };
    expect(() => planStagingBatch({ deploySha: SHA, baseSha: BASE }, broken)).toThrowError(
      /schemaVersion/u,
    );
  });

  it('refuses a project whose slug cannot be derived safely', () => {
    const deps = happyDeps(['home/../etc']);
    // Inventory + nx.json + workspace list khớp nhau (drift check qua) — slug
    // check là chốt cần test.
    const aligned: StagingPlanDeps = {
      ...deps,
      listProjects: () => ['home/../etc', '@ecoma-io/auth-nonce-prune-job'],
      readTextFile: (path) => {
        if (path === deployEligibilityPath()) {
          return ELIGIBILITY_TEXT.replace(
            '"@ecoma-io/home": { "staging": "releaseable" }',
            '"home/../etc": { "staging": "releaseable" }',
          );
        }
        if (path === planNxJsonPath()) {
          // Khớp inventory để drift check qua — slug check là chốt cần test.
          return JSON.stringify({
            release: { projects: ['home/../etc', '@ecoma-io/auth-nonce-prune-job'] },
          });
        }
        return deps.readTextFile(path);
      },
    };
    expect(() => planStagingBatch({ deploySha: SHA, baseSha: BASE }, aligned)).toThrowError(
      /cannot derive a safe slug/u,
    );
  });
});
