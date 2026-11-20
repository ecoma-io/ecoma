import { describe, expect, it } from 'vitest';

import {
  assertCommitVerification,
  auditMembership,
  buildManifest,
  buildReleaseSubject,
  classifyChangedFiles,
  classifyEligibility,
  computeAllowlist,
  extractManifest,
  parseDryRun,
  parseJsonc,
  projectSlug,
  readBatchUnits,
  releaseBranchName,
  resolveBatch,
  validateManifestShape,
} from '../../scripts/release/release-pr.mjs';

/**
 * Pure logic của runner Release PR (#361): audit membership, bảng chọn batch
 * §7.2, allowlist metadata-only §7.3, manifest identity, và các fail-closed
 * check. Chuỗi REST (commit, ref dance, PR) là integration-level — chạy thật
 * trong Actions và được evidence post-merge cover; những gì spec này chấm là
 * mọi nhánh fail-closed mà runner có thể dừng run TRƯỚC khi ghi gì cả.
 */

describe('parseJsonc', () => {
  it('strips line comments but preserves URLs inside strings', () => {
    const parsed = parseJsonc(`{
      // first comment
      "endpoint": "https://api.example.com/v1", // trailing
      "nested": { "a": 1 }
    }`);

    expect(parsed).toEqual({ endpoint: 'https://api.example.com/v1', nested: { a: 1 } });
  });

  it('strips trailing commas the way the real deploy-eligibility.jsonc has them', () => {
    const parsed = parseJsonc(`{
      "projects": {
        "a": { "staging": "releaseable" }, // comment giữa chừng
        "b": { "staging": "excluded", "reason": "keep this, string, intact" },
      },
    }`);

    expect(parsed).toEqual({
      projects: {
        a: { staging: 'releaseable' },
        b: { staging: 'excluded', reason: 'keep this, string, intact' },
      },
    });
  });

  it('strips block comments and rejects unterminated input', () => {
    expect(parseJsonc('{ /* c1 */ "a": 1 }')).toEqual({ a: 1 });
    expect(() => parseJsonc('{"a": "unterminated')).toThrow('Unterminated string');
    expect(() => parseJsonc('{ /* unterminated')).toThrow('Unterminated block comment');
  });
});

describe('classifyEligibility', () => {
  const config = {
    schemaVersion: 1,
    rules: [{ match: '*-db', staging: 'excluded', reason: 'migration project' }],
    projects: {
      '@ecoma-io/home': { staging: 'releaseable' },
    },
  };

  it('prefers explicit entries over rules and classifies by rule otherwise', () => {
    const classified = classifyEligibility(['@ecoma-io/home', 'deploys/home-db'], config);

    expect(classified.get('@ecoma-io/home')).toEqual({ staging: 'releaseable' });
    expect(classified.get('deploys/home-db')).toEqual({
      staging: 'excluded',
      reason: 'migration project',
    });
  });

  it('blocks an unclassified project instead of skipping it silently', () => {
    expect(() => classifyEligibility(['@ecoma-io/mystery'], config)).toThrow(
      'Deploy eligibility is not classified for project @ecoma-io/mystery',
    );
  });

  it('rejects an unsupported schema version', () => {
    expect(() => classifyEligibility(['x'], { schemaVersion: 99 })).toThrow('schemaVersion');
  });
});

describe('resolveBatch — the 7.2 selection table', () => {
  const candidates = ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job'];
  const changes = { '@ecoma-io/home': 'no version plan change reached this project' };

  it('drops no-change projects with their reason when the request is empty', () => {
    const { batch, excluded, noOp } = resolveBatch({
      requested: [],
      candidates,
      changesByProject: changes,
    });

    expect(batch).toEqual(['@ecoma-io/auth-nonce-prune-job']);
    expect(excluded).toEqual([{ project: '@ecoma-io/home', reason: changes['@ecoma-io/home'] }]);
    expect(noOp).toBe(false);
  });

  it('reports a valid no-op when no project has changes and none requested', () => {
    const { batch, noOp } = resolveBatch({
      requested: [],
      candidates,
      changesByProject: { '@ecoma-io/home': 'x', '@ecoma-io/auth-nonce-prune-job': 'y' },
    });

    expect(batch).toEqual([]);
    expect(noOp).toBe(true);
  });

  it('fails closed when an explicitly requested project has nothing to release', () => {
    expect(() =>
      resolveBatch({ requested: ['@ecoma-io/home'], candidates, changesByProject: changes }),
    ).toThrow('@ecoma-io/home has nothing to release');
  });

  it('fails closed naming unknown and duplicate projects', () => {
    expect(() =>
      resolveBatch({ requested: ['@ecoma-io/nope'], candidates, changesByProject: {} }),
    ).toThrow('not in release.projects: @ecoma-io/nope');
    expect(() =>
      resolveBatch({
        requested: ['@ecoma-io/home', '@ecoma-io/home'],
        candidates,
        changesByProject: {},
      }),
    ).toThrow('Duplicate project');
  });

  it('keeps exactly the explicit list when every project has changes', () => {
    const { batch, excluded } = resolveBatch({
      requested: ['@ecoma-io/home'],
      candidates,
      changesByProject: {},
    });

    expect(batch).toEqual(['@ecoma-io/home']);
    expect(excluded).toEqual([]);
  });
});

