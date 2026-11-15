/**
 * Colocated spec của trang Onboarding (issue #208) — nội dung lệnh copy-được:
 *
 * - **Bằng chứng CLI pin**: page công bố đúng version ghim `18.10.9` (kết
 *   luận #205 quyết định 12) — assert tồn tại, không nhảy version âm thầm.
 * - **SR-002**: không token thật nào ở trang — mọi tham chiếu token là
 *   placeholder `$PACT_BROKER_TOKEN` / `<machine-token-...>`.
 * - **Copy control** là điều khiển thật: click gọi `navigator.clipboard`.
 * - Mỗi khối lệnh dùng **chính syntax đã chạy thật** với CLI pin (bằng chứng
 *   trong PR của #208) — spec ghim các flag cốt lõi để ai sửa page không thể
 *   thay bằng flag bịa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import OnboardingPage from './onboarding.vue';
import { mountPactBrokerPage } from '../../tests/harness';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('onboarding page — pinned CLI and copyable commands', () => {
  it('announces the pinned pact-cli version 18.10.9', async () => {
    const wrapper = await mountPactBrokerPage(OnboardingPage);

    expect(wrapper.find('[data-testid="pact-broker-onboarding-pin"]').text()).toContain(
      '@pact-foundation/pact-cli@18.10.9',
    );
    wrapper.unmount();
  });

  it('renders the local commands with the flags proven against the pinned CLI', async () => {
    const wrapper = await mountPactBrokerPage(OnboardingPage);

    const publish = wrapper.find('[data-testid="pact-broker-onboarding-publish"]').text();
    expect(publish).toContain('--consumer-app-version');
    expect(publish).toContain('--broker-base-url');
    expect(publish).toContain('--broker-token');

    const verify = wrapper.find('[data-testid="pact-broker-onboarding-verify"]').text();
    // pact CLI 18.10.9: binary là `pact verifier` (pact-verifier là deprecated
    // alias), token đi qua env PACT_BROKER_TOKEN (KHÔNG có --broker-token flag).
    // `--provider-version ... --publish` để result về broker, và
    // `--consumer-version-selectors '{"latest":true}'` là BẮT BUỘC với broker
    // này — đường mặc định cần HAL link `pb:latest-provider-pacts` mà API chưa
    // phát; thiếu cờ là 404 "No pacts found" (bằng chứng chạy thật trong PR).
    expect(verify).toContain('pact verifier');
    expect(verify).toContain('--provider-version');
    expect(verify).toContain('--publish');
    expect(verify).toContain('--consumer-version-selectors');
    expect(verify).toContain('--broker-url');
    expect(verify).toContain('--provider-name');

    const gate = wrapper.find('[data-testid="pact-broker-onboarding-can-i-deploy"]').text();
    expect(gate).toContain('--pacticipant');
    expect(gate).toContain('--to-environment');
    wrapper.unmount();
  });

  it('renders the CI commands including record-deployment', async () => {
    const wrapper = await mountPactBrokerPage(OnboardingPage);

    const record = wrapper.find('[data-testid="pact-broker-onboarding-ci-record-deployment"]');
    expect(record.exists()).toBe(true);
    expect(record.text()).toContain('--environment');
    wrapper.unmount();
  });

  it('never renders a real token — only placeholders', async () => {
    const wrapper = await mountPactBrokerPage(OnboardingPage);

    const text = wrapper.text();
    expect(text).toContain('$PACT_BROKER_TOKEN');
    // Không giá trị nào trông như token thật (base64url 32+ ký tự không khoảng;
    // chấm phủ cả hình dạng JWT — phần header/payload của JWT cũng khớp).
    expect(text).not.toMatch(/[A-Za-z0-9_.-]{32,}/u);
    wrapper.unmount();
  });

  it('copies the block code through the real clipboard control', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    try {
      const wrapper = await mountPactBrokerPage(OnboardingPage);

      const code = wrapper.find('[data-testid="pact-broker-onboarding-publish"]').text();
      await wrapper.find('[data-testid="pact-broker-onboarding-publish-copy"]').trigger('click');
      expect(writeText).toHaveBeenCalledWith(code);
      wrapper.unmount();
    } finally {
      // Khôi phục descriptor gốc: navigator là global dùng chung giữa các test.
      if (originalClipboard === undefined) {
        delete (navigator as { clipboard?: unknown }).clipboard;
      } else {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      }
    }
  });
});
