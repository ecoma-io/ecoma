/**
 * Ghim vocabulary staff status và ràng buộc terminal của nó.
 *
 * ⚠️ Đây là test cho **constraint type** ở tầng domain: staff status là trục độc
 * lập với account status, `terminated` là terminal, và không có policy runtime
 * nào (self-assignment, step-up, …) sống ở lib thuần này — policy là việc của
 * application/resource-owning backend (SR-005, `01-architecture.md` §7).
 */

import { describe, expect, it } from 'vitest';

import {
  BACKOFFICE_STAFF_STATUSES,
  BACKOFFICE_STAFF_STATUS,
  isBackofficeStaffStatus,
  isTerminalStaffStatus,
} from './staff-status';

describe('staff status vocabulary', () => {
  it('declares exactly the three proposed labels', () => {
    expect([...BACKOFFICE_STAFF_STATUSES].toSorted()).toEqual([
      'active',
      'suspended',
      'terminated',
    ]);
    expect(Object.keys(BACKOFFICE_STAFF_STATUS).length).toEqual(
      Object.values(BACKOFFICE_STAFF_STATUS).length,
    );
    expect(Object.values(BACKOFFICE_STAFF_STATUS)).toEqual([...BACKOFFICE_STAFF_STATUSES]);
  });

  it('declares the axis as separate from account status, which cannot be smeared to staff', () => {
    // 'deleted' KHÔNG là giá trị của staff status: hai trục khác hẳn
    // (`01-architecture.md` §4.2). Nếu một ngày account đổi vocabulary, lib này
    // phải không bị kéo theo.
    expect(BACKOFFICE_STAFF_STATUSES).not.toContain('deleted');
  });
});

describe('type guard', () => {
  it('accepts every declared label', () => {
    for (const status of BACKOFFICE_STAFF_STATUSES) {
      expect(isBackofficeStaffStatus(status)).toBe(true);
    }
  });

  it('rejects account-only labels, core flags and non-strings', () => {
    expect(isBackofficeStaffStatus('deleted')).toBe(false);
    expect(isBackofficeStaffStatus('active ')).toBe(false);
    expect(isBackofficeStaffStatus('Active')).toBe(false);
    expect(isBackofficeStaffStatus(undefined)).toBe(false);
    expect(isBackofficeStaffStatus(null)).toBe(false);
  });
});

describe('terminality of terminated', () => {
  it('marks only terminated as terminal among the three', () => {
    expect(isTerminalStaffStatus('terminated')).toBe(true);
    expect(isTerminalStaffStatus('active')).toBe(false);
    expect(isTerminalStaffStatus('suspended')).toBe(false);
  });
  // ⚠️ Không có transition `terminated → anything` ở đây, và cũng không cần
  // exception: "khôi phục membership là thao tác mới có audit" (`01` §4.2),
  // tức một thao tác INSERT mới (staff entry mới), không phải transition trong
  // vocabulary này. Module không có hàm nào chuyển terminal thành được — đó
  // chính là security property được bảo vệ.
});
