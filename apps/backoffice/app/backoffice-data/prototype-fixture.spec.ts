import { describe, expect, it } from 'vitest';

import { PROTOTYPE_DATA } from './prototype-fixture';
import type { StaffMember } from './types';
import en from '../i18n/locales/en';

const ROLE_IDS = new Set(PROTOTYPE_DATA.roles.map((role) => role.id));
const PERMISSION_IDS = new Set(PROTOTYPE_DATA.permissions.map((permission) => permission.id));
const ACCOUNT_ID_RE = /^acct_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

function getNestedKey(tree: unknown, path: string): string | undefined {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    return (node as Record<string, unknown>)[segment];
  }, tree) as string | undefined;
}

describe('prototype data invariants', () => {
  it('has no unrestricted bypass role', () => {
    const allWildcard = PROTOTYPE_DATA.permissions.some((permission) => {
      if (permission.id.includes('*')) {
        return true;
      }
      return permission.domain === '*' || permission.action === '*';
    });
    expect(allWildcard).toBe(false);
  });

  it('does not expose admin/superadmin/owner role', () => {
    const forbidden = ['admin', 'superadmin', 'owner', 'root'];
    for (const role of PROTOTYPE_DATA.roles) {
      for (const term of forbidden) {
        expect(role.id).not.toContain(term);
      }
    }
  });

  it('staff members do not use email as identity and use valid account ids', () => {
    for (const member of PROTOTYPE_DATA.staff) {
      expect((member as Partial<StaffMember> & { email?: unknown }).email).toBeUndefined();
      expect(member.accountId).toMatch(ACCOUNT_ID_RE);
      expect(member.displayName.trim().length > 0).toBe(true);
      expect(['active', 'suspended', 'terminated']).toContain(member.status);
      expect(Array.isArray(member.roleIds)).toBe(true);
      for (const roleId of member.roleIds) {
        expect(ROLE_IDS.has(roleId)).toBe(true);
      }
    }
  });

  it('every role references only existing permissions and has finite set', () => {
    for (const role of PROTOTYPE_DATA.roles) {
      expect(role.permissionIds.length >= 1).toBe(true);
      for (const permissionId of role.permissionIds) {
        expect(PERMISSION_IDS.has(permissionId)).toBe(true);
      }
    }
  });

  it('no permission is a wildcard and every permission is well-formed', () => {
    for (const permission of PROTOTYPE_DATA.permissions) {
      expect(permission.id).toBe(`${permission.domain}.${permission.action}`);
      expect(permission.domain.length > 0).toBe(true);
      expect(permission.action.length > 0).toBe(true);
      expect(permission.domain).not.toBe('*');
      expect(permission.action).not.toBe('*');
      expect(permission.id).not.toMatch(/\*/u);
    }
  });

  it('catalog has display strings for every role in the fixture', () => {
    for (const role of PROTOTYPE_DATA.roles) {
      const name = getNestedKey(en, `roles.items.${role.id}.name`);
      const description = getNestedKey(en, `roles.items.${role.id}.description`);
      expect(typeof name).toBe('string');
      expect(name && name.trim().length > 0).toBe(true);
      expect(typeof description).toBe('string');
      expect(description && description.trim().length > 0).toBe(true);
    }
  });

  it('catalog has descriptions for every permission in the fixture', () => {
    for (const permission of PROTOTYPE_DATA.permissions) {
      const desc = getNestedKey(en, `permissions.items.${permission.domain}.${permission.action}`);
      expect(typeof desc).toBe('string');
      expect(desc && desc.trim().length > 0).toBe(true);
    }
  });

  it('fixture contains cases representing UI states (empty roleIds and terminated/suspended)', () => {
    expect(PROTOTYPE_DATA.staff.some((member) => member.roleIds.length === 0)).toBe(true);
    expect(PROTOTYPE_DATA.staff.some((member) => member.status === 'terminated')).toBe(true);
    expect(PROTOTYPE_DATA.staff.some((member) => member.status === 'suspended')).toBe(true);
  });
});
