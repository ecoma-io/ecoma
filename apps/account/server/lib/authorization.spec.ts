/**
 * Unit test cho `server/lib/authorization.ts` — cổng enforcement phát lời mời.
 *
 * Neo hai thứ là **hợp đồng**: literal permission (ADR-0010) và hành vi
 * fail-closed hiện tại (ADR-0009 — hợp đồng verdict chưa tồn tại, cổng trả
 * `unavailable`, không bao giờ `allowed`). Khi #44 thay thân hàm thành lời gọi
 * network, test "returns unavailable" sẽ được thay bằng test hợp đồng mới của
 * cổng network — sự thay đổi đó là có chủ đích và thấy được tại đây.
 */

import { describe, expect, it } from 'vitest';

import { authorizeInvitationIssuance, INVITATION_CREATE_PERMISSION } from './authorization';

describe('invitation.create permission literal', () => {
  it('follows the domain.action naming rule of ADR-0010', () => {
    // Đúng một dấu chấm, hai nửa đều khác rỗng, không wildcard — luật đặt tên
    // của ADR-0010. Nửa domain là resource noun (`invitation`), nửa action là
    // verb (`create`) — cùng hình với các candidate literal của #44
    // (staff.create, role.assign).
    expect(INVITATION_CREATE_PERMISSION).toBe('invitation.create');
    const dotCount = (INVITATION_CREATE_PERMISSION.match(/\./gu) ?? []).length;
    expect(dotCount).toBe(1);
    const [domain, action] = INVITATION_CREATE_PERMISSION.split('.');
    expect(domain.length).toBeGreaterThan(0);
    expect(action.length).toBeGreaterThan(0);
    expect(INVITATION_CREATE_PERMISSION).not.toMatch(/[*]/u);
  });
});

describe('authorizeInvitationIssuance', () => {
  it('fails closed with unavailable while no staff-access verdict contract exists', async () => {
    // ADR-0009: không có hợp đồng authorization-result nội bộ; tạo một hợp đồng
    // mới đòi ADR mới — ngoài scope của slice này. Cổng **không bao giờ** trả
    // `allowed` và không có đường nào suy verdict từ trạng thái `account`.
    const verdict = await authorizeInvitationIssuance('sub_abcdefghijklmnopqrstuvwxyz234567');
    // Một assertion khôi hình toàn verdict thay vì `expect` có điều kiện: hợp
    // đồng hiện tại CHÍNH XÁC là `{verdict: 'unavailable', reason: ...}` —
    // thừa hay thiếu thuộc tính nào đều đỏ.
    expect(verdict).toEqual({
      verdict: 'unavailable',
      reason: 'authorization_contract_not_established',
    });
  });

  it('never returns allowed for any principal', async () => {
    for (const actorSub of ['', 'sub_abcdefghijklmnopqrstuvwxyz234567', 'anything']) {
      const verdict = await authorizeInvitationIssuance(actorSub);
      expect(verdict.verdict).not.toBe('allowed');
      expect(verdict.verdict).not.toBe('denied');
    }
  });
});
