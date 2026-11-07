import { describe, expect, it } from 'vitest';

import { isTemplateAuthorized } from './is-template-authorized';

/**
 * Test của use case authorization SR-001 — hàm thuần, không port.
 *
 * Phần đáng kiểm là **hợp đồng biên** của verdict: default-deny khi principal không có entry
 * hay có entry rỗng, so khớp chuỗi chuẩn (không chuẩn hoá, không lowercase ở đây), và kết
 * quả deny không phân biệt hai trường hợp — tầng route nhận một boolean verdict, không nhận
 * lý do chi tiết.
 */

const TEMPLATES_BY_PRINCIPAL: ReadonlyMap<string, readonly string[]> = new Map([
  ['svc.account', ['account.login-otp']],
  ['svc.payment', []],
]);

describe('isTemplateAuthorized', () => {
  it('allows a principal whose allowlist contains the requested template', () => {
    const result = isTemplateAuthorized({
      principalId: 'svc.account',
      template: 'account.login-otp',
      templatesByPrincipal: TEMPLATES_BY_PRINCIPAL,
    });

    expect(result).toEqual({ allowed: true });
  });

  it('denies a template approved only for another principal', () => {
    const result = isTemplateAuthorized({
      principalId: 'svc.payment',
      template: 'account.login-otp',
      templatesByPrincipal: TEMPLATES_BY_PRINCIPAL,
    });

    expect(result).toEqual({ allowed: false, reason: 'template-not-allowed' });
  });

  it('denies a template unknown to the catalog without consulting the catalog', () => {
    // Cho phép trùng tên test catalog thật: use case này không biết catalog — một template
    // chưa approve bị chặn ngay tại đây kể cả khi nó không tồn tại trong catalog.
    const result = isTemplateAuthorized({
      principalId: 'svc.account',
      template: 'missing-template',
      templatesByPrincipal: TEMPLATES_BY_PRINCIPAL,
    });

    expect(result).toEqual({ allowed: false, reason: 'template-not-allowed' });
  });

  it('treats a principal with an empty allowlist the same as one with no entry', () => {
    // `svc.payment` có entry rỗng — hợp lệ và chặt nhất; `svc.missing` không có entry.
    // Hai dạng phải cùng một verdict deny, không nhánh nào "cho phép tất cả".
    const emptyEntry = isTemplateAuthorized({
      principalId: 'svc.payment',
      template: 'account.login-otp',
      templatesByPrincipal: TEMPLATES_BY_PRINCIPAL,
    });
    const noEntry = isTemplateAuthorized({
      principalId: 'svc.missing',
      template: 'account.login-otp',
      templatesByPrincipal: TEMPLATES_BY_PRINCIPAL,
    });

    expect(emptyEntry).toEqual(noEntry);
    expect(emptyEntry).toEqual({ allowed: false, reason: 'template-not-allowed' });
  });

  it('matches the template by exact string without normalizing it', () => {
    // So khớp **chuỗi chuẩn** đã qua validate shape: use case không trim, không lowercase,
    // không chuẩn hoá — việc chuẩn hoá ở tầng trước, lặp lại ở đây là hai nguồn lệch.
    const result = isTemplateAuthorized({
      principalId: 'svc.account',
      template: 'Account.Login-OTP',
      templatesByPrincipal: TEMPLATES_BY_PRINCIPAL,
    });

    expect(result).toEqual({ allowed: false, reason: 'template-not-allowed' });
  });

  it('does not let the input mutate the allowlist map', () => {
    // Payload **không** có đường nào merge vào allowlist: hàm chỉ đọc map — "merge" chỉ có
    // thể xảy ra nếu caller truyền chính map mutable, use case không mở đường đó.
    const templatesByPrincipal = new Map<string, readonly string[]>(TEMPLATES_BY_PRINCIPAL);
    const before = JSON.stringify([...templatesByPrincipal.entries()]);

    isTemplateAuthorized({
      principalId: 'svc.account',
      template: 'welcome',
      templatesByPrincipal,
    });

    expect(JSON.stringify([...templatesByPrincipal.entries()])).toBe(before);
  });
});
