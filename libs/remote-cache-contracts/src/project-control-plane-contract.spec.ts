import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PROJECT_CREDENTIAL_FIELDS,
  isRemoteCacheProjectName,
  PROJECT_LIST_DEFAULT_LIMIT,
  PROJECT_LIST_MAX_LIMIT,
  validateCreateRemoteCacheProjectRequest,
  validateRemoteCacheProject,
  validateRemoteCacheProjectListRequest,
  validateRemoteCacheProjectListResponse,
  type RemoteCacheControlPlaneRejectionReason,
  type RemoteCacheControlPlaneValidation,
  type RemoteCacheProject,
} from './project-control-plane-contract';

const VALID_PROJECT: RemoteCacheProject = {
  id: '0f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0a',
  tenant_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  name: 'orders-cache',
  created_at: '2026-10-31T00:00:00Z',
};

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result: RemoteCacheControlPlaneValidation<unknown>,
  reason: RemoteCacheControlPlaneRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('remote-cache project name', () => {
  it('accepts lowercase DNS-like labels', () => {
    expect(isRemoteCacheProjectName('a')).toBe(true);
    expect(isRemoteCacheProjectName('orders-cache')).toBe(true);
    expect(isRemoteCacheProjectName('c0ntract-c4ch3')).toBe(true);
    expect(isRemoteCacheProjectName('a'.repeat(64))).toBe(true);
  });

  it('rejects uppercase, leading-or-trailing dash, empty, and oversized names', () => {
    expect(isRemoteCacheProjectName('Orders')).toBe(false);
    expect(isRemoteCacheProjectName('-lead')).toBe(false);
    expect(isRemoteCacheProjectName('trail-')).toBe(false);
    expect(isRemoteCacheProjectName('')).toBe(false);
    expect(isRemoteCacheProjectName('a'.repeat(65))).toBe(false);
    expect(isRemoteCacheProjectName('has space')).toBe(false);
    expect(isRemoteCacheProjectName(null)).toBe(false);
    expect(isRemoteCacheProjectName(42)).toBe(false);
  });
});

