/**
 * Ghim vòng đời membership: provision tường minh, một membership active trên
 * `(tenant, actor)`, revoke là terminal cho bản ghi đó, provision lại tạo danh
 * tính mới, và membership của tenant này không bao giờ được đọc như membership
 * của tenant khác.
 */

import { describe, expect, it } from 'vitest';

import { createTenantId, type TenantActorId, type TenantId } from './shared';
import {
  findMembership,
  isMembershipStatus,
  isMembershipActive,
  provisionMembership,
  revokeMembership,
  type Membership,
} from './membership';

const CREATED_AT = 1_775_000_000_000;
const REVOKED_AT = CREATED_AT + 1_000;

function memberships(): Membership[] {
  const acme = provisionMembership({
    id: 'mbr_acme_alice',
    tenantId: 'tnt_acme',
    actor: 'sub_alice',
    createdAt: CREATED_AT,
  });
  const other = provisionMembership({
    id: 'mbr_other_alice',
    tenantId: 'tnt_other',
    actor: 'sub_alice',
    createdAt: CREATED_AT,
  });
  if (!acme.ok || !other.ok) {
    throw new Error('fixture is invalid');
  }
  return [acme.value, other.value];
}

describe('provisioning', () => {
  it('creates an active membership with its own identity and no role', () => {
    const [membership] = memberships();
    expect(membership?.status).toBe('active');
    expect(membership?.id).toBe('mbr_acme_alice');
    // Permission đến từ grant trực tiếp, không từ role trên membership.
    expect(Object.hasOwn(membership ?? {}, 'role')).toBe(false);
  });

  it('rejects provisioning a duplicate active membership for the same account', () => {
    const [membership] = memberships();
    const duplicate = provisionMembership(
      {
        id: 'mbr_acme_alice_second',
        tenantId: 'tnt_acme',
        actor: 'sub_alice',
        createdAt: CREATED_AT,
      },
      [membership as Membership],
    );
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'membership_already_active' } });
  });

  it('rejects reusing a membership identity already present in the tenant', () => {
    const [membership] = memberships();
    expect(
      provisionMembership(
        { id: 'mbr_acme_alice', tenantId: 'tnt_acme', actor: 'sub_bob', createdAt: CREATED_AT },
        [membership as Membership],
      ),
    ).toMatchObject({ ok: false, error: { code: 'duplicate_membership_id' } });
  });

  it('provisions a new membership with a new identity after revocation', () => {
    const [membership] = memberships();
    const revoked = revokeMembership({
      membership: membership as Membership,
      revokedAt: REVOKED_AT,
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) {
      throw new Error('fixture is invalid');
    }
    const reprovisioned = provisionMembership(
      {
        id: 'mbr_acme_alice_again',
        tenantId: 'tnt_acme',
        actor: 'sub_alice',
        createdAt: REVOKED_AT,
      },
      [revoked.value],
    );
    expect(reprovisioned.ok).toBe(true);
    if (!reprovisioned.ok) {
      throw new Error('fixture is invalid');
    }
    // Bản ghi cũ nằm lại làm lịch sử; bản mới là một danh tính khác. Nhờ đó
    // grant của lần cũ không áp cho lần mới.
    expect(reprovisioned.value.status).toBe('active');
    expect(reprovisioned.value.id).not.toBe(revoked.value.id);
  });

  it('fails closed when the existing set mixes tenants', () => {
    const set = memberships();
    const crossTenant = provisionMembership(
      { id: 'mbr_acme_bob', tenantId: 'tnt_acme', actor: 'sub_bob', createdAt: CREATED_AT },
      set,
    );
    expect(crossTenant).toMatchObject({ ok: false, error: { code: 'inconsistent_context' } });
  });

  it('allows the same sub to be a member of several tenants', () => {
    const set = memberships();
    expect(set).toHaveLength(2);
    expect(set.map((membership) => membership.tenantId).toSorted()).toEqual([
      'tnt_acme',
      'tnt_other',
    ]);
  });

  it('rejects malformed input instead of creating a partial membership', () => {
    expect(
      provisionMembership({ id: '', tenantId: 'tnt_acme', actor: 'sub_a', createdAt: CREATED_AT }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_membership_id' } });
    expect(
      provisionMembership({
        id: 'mbr_acme_a',
        tenantId: 'tnt_acme',
        actor: '',
        createdAt: CREATED_AT,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_actor' } });
    expect(
      provisionMembership({
        id: 'mbr_acme_a',
        tenantId: 'tnt_acme',
        actor: 'sub_a',
        createdAt: Number.NaN,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_timestamp' } });
  });
});

describe('revocation', () => {
  it('is terminal: a second revoke is rejected rather than rewriting the timestamp', () => {
    const [membership] = memberships();
    const first = revokeMembership({ membership: membership as Membership, revokedAt: REVOKED_AT });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error('fixture is invalid');
    }
    expect(
      revokeMembership({ membership: first.value, revokedAt: REVOKED_AT + 5_000 }),
    ).toMatchObject({ ok: false, error: { code: 'membership_already_revoked' } });
    expect(first.value.revokedAt).toBe(REVOKED_AT);
  });

  it('rejects a revocation timestamp before the membership was created', () => {
    const [membership] = memberships();
    expect(
      revokeMembership({ membership: membership as Membership, revokedAt: CREATED_AT - 1 }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_timestamp' } });
  });

  it('makes the revoked membership stop authorizing', () => {
    const [membership] = memberships();
    const revoked = revokeMembership({
      membership: membership as Membership,
      revokedAt: REVOKED_AT,
    });
    if (!revoked.ok) {
      throw new Error('fixture is invalid');
    }
    expect(isMembershipActive(revoked.value)).toBe(false);
  });
});

describe('tenant isolation of membership reads', () => {
  it('finds a membership only under the tenant that owns it', () => {
    const set = memberships();
    expect(
      findMembership(set, createTenantId('tnt_acme'), 'sub_alice' as TenantActorId),
    ).toBeDefined();
    // `sub_alice` là member của cả hai tenant, nhưng tra theo tenant luôn trả
    // đúng bản ghi của tenant đó — không có "membership đầu tiên".
    expect(
      findMembership(set, createTenantId('tnt_unknown'), 'sub_alice' as TenantActorId),
    ).toBeUndefined();
    expect(
      findMembership(set, createTenantId('tnt_acme'), 'sub_bob' as TenantActorId),
    ).toBeUndefined();
  });

  it('does not treat a foreign membership row as membership of the selected tenant', () => {
    const [acmeMembership] = memberships();
    const membershipOnAcme = acmeMembership as Membership;
    const mislabelled = { ...membershipOnAcme, tenantId: 'tnt_other' as TenantId };
    // Cùng actor, cùng trạng thái — nhưng khác tenant. Tra trên `tnt_acme` phải
    // không thấy gì thay vì tái dùng bản ghi của tenant khác.
    expect(
      findMembership([mislabelled], createTenantId('tnt_acme'), 'sub_alice' as TenantActorId),
    ).toBeUndefined();
  });

  it('returns nothing for an ambiguous set instead of picking one row', () => {
    const [membership] = memberships();
    const row = membership as Membership;
    // Hai membership active cho cùng `(tenant, actor)` là dữ liệu hỏng: chọn đại
    // một bản ghi sẽ khiến grant của bản còn lại có thể được tính. Fail closed.
    expect(
      findMembership(
        [row, { ...row, id: 'mbr_acme_alice_duplicate' as Membership['id'] }],
        createTenantId('tnt_acme'),
        'sub_alice' as TenantActorId,
      ),
    ).toBeUndefined();
  });

  it('rejects an unknown status label as not active', () => {
    expect(isMembershipStatus('active')).toBe(true);
    expect(isMembershipStatus('revoked')).toBe(true);
    expect(isMembershipStatus('owner')).toBe(false);
    expect(isMembershipStatus(null)).toBe(false);
  });
});
