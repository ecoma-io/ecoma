/**
 * Ghim invariant ownership của tenant: luôn có **đúng một** owner, không có
 * tenant ownerless, và owner là nguồn authority duy nhất (không phải grant,
 * không phải membership).
 *
 * Đây là test cho bất biến nghiệp vụ, không phải test getter: mỗi ca dưới đây
 * đỏ khi ai đó thêm một đường tạo tenant thiếu owner hoặc biến owner thành
 * collection.
 */

import { describe, expect, it } from 'vitest';

import { isTenantActorId, isTenantId, type TenantActorId } from './shared';
import { createTenant, isTenantOwner, isTenantName, type Tenant } from './tenant';

const CREATED_AT = 1_775_000_000_000;

function tenant(overrides: Partial<Parameters<typeof createTenant>[0]> = {}): Tenant {
  const result = createTenant({
    id: 'tnt_acme',
    name: 'Acme',
    owner: 'sub_alice',
    createdAt: CREATED_AT,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`fixture is invalid: ${result.error.code}`);
  }
  return result.value;
}

describe('tenant creation', () => {
  it('creates a tenant whose owner is exactly the account that created it', () => {
    const created = tenant();
    expect(created.owner).toBe('sub_alice');
    expect(isTenantOwner(created, 'sub_alice' as TenantActorId)).toBe(true);
  });

  it('cannot produce an ownerless tenant from any call shape', () => {
    // Mọi cách biểu diễn "không có owner" đều bị từ chối trước khi tenant tồn
    // tại. Không có overload nào nhận danh sách owner rỗng.
    for (const owner of [undefined, null, '', '   ', [], {}, 42]) {
      const result = createTenant({
        id: 'tnt_acme',
        name: 'Acme',
        owner,
        createdAt: CREATED_AT,
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_actor' } });
    }
  });

  it('does not carry a mutable lifecycle status (suspension is derived, legal lifecycle deferred)', () => {
    const created = tenant();
    // Không có cột `status`: một nguồn sự thật thứ hai cho "bị đình chỉ" hoặc
    // "đã xoá" không tồn tại để lệch với suspension record / quyết định pháp lý.
    expect(Object.hasOwn(created, 'status')).toBe(false);
    expect(Object.hasOwn(created, 'deletedAt')).toBe(false);
    expect(Object.hasOwn(created, 'archivedAt')).toBe(false);
  });

  it('freezes the created tenant so callers cannot hand back a second owner', () => {
    const created = tenant();
    expect(Object.isFrozen(created)).toBe(true);
    expect(() => {
      (created as { owner: string }).owner = 'sub_mallory';
    }).toThrow(TypeError);
    expect(isTenantOwner(created, 'sub_alice' as TenantActorId)).toBe(true);
  });

  it('rejects malformed identity, name and timestamp inputs', () => {
    expect(
      createTenant({ id: '', name: 'Acme', owner: 'sub_a', createdAt: CREATED_AT }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_tenant_id' } });
    expect(
      createTenant({ id: 'tnt_a', name: ' Acme ', owner: 'sub_a', createdAt: CREATED_AT }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_tenant_name' } });
    expect(
      createTenant({ id: 'tnt_a', name: 'Acme', owner: 'sub_a', createdAt: 1.5 }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_timestamp' } });
  });
});

describe('owner authority scope', () => {
  it('recognises the owner only on the tenant it belongs to', () => {
    const acme = tenant({ id: 'tnt_acme', owner: 'sub_alice' });
    const other = tenant({ id: 'tnt_other', owner: 'sub_bob' });
    // Cùng một `sub` không tự động là owner của tenant khác: không có global
    // owner role bypass tenant isolation.
    expect(isTenantOwner(acme, 'sub_alice' as TenantActorId)).toBe(true);
    expect(isTenantOwner(other, 'sub_alice' as TenantActorId)).toBe(false);
    expect(isTenantOwner(other, 'sub_bob' as TenantActorId)).toBe(true);
  });
});

describe('identity guards', () => {
  it('accepts opaque ids and rejects empty, padded or over-long values', () => {
    expect(isTenantId('tnt_acme')).toBe(true);
    expect(isTenantActorId('sub_alice')).toBe(true);
    expect(isTenantId('')).toBe(false);
    expect(isTenantId(' tnt_acme')).toBe(false);
    expect(isTenantActorId('a'.repeat(201))).toBe(false);
  });

  it('accepts a normal tenant name and rejects an empty one', () => {
    expect(isTenantName('Acme')).toBe(true);
    expect(isTenantName('')).toBe(false);
    expect(isTenantName(null)).toBe(false);
  });
});

describe('isTenantOwner — kernel invariant P3: shape guard before owner comparison', () => {
  it('returns false (never throws) for a malformed tenant even when owner matches', () => {
    // `tenant.owner === actor` đơn lẻ sẽ trả true cho bản ghi dưới đây, nhưng
    // invariant P3 của kernel yêu cầu kiểm tra hình dạng trước: id rỗng không
    // hợp lệ ⇒ không phải owned tenant hợp lệ ⇒ false, không ném.
    expect(
      isTenantOwner({ id: '', owner: 'sub_alice' } as Tenant, 'sub_alice' as TenantActorId),
    ).toBe(false);
    expect(
      isTenantOwner({ id: 'tnt_acme', owner: '' } as Tenant, 'sub_alice' as TenantActorId),
    ).toBe(false);
    expect(isTenantOwner(null as never, 'sub_alice' as TenantActorId)).toBe(false);
    expect(isTenantOwner(undefined as never, 'sub_alice' as TenantActorId)).toBe(false);
    expect(isTenantOwner({} as never, 'sub_alice' as TenantActorId)).toBe(false);
  });

  it('still compares owner for a well-formed tenant', () => {
    const created = tenant();
    expect(isTenantOwner(created, 'sub_alice' as TenantActorId)).toBe(true);
    expect(isTenantOwner(created, 'sub_mallory' as TenantActorId)).toBe(false);
  });
});
