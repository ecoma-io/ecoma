/**
 * Chấp nhận các control tương tác trên trang dữ liệu — "không có nút chết".
 *
 * ⚠️ Mọi nút phải có nhãn nhìn thấy được, mọi liên kết phải trỏ đi đâu đó, mọi control
 * disabled phải tự giải thích — không khẳng định nào ở đây đọc được từ markup tĩnh: chúng
 * mount trang thật với adapter thật (mock) rồi đi qua từng control. (Tách từ
 * `tests/acceptance-data-pages.spec.ts` — nhóm `interactive controls` giữ nguyên từng
 * test case.)
 */
import { describe, expect, it, vi } from 'vitest';
import type { Result } from '../account-data/types';

import EmailsPage from './emails.vue';
import SessionsPage from './sessions.vue';
import ApplicationsPage from './applications.vue';
import PreferencesPage from './preferences.vue';
import NotificationsPage from './notifications.vue';
import { flushPromises, mountAccount } from '../../tests/harness';

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

describe('interactive controls', () => {
  it('every button on /emails has a visible or explicit label', async () => {
    const { wrapper } = await mountAccount(EmailsPage);

    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBeGreaterThan(0);

    for (const button of buttons) {
      const label =
        button.text().trim() || button.attributes('aria-label') || button.attributes('title');
      expect(label, `an unlabelled button is unusable: ${button.html()}`).toBeTruthy();
    }
  });

  it('every link on /emails points somewhere', async () => {
    const { wrapper } = await mountAccount(EmailsPage);

    for (const anchor of wrapper.findAll('a')) {
      // `href=""` là link chết — bấm không đi đâu.
      expect(anchor.attributes('href'), `a dead link: ${anchor.html()}`).toBeTruthy();
    }
  });

  it('every disabled control explains itself', async () => {
    const { wrapper } = await mountAccount(EmailsPage);

    // `<button disabled>` bị trình đọc màn hình bỏ qua, nên người dùng bàn phím cần một
    // lý do **hiện ra** — `title` là cách phổ biến nhất khi nút vẫn phải hiện.
    for (const control of wrapper.findAll('[disabled]')) {
      expect(
        control.attributes('title') ?? control.attributes('aria-label'),
        `a disabled control with no explanation: ${control.html()}`,
      ).toBeTruthy();
    }
  });

  it('every form field on /emails has an associated label element', async () => {
    const { wrapper } = await mountAccount(EmailsPage);

    for (const field of wrapper.findAll('input, select, textarea')) {
      const id = field.attributes('id');
      expect(id, `a field without an id cannot be labelled: ${field.html()}`).toBeTruthy();
      expect(wrapper.find(`label[for="${id}"]`).exists(), `no <label for="${id}">`).toBe(true);
    }
  });

  it('a new address is added through the adapter, not to a local copy', async () => {
    const { wrapper, adapter } = await mountAccount(EmailsPage);
    const before = await adapter.listEmails();

    await wrapper.find('[data-testid="email-new-address"]').setValue('new@example.com');
    await wrapper.find('[data-testid="email-add-form"]').trigger('submit');
    await wrapper.vm.$nextTick();

    const after = await adapter.listEmails();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((email) => email.address === 'new@example.com')).toBe(true);
  });

  it('a new address starts unverified and is not the sign-in address', async () => {
    const { adapter } = await mountAccount(EmailsPage);
    const added = unwrap(await adapter.addEmail('fresh@example.com'));

    expect(added.status).toBe('pending');
    expect(added.isSignInAddress).toBe(false);
  });

  it('the sign-in address cannot be removed from the UI', async () => {
    const { wrapper, adapter } = await mountAccount(EmailsPage);
    const emails = await adapter.listEmails();
    const signIn = emails.find((email) => email.isSignInAddress);
    expect(signIn, 'the fixture must contain a sign-in address').toBeDefined();
    const id = signIn?.id ?? '';

    // Nút xoá tồn tại nhưng **bị vô hiệu hoá kèm lý do nhìn thấy được** — đây là mẫu a11y
    // đúng: bỏ hẳn nút thì người dùng không biết tại sao mình không xoá được.
    const remove = wrapper.find(`[data-testid="email-remove-${id}"]`);
    expect(remove.exists()).toBe(true);
    expect(
      remove.attributes('disabled'),
      'removing the sign-in address must be disabled',
    ).toBeDefined();
    expect(remove.attributes('title') ?? '', 'a disabled control must explain itself').not.toBe('');
    expect(wrapper.find(`[data-testid="email-blocked-${id}"]`).exists()).toBe(true);

    // Và nếu ai đó gọi thẳng adapter thì hợp đồng vẫn giữ.
    const removed = await adapter.removeEmail(id);
    expect(removed.ok).toBe(false);
  });

  it('the current session cannot be revoked from the UI', async () => {
    const { wrapper, adapter } = await mountAccount(SessionsPage);
    const sessions = await adapter.listSessions();
    const current = sessions.find((session) => session.isCurrent);
    const other = sessions.find((session) => !session.isCurrent);
    expect(current, 'the fixture must contain a current session').toBeDefined();
    expect(other, 'the fixture must contain another session').toBeDefined();

    // Không có nút thu hồi cho chính session đang dùng — thu hồi nó nghĩa là tự đuổi
    // mình ra khỏi tài khoản ngay giữa thao tác.
    expect(wrapper.find(`[data-testid="session-revoke-${current?.id}"]`).exists()).toBe(false);
    expect(wrapper.find(`[data-testid="session-revoke-${other?.id}"]`).exists()).toBe(true);
  });

  it('a high-risk application is flagged from the adapter, not by the UI', async () => {
    const { wrapper, adapter } = await mountAccount(ApplicationsPage);
    const applications = await adapter.listApplications();
    const risky = applications.filter((application) => application.highRisk);
    expect(risky.length).toBeGreaterThan(0);

    // Cờ rủi ro là **dữ liệu của BFF**, không phải phán đoán của UI: UI chỉ hiển thị.
    expect(wrapper.findAll('[data-testid="application-high-risk"]').length).toBe(risky.length);
  });

  it('reverts a notification toggle and reports failure when the write cannot reach the server', async () => {
    // Adapter thật reject khi mạng lỗi (`$fetch`); chỉ trả `Result` cho lỗi nghiệp
    // vụ. Không bắt thì toggle giữ vị trí người dùng bấm trong khi server chưa
    // nhận — đúng thứ khối chú thích của trang cấm ("nói dối rằng lựa chọn đã
    // được giữ").
    const { wrapper, adapter } = await mountAccount(NotificationsPage);
    await flushPromises();
    const checkbox = wrapper.find('[data-testid="notification-serviceEmail"]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(true);

    vi.spyOn(adapter, 'updateNotificationPreferences').mockRejectedValueOnce(
      new Error('network down'),
    );
    await checkbox.setValue(false);
    await flushPromises();

    expect(wrapper.find('[data-testid="account-result"]').attributes('data-tone')).toBe('danger');
    expect(
      (wrapper.find('[data-testid="notification-serviceEmail"]').element as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('writes preferences once per save, not twice', async () => {
    // Trước đây `save()` gửi patch ba trường rồi còn gọi `chooseAndPersist` — mỗi
    // lần là một `updatePreferences` thật. Hai lần ghi: lần thứ hai hỏng trong
    // khi lần đầu thành công thì UI báo thất bại cho thay đổi đã nằm trên server.
    const { wrapper, adapter } = await mountAccount(PreferencesPage);
    await flushPromises();

    const updatePreferences = vi.spyOn(adapter, 'updatePreferences');
    await wrapper.find('[data-testid="preferences-form"]').trigger('submit');
    await flushPromises();

    expect(updatePreferences).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="account-result"]').attributes('data-tone')).toBe('success');
  });

  it('says colour mode is not applied yet instead of pretending it works', async () => {
    // `preferences.colorMode` chưa được shell áp (chưa có theme class, chưa có
    // token dark): lưu "Thành công" rồi không có gì đổi chính là thứ trang này
    // cấm. Control phải nói ra trạng thái thật, có lý do nhìn thấy được.
    const { wrapper } = await mountAccount(PreferencesPage);
    await flushPromises();

    const fieldset = wrapper.find('[data-testid="preferences-color-mode"]');
    expect(fieldset.attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="preferences-color-mode-hint"]').text()).toContain(
      'not applied yet',
    );
  });
});
