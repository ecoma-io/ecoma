import { describe, expect, it } from 'vitest';

import { buildObjectStorageEnvs } from './object-storage-env.js';

describe('buildObjectStorageEnvs', () => {
  it('builds the exact S3 env names the worker config reads, with a plain-HTTP internal endpoint', () => {
    const envs = buildObjectStorageEnvs({
      host: 'ecoma-object-store',
      port: 8333,
      bucket: 'remote-cache',
      accessKeyId: 'ecoma-remote-cache-local',
    });
    expect(envs).toEqual({
      S3_ENDPOINT: 'http://ecoma-object-store:8333',
      S3_BUCKET: 'remote-cache',
      S3_ACCESS_KEY_ID: 'ecoma-remote-cache-local',
    });
  });

  it('carries exactly the three non-secret keys and never a secret key', () => {
    const envs = buildObjectStorageEnvs({
      host: 'h',
      port: 1,
      bucket: 'b',
      accessKeyId: 'a',
    });
    expect(Object.keys(envs).toSorted()).toEqual(['S3_ACCESS_KEY_ID', 'S3_BUCKET', 'S3_ENDPOINT']);
    expect(Object.keys(envs)).not.toContain('S3_SECRET_ACCESS_KEY');
  });
});
