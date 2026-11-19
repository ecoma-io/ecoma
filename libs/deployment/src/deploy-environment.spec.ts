/**
 * Spec khóa adapter seam environment + hợp đồng state isolation (`02-delivery.md`
 * §4.2, §7.4.1 — quyết định #345, delivery #367):
 *
 * 1. Hai environment (local/staging) đi qua MỘT lifecycle contract, chỉ khác
 *    nhau ở bốn chiều môi trường khai tường minh.
 * 2. Stack selection theo §7.4.1: local per-worktree trên `file://`, staging
 *    một stack per project (`staging`/`staging-candidate`) trên `s3://` R2.
 * 3. Tổ hợp stack↔backend sai bị TỪ CHỐI ngay tại chỗ chọn — một stack không
 *    bao giờ "mượn" backend của hệ kia, và `s3://` staging thiếu điều kiện R2
 *    (endpoint/region/s3ForcePathStyle=true) không được chạy.
 */

import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEPLOYMENT_ENVIRONMENT_IDS,
  DEPLOYMENT_LIFECYCLE_PHASES,
  STAGING_STATE_URL_ENV_KEY,
  deploymentEnvironmentAdapter,
  localDeploymentAdapter,
  resolveStagingStateUrl,
  stagingDeploymentAdapter,
  type DeploymentEnvironmentId,
  validateStackBackendPairing,
} from './deploy-environment.js';
import { worktreeNamespace } from './deploy-namespace.js';

/** Worktree root thật (đã tồn tại trên đĩa) để `resolveContext` normalize được. */
const THIS_DIR = dirname(import.meta.filename ?? '');
const PARENT_DIR = dirname(THIS_DIR);

const CANONICAL_STAGING_BACKEND =
  's3://ecoma-staging-state?endpoint=https://account-id.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true';

describe('deployment environment adapter seam', () => {
  it('exposes exactly the local and staging environments through the dispatch entry', () => {
    expect([...DEPLOYMENT_ENVIRONMENT_IDS]).toEqual(['local', 'staging']);
    expect(deploymentEnvironmentAdapter('local')).toBe(localDeploymentAdapter);
    expect(deploymentEnvironmentAdapter('staging')).toBe(stagingDeploymentAdapter);
  });

  it('carries the same shared lifecycle contract on both adapters', () => {
    // Cùng THAM CHIẾU: lifecycle là một hợp đồng duy nhất, không phải hai bản
    // khai riêng có thể trôi lệch giữa các lane.
    expect(localDeploymentAdapter.lifecycle).toBe(DEPLOYMENT_LIFECYCLE_PHASES);
    expect(stagingDeploymentAdapter.lifecycle).toBe(DEPLOYMENT_LIFECYCLE_PHASES);
    expect([...DEPLOYMENT_LIFECYCLE_PHASES]).toEqual(['preview', 'up', 'down']);
  });

  it('declares the four environment dimensions that differ between local and staging', () => {
    expect(localDeploymentAdapter).toMatchObject({
      environment: 'local',
      runtime: 'docker-wic',
      routing: 'traefik',
      namespaceMode: 'per-worktree',
      passphraseSource: 'worktree-file',
    });
    expect(stagingDeploymentAdapter).toMatchObject({
      environment: 'staging',
      runtime: 'cloudflare-workers',
      routing: 'workers-router',
      namespaceMode: 'fixed',
      passphraseSource: 'environment-secret-per-stack',
    });
  });

  it('rejects an environment id outside the seam', () => {
    // Lane production chưa thuộc seam (#367 non-goal) — dispatch phải fail thay vì trả adapter nào đó.
    expect(() => deploymentEnvironmentAdapter('production' as DeploymentEnvironmentId)).toThrow(
      /unknown deployment environment/u,
    );
  });
});

