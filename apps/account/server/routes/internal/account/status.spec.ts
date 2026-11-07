import { describe, expect, it } from 'vitest';

import { validateAccountStatusResponse } from '@ecoma-io/account-contracts';

import { toContractStatus } from './status.get';

/**
 * Test ánh xạ trạng thái của `GET /internal/account/status`.
 *
 * ⚠️ Contract này là control point fail-closed lúc `auth` phát hành token, và mỗi
 * giá trị sai ở đây đều thành lỗi bảo mật chứ không chỉ là lỗi contract:
 * - Trả `active` cho một account không tồn tại thì `auth` cấp token cho một `sub` không
 *   có thật.
 * - Trả trạng thái ngoài tập bốn giá trị thì `auth` nhận payload không validate được.
 * - Để lọt một trường định danh thì endpoint biến thành đường đọc hồ sơ.
 *
 * Vì vậy test ở đây chạy **qua** `validateAccountStatusResponse` của lib thay vì so
 * sánh object thô: validator là chốt chặn cuối của contract, và một test bỏ qua nó
 * thì sẽ xanh với một response mà `auth` thực sự từ chối.
 */
describe('toContractStatus', () => {
  it('maps each persisted status to the same contract value', () => {
    expect(toContractStatus('active')).toBe('active');
    expect(toContractStatus('suspended')).toBe('suspended');
    expect(toContractStatus('deleted')).toBe('deleted');
  });

  it('maps a missing row to not_found rather than an error', () => {
    // `not_found` là một trong bốn giá trị hợp lệ, không phải lỗi: trả nó như lỗi
    // riêng (404, body khác) sẽ tạo thêm oracle đo sự tồn tại của account (FR-011b).
    expect(toContractStatus(null)).toBe('not_found');
  });

  it('maps an unknown persisted status to not_found instead of leaking it', () => {
    // Giá trị lạ trong DB (migration sai, sửa tay) không được đi thẳng vào response.
    expect(toContractStatus('pending_review')).toBe('not_found');
    expect(toContractStatus('')).toBe('not_found');
  });

  it('produces a payload the contract validator accepts for every mapping', () => {
    for (const rowStatus of ['active', 'suspended', 'deleted', null, 'nonsense']) {
      const validation = validateAccountStatusResponse({ status: toContractStatus(rowStatus) });
      expect(validation.ok).toBe(true);
    }
  });

  it('gives not_found and deleted the same issuance outcome (FR-011d)', () => {
    // Cả hai đều nghĩa là **không cấp token**. Phân biệt chúng không mang lại giá trị
    // cho consumer, và giữ cả hai là quyết định có chủ đích chứ không phải sơ suất —
    // nên test này ghi lại rằng chúng là hai giá trị *khác nhau* ở tầng contract.
    expect(toContractStatus(null)).not.toBe(toContractStatus('deleted'));
  });

  it('never carries an identifying field for any input', () => {
    // FR-011b: chỉ trả `status`. Test này bảo vệ đúng ranh giới đó ở tầng mapping.
    for (const rowStatus of ['active', 'suspended', 'deleted', null, 'nonsense']) {
      const payload = { status: toContractStatus(rowStatus) };
      expect(Object.keys(payload)).toEqual(['status']);
      expect(validateAccountStatusResponse(payload).ok).toBe(true);
    }
  });
});
