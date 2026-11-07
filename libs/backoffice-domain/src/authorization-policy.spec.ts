/**
 * Ghim policy `can()` ở cả bốn nhánh deny + nhánh allow + marker `stale`.
 *
 * ⚠️ Đây là test cho policy THUẦN — fail-closed phải đỏ ngay khi ai đó thêm
 * nhánh allow ngầm (mutation evidence của AC: bỏ một lớp lọc dưới đây phải
 * làm test tương ứng đỏ, không phải xanh nhờ test khác).
 */

import { describe, expect, it } from 'vitest';

import type { GrantedAssignment } from './authorization-policy';
import { REVOCATION_FRESHNESS_TTL_SECONDS, can } from './authorization-policy';

const PERM = 'delivery.redrive';

/** Mốc thời gian cố định — domain không đọc đồng hồ nên caller truyền. */
const NOW = new Date('2026-11-01T12:00:00.000Z');

/** Mốc fetch = now — dữ liệu vừa đọc, mặc định không stale (true nghĩa là STALE). */
function assignment(overrides: Partial<GrantedAssignment> = {}): GrantedAssignment {
  return {
    permissions: [PERM],
    validUntil: null,
    revokedAt: null,
    fetchedAt: NOW,
    staffStatus: 'active',
    ...overrides,
  };
}

describe('deny-by-default', () => {
  it('denies an empty assignment set with permission_not_granted', () => {
    expect(can(PERM, [], NOW)).toEqual({
      allowed: false,
      denial: 'permission_not_granted',
      stale: false,
      riskClass: 'normal',
    });
  });

  it('denies a permission the assignments do not grant', () => {
    const decision = can('other.action', [assignment({ permissions: ['delivery.restart'] })], NOW);
    expect(decision).toMatchObject({ allowed: false, denial: 'permission_not_granted' });
  });
});

describe('staff status gate (invariant 5)', () => {
  it('denies while staff is suspended even though the token would still be valid', () => {
    const decision = can(PERM, [assignment({ staffStatus: 'suspended' })], NOW);
    expect(decision).toMatchObject({ allowed: false, denial: 'staff_not_active' });
  });

  it('denies while staff is terminated', () => {
    const decision = can(PERM, [assignment({ staffStatus: 'terminated' })], NOW);
    expect(decision).toMatchObject({ allowed: false, denial: 'staff_not_active' });
  });

  it('denies an unreadable staff status label rather than treating it as active', () => {
    const decision = can(PERM, [assignment({ staffStatus: 'corrupt' as never })], NOW);
    expect(decision).toMatchObject({ allowed: false, denial: 'staff_not_active' });
  });

  it('denies when only one fetched snapshot shows a non-active status (stale wins)', () => {
    const decision = can(PERM, [assignment(), assignment({ staffStatus: 'terminated' })], NOW);
    expect(decision).toMatchObject({ allowed: false, denial: 'staff_not_active' });
  });
});