describe('release identity', () => {
  it('builds one subject for a single project and for a batch', () => {
    expect(buildReleaseSubject([{ project: '@ecoma-io/home', version: '0.0.2' }])).toBe(
      'chore(release): release @ecoma-io/home 0.0.2',
    );
    expect(
      buildReleaseSubject([
        { project: '@ecoma-io/home', version: '0.1.0' },
        { project: '@ecoma-io/auth-nonce-prune-job', version: '0.0.2' },
      ]),
    ).toBe('chore(release): release @ecoma-io/home 0.1.0, @ecoma-io/auth-nonce-prune-job 0.0.2');
  });

  it('derives a deterministic branch name from the sorted batch slugs', () => {
    expect(releaseBranchName(['@ecoma-io/home'])).toBe('release/home');
    expect(releaseBranchName(['@ecoma-io/auth-nonce-prune-job', '@ecoma-io/home'])).toBe(
      'release/auth-nonce-prune-job+home',
    );
    expect(() => projectSlug('@ecoma-io/bad/slug!')).toThrow('safe slug');
  });
});

describe('metadata-only allowlist', () => {
  const allowlist = computeAllowlist(['apps/home']);
  const batchRoots = ['apps/home'];

  it('accepts a diff that only touches batch manifests and changelogs', () => {
    const files = ['apps/home/package.json', 'apps/home/CHANGELOG.md'];
    const { violations, missingManifest, missingChangelog } = classifyChangedFiles(
      files,
      allowlist,
      batchRoots,
    );

    expect(violations).toEqual([]);
    expect(missingManifest).toEqual([]);
    expect(missingChangelog).toEqual([]);
  });

  it('fails closed on a file outside the allowlist', () => {
    const { violations } = classifyChangedFiles(['apps/home/src/index.ts'], allowlist, batchRoots);

    expect(violations).toEqual(['apps/home/src/index.ts']);
  });

  it('separates a missing manifest (blocking) from a missing changelog (warning)', () => {
    const { missingManifest, missingChangelog } = classifyChangedFiles(
      ['apps/home/CHANGELOG.md'],
      allowlist,
      batchRoots,
    );

    expect(missingManifest).toEqual(['apps/home']);
    expect(missingChangelog).toEqual([]);
    const { missingChangelog: warned } = classifyChangedFiles(
      ['apps/home/package.json'],
      allowlist,
      batchRoots,
    );
    expect(warned).toEqual(['apps/home']);
  });
});

describe('manifest identity — the 2026-11-19 binding', () => {
  const units = [{ project: '@ecoma-io/home', version: '0.0.2' }];

  it('builds a manifest with all three identity fields present', () => {
    const manifest = buildManifest({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      batchRoots: ['apps/home'],
      units,
      sourceRunUrl: 'https://github.com/ecoma-io/ecoma/actions/runs/1',
    });

    expect(manifest.release_base_sha).toBe('a'.repeat(40));
    expect(manifest.head_sha).toBe('b'.repeat(40));
    // Phase B chưa build artifact: digest là null tường minh — field PHẢI có.
    expect(manifest.units).toEqual([
      { project: '@ecoma-io/home', version: '0.0.2', artifact_digest: null },
    ]);
    expect(validateManifestShape(manifest)).toEqual({ ok: true, missing: [] });
  });

  it('fails closed listing every missing field', () => {
    const missing = validateManifestShape({ spec: 1, units: [{ project: 'p', version: '1' }] });

    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain('release_base_sha (40-hex)');
    expect(missing.missing).toContain('head_sha (40-hex)');
    expect(missing.missing).toContain(
      'units[0].artifact_digest (key must exist; null until Phase C)',
    );
    expect(missing.missing).toContain('batch_roots (non-empty array of project roots)');
  });

  it('reports a primitive unit as missing fields instead of crashing on the in operator', () => {
    const missing = validateManifestShape({
      spec: 1,
      release_base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      batch_roots: ['apps/home'],
      units: ['garbage'],
    });

    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain(
      'units[0].artifact_digest (key must exist; null until Phase C)',
    );
  });

  it('rejects non-string batch_roots entries', () => {
    const missing = validateManifestShape({
      spec: 1,
      release_base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      batch_roots: [42],
      units: [{ project: 'p', version: '1', artifact_digest: null }],
    });

    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain('batch_roots (every entry must be a non-empty string)');
  });

  it('rejects a manifest without units, with a short SHA, or not an object', () => {
    expect(
      validateManifestShape({
        spec: 1,
        release_base_sha: 'a'.repeat(40),
        head_sha: 'b'.repeat(40),
        units: [],
      }).missing,
    ).toContain('units (non-empty array)');
    expect(
      validateManifestShape({
        spec: 1,
        release_base_sha: 'abc',
        head_sha: 'b'.repeat(40),
        units: units,
      }).missing,
    ).toContain('release_base_sha (40-hex)');
    expect(validateManifestShape(null).missing).toEqual(['manifest']);
  });

  it('extracts the manifest from the PR body and reports absence honestly', () => {
    const manifest = buildManifest({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      batchRoots: [],
      units,
    });
    const body = `prose\n\n\`\`\`release-manifest\n${JSON.stringify(manifest)}\n\`\`\`\ntrailer`;

    expect(extractManifest(body)).toEqual(manifest);
    expect(extractManifest('no block here')).toBeNull();
    expect(extractManifest('```release-manifest\nnot json\n```')).toBeNull();
  });
});

