import { describe, expect, it, vi } from 'vitest';

import {
  assertCanonicalBootstrapEmail,
  BOOTSTRAP_EMAIL,
  runBootstrapSuperadmin,
  type BootstrapStageRequest,
  type BootstrapStageResult,
  type BootstrapStageRunner,
} from './bootstrap-superadmin.js';

/**
 * Bọc một runner để ghi lại các bước nó nhận, phục vụ kiểm thứ tự canonical
 * `preflight → A1 → A2 → S1 → S2 → S3` và việc dừng ở bước fail.
 */
function recordStages(runner: BootstrapStageRunner): {
  readonly runStage: BootstrapStageRunner;
  readonly requests: BootstrapStageRequest[];
} {
  const requests: BootstrapStageRequest[] = [];
  const runStage: BootstrapStageRunner = (request) => {
    requests.push(request);
    return runner(request);
  };
  return { runStage, requests };
}

/** Stage thành công tối thiểu đúng hình dạng service in ra. */
function success(
  stage: string,
  status: string,
  payload: Record<string, unknown>,
): BootstrapStageResult {
  return { ok: true, stage, status, payload };
}

/** Runner hạnh phúc trên một database trống. */
const happyStages: BootstrapStageRunner = (request) => {
  switch (request.action) {
    case 'verify':
      return {
        ok: false,
        stage: 'account.verify',
        reason: request.input['sub'] === undefined ? 'no_bootstrap_account' : 'unused',
      };
    case 'provision':
      return success('account.provision', 'created', { sub: `sub_${'a'.repeat(32)}` });
    case 'staff-provision':
      return success('staff.provision', 'created', { staff_id: 'staff-1' });
    case 'staff-assign':
      return success('staff.assign', 'created', { staff_id: 'staff-1', assignment_id: 'asg-1' });
    case 'staff-verify':
      return success('staff.verify', 'verified', { staff_id: 'staff-1' });
  }
};