describe('assignment time window (read-time filter)', () => {
  it('denies an assignment whose valid_until has passed (AC-018)', () => {
    const decision = can(
      PERM,
      [assignment({ validUntil: new Date('2026-10-31T00:00:00.000Z') })],
      NOW,
    );
    expect(decision).toMatchObject({ allowed: false, denial: 'assignment_expired' });
  });

  it('denies an assignment revoked earlier and keeps a revoked reason over expiry', () => {
    // Cả revoked lẫn expired trong tập: revoked là dấu hiệu thu hồi có chủ
    // đích (T-05) nên reason ưu tiên nó — việc này dễ bỏ sót khi refactor
    // mảng lọc, nên ghim riêng.
    const decision = can(
      PERM,
      [
        assignment({ validUntil: new Date('2026-10-31T00:00:00.000Z') }),
        assignment({
          revokedAt: new Date('2026-10-30T00:00:00.000Z'),
        }),
      ],
      NOW,
    );
    expect(decision).toMatchObject({ allowed: false, denial: 'assignment_revoked' });
  });

  it('allows an assignment whose windows are still open even by one millisecond', () => {
    // Boundary: valid_until == now vẫn hết hạn (điều kiện là `>` ngoài).
    const decision = can(PERM, [assignment({ validUntil: NOW })], NOW);
    expect(decision.allowed).toBe(false);

    const oneMsAfter = new Date(NOW.getTime() + 1);
    expect(can(PERM, [assignment({ validUntil: oneMsAfter })], NOW).allowed).toBe(true);
  });

  it('does not let an unrelated revoked assignment mask an expired denial (S3)', () => {
    // S3 (issue #102): assignment của permission KHÁC bị revoke không phải là
    // bằng chứng về permission đang hỏi. Trước fix, `can()` quét
    // `assignments.some(a => a.revokedAt !== null)` trên TOÀN tập nên denial
    // `assignment_expired` của permission này bị ghi nhầm thành
    // `assignment_revoked` — hai sự kiện khác nhau bị trộn làm một, và cơ chế
    // điều tra đọc sai nguyên nhân.
    const decision = can(
      PERM,
      [
        assignment({
          permissions: ['other.action'],
          revokedAt: new Date('2026-10-30T00:00:00.000Z'),
        }),
        assignment({ validUntil: new Date('2026-10-31T00:00:00.000Z') }),
      ],
      NOW,
    );
    expect(decision).toMatchObject({ allowed: false, denial: 'assignment_expired' });
  });

  it('still reports a revoked denial when the revoked assignment carries the permission', () => {
    // Đối chiếu trực diện với case trên: cùng tập đó, nhưng assignment bị
    // revoke BÂY GIỜ mang đúng permission → lý do phải là revoke, không phải
    // expiry. Bỏ lọc theo permission thì test này vẫn xanh, nên cả hai phải
    // đứng cạnh nhau.
    const decision = can(
      PERM,
      [
        assignment({
          permissions: ['other.action'],
          revokedAt: new Date('2026-10-30T00:00:00.000Z'),
        }),
        assignment({ revokedAt: new Date('2026-10-30T00:00:00.000Z') }),
      ],
      NOW,
    );
    expect(decision).toMatchObject({ allowed: false, denial: 'assignment_revoked' });
  });

  it('treats a future-dated revocation as not yet revoked when the window has expired', () => {
    // `revoked_at` lập trình cho tương lai chưa có hiệu lực: lý do thực sự của
    // denial lúc này là **hết hạn tự nhiên**, không phải thu hồi. Điều kiện
    // cũ (`revokedAt !== null`) gọi một lần thu hồi tương lai là "đã bị thu
    // hồi" — audit ghi sai nguyên nhân cho một sự kiện chưa xảy ra.
    const decision = can(
      PERM,
      [
        assignment({
          validUntil: new Date('2026-10-31T00:00:00.000Z'),
          revokedAt: new Date(NOW.getTime() + 60_000),
        }),
      ],
      NOW,
    );
    expect(decision).toMatchObject({ allowed: false, denial: 'assignment_expired' });
  });

  it('allows a permission whose only revocation is dated in the future', () => {
    // Nửa đối chiếu: một lần thu hồi lập trình cho tương lai chưa có hiệu lực
    // thì assignment VẪN sống — bộ lọc `live` giữ nó, policy không deny.
    const decision = can(PERM, [assignment({ revokedAt: new Date(NOW.getTime() + 60_000) })], NOW);
    expect(decision.allowed).toBe(true);
  });

  it('allows when at least one live assignment carries the permission (AC-003)', () => {
    // Hai role, một có permission một không — chỉ live có permission quyết định.
    const decision = can(PERM, [assignment({ permissions: ['other.action'] }), assignment()], NOW);
    expect(decision.allowed).toBe(true);
  });

  it('treats a wrong-direction window check as expired, never allows', () => {
    // Đặt valid_until dưới revoked_at cùng quá khứ — lọc phải loại cả hai
    // hàng; mutation nào bỏ một trong hai điều kiện sẽ làm test này xanh
    // sai nếu chỉ giữ lại một mốc. Vì vậy cả hai mốc cùng tồn tại ở hàng:
    const decision = can(
      PERM,
      [
        assignment({
          validUntil: new Date('2026-10-30T00:00:00.000Z'),
          revokedAt: new Date('2026-10-29T00:00:00.000Z'),
        }),
      ],
      NOW,
    );
    // Expiry trước revoke về mốc thời gian, nhưng policy ưu tiên báo
    // revoked (thu hồi có chủ đích, T-05) — ghim hành vi ưu tiên đó.
    expect(decision).toMatchObject({ allowed: false, denial: 'assignment_revoked' });
  });
});

describe('allow path', () => {
  it('allows a live assignment with the requested permission', () => {
    const decision = can(PERM, [assignment()], NOW);
    expect(decision).toEqual({ allowed: true, stale: false, riskClass: 'normal' });
  });
});

describe('revocation freshness (ADR-0002)', () => {
  it('pins the TTL values to the ADR targets', () => {
    expect(REVOCATION_FRESHNESS_TTL_SECONDS).toEqual({ normal: 60, high: 5 });
  });

  it('marks normal-class data older than 60s as stale but still decides on it', () => {
    const fetchedAt = new Date(NOW.getTime() - 61_000);
    const decision = can(PERM, [assignment({ fetchedAt })], NOW);
    expect(decision.allowed).toBe(true);
    expect(decision.stale).toBe(true);
  });

  it('marks normal-class data fetched exactly 60s ago as fresh', () => {
    const fetchedAt = new Date(NOW.getTime() - 60_000);
    expect(can(PERM, [assignment({ fetchedAt })], NOW).stale).toBe(false);
  });

  it('marks high-class data older than 5s as stale (target not met by mechanism yet)', () => {
    const fetchedAt = new Date(NOW.getTime() - 6_000);
    const decision = can(PERM, [assignment({ fetchedAt })], NOW, 'high');
    // Marker `stale` phải xuất hiện trên CẢ allow lẫn deny — caller fail
    // closed với nó, policy không biến stale thành allow ẩn.
    expect(decision.allowed).toBe(true);
    expect(decision.stale).toBe(true);
  });

  it('marks high-class data fetched within 5s as fresh', () => {
    const fetchedAt = new Date(NOW.getTime() - 5_000);
    expect(can(PERM, [assignment({ fetchedAt })], NOW, 'high').stale).toBe(false);
  });

  it('carries the stale marker on a denial for old data, never a silent allow', () => {
    const fetchedAt = new Date(NOW.getTime() - 61_000);
    const decision = can('other.action', [assignment({ fetchedAt })], NOW);
    expect(decision).toMatchObject({
      allowed: false,
      denial: 'permission_not_granted',
      stale: true,
    });
  });

  it('treats the whole set as stale when the oldest snapshot exceeds the TTL', () => {
    // Một ảnh fresher không cứu ảnh cũ: mốc so là snapshot cũ nhất.
    const decision = can(
      PERM,
      [assignment(), assignment({ fetchedAt: new Date(NOW.getTime() - 61_000) })],
      NOW,
    );
    expect(decision.stale).toBe(true);
  });
});
