/**
 * Ghim vocabulary staff status va rang buoc terminal cua no o phia
 * `staff-access`, cung ghim su doi xung voi wire type cua contracts layer.
 *
 * ⚠️ Day la test cho **constraint type** o tang domain: staff status la truc
 * doc lap voi account status, `terminated` la terminal, va khong co policy
 * runtime nao (self-assignment, step-up, ...) song o lib thuan nay — policy
 * la viec cua tang application/service (SR-005, `01-architecture.md` §7).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STAFF_ACCESS_STAFF_STATUS,
  STAFF_ACCESS_STAFF_STATUSES,
  isStaffAccessStaffStatus,
  isTerminalStaffAccessStatus,
} from './staff-status';

describe('staff status vocabulary', () => {
  it('declares exactly the three proposed labels', () => {
    expect([...STAFF_ACCESS_STAFF_STATUSES].toSorted()).toEqual([
      'active',
      'suspended',
      'terminated',
    ]);
    expect(Object.keys(STAFF_ACCESS_STAFF_STATUS).length).toEqual(
      Object.values(STAFF_ACCESS_STAFF_STATUS).length,
    );
    expect(Object.values(STAFF_ACCESS_STAFF_STATUS)).toEqual([...STAFF_ACCESS_STAFF_STATUSES]);
  });

  it('declares the axis as separate from account status, which cannot be smeared to staff', () => {
    // 'deleted' KHONG la gia tri cua staff status: hai truc khac han
    // (`01-architecture.md` §4.2). Neu mot ngay account doi vocabulary, lib
    // nay phai khong bi keo theo.
    expect(STAFF_ACCESS_STAFF_STATUSES).not.toContain('deleted');
  });
});

describe('type guard', () => {
  it('accepts every declared label', () => {
    for (const status of STAFF_ACCESS_STAFF_STATUSES) {
      expect(isStaffAccessStaffStatus(status)).toBe(true);
    }
  });

  it('rejects account-only labels, core flags and non-strings', () => {
    expect(isStaffAccessStaffStatus('deleted')).toBe(false);
    expect(isStaffAccessStaffStatus('active ')).toBe(false);
    expect(isStaffAccessStaffStatus('Active')).toBe(false);
    expect(isStaffAccessStaffStatus(undefined)).toBe(false);
    expect(isStaffAccessStaffStatus(null)).toBe(false);
  });
});

describe('terminality of terminated', () => {
  it('marks only terminated as terminal among the three', () => {
    expect(isTerminalStaffAccessStatus('terminated')).toBe(true);
    expect(isTerminalStaffAccessStatus('active')).toBe(false);
    expect(isTerminalStaffAccessStatus('suspended')).toBe(false);
  });
  // ⚠️ Khong co transition `terminated → anything` o day, va cung khong can
  // exception: "khoi phuc membership la thao tac moi co audit" (`01` §4.2),
  // tuc mot thao tac INSERT moi (staff entry moi), khong phai transition trong
  // vocabulary nay. Module khong co ham nao chuyen terminal thanh duoc — do
  // chinh la security property duoc bao ve.
});

// ---------------------------------------------------------------------------
// Doi xung voi wire type cua contracts layer
// ---------------------------------------------------------------------------
//
// ⚠️ `type:domain` khong duoc import `type:contracts` (module boundary), nen
// tap nhan o hai lib phai doi xung bang doc file nguon cua producer — cung
// ky thuat ma `libs/backoffice-domain/src/account-id.spec.ts` dung de ghim
// entropy voi `libs/account-domain/src/subject.ts`. Lech tap nhan o bat ky
// ben nao thi test nay do TRUOC khi merge, khong doi runtime phat hien.

describe('parity with the staff-access contracts wire type', () => {
  const CONTRACTS_STAFF_STATUS_TS = resolve(
    import.meta.dirname,
    '../../../libs/staff-access-contracts/src/management-staff-contract.ts',
  );

  it('mirrors the STAFF_STATUSES wire list of @ecoma-io/staff-access-contracts', () => {
    const source = readFileSync(CONTRACTS_STAFF_STATUS_TS, 'utf8');
    const wireList = source.match(/export const STAFF_STATUSES = \[([^\]]+)\] as const;/u)?.[1];
    expect(wireList).toBeDefined();
    const wireLabels = (wireList ?? '')
      .split(',')
      .map((entry) => entry.trim().replaceAll("'", ''))
      .filter((entry) => entry.length > 0);

    expect([...STAFF_ACCESS_STAFF_STATUSES].toSorted()).toEqual(wireLabels.toSorted());
  });
});