describe('runBootstrapSuperadmin', () => {
  it('runs preflight, both Account steps, both Staff Access steps and the read-only verification in order', () => {
    // Lần `verify` đầu là preflight (chưa có `sub`), lần thứ hai là A2.
    let verifyCalls = 0;
    const runner: BootstrapStageRunner = (request) => {
      if (request.action !== 'verify') return happyStages(request);
      verifyCalls += 1;
      return verifyCalls === 1
        ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
        : success('account.verify', 'verified', { sub: 'sub_' + 'a'.repeat(32) });
    };

    const recorded = recordStages(runner);
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-1',
      operatorRef: 'CHG-1',
      runStage: recorded.runStage,
    });
    const recordedStages = recorded.requests;

    expect(result.outcome).toBe('bootstrapped');
    expect(recordedStages.map((r) => `${r.service}:${r.action}`)).toEqual([
      'account:verify',
      'account:provision',
      'account:verify',
      'staff-access:staff-provision',
      'staff-access:staff-assign',
      'staff-access:staff-verify',
    ]);
    // Cùng một correlation id xuyên suốt; `sub` chỉ đi từ A2 trở đi.
    expect(recordedStages.every((r) => r.input['correlation_id'] === 'corr-1')).toBe(true);
    expect(recordedStages[1]?.input['operator_ref']).toBe('CHG-1');
    expect(recordedStages[3]?.input['sub']).toBe(`sub_${'a'.repeat(32)}`);
  });

  it('stops before A1 when the Account database already holds another account', () => {
    const recorded = recordStages(() => ({
      ok: false,
      stage: 'account.verify',
      reason: 'account_database_not_empty',
    }));
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-2',
      operatorRef: '',
      runStage: recorded.runStage,
    });
    const recordedStages = recorded.requests;

    expect(result.outcome).toBe('failed');
    expect(result.failedStage).toBe('account.verify');
    expect(result.reason).toBe('account_database_not_empty');
    // Preflight là bước duy nhất đã chạy: không có Account nào được tạo.
    expect(recordedStages).toHaveLength(1);
  });

  it('stops at the first failing stage and never continues to later stages', () => {
    let calls = 0;
    let verifyCalls = 0;
    const runner: BootstrapStageRunner = (request) => {
      calls += 1;
      if (request.action === 'verify') {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
          : success('account.verify', 'verified', { sub: `sub_${'b'.repeat(32)}` });
      }
      if (request.action === 'provision') {
        return success('account.provision', 'created', { sub: `sub_${'b'.repeat(32)}` });
      }
      return { ok: false, stage: 'staff.provision', reason: 'staff_not_active' };
    };

    const recorded = recordStages(runner);
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-3',
      operatorRef: '',
      runStage: recorded.runStage,
    });
    const recordedStages = recorded.requests;

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('staff_not_active');
    expect(recordedStages.map((r) => r.action)).toEqual([
      'verify',
      'provision',
      'verify',
      'staff-provision',
    ]);
    expect(calls).toBe(4);
  });

  it('reports sub_mismatch when A2 returns a different subject than A1', () => {
    let verifyCalls = 0;
    const runner: BootstrapStageRunner = (request) => {
      if (request.action !== 'verify') return happyStages(request);
      verifyCalls += 1;
      return verifyCalls === 1
        ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
        : success('account.verify', 'verified', { sub: `sub_${'c'.repeat(32)}` });
    };

    const result = runBootstrapSuperadmin({
      correlationId: 'corr-4',
      operatorRef: '',
      runStage: runner,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('sub_mismatch');
  });

  it('reports guard_denied — not bootstrapped — when the measured guard rejects the run', () => {
    let verifyCalls = 0;
    const runner: BootstrapStageRunner = (request) => {
      if (request.action === 'verify') {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
          : success('account.verify', 'verified', { sub: `sub_${'d'.repeat(32)}` });
      }
      if (request.action === 'provision') {
        return success('account.provision', 'created', { sub: `sub_${'d'.repeat(32)}` });
      }
      if (request.action === 'staff-provision') {
        return { ok: false, stage: 'staff.provision', reason: 'mode_mismatch' };
      }
      return success('staff.verify', 'verified', { staff_id: 'staff-1' });
    };

    const result = runBootstrapSuperadmin({
      correlationId: 'corr-5',
      operatorRef: '',
      runStage: runner,
    });

    expect(result.outcome).toBe('guard_denied');
    expect(result.stages.map((s) => s.outcome)).toContain('denied');
    // Không bước ghi nào được báo thành công sau khi guard từ chối.
    expect(result.staffId).toBeUndefined();
    expect(result.assignmentId).toBeUndefined();
  });

  it('does not leak the input payload into the stage log', () => {
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-6',
      operatorRef: 'CHG-SECRET',
      runStage: (request) => {
        if (request.action === 'verify') {
          return { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' };
        }
        return { ok: false, stage: 'account.provision', reason: 'denied' };
      },
    });

    expect(JSON.stringify(result)).not.toContain('CHG-SECRET');
  });
});

describe('assertCanonicalBootstrapEmail', () => {
  it('accepts the canonical address, including a differently-cased assertion', () => {
    expect(() => assertCanonicalBootstrapEmail(undefined)).not.toThrow();
    expect(() => assertCanonicalBootstrapEmail(BOOTSTRAP_EMAIL)).not.toThrow();
    expect(() =>
      assertCanonicalBootstrapEmail(`  ${BOOTSTRAP_EMAIL.toUpperCase()}  `),
    ).not.toThrow();
  });

  it('refuses any other address, even a syntactically valid one', () => {
    expect(() => assertCanonicalBootstrapEmail('admin@example.com')).toThrow(/canonical/u);
  });
});

describe('canonical constant', () => {
  it('is the accepted canonical Superadmin address', () => {
    expect(BOOTSTRAP_EMAIL).toBe('superadmin@ecoma.io');
  });

  it('is not read from configuration by the runner', () => {
    // Hằng phải là literal trong module: một biến env khác giá trị canonical
    // không đổi được nó — nó chỉ làm assert fail-fast ném lỗi.
    vi.stubEnv('ECOMA_BOOTSTRAP_EMAIL', 'attacker@example.com');
    try {
      expect(BOOTSTRAP_EMAIL).toBe('superadmin@ecoma.io');
      expect(() => assertCanonicalBootstrapEmail(process.env['ECOMA_BOOTSTRAP_EMAIL'])).toThrow(
        /canonical/u,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
