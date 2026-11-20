import { describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import {
  MAX_RESEND_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS,
  RESEND_RETRY_GAP_MS,
  waitForContinueTargetAfterOtpVerify,
} from './otp-verify-recovery.js';

// Helper thật assert "retry đã sửa" bằng `expect(continueTarget).toBeVisible`
// của @playwright/test. Mock giữ NGUYÊN ngữ nghĩa assertion: `toBeVisible`
// phải hỏi `isVisible` của fake locator và throw khi chưa hiện — mock no-op
// sẽ biến assert của implementation thành vacuous và che bug. vitest tự hoist
// `vi.mock` lên trước mọi import.
vi.mock('@playwright/test', () => ({
  expect: (locator: unknown) => ({
    toBeVisible: async () => {
      const visible = await (locator as { isVisible?: () => Promise<boolean> }).isVisible?.();
      if (visible !== true) {
        throw new Error('expected element to be visible, fake locator reports not visible');
      }
    },
  }),
}));

/** Kết quả một lượt `waitFor` — element mount thật hay chết trong cửa sổ. */
type Outcome = 'visible' | 'missing';

/**
 * Locator giả theo kịch bản: mỗi lượt `waitFor` đọc tiếp một outcome. Khi
 * `visibleAfter` có mặt, `isVisible` hỏi predicate ngoài — mô hình "bấm retry
 * sửa xong, target thật sự mount" cho assert `toBeVisible` của impl.
 */
function scriptedLocator(
  sequence: Outcome[],
  clickSink: string[],
  label: string,
  visibleAfter?: () => boolean,
): Locator {
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
    isVisible: async () => visibleAfter?.() ?? false,
  } as unknown as Locator;
}

interface HarnessOptions {
  /** URL đầy đủ mà `page.url()` trả — mặc định trang login (sống, http). */
  readonly pageUrl?: string;
  /** `login-request-failed` có đang hiển thị hay không. */
  readonly requestFailedVisible?: boolean;
  /**
   * `login-request-failed` ẩn đi sau lượt submit đầu — mô hình trang đã rời
   * trạng thái lỗi khi response của re-click về; duy nhất đường này chạm được
   * nhánh rethrow của round-trip timeout không kèm thẻ lỗi (POST chưa hoàn
   * tất — lỗi thật).
   */
  readonly requestFailedHidesAfterSubmit?: boolean;
  /** `login-code-invalid` có đang hiển thị hay không. */
  readonly codeInvalidVisible?: boolean;
  /**
   * `login-code-invalid` chỉ hiện SAU lượt submit đầu của helper — mô hình
   * trình tự run 44784071601: 400 của re-click (nhánh 4) là thứ render thẻ
   * lỗi, trước đó nhánh 3 chưa được vào.
   */
  readonly codeInvalidVisibleAfterSubmit?: boolean;
  /** Kịch bản mount của `login-continue-target`, đọc theo lượt waitFor. */
  readonly continueSequence?: Outcome[];
  /** Kịch bản mount của `login-continue-retry`, đọc theo lượt waitFor. */
  readonly retrySequence?: Outcome[];
  /** Đọc OTP của recovery code-invalid — vắng mặt ⇒ không bật recovery đó. */
  readonly readOtp?: () => Promise<string>;
  /** Có wiring closure recovery dead-page hay không (độ phủ tùy chọn). */
  readonly wireDeadPageRecovery?: boolean;
  /**
   * Round-trip submit chết bởi race điều hướng (waitFor ném signature race
   * thay vì resolve) — mock cho đường nuốt race của impl.
   */
  readonly roundTripRace?: boolean;
  /**
   * Round-trip submit chết bằng timeout (waitFor ném lỗi timeout thường thay vì
   * resolve) — mock cho đường nuốt round-trip-400 của impl; kèm thẻ lỗi hiển thị
   * thì được nuốt, không thì phải rethrow.
   */
  readonly roundTripHangs?: boolean;
  /** Mã OTP caller đã nộp trước khi vào helper — bật vòng freshness của resend. */
  readonly submittedOtp?: string;
  /**
   * `continueTarget` mount sau khi bấm retry — bật cho test assert
   * `expect(continueTarget).toBeVisible` của impl trên đường sửa lỗi handoff.
   */
  readonly continueVisibleAfterRetryClick?: boolean;
}

