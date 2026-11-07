/**
 * Unit test của lớp ánh xạ hàng DB ⇒ ảnh authorization (`queries.ts` — phần
 * JS thuần của module; câu SQL của cùng module được chạy thật ở suite
 * integration với PostgreSQL testcontainers). Hai bất biến ở đây là thứ mà
 * integration không ghim được vì nó dùng dữ liệu seed hợp lệ:
 *
 * 1. **Không lọc trong SQL, policy mới là nơi lọc** — hàng hết hạn/revoke phải
 *    đến được ảnh assignment **nguyên trạng** (kể cả `null`), nếu không policy
 *    mất đúng lý do `assignment_expired`/`assignment_revoked` khi phân loại.
 * 2. **Nhãn lạ không được coi là `active`** — `staff.status` viết tay sai trong
 *    DB phải trở thành `terminated` (deny), không phải fallback "tối ưu hoá"
 *    về active: một nhãn lạ là dữ liệu hỏng, và dữ liệu hỏng fail-closed.
 */

import { describe, expect, it } from 'vitest';
import type { PoolClient, QueryResult } from 'pg';

import { loadPrincipalAuthorization } from './queries';

/** Client giả — trả đúng shape `QueryResult` mà module map, không mở connection. */
function clientReturning(rows: Record<string, unknown>[]): PoolClient {
  return {
    query: async () =>
      ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] }) as QueryResult,
  } as unknown as PoolClient;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    permissions: ['staff.read'],
    valid_until: null,
    revoked_at: null,
    fetched_at: '2026-01-01T00:00:00Z',
    staff_status: 'active',
    ...overrides,
  };
}

describe('loadPrincipalAuthorization — row mapping', () => {
  it('returns an empty assignment set for an unknown sub (denied-by-default at the policy)', () => {
    // Staff row vắng ⇒ tập rỗng — KHÔNG phải lỗi, KHÔNG phải allow: `can()`
    // deny tập rỗng bằng `permission_not_granted`.
    return expect(loadPrincipalAuthorization(clientReturning([]), 'sub_x')).resolves.toEqual({
      assignments: [],
    });
  });

  it('maps snake_case columns to the GrantedAssignment shape with real Dates', async () => {
    const { assignments } = await loadPrincipalAuthorization(
      clientReturning([
        row({
          valid_until: '2026-06-01T00:00:00Z',
          revoked_at: '2026-02-01T00:00:00Z',
        }),
      ]),
      'sub_x',
    );

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toEqual({
      permissions: ['staff.read'],
      validUntil: new Date('2026-06-01T00:00:00Z'),
      revokedAt: new Date('2026-02-01T00:00:00Z'),
      fetchedAt: new Date('2026-01-01T00:00:00Z'),
      staffStatus: 'active',
    });
    expect(assignments[0]?.validUntil).toBeInstanceOf(Date);
    expect(assignments[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it('keeps expired and revoked windows in the snapshot instead of filtering them out', () => {
    // ⚠️ Read-time filter đúng thiết kế §4.6: lọc trong SQL (hoặc ở bước map)
    // là lặp logic của policy và làm mất đúng lý do `revoked`/`expired` —
    // policy phải tự thấy hai mốc này để phân loại denial.
    return expect(
      loadPrincipalAuthorization(
        clientReturning([
          row({
            valid_until: '2020-01-01T00:00:00Z',
            revoked_at: '2021-01-01T00:00:00Z',
          }),
        ]),
        'sub_x',
      ),
    ).resolves.toEqual({
      assignments: [
        {
          permissions: ['staff.read'],
          validUntil: new Date('2020-01-01T00:00:00Z'),
          revokedAt: new Date('2021-01-01T00:00:00Z'),
          fetchedAt: new Date('2026-01-01T00:00:00Z'),
          staffStatus: 'active',
        },
      ],
    });
  });

  it('maps a role with no permissions to an empty permission list, not null', () => {
    // Hàng mà `role_permissions` trống (`ARRAY_AGG … FILTER` trả NULL) được
    // COALESCE về `'{}'` — policy deny nó bằng `permission_not_granted`, nên
    // bước map không được biến `null` thành một exception.
    return expect(
      loadPrincipalAuthorization(clientReturning([row({ permissions: [] })]), 'sub_x'),
    ).resolves.toEqual({
      assignments: [expect.objectContaining({ permissions: [] })],
    });
  });
});

describe('loadPrincipalAuthorization — unknown staff status label', () => {
  it('treats an unreadable status as terminated instead of active', async () => {
    // ⚠️ Mutation evidence: bỏ `isBackofficeStaffStatus` (fallback về giá trị
    // raw) là test này đỏ — nhãn lạ viết tay trong DB (sai migration, gõ tay)
    // sẽ được coi như active, tức dữ liệu hỏng nới quyền thay vì fail-closed.
    const { assignments } = await loadPrincipalAuthorization(
      clientReturning([row({ staff_status: 'ACTIVE' })]),
      'sub_x',
    );

    expect(assignments[0]?.staffStatus).toBe('terminated');
  });

  it('treats an account-only status label as terminated too', async () => {
    // Hai trục độc lập: `deleted`/`suspended` của account không phải nhãn
    // của trục staff — không nhận diện chéo.
    const { assignments } = await loadPrincipalAuthorization(
      clientReturning([row({ staff_status: 'deleted' })]),
      'sub_x',
    );

    expect(assignments[0]?.staffStatus).toBe('terminated');
  });

  it('passes every declared staff status through unchanged', async () => {
    const statuses = ['active', 'suspended', 'terminated'] as const;

    for (const status of statuses) {
      const { assignments } = await loadPrincipalAuthorization(
        clientReturning([row({ staff_status: status })]),
        'sub_x',
      );
      expect(assignments[0]?.staffStatus, `status: ${status}`).toBe(status);
    }
  });
});