describe('create-project request contract', () => {
  it('accepts a well-formed request and copies the scope list', () => {
    const result = validateCreateRemoteCacheProjectRequest({
      name: 'orders-cache',
      api_key_scopes: ['read', 'write'],
    });
    expect(result).toEqual({
      ok: true,
      payload: { name: 'orders-cache', api_key_scopes: ['read', 'write'], trusted_ci: false },
    });
  });

  it('rejects payloads missing a required field', () => {
    const result = validateCreateRemoteCacheProjectRequest({ name: 'x' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'api_key_scopes');

    const missingName = validateCreateRemoteCacheProjectRequest({ api_key_scopes: ['read'] });
    expect(missingName.ok).toBe(false);
    expectRejectedBy(missingName, 'invalid_payload', 'name');
  });

  it('rejects fields outside the contract, including a forced tenant_id', () => {
    const result = validateCreateRemoteCacheProjectRequest({
      name: 'x',
      api_key_scopes: ['read'],
      tenant_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'tenant_id');
  });

  it('rejects empty, duplicate, and out-of-vocabulary scope arrays', () => {
    const empty = validateCreateRemoteCacheProjectRequest({ name: 'x', api_key_scopes: [] });
    expect(empty.ok).toBe(false);
    expectRejectedBy(empty, 'invalid_scopes', 'non-empty');

    const duplicated = validateCreateRemoteCacheProjectRequest({
      name: 'x',
      api_key_scopes: ['read', 'read'],
    });
    expect(duplicated.ok).toBe(false);
    expectRejectedBy(duplicated, 'invalid_scopes', 'duplicate-free');

    const unknownToken = validateCreateRemoteCacheProjectRequest({
      name: 'x',
      api_key_scopes: ['admin'],
    });
    expect(unknownToken.ok).toBe(false);
    expectRejectedBy(unknownToken, 'invalid_scopes', '"read"/"write"');

    const notAnArray = validateCreateRemoteCacheProjectRequest({
      name: 'x',
      api_key_scopes: 'read',
    });
    expect(notAnArray.ok).toBe(false);
    expectRejectedBy(notAnArray, 'invalid_scopes', 'array');
  });

  it('rejects a name outside the DNS-like pattern', () => {
    const result = validateCreateRemoteCacheProjectRequest({
      name: 'Bad_Name',
      api_key_scopes: ['read'],
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_project_name', 'DNS-like');
  });

  it('accepts trusted_ci boolean and defaults to false', () => {
    const trusted = validateCreateRemoteCacheProjectRequest({
      name: 'orders-cache',
      api_key_scopes: ['read', 'write'],
      trusted_ci: true,
    });
    expect(trusted.ok).toBe(true);
    expect((trusted as { ok: true; payload: { trusted_ci: boolean } }).payload.trusted_ci).toBe(
      true,
    );

    const untrusted = validateCreateRemoteCacheProjectRequest({
      name: 'orders-cache',
      api_key_scopes: ['read'],
      trusted_ci: false,
    });
    expect(untrusted.ok).toBe(true);
    expect((untrusted as { ok: true; payload: { trusted_ci: boolean } }).payload.trusted_ci).toBe(
      false,
    );

    const absent = validateCreateRemoteCacheProjectRequest({
      name: 'orders-cache',
      api_key_scopes: ['read'],
    });
    expect(absent.ok).toBe(true);
    expect((absent as { ok: true; payload: { trusted_ci: boolean } }).payload.trusted_ci).toBe(
      false,
    );
  });

  it('rejects trusted_ci when not a boolean', () => {
    const result = validateCreateRemoteCacheProjectRequest({
      name: 'x',
      api_key_scopes: ['read'],
      trusted_ci: 'yes',
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'boolean');
  });
});

describe('project wire contract', () => {
  it('accepts a well-formed project entry', () => {
    expect(validateRemoteCacheProject(VALID_PROJECT)).toEqual({
      ok: true,
      payload: VALID_PROJECT,
    });
  });

  it('rejects entries carrying any forbidden credential field, naming only the field', () => {
    for (const field of FORBIDDEN_PROJECT_CREDENTIAL_FIELDS) {
      const result = validateRemoteCacheProject({ ...VALID_PROJECT, [field]: 'leak' });
      expect(result.ok).toBe(false);
      expectRejectedBy(result, 'forbidden_field', field);
    }
  });

  it('rejects entries missing a field', () => {
    const { name: _name, ...missingName } = VALID_PROJECT;
    const result = validateRemoteCacheProject(missingName);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_entry', 'name');

    const { id: _id, ...missingId } = VALID_PROJECT;
    const missingIdResult = validateRemoteCacheProject(missingId);
    expect(missingIdResult.ok).toBe(false);
    expectRejectedBy(missingIdResult, 'invalid_entry', 'id');
  });

  it('rejects fields outside the contract and non-object payloads', () => {
    const result = validateRemoteCacheProject({ ...VALID_PROJECT, extra: 1 });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'extra');

    const arrayResult = validateRemoteCacheProject([VALID_PROJECT]);
    expect(arrayResult.ok).toBe(false);
    expectRejectedBy(arrayResult, 'invalid_payload', 'object');

    const nullResult = validateRemoteCacheProject(null);
    expect(nullResult.ok).toBe(false);
    expectRejectedBy(nullResult, 'invalid_payload', 'object');
  });

  it('rejects malformed UUIDs and timestamps', () => {
    const badId = validateRemoteCacheProject({ ...VALID_PROJECT, id: 'not-a-uuid' });
    expect(badId.ok).toBe(false);
    expectRejectedBy(badId, 'invalid_entry', 'UUID');

    const badTenant = validateRemoteCacheProject({ ...VALID_PROJECT, tenant_id: '' });
    expect(badTenant.ok).toBe(false);
    expectRejectedBy(badTenant, 'invalid_tenant_id', 'UUID');

    const badTimestamp = validateRemoteCacheProject({
      ...VALID_PROJECT,
      created_at: '2026-10-31 00:00:00',
    });
    expect(badTimestamp.ok).toBe(false);
    expectRejectedBy(badTimestamp, 'invalid_entry', 'ISO 8601');
  });
});

describe('project list response contract', () => {
  it('accepts an empty page and a full page', () => {
    expect(validateRemoteCacheProjectListResponse({ projects: [], next_cursor: null })).toEqual({
      ok: true,
      payload: { projects: [], next_cursor: null },
    });
    const fullPage = Array.from({ length: PROJECT_LIST_MAX_LIMIT }, () => VALID_PROJECT);
    expect(
      validateRemoteCacheProjectListResponse({ projects: fullPage, next_cursor: 'next' }),
    ).toEqual({
      ok: true,
      payload: { projects: fullPage, next_cursor: 'next' },
    });
  });

  it('rejects oversized pages', () => {
    const oversized = Array.from({ length: PROJECT_LIST_MAX_LIMIT + 1 }, () => VALID_PROJECT);
    const result = validateRemoteCacheProjectListResponse({
      projects: oversized,
      next_cursor: null,
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', `${PROJECT_LIST_MAX_LIMIT}`);
  });

  it('rejects envelope fields outside the contract, such as a total count', () => {
    const result = validateRemoteCacheProjectListResponse({
      projects: [],
      next_cursor: null,
      total: 0,
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'total');
  });

  it('rejects a bad cursor shape and a bad entry inside the page', () => {
    const emptyCursor = validateRemoteCacheProjectListResponse({ projects: [], next_cursor: '' });
    expect(emptyCursor.ok).toBe(false);
    expectRejectedBy(emptyCursor, 'invalid_pagination', 'null or a non-empty string');

    const numericCursor = validateRemoteCacheProjectListResponse({
      projects: [VALID_PROJECT],
      next_cursor: 7,
    });
    expect(numericCursor.ok).toBe(false);
    expectRejectedBy(numericCursor, 'invalid_pagination', 'null or a non-empty string');

    const leakedEntry = validateRemoteCacheProjectListResponse({
      projects: [{ ...VALID_PROJECT, token: 'leak' }],
      next_cursor: null,
    });
    expect(leakedEntry.ok).toBe(false);
    expectRejectedBy(leakedEntry, 'forbidden_field', 'token');
  });
});

describe('project list request pagination', () => {
  it('applies the default limit and treats an empty cursor as the first page', () => {
    expect(validateRemoteCacheProjectListRequest({})).toEqual({
      ok: true,
      payload: { limit: PROJECT_LIST_DEFAULT_LIMIT, cursor: null },
    });
  });

  it('accepts an explicit limit inside the range together with a cursor', () => {
    expect(
      validateRemoteCacheProjectListRequest({ limit: PROJECT_LIST_MAX_LIMIT, cursor: 'token' }),
    ).toEqual({ ok: true, payload: { limit: PROJECT_LIST_MAX_LIMIT, cursor: 'token' } });
  });

  it('rejects a limit outside [1, MAX]', () => {
    const zero = validateRemoteCacheProjectListRequest({ limit: 0 });
    expect(zero.ok).toBe(false);
    expectRejectedBy(zero, 'invalid_pagination', '[1,');

    const over = validateRemoteCacheProjectListRequest({ limit: PROJECT_LIST_MAX_LIMIT + 1 });
    expect(over.ok).toBe(false);
    expectRejectedBy(over, 'invalid_pagination', '[1,');

    const fractional = validateRemoteCacheProjectListRequest({ limit: 1.5 });
    expect(fractional.ok).toBe(false);
    expectRejectedBy(fractional, 'invalid_pagination', 'integer');
  });

  it('rejects a non-string cursor', () => {
    const result = validateRemoteCacheProjectListRequest({ cursor: 5 });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_pagination', 'cursor token');
  });
});
