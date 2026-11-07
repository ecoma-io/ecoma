/**
 * Ghim workspace thuộc đúng một tenant, và mọi tra cứu workspace xuyên tenant
 * fail closed.
 */

import { describe, expect, it } from 'vitest';

import { createTenantId, createWorkspaceId, type WorkspaceId } from './shared';
import {
  assertWorkspaceBelongsToTenant,
  createWorkspace,
  findWorkspace,
  type Workspace,
} from './workspace';

const CREATED_AT = 1_775_000_000_000;

const acmeMain: Workspace = (() => {
  const result = createWorkspace({
    id: 'wsp_main',
    tenantId: 'tnt_acme',
    name: 'Main',
    createdAt: CREATED_AT,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

const otherMain: Workspace = (() => {
  const result = createWorkspace({
    id: 'wsp_main',
    tenantId: 'tnt_other',
    name: 'Main',
    createdAt: CREATED_AT,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

describe('workspace ownership', () => {
  it('binds every workspace to exactly one tenant', () => {
    expect(acmeMain.tenantId).toBe('tnt_acme');
    expect(Object.hasOwn(acmeMain, 'status')).toBe(false);
  });

  it('rejects a duplicate workspace id inside the same tenant', () => {
    expect(
      createWorkspace(
        { id: 'wsp_main', tenantId: 'tnt_acme', name: 'Other', createdAt: CREATED_AT },
        [acmeMain],
      ),
    ).toMatchObject({ ok: false, error: { code: 'duplicate_workspace_id' } });
  });

  it('rejects a mixed-tenant workspace set instead of guessing the tenant', () => {
    expect(
      createWorkspace({ id: 'wsp_new', tenantId: 'tnt_acme', name: 'New', createdAt: CREATED_AT }, [
        acmeMain,
        otherMain,
      ]),
    ).toMatchObject({ ok: false, error: { code: 'inconsistent_context' } });
  });

  it('does not let two tenants share one workspace row', () => {
    // Cùng `workspaceId` nhưng khác tenant: tra cứu phải trả đúng bản ghi của
    // tenant đang chọn và không thấy bản ghi của tenant kia.
    const found = findWorkspace(
      [acmeMain, otherMain],
      createTenantId('tnt_acme'),
      'wsp_main' as WorkspaceId,
    );
    expect(found).toBe(acmeMain);
    expect(
      findWorkspace([acmeMain], createTenantId('tnt_other'), 'wsp_main' as WorkspaceId),
    ).toBeUndefined();
  });
});

describe('cross-tenant reference rejection', () => {
  it('fails closed when the workspace belongs to another tenant', () => {
    expect(
      assertWorkspaceBelongsToTenant(
        [otherMain],
        createTenantId('tnt_acme'),
        createWorkspaceId('wsp_main'),
      ),
    ).toMatchObject({ ok: false, error: { code: 'workspace_not_in_tenant' } });
  });

  it('fails closed when the workspace does not exist at all', () => {
    expect(
      assertWorkspaceBelongsToTenant(
        [acmeMain],
        createTenantId('tnt_acme'),
        createWorkspaceId('wsp_ghost'),
      ),
    ).toMatchObject({ ok: false, error: { code: 'workspace_not_in_tenant' } });
  });

  it('accepts a workspace that belongs to the selected tenant', () => {
    const result = assertWorkspaceBelongsToTenant(
      [acmeMain],
      createTenantId('tnt_acme'),
      createWorkspaceId('wsp_main'),
    );
    expect(result).toMatchObject({ ok: true, value: { id: 'wsp_main', tenantId: 'tnt_acme' } });
  });
});