describe('stack selection per 02-delivery.md §7.4.1', () => {
  it('local selects one per-worktree stack on a file:// backend', () => {
    const selection = localDeploymentAdapter.stackSelection('platform-deploy', {
      worktreeRoot: THIS_DIR,
    });
    expect(selection.environment).toBe('local');
    expect(selection.stackName).toBe(`local-${worktreeNamespace(THIS_DIR)}`);
    expect(selection.fullStackRef).toBe(`organization/platform-deploy/${selection.stackName}`);
    expect(selection.backendUrl.startsWith('file://')).toBe(true);
    // Ổn định qua các lần gọi: cùng root là cùng stack, không sinh tên mới.
    expect(
      localDeploymentAdapter.stackSelection('platform-deploy', { worktreeRoot: THIS_DIR }),
    ).toEqual(selection);
  });

  it('maps two different worktree roots to two different local stacks', () => {
    const a = localDeploymentAdapter.stackSelection('platform-deploy', { worktreeRoot: THIS_DIR });
    const b = localDeploymentAdapter.stackSelection('platform-deploy', {
      worktreeRoot: PARENT_DIR,
    });
    expect(a.stackName).not.toBe(b.stackName);
  });

  it('staging selects one stack per project with the slot as the stack name', () => {
    const continuous = stagingDeploymentAdapter.stackSelection('account-deploy', {
      backendUrl: CANONICAL_STAGING_BACKEND,
    });
    expect(continuous.stackName).toBe('staging');
    expect(continuous.fullStackRef).toBe('organization/account-deploy/staging');
    const candidate = stagingDeploymentAdapter.stackSelection('account-deploy', {
      slot: 'staging-candidate',
      backendUrl: CANONICAL_STAGING_BACKEND,
    });
    expect(candidate.stackName).toBe('staging-candidate');
    expect(candidate.fullStackRef).toBe('organization/account-deploy/staging-candidate');
    // Candidate slot là stack của environment staging trên CÙNG backend —
    // isolation bằng state key, không phải backend hay environment thứ tư.
    expect(candidate.backendUrl).toBe(continuous.backendUrl);
  });
});

describe('state isolation contract — stack↔backend pairing', () => {
  it('accepts local on file://', () => {
    expect(() =>
      validateStackBackendPairing('local', 'file:///wt/.pulumi-local-state'),
    ).not.toThrow();
  });

  it('rejects local on an s3:// backend', () => {
    expect(() => validateStackBackendPairing('local', CANONICAL_STAGING_BACKEND)).toThrow(
      /local.*requires a file:\/\//u,
    );
  });

  it('rejects staging on a file:// backend', () => {
    expect(() => validateStackBackendPairing('staging', 'file:///wt/.pulumi-local-state')).toThrow(
      /staging.*requires an s3:\/\//u,
    );
  });

  it('accepts a canonical staging R2 backend URL', () => {
    expect(() => validateStackBackendPairing('staging', CANONICAL_STAGING_BACKEND)).not.toThrow();
  });

  it('rejects an s3:// staging backend missing endpoint, region or s3ForcePathStyle=true', () => {
    const badUrls = [
      's3://bucket',
      's3://bucket?region=auto&s3ForcePathStyle=true',
      's3://bucket?endpoint=https://account-id.r2.cloudflarestorage.com&s3ForcePathStyle=true',
      's3://bucket?endpoint=https://account-id.r2.cloudflarestorage.com&region=auto',
      's3://bucket?endpoint=https://account-id.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=false',
      's3://?endpoint=https://account-id.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true',
    ];
    for (const url of badUrls) {
      // Mọi lỗi pairing staging đều mở đầu bằng "staging backend URL" + URL bị lỗi.
      expect(() => validateStackBackendPairing('staging', url)).toThrow(/staging backend URL/u);
    }
  });

  it('rejects a backend value that is not a URL at all', () => {
    expect(() => validateStackBackendPairing('local', 'not-a-url')).toThrow(
      /not a valid backend URL/u,
    );
  });
});

describe('staging state backend resolution', () => {
  it('fails closed when the staging state URL variable is unset or empty', () => {
    expect(() => resolveStagingStateUrl({})).toThrow(new RegExp(STAGING_STATE_URL_ENV_KEY, 'u'));
    expect(() => resolveStagingStateUrl({ [STAGING_STATE_URL_ENV_KEY]: '' })).toThrow(
      new RegExp(STAGING_STATE_URL_ENV_KEY, 'u'),
    );
  });

  it('returns the configured staging state URL without rewriting it', () => {
    expect(resolveStagingStateUrl({ [STAGING_STATE_URL_ENV_KEY]: CANONICAL_STAGING_BACKEND })).toBe(
      CANONICAL_STAGING_BACKEND,
    );
  });
});
