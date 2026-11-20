import { describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';
import { recoverLoginByRelogin } from './login-recovery.js';

// Cùng quy ước với `otp-verify-recovery.spec.ts`: mock `expect` của
// @playwright/test — assert chỉ cần resolve, unit test không kéo runtime.
vi.mock('@playwright/test', () => ({
  expect: () => ({ toBeVisible: async () => undefined }),
}));

/** Kết quả một lượt `waitFor` — element mount thật hay chết trong cửa sổ. */
type Outcome = 'visible' | 'missing';

function scriptedLocator(sequence: Outcome[]): Locator {
  let call = 0;
  return {
    waitFor: () => {
      const outcome = sequence[Math.min(call, sequence.length - 1)] ?? 'missing';
      call += 1;
      return outcome === 'visible'
        ? Promise.resolve()
        : new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error('timeout'));
            }, 0);
          });
    },
    click: async () => undefined,
    isVisible: async () => false,
  } as unknown as Locator;
}

interface HarnessOptions {
  /** Form email đã hiển thị (browser đang đứng trang login) hay phải goto. */
  readonly emailFormVisible?: boolean;
  /** Thẻ `login-request-failed` hiện thay cho form mã (challenge chết). */
  readonly challengeRequestFailed?: boolean;
  /** Kịch bản mount của `login-continue-target` trong pha chờ sau verify. */
  readonly continueSequence?: Outcome[];
}

function makeHarness(options: HarnessOptions) {
  const gotoCalls: string[] = [];
  const emailFills: string[] = [];
  const submitClicks: string[] = [];
  const codeFills: string[] = [];
  const otpReads: string[] = [];
  const page = {
    url: () => 'https://account.local/login',
    goto: async (url: string) => {
      gotoCalls.push(url);
      return null;
    },
    getByTestId: (testId: string) => {
      switch (testId) {
        case 'login-email-form':
          return {
            isVisible: async () => options.emailFormVisible ?? false,
            waitFor: async () => undefined,
          };
        case 'login-email':
          return {
            fill: async (value: string) => {
              emailFills.push(value);
            },
          };
        case 'login-submit':
          return {
            click: async () => {
              submitClicks.push(testId);
            },
          };
        case 'login-code':
          return {
            fill: async (value: string) => {
              codeFills.push(value);
            },
          };
        case 'login-code-submit':
          return {
            click: async () => {
              submitClicks.push(testId);
            },
          };
        case 'login-code-form':
          // Scenario challenge chết: form mã không mount — waitFor chết trên
          // macrotask để `challengeFailed` thắng race như thời gian thật.
          return {
            waitFor: async () => {
              if (options.challengeRequestFailed ?? false) {
                await new Promise((resolve) => {
                  setTimeout(resolve, 0);
                });
                throw new Error('timeout');
              }
              return undefined;
            },
          };
        case 'login-code-invalid':
          return { isVisible: async () => false };
        default:
          throw new Error(`unexpected getByTestId: ${testId}`);
      }
    },
  } as unknown as Page;
  const params = {
    loginEntryUrl: 'https://portal.local/api/auth/login',
    email: 'user@example.test',
    readOtp: async () => {
      otpReads.push('otp');
      return '11223344';
    },
    requestFailed: {
      isVisible: async () => options.challengeRequestFailed ?? false,
      waitFor: async () => undefined,
    } as unknown as Locator,
    continueTarget: scriptedLocator(options.continueSequence ?? ['visible']),
    retryButton: scriptedLocator([]),
    describeStuckState: async () => 'stuck',
  };
  return {
    run: () => recoverLoginByRelogin(page, params),
    gotoCalls,
    emailFills,
    submitClicks,
    codeFills,
    otpReads,
  };
}

describe('recoverLoginByRelogin', () => {
  it('re-drives the login in place when the email form is already mounted', async () => {
    const harness = makeHarness({ emailFormVisible: true, continueSequence: ['visible'] });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.gotoCalls).toHaveLength(0);
    expect(harness.emailFills).toEqual(['user@example.test']);
    expect(harness.codeFills).toEqual(['11223344']);
    expect(harness.otpReads).toHaveLength(1);
    expect(harness.submitClicks).toEqual(['login-submit', 'login-code-submit']);
  });

  it('navigates to the absolute entry URL first when the browser sits on a dead page', async () => {
    const harness = makeHarness({ continueSequence: ['visible'] });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.gotoCalls).toEqual(['https://portal.local/api/auth/login']);
    expect(harness.emailFills).toEqual(['user@example.test']);
  });

  it('re-clicks login-submit exactly once when the challenge dies at the network layer', async () => {
    const harness = makeHarness({
      emailFormVisible: true,
      challengeRequestFailed: true,
      continueSequence: ['visible'],
    });
    await expect(harness.run()).resolves.toBeUndefined();
    expect(harness.submitClicks).toEqual(['login-submit', 'login-submit', 'login-code-submit']);
  });

  it('throws when the re-login verify never mounts the continue target — no nested recovery', async () => {
    const harness = makeHarness({ emailFormVisible: true, continueSequence: ['missing'] });
    await expect(harness.run()).rejects.toThrow(
      'login continue page never appeared after OTP verify',
    );
  });
});
