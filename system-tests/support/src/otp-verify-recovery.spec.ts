import { describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import { MAX_VERIFY_ATTEMPTS, waitForContinueTargetAfterOtpVerify } from './otp-verify-recovery.js';

// Helper thật assert "retry đã sửa" bằng `expect(continueTarget).toBeVisible`
// của @playwright/test; với fake locator dưới đây assert đó chỉ cần resolve,
// nên mock cả module — unit test không kéo Playwright runtime vào. vitest tự
// hoist `vi.mock` lên trước mọi import.
vi.mock('@playwright/test', () => ({
  expect: () => ({ toBeVisible: async () => undefined }),
}));

/** Kết quả một lượt `waitFor` — element mount thật hay chết trong cửa sổ. */
type Outcome = 'visible' | 'missing';

/** Locator giả theo kịch bản: mỗi lượt `waitFor` đọc tiếp một outcome. */
function scriptedLocator(sequence: Outcome[], clickSink: string[], label: string): Locator {
  let call = 0;
  return {
    waitFor: () => {
      const outcome = sequence[Math.min(call, sequence.length - 1)] ?? 'missing';
      call += 1;
      // "missing" chết ở macrotask (giống timeout thật): nếu cả hai waiter kết
      // thúc cùng một lượt microtask, thứ tự attach trong `Promise.race` sẽ
      // quyết định thắng thua — không phải thứ tự element mount thật.
      return outcome === 'visible'
        ? Promise.resolve()
        : new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error('timeout'));
            }, 0);
          });
    },
    click: async () => {
      clickSink.push(label);
    },
    isVisible: async () => false,
  } as unknown as Locator;
}

interface HarnessOptions {
  /** Pathname mà `page.url()` trả — mặc định `/login` (đang đứng trang login). */
  readonly pathname?: string;
  /** `login-request-failed` có đang hiển thị hay không. */
  readonly requestFailedVisible?: boolean;
  /** Kịch bản mount của `login-continue-target`, đọc theo lượt waitFor. */
  readonly continueSequence?: Outcome[];
  /** Kịch bản mount của `login-continue-retry`, đọc theo lượt waitFor. */
  readonly retrySequence?: Outcome[];
}

function makeHarness(options: HarnessOptions) {
  const submitClicks: string[] = [];
  const retryClicks: string[] = [];
  const gotoCalls: string[] = [];
  const page = {
    url: () => `https://account.local${options.pathname ?? '/login'}`,
    goto: async (url: string) => {
      gotoCalls.push(url);
      return null;
    },
    getByTestId: (testId: string) => {
      if (testId !== 'login-code-submit') {
        throw new Error(`unexpected getByTestId: ${testId}`);
      }
      return {
        click: async () => {
          submitClicks.push(testId);
        },
      };
    },
  } as unknown as Page;
  const params = {
    continueTarget: scriptedLocator(options.continueSequence ?? [], [], 'continue-target'),
    retryButton: scriptedLocator(options.retrySequence ?? [], retryClicks, 'login-continue-retry'),
    requestFailed: {
      isVisible: async () => options.requestFailedVisible ?? false,
      waitFor: async () => undefined,
      click: async () => undefined,
    } as unknown as Locator,
    describeStuckState: async () => 'url=https://account.local/login visible=[login-code-form]',
  };
  return {
    run: () => waitForContinueTargetAfterOtpVerify(page, params),
    submitClicks,
    retryClicks,
    gotoCalls,
  };
}

describe('waitForContinueTargetAfterOtpVerify', () => {
  it('returns as soon as the continue target mounts on the first attempt', async () => {
    const harness = makeHarness({ continueSequence: ['visible'] });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.submitClicks).toHaveLength(0);
    expect(harness.retryClicks).toHaveLength(0);
    expect(harness.gotoCalls).toHaveLength(0);
  });

  it('re-clicks login-code-submit exactly once when verify dies at the network layer, then succeeds', async () => {
    const harness = makeHarness({
      continueSequence: ['missing', 'visible'],
      requestFailedVisible: true,
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.submitClicks).toHaveLength(1);
    expect(harness.retryClicks).toHaveLength(0);
    expect(harness.gotoCalls).toHaveLength(0);
  });

  it('throws on a second network death without another re-click — the loop stays bounded', async () => {
    const harness = makeHarness({
      continueSequence: ['missing', 'missing'],
      requestFailedVisible: true,
    });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.submitClicks).toHaveLength(1);
    expect(MAX_VERIFY_ATTEMPTS).toBe(2);
  });

  it('throws immediately when the login page shows a no-recovery code state', async () => {
    const harness = makeHarness({ continueSequence: ['missing'], requestFailedVisible: false });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.submitClicks).toHaveLength(0);
  });

  it('re-navigates a dead /login/continue hop once and accepts the second chance', async () => {
    const harness = makeHarness({
      pathname: '/login/continue',
      continueSequence: ['missing', 'visible'],
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.gotoCalls).toEqual(['https://account.local/login/continue']);
    expect(harness.submitClicks).toHaveLength(0);
  });

  it('throws when the re-navigated continue page still renders no card', async () => {
    const harness = makeHarness({
      pathname: '/login/continue',
      continueSequence: ['missing', 'missing'],
      retrySequence: ['missing', 'missing'],
    });
    await expect(harness.run()).rejects.toThrow(
      '/login/continue rendered no card even after re-navigation',
    );
    expect(harness.gotoCalls).toHaveLength(1);
  });

  it('clicks the handoff retry button once and waits for the target afterwards', async () => {
    const harness = makeHarness({ retrySequence: ['visible'] });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.retryClicks).toEqual(['login-continue-retry']);
    expect(harness.submitClicks).toHaveLength(0);
  });
});
