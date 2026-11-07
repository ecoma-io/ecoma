/**
 * Bất biến của mock adapter — thứ chống lẫn giữa preview và dữ liệu thật.
 *
 * ⚠️ Đây là lý do file mock tồn tại: nó **không** được phép trông giống một tài
 * khoản đã lưu. Ba điều test này giữ là:
 *
 * 1. `isPreview` bật — banner của layout dựa vào cờ này, và nó phải do lớp dữ liệu
 *    đặt chứ không phải bởi biến build-time, để khi adapter thật thay vào thì banner
 *    tự biến mất.
 * 2. **Tất định** — mọi mốc thời gian là hằng số ISO, không `Date.now()`. UI format
 *    bằng `Intl` theo locale + timezone tường minh, nên SSR và client cho cùng chuỗi;
 *    dùng đồng hồ thật sẽ tạo hydration mismatch chỉ vào những ngày khác nhau.
 * 3. **Không giả vờ là server** — thao tác ghi chỉ đổi state trong bộ nhớ, và nó từ
 *    chối đúng những việc mà server sẽ từ chối (xoá địa chỉ đăng nhập cuối cùng,
 *    thu hồi chính phiên này) để UI không đi qua một đường production từ chối.
 */
import { describe, expect, it } from 'vitest';

import { createMockAccountAdapter, MOCK_CONSENT_HANDLE } from './';
import type { AccountAdapter, Result } from './types';