function makeHarness(options: HarnessOptions) {
  const submitClicks: string[] = [];
  const resendClicks: string[] = [];
  const codeFills: string[] = [];
  const retryClicks: string[] = [];
  const gotoCalls: string[] = [];
  const recoverCalls: string[] = [];
  const codeFormHiddenWaits: number[] = [];
  const waitTimeouts: number[] = [];
  const page = {
    url: () => options.pageUrl ?? 'https://account.local/login',
    goto: async (url: string) => {
      gotoCalls.push(url);
      return null;
    },
    // Gap giữa hai lượt resend của vòng freshness — mock no-op có ghi nhận để
    // test assert nhịp chờ mà không chờ thật 10s.
    waitForTimeout: async (ms: number) => {
      waitTimeouts.push(ms);
    },
    getByTestId: (testId: string) => {
      if (testId === 'login-code-invalid') {
        return {
          isVisible: async () =>
            options.codeInvalidVisibleAfterSubmit
              ? submitClicks.length > 0
              : (options.codeInvalidVisible ?? false),
        };
      }
      if (testId === 'login-code-form') {
        return {
          isVisible: async () => true,
          // `waitFor({ state: 'hidden' })` của vòng đợi round-trip submit —
          // resolve như element đã rời DOM, ghi nhận để test assert bước chờ;
          // khi `roundTripRace`, ném đúng signature race của navigation chết;
          // khi `roundTripHangs`, ném đúng signature timeout của form bị giữ
          // lại sau một 400 (`login/index.vue` giữ form khi verify trả kết quả
          // lỗi, không có navigation nào để ẩn form).
          waitFor: async () => {
            codeFormHiddenWaits.push(codeFormHiddenWaits.length + 1);
            if (options.roundTripRace ?? false) {
              throw new Error('element was detached from the DOM, retrying');
            }
            if (options.roundTripHangs ?? false) {
              throw new Error('locator.waitFor: Timeout 15000ms exceeded');
            }
            return undefined;
          },
        };
      }
      if (testId === 'login-code') {
        // Impl chỉ `fill()` ô nhập mã — không có click; fixture phải khớp impl.
        return {
          fill: async (value: string) => {
            codeFills.push(value);
          },
        };
      }
      const sink =
        testId === 'login-code-submit'
          ? submitClicks
          : testId === 'login-resend'
            ? resendClicks
            : undefined;
      if (sink === undefined) {
        throw new Error(`unexpected getByTestId: ${testId}`);
      }
      return {
        click: async () => {
          sink.push(testId);
        },
      };
    },
  } as unknown as Page;
  const params = {
    continueTarget: scriptedLocator(
      options.continueSequence ?? [],
      [],
      'continue-target',
      // Target mount SAU khi retry click xong — state thật mà assert của impl hỏi.
      options.continueVisibleAfterRetryClick === true ? () => retryClicks.length > 0 : undefined,
    ),
    retryButton: scriptedLocator(options.retrySequence ?? [], retryClicks, 'login-continue-retry'),
    requestFailed: {
      isVisible: async () =>
        options.requestFailedHidesAfterSubmit
          ? submitClicks.length === 0
          : (options.requestFailedVisible ?? false),
      waitFor: async () => undefined,
      click: async () => undefined,
    } as unknown as Locator,
    describeStuckState: async () => 'url=https://account.local/login visible=[login-code-form]',
    readOtp: options.readOtp,
    submittedOtp: options.submittedOtp,
    recoverFromDeadPage: options.wireDeadPageRecovery
      ? async () => {
          recoverCalls.push('dead-page');
        }
      : undefined,
  };
  return {
    run: () => waitForContinueTargetAfterOtpVerify(page, params),
    submitClicks,
    resendClicks,
    codeFills,
    retryClicks,
    gotoCalls,
    recoverCalls,
    codeFormHiddenWaits,
    waitTimeouts,
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
    expect(harness.codeFormHiddenWaits).toHaveLength(1);
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
    expect(MAX_VERIFY_ATTEMPTS).toBe(3);
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
      pageUrl: 'https://account.local/login/continue',
      continueSequence: ['missing', 'visible'],
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.gotoCalls).toEqual(['https://account.local/login/continue']);
    expect(harness.submitClicks).toHaveLength(0);
  });

  it('throws when the re-navigated continue page still renders no card', async () => {
    const harness = makeHarness({
      pageUrl: 'https://account.local/login/continue',
      continueSequence: ['missing', 'missing'],
      retrySequence: ['missing', 'missing'],
    });
    await expect(harness.run()).rejects.toThrow(
      '/login/continue rendered no card even after re-navigation',
    );
    expect(harness.gotoCalls).toHaveLength(1);
  });

  it('clicks the handoff retry button once and waits for the target afterwards', async () => {
    const harness = makeHarness({
      retrySequence: ['visible'],
      continueVisibleAfterRetryClick: true,
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.retryClicks).toEqual(['login-continue-retry']);
    expect(harness.submitClicks).toHaveLength(0);
  });

  it('recovers a rejected verify by resending and reading a fresh OTP, then succeeds (instance 13)', async () => {
    const harness = makeHarness({
      continueSequence: ['missing', 'visible'],
      requestFailedVisible: true,
      codeInvalidVisible: true,
      readOtp: async () => '88776655',
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.resendClicks).toEqual(['login-resend']);
    expect(harness.codeFills).toEqual(['88776655']);
    // Code-invalid wins over the bare request-failed branch: the server already
    // answered 400, so re-submitting the old code would be futile.
    expect(harness.submitClicks).toEqual(['login-code-submit']);
    expect(harness.codeFormHiddenWaits).toHaveLength(1);
    expect(harness.recoverCalls).toHaveLength(0);
  });

  it('falls back to the request-failed re-click when the code state has no reader wired', async () => {
    const harness = makeHarness({
      continueSequence: ['missing', 'missing'],
      requestFailedVisible: true,
      codeInvalidVisible: true,
    });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.resendClicks).toHaveLength(0);
    expect(harness.codeFills).toHaveLength(0);
    // Backward-compatible: without readOtp the helper keeps the #520 behavior —
    // one re-click on the request-failed branch, then throw.
    expect(harness.submitClicks).toHaveLength(1);
  });

  it('throws after the resend recovery spent its single shot and the next verify dies again', async () => {
    const harness = makeHarness({
      continueSequence: ['missing', 'missing'],
      requestFailedVisible: true,
      codeInvalidVisible: true,
      readOtp: async () => '88776655',
    });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.resendClicks).toEqual(['login-resend']);
    expect(harness.codeFills).toEqual(['88776655']);
    expect(harness.submitClicks).toEqual(['login-code-submit']);
  });

  it('delegates a dead browser page to the re-login recovery exactly once', async () => {
    const harness = makeHarness({
      pageUrl: 'chrome-error://chromewebdata/',
      wireDeadPageRecovery: true,
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.recoverCalls).toEqual(['dead-page']);
    expect(harness.submitClicks).toHaveLength(0);
    expect(harness.resendClicks).toHaveLength(0);
  });

  it('throws on a dead browser page when no recovery closure is wired', async () => {
    const harness = makeHarness({
      pageUrl: 'chrome-error://chromewebdata/',
      continueSequence: ['missing'],
    });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.recoverCalls).toHaveLength(0);
  });

  it('treats about:blank as a live page — transient mid-navigation must not trigger re-login', async () => {
    const harness = makeHarness({
      pageUrl: 'about:blank',
      wireDeadPageRecovery: true,
      continueSequence: ['missing'],
    });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.recoverCalls).toHaveLength(0);
  });

  it('surfaces swallowed round-trip races in the exhausted-budget throw', async () => {
    const harness = makeHarness({
      continueSequence: ['missing', 'missing'],
      requestFailedVisible: true,
      roundTripRace: true,
    });
    await expect(harness.run()).rejects.toThrow('swallowed submit round-trip races: 1');
    expect(harness.submitClicks).toHaveLength(1);
  });

  it('treats a completed-but-400 round trip as finished and recovers via resend (run 44784071601)', async () => {
    // Trình tự thật của run 44784071601 (attempt 1): verify đầu chết -1 sau khi
    // server đã consume challenge ⇒ nhánh 4 re-click nhận 400 và trang GIỮ form
    // kèm `login-code-invalid` — round-trip timeout phải được nuốt (POST đã hoàn
    // tất) để nhánh resend chạy, thay vì chết bằng TimeoutError như bản cũ.
    const harness = makeHarness({
      continueSequence: ['missing', 'missing', 'visible'],
      requestFailedVisible: true,
      codeInvalidVisibleAfterSubmit: true,
      roundTripHangs: true,
      readOtp: async () => '12345678',
      submittedOtp: '50538501',
    });
    await expect(harness.run()).resolves.toBeUndefined();
    // Re-click của nhánh 4 + submit của nhánh resend.
    expect(harness.submitClicks).toHaveLength(2);
    expect(harness.resendClicks).toEqual(['login-resend']);
    expect(harness.codeFills).toEqual(['12345678']);
    expect(harness.codeFormHiddenWaits).toHaveLength(2);
    expect(harness.recoverCalls).toHaveLength(0);
  });

  it('re-clicks resend until the mail sink yields a different code, bridging the resend cooldown', async () => {
    const readOtpCodes = ['11111111', '11111111', '22222222'];
    let read = 0;
    const harness = makeHarness({
      continueSequence: ['missing', 'visible'],
      codeInvalidVisible: true,
      readOtp: async () => readOtpCodes[read++] ?? '22222222',
      submittedOtp: '11111111',
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.resendClicks).toHaveLength(3);
    expect(harness.codeFills).toEqual(['22222222']);
    expect(harness.waitTimeouts).toEqual([RESEND_RETRY_GAP_MS, RESEND_RETRY_GAP_MS]);
    expect(harness.submitClicks).toEqual(['login-code-submit']);
  });

  it('keeps the resend loop bounded at its budget and still fails with the stuck-state throw', async () => {
    const harness = makeHarness({
      codeInvalidVisible: true,
      roundTripHangs: true,
      readOtp: async () => '11111111',
      submittedOtp: '11111111',
    });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
    expect(harness.resendClicks).toHaveLength(MAX_RESEND_ATTEMPTS + 1);
    expect(harness.waitTimeouts).toHaveLength(MAX_RESEND_ATTEMPTS);
    expect(harness.waitTimeouts.every((ms) => ms === RESEND_RETRY_GAP_MS)).toBe(true);
    expect(harness.codeFills).toEqual(['11111111']);
  });

  it('rethrows the raw timeout when a hung round trip has no rendered error — true death stays fatal', async () => {
    const harness = makeHarness({
      requestFailedVisible: true,
      requestFailedHidesAfterSubmit: true,
      roundTripHangs: true,
    });
    await expect(harness.run()).rejects.toThrow('Timeout 15000ms exceeded');
    // Nhánh 4 đã re-click đúng một lượt trước khi chết — lỗi không được nuốt
    // cũng không được bọc thành stuck-state.
    expect(harness.submitClicks).toHaveLength(1);
  });
});