const readBatchUnitFile = (path) => {
  if (path === 'apps/home/package.json') return JSON.stringify({ version: '0.0.2' });
  if (path === 'apps/account/package.json') return JSON.stringify({ version: '1.4.0' });
  throw new Error(`unexpected path: ${path}`);
};

const readBatchUnitFileNoVersion = (path) => {
  if (path === 'apps/home/package.json') return JSON.stringify({ name: '@ecoma-io/home' });
  throw new Error(`unexpected path: ${path}`);
};

describe('readBatchUnits — the batch/roots zip', () => {
  it('maps each project to the version of the package.json at the same position', () => {
    expect(
      readBatchUnits(
        ['@ecoma-io/home', '@ecoma-io/account'],
        ['apps/home', 'apps/account'],
        readBatchUnitFile,
      ),
    ).toEqual([
      { project: '@ecoma-io/home', version: '0.0.2' },
      { project: '@ecoma-io/account', version: '1.4.0' },
    ]);
  });

  it('refuses to zip when batch and batchRoots lengths differ', () => {
    expect(() =>
      readBatchUnits(['@ecoma-io/home', '@ecoma-io/account'], ['apps/home'], readBatchUnitFile),
    ).toThrow(/length mismatch/u);
  });

  it('rejects a package.json without a valid version field', () => {
    expect(() =>
      readBatchUnits(['@ecoma-io/home'], ['apps/home'], readBatchUnitFileNoVersion),
    ).toThrow(/has no valid version field/u);
  });
});

describe('commit signature gate — the DISC3 path', () => {
  it('accepts exactly verified=true with reason=valid', () => {
    expect(() =>
      assertCommitVerification({ verification: { verified: true, reason: 'valid' } }),
    ).not.toThrow();
  });

  it('fails closed on unsigned commits and on any other reason', () => {
    expect(() =>
      assertCommitVerification({ verification: { verified: false, reason: 'unsigned' } }),
    ).toThrow('signature check failed');
    expect(() =>
      assertCommitVerification({ verification: { verified: true, reason: 'unknown' } }),
    ).toThrow('signature check failed');
    expect(() => assertCommitVerification({})).toThrow('signature check failed');
  });
});

describe('parseDryRun — nx release --dry-run classification', () => {
  it('collects the planned UPDATE files', () => {
    const parsed = parseDryRun(
      'UPDATE apps/home/package.json [dry-run]\nUPDATE apps/home/CHANGELOG.md [dry-run]\n',
    );

    expect(parsed.changed).toEqual(['apps/home/package.json', 'apps/home/CHANGELOG.md']);
    expect(parsed.reason).toBeUndefined();
  });

  it('gives the specific no-change reason from the version-plans message', () => {
    const parsed = parseDryRun('NX   No changes were detected within version plans\n');

    expect(parsed.changed).toEqual([]);
    expect(parsed.reason).toBe(
      'no version plan change reached this project since its last release',
    );
  });

  it('falls back to a generic reason for an unrecognized empty output', () => {
    expect(parseDryRun('')).toEqual({
      changed: [],
      reason: 'nx release reported no file changes for this project',
    });
  });
});

describe('auditMembership — the #360 equality contract', () => {
  const eligibility = {
    schemaVersion: 1,
    rules: [],
    projects: {
      '@ecoma-io/home': { staging: 'releaseable' },
      '@ecoma-io/auth-nonce-prune-job': { staging: 'releaseable' },
      '@ecoma-io/dx': { staging: 'excluded', reason: 'tooling' },
    },
  };

  it('passes when the staging releaseable set equals release.projects', () => {
    expect(() =>
      auditMembership({
        projects: ['@ecoma-io/auth-nonce-prune-job', '@ecoma-io/home'],
        eligibility,
        projectNames: ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job', '@ecoma-io/dx'],
      }),
    ).not.toThrow();
  });

  it('blocks on drift between the two lists', () => {
    expect(() =>
      auditMembership({
        projects: ['@ecoma-io/home'],
        eligibility,
        projectNames: ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job', '@ecoma-io/dx'],
      }),
    ).toThrow('Deploy eligibility drift');
  });
});
