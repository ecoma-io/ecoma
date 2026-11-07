/**
 * Chấp nhận trang uỷ quyền — trang mà **UI không được trở thành ranh giới bảo mật**.
 *
 * ⚠️ Trang dễ bị "tiện tay" dựng luôn URL hoặc tin vào `client_id` từ query string.
 * Mỗi khẳng định dưới đây bảo vệ một điều kiện đã chốt, và mỗi cái đều kiểm **hành vi
 * render + hành vi adapter**, không chỉ markup. (Tách từ `tests/acceptance-auth-flow.spec.ts`
 * — nhóm `consent acceptance` giữ nguyên từng test case.)
 */
import { describe, expect, it, vi } from 'vitest';

import ConsentPage from './consent.vue';
import { MOCK_CONSENT_HANDLE } from '../account-data/mock-adapter';
import { flushPromises, mountAccount } from '../../tests/harness';

/** Tham số protocol mà UI không bao giờ được tự dựng hay tin. */
const PROTOCOL_PARAMS = /[?&](code|state|client_id|redirect_uri|scope|response_type|nonce)=/u;

describe('consent acceptance', () => {
  it('takes its client name, permissions and risk from the adapter alone', async () => {
    const { wrapper } = await mountAccount(ConsentPage, {
      route: { path: '/consent', query: { handle: MOCK_CONSENT_HANDLE } },
    });

    expect(wrapper.find('[data-testid="consent-card"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Ecoma Docs');
    expect(wrapper.find('[data-testid="consent-high-risk"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="consent-permissions"] li').length).toBe(3);
  });

  it('ignores a handle it does not recognise instead of inventing a client', async () => {
    const { wrapper } = await mountAccount(ConsentPage, {
      route: { path: '/consent', query: { handle: 'forged-handle' } },
    });

    // Adapter từ chối handle lạ → nhánh `empty`, với câu giải thích — không phải
    // một consent screen trống giả (trước đây `isEmpty(undefined)` là false nên
    // state là `ready` với `value: undefined` và không nhánh nào khớp), và càng
    // không phải nhánh lỗi (handle không phải lỗi tải).
    expect(wrapper.find('[data-testid="consent-approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="consent-denied"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="consent-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('The requesting application is not identified.');
  });

  it('shows the empty state when the URL carries no handle at all', async () => {
    const { wrapper } = await mountAccount(ConsentPage, {
      route: { path: '/consent', query: {} },
    });

    expect(wrapper.find('[data-testid="consent-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="consent-approve"]').exists()).toBe(false);
  });

  it('never renders a browser-supplied client_id as if it were trusted', async () => {
    const { wrapper } = await mountAccount(ConsentPage, {
      route: {
        path: '/consent',
        query: { handle: MOCK_CONSENT_HANDLE, client_id: 'attacker-app', scope: 'admin:write' },
      },
    });

    const text = wrapper.text();
    expect(text, 'a query client_id must not be displayed').not.toContain('attacker-app');
    expect(text, 'a query scope must not be displayed').not.toContain('admin:write');
  });

  it('shows approve and deny, and builds no success or error redirect', async () => {
    const { wrapper, adapter } = await mountAccount(ConsentPage, {
      route: { path: '/consent', query: { handle: MOCK_CONSENT_HANDLE } },
    });

    const decideConsent = vi.spyOn(adapter, 'decideConsent');
    await wrapper.find('[data-testid="consent-approve"]').trigger('click');
    await flushPromises();

    // Quyết định đi qua adapter — nơi duy nhất được phép biết hậu quả của nó.
    expect(decideConsent).toHaveBeenCalledWith(MOCK_CONSENT_HANDLE, 'approve');

    // Không có `window.location` nào bị gán, và không có liên kết protocol nào.
    for (const anchor of wrapper.findAll('a')) {
      expect(anchor.attributes('href') ?? '', 'no protocol href').not.toMatch(PROTOCOL_PARAMS);
    }
    expect(wrapper.html()).not.toMatch(PROTOCOL_PARAMS);
  });

  it('reports a refused decision instead of a completed authorization', async () => {
    const { wrapper } = await mountAccount(ConsentPage, {
      adapterOptions: { failWrites: ['decideConsent'] },
      route: { path: '/consent', query: { handle: MOCK_CONSENT_HANDLE } },
    });

    await wrapper.find('[data-testid="consent-approve"]').trigger('click');
    await flushPromises();

    // `data-tone` là thứ phân biệt thành công với thất bại — đọc class thì một thay
    // đổi Tailwind sau này sẽ làm test im lặng pass/fail sai.
    expect(wrapper.find('[data-testid="account-result"]').attributes('data-tone')).toBe('danger');
    // Lưu hỏng thì handle chưa bị tiêu thụ: nút vẫn bấm được để thử lại.
    expect(
      (wrapper.find('[data-testid="consent-approve"]').element as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('reports a granted decision as granted, keeps it on screen, and never re-uses the handle', async () => {
    const { wrapper, adapter } = await mountAccount(ConsentPage, {
      route: { path: '/consent', query: { handle: MOCK_CONSENT_HANDLE } },
    });

    expect(wrapper.find('[data-testid="account-result"]').exists()).toBe(false);

    // Spy sau khi mount: lần gọi đầu (`useAsyncState` nạp context) đã xảy ra, nên
    // mọi lần gọi sau đây đều là của `reload()` — thứ không được tồn tại.
    const getConsentContext = vi.spyOn(adapter, 'getConsentContext');
    await wrapper.find('[data-testid="consent-deny"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="account-result"]').attributes('data-tone')).toBe('success');
    // Handle đã tiêu thụ: không `reload()` nạp lại context bằng chính handle đó —
    // adapter thật trả `undefined`, nhánh `empty` ("yêu cầu không còn hợp lệ")
    // sẽ phủ ngay lên thông báo vừa thành công.
    expect(getConsentContext).not.toHaveBeenCalled();
    // Thông báo và context vẫn trên màn hình, và nút bị khoá: gửi lại một handle
    // đã dùng sẽ làm adapter thật báo lỗi đè lên thành công.
    expect(wrapper.find('[data-testid="consent-approve"]').exists()).toBe(true);
    expect(
      (wrapper.find('[data-testid="consent-approve"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('reloads the context and unlocks the buttons when the handle in the URL changes', async () => {
    // `NuxtPage` tái sử dụng instance của page khi chỉ đổi query, còn
    // `useAsyncState` chỉ nạp ở `onMounted`: không có watch thì quyền của handle
    // cũ vẫn trên màn hình trong khi `decide()` đã đọc handle mới lúc bấm — cấp
    // quyền nhầm ứng dụng. Route trong harness là `reactive` nên `setRoute`
    // giữa chừng chính là mô phỏng điều hướng SPA đó.
    const { wrapper, adapter, setRoute } = await mountAccount(ConsentPage, {
      route: { path: '/consent', query: { handle: MOCK_CONSENT_HANDLE } },
    });
    expect(wrapper.text()).toContain('Ecoma Docs');

    const getConsentContext = vi.spyOn(adapter, 'getConsentContext');
    setRoute({ query: { handle: 'forged-handle' } });
    await flushPromises();

    // Context cũ bị thay bằng nhánh `empty` của handle mới, không phải treo quyền cũ.
    expect(wrapper.find('[data-testid="consent-empty"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Ecoma Docs');
    expect(getConsentContext).toHaveBeenCalledTimes(1);

    // Quay lại handle hợp lệ: context mới tải và nút bật — trạng thái quyết định
    // cũ (nếu có) không giữ khóa.
    setRoute({ query: { handle: MOCK_CONSENT_HANDLE } });
    await flushPromises();
    expect(wrapper.text()).toContain('Ecoma Docs');
    expect(
      (wrapper.find('[data-testid="consent-approve"]').element as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(getConsentContext).toHaveBeenCalledTimes(2);
  });
});