/**
 * Thu hẹp `Result<T>` sang nhánh thành công.
 *
 * ⚠️ Vì sao cần: `expect(result.ok).toBe(true)` rồi `if (result.ok) { … }` là cách
 * thông thường, nhưng `vitest/no-conditional-expect` cấm `expect` bên trong nhánh —
 * đúng, vì `it` không có `expect` nào chạy thì vẫn xanh. Hàm này **ném** thay vì
 * phủ định: nếu adapter trả `ok: false`, test đỏ ngay với lý do của chính adapter
 * thay vì im lặng bỏ qua phần còn lại.
 */
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, got: ${result.reason}`);
  }
  return result.value;
}

/** Trích mọi mốc thời gian ISO có trong kết quả đọc, để kiểm tính tất định. */
function collectIsoStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(value)) {
      found.push(value);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectIsoStrings(item, found);
    }
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      collectIsoStrings(item, found);
    }
  }
  return found;
}

async function snapshot(adapter: AccountAdapter): Promise<unknown> {
  return {
    profile: await adapter.getProfile(),
    emails: await adapter.listEmails(),
    passkeys: await adapter.listPasskeys(),
    sessions: await adapter.listSessions(),
    applications: await adapter.listApplications(),
    preferences: await adapter.getPreferences(),
    notifications: await adapter.getNotificationPreferences(),
    privacy: await adapter.listPrivacyRequests(),
  };
}

describe('mock adapter', () => {
  it('flags itself as preview data', () => {
    expect(createMockAccountAdapter().isPreview).toBe(true);
  });

  it('reads identically on every call — no clock, no randomness', async () => {
    const first = await snapshot(createMockAccountAdapter());
    const second = await snapshot(createMockAccountAdapter());
    expect(second).toEqual(first);
  });

  it('uses fixed ISO timestamps so SSR and client render the same strings', async () => {
    const adapter = createMockAccountAdapter();
    const timestamps = collectIsoStrings(await snapshot(adapter));
    expect(timestamps.length).toBeGreaterThan(0);
    expect(timestamps).toContain('2026-10-13T08:52:00.000Z');
    for (const timestamp of timestamps) {
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
    }
  });

  it('refuses to remove the last sign-in email', async () => {
    const adapter = createMockAccountAdapter();
    const emails = await adapter.listEmails();
    const signInAddress = emails.find((email) => email.isSignInAddress);
    expect(signInAddress).toBeDefined();
    const result = await adapter.removeEmail((signInAddress as { id: string }).id);
    expect(result.ok).toBe(false);
    // Và địa chỉ vẫn còn trong danh sách — một mock trả `ok` sai sẽ khiến UI
    // hiển thị "đã xoá" trong khi không có gì bị xoá.
    expect((await adapter.listEmails()).some((email) => email.id === signInAddress?.id)).toBe(true);
  });

  it('allows removing a non sign-in email', async () => {
    const adapter = createMockAccountAdapter();
    const removable = (await adapter.listEmails()).find((email) => !email.isSignInAddress);
    expect(removable).toBeDefined();
    const result = await adapter.removeEmail((removable as { id: string }).id);
    expect(result.ok).toBe(true);
    expect((await adapter.listEmails()).some((email) => email.id === removable?.id)).toBe(false);
  });

  it('refuses to revoke the current session, and lets others go', async () => {
    const adapter = createMockAccountAdapter();
    const sessions = await adapter.listSessions();
    const current = sessions.find((session) => session.isCurrent);
    const other = sessions.find((session) => !session.isCurrent);
    expect(await adapter.revokeSession((current as { id: string }).id)).toEqual({
      ok: false,
      reason: 'current session',
    });
    expect((await adapter.revokeSession((other as { id: string }).id)).ok).toBe(true);
  });

  it('marks a newly submitted privacy request pending, not completed', async () => {
    const adapter = createMockAccountAdapter();
    // Nộp yêu cầu không phải là đã xoá dữ liệu. Badge "Completed" ở đây là nói dối.
    expect(unwrap(await adapter.submitPrivacyRequest('delete')).status).toBe('pending');
  });

  it('adds a new email address as pending, never as a verified sign-in address', async () => {
    const adapter = createMockAccountAdapter();
    const added = unwrap(await adapter.addEmail('new@example.com'));

    expect(added.status).toBe('pending');
    expect(added.isSignInAddress).toBe(false);
  });

  it('serves a consent context only for its own handle', async () => {
    const adapter = createMockAccountAdapter();
    expect(await adapter.getConsentContext(MOCK_CONSENT_HANDLE)).toBeDefined();
    expect(await adapter.getConsentContext('some-other-handle')).toBeUndefined();
  });

  it('renders the code step only when the challenge mode is "code"', async () => {
    const linkMode = createMockAccountAdapter();
    const codeMode = createMockAccountAdapter({ challengeMode: 'code' });

    expect(unwrap(await linkMode.requestLoginChallenge('a@example.com')).mode).toBe('email-link');
    // Chế độ email-link không có bước nhập mã, nên mã "đúng" cũng phải bị từ chối.
    expect(await linkMode.verifyLoginCode('123456')).toEqual({
      ok: false,
      reason: 'invalid code',
    });

    expect(unwrap(await codeMode.requestLoginChallenge('a@example.com')).mode).toBe('code');
    const accepted = await codeMode.verifyLoginCode('123456');
    // Mock không có BFF ⇒ không có continuation cấp được: trường tồn tại với giá
    // trị `undefined`, không phải trường vắng mặt — caller đọc `.confirmUrl`
    // an toàn trên mọi value thành công.
    expect(accepted).toEqual({ ok: true, value: { confirmUrl: undefined } });
    expect((await codeMode.verifyLoginCode('000000')).ok).toBe(false);
  });

  it('surfaces an invalid stored locale instead of silently substituting one', async () => {
    const adapter = createMockAccountAdapter({ invalidStoredLocale: 'fr' });
    const preferences = await adapter.getPreferences();
    expect(preferences.locale).toBeUndefined();
    expect(preferences.invalidLocale).toBe('fr');
  });

  it('can be told to refuse a write, so the UI failure path is reachable', async () => {
    const adapter = createMockAccountAdapter({ failWrites: ['updateProfile'] });
    const result = await adapter.updateProfile({ displayName: 'New name' });
    expect(result.ok).toBe(false);
  });

  it('keeps each adapter instance independent', async () => {
    const first = createMockAccountAdapter();
    const second = createMockAccountAdapter();
    await first.addEmail('only-in-first@example.com');
    expect((await first.listEmails()).length).not.toBe((await second.listEmails()).length);
  });
});
