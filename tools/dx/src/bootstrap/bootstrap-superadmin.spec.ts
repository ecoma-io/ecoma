import { describe, expect, it, vi } from 'vitest';

import {
  assertCanonicalBootstrapEmail,
  assertOperatorRef,
  BOOTSTRAP_EMAIL,
  INPUT_STAGE,
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
    // S3 xác nhận đúng staff theo `sub` của Account, không đếm toàn bảng staff.
    expect(recordedStages[5]?.input['sub']).toBe(`sub_${'a'.repeat(32)}`);
  });

  it('rejects a blank or unsafe operator ref before any stage runs', () => {
    // A1 commit trước S1/S2: để `staff-access` từ chối `operator_ref_missing` ở
    // S1 nghĩa là đã tạo một Account không có attribution trong audit.
    for (const operatorRef of ['', '   ']) {
      const recorded = recordStages(happyStages);
      const result = runBootstrapSuperadmin({
        correlationId: 'corr-input',
        operatorRef,
        runStage: recorded.runStage,
      });

      expect(result.outcome).toBe('failed');
      expect(result.failedStage).toBe(INPUT_STAGE);
      expect(result.reason).toBe('operator_ref_missing');
      // Không có lần chạm database nào, kể cả preflight.
      expect(recorded.requests).toHaveLength(0);
    }
  });

  it('rejects a non-empty malformed operator ref with operator_ref_invalid before any stage runs', () => {
    for (const operatorRef of ['CHG 1', 'CHG-1\nINJECTED', 'CHG/1', 'a.b', 'a:b']) {
      const recorded = recordStages(happyStages);
      const result = runBootstrapSuperadmin({
        correlationId: 'corr-input-invalid',
        operatorRef,
        runStage: recorded.runStage,
      });

      expect(result.outcome).toBe('failed');
      expect(result.failedStage).toBe(INPUT_STAGE);
      expect(result.reason).toBe('operator_ref_invalid');
      // Không có lần chạm database nào, kể cả preflight.
      expect(recorded.requests).toHaveLength(0);
    }
  });

  it('trims the operator ref before it reaches the audit payload', () => {
    const recorded = recordStages(happyStages);
    runBootstrapSuperadmin({
      correlationId: 'corr-trim',
      operatorRef: '  CHG-TRIM  ',
      runStage: recorded.runStage,
    });

    expect(recorded.requests[1]?.input['operator_ref']).toBe('CHG-TRIM');
  });

  it('stops before A1 when the Account database already holds another account', () => {
    const recorded = recordStages(() => ({
      ok: false,
      stage: 'account.verify',
      reason: 'account_database_not_empty',
    }));
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-2',
      operatorRef: 'CHG-TEST',
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
      operatorRef: 'CHG-TEST',
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
      operatorRef: 'CHG-TEST',
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
      operatorRef: 'CHG-TEST',
      runStage: runner,
    });

    expect(result.outcome).toBe('guard_denied');
    expect(result.stages.map((s) => s.outcome)).toContain('denied');
    // Không bước ghi nào được báo thành công sau khi guard từ chối.
    expect(result.staffId).toBeUndefined();
    expect(result.assignmentId).toBeUndefined();
    // Chi tiết của bước bị từ chối chỉ nói về **bước đó**: A1 đã commit một
    // Account hợp lệ, nên "no writes were performed" là một câu sai.
    expect(result.stages.map((s) => s.detail)).not.toContain(expect.stringContaining('No writes'));
    const deniedEntry = result.stages.find((s) => s.outcome === 'denied');
    expect(deniedEntry?.detail).toContain('this step wrote nothing');
  });

  it('keeps guard_denied as the outcome when the diagnostic read-back concludes normally', () => {
    // Sau khi guard từ chối, S3 chỉ là chẩn đoán. Nó có thể fail vì lần chạy này
    // chưa từng ghi gì (`staff_missing_or_ambiguous`) — đó là kết luận, không
    // phải lỗi thực thi — nên kết quả vẫn là `guard_denied` và exit code khác 0.
    let verifyCalls = 0;
    const runner: BootstrapStageRunner = (request) => {
      if (request.action === 'verify') {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
          : success('account.verify', 'converged', { sub: `sub_${'e'.repeat(32)}` });
      }
      if (request.action === 'provision') {
        return success('account.provision', 'created', { sub: `sub_${'e'.repeat(32)}` });
      }
      if (request.action === 'staff-provision') {
        return { ok: false, stage: 'staff.provision', reason: 'mode_mismatch' };
      }
      return { ok: false, stage: 'staff.verify', reason: 'staff_missing_or_ambiguous' };
    };

    const result = runBootstrapSuperadmin({
      correlationId: 'corr-7',
      operatorRef: 'CHG-TEST',
      runStage: runner,
    });

    expect(result.outcome).toBe('guard_denied');
    expect(result.failedStage).toBeUndefined();
    expect(result.stages.map((s) => s.outcome)).toEqual([
      'fresh',
      'created',
      'verified',
      'denied',
      'denied',
    ]);
  });

  it('logs an infrastructure failure of the diagnostic read-back as failed, not as a denial', () => {
    // `failed` và `denied` là hai kết luận khác nhau: một `database_unreachable`
    // ở S3 không phải guard từ chối có chủ đích. Kết luận tổng vẫn là
    // `guard_denied` (guard mới là lý do dừng), nhưng dòng nhật ký phải đúng.
    let verifyCalls = 0;
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-7b',
      operatorRef: 'CHG-TEST',
      runStage: (request) => {
        if (request.action === 'verify') {
          verifyCalls += 1;
          return verifyCalls === 1
            ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
            : success('account.verify', 'converged', { sub: `sub_${'h'.repeat(32)}` });
        }
        if (request.action === 'provision') {
          return success('account.provision', 'created', { sub: `sub_${'h'.repeat(32)}` });
        }
        if (request.action === 'staff-provision') {
          return { ok: false, stage: 'staff.provision', reason: 'mode_mismatch' };
        }
        return { ok: false, stage: 'staff.verify', reason: 'database_unreachable' };
      },
    });

    expect(result.outcome).toBe('guard_denied');
    expect(result.stages.map((s) => s.outcome)).toEqual([
      'fresh',
      'created',
      'verified',
      'denied',
      'failed',
    ]);
  });

  it('fails when a staff step succeeds without returning the ids later steps need', () => {
    let verifyCalls = 0;
    const runner: BootstrapStageRunner = (request) => {
      if (request.action === 'verify') {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
          : success('account.verify', 'verified', { sub: `sub_${'f'.repeat(32)}` });
      }
      if (request.action === 'provision') {
        return success('account.provision', 'created', { sub: `sub_${'f'.repeat(32)}` });
      }
      if (request.action === 'staff-provision') {
        return success('staff.provision', 'created', {});
      }
      return success('staff.assign', 'created', {});
    };

    const result = runBootstrapSuperadmin({
      correlationId: 'corr-8',
      operatorRef: 'CHG-TEST',
      runStage: runner,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('missing_staff_id_in_response');
  });

  it('never re-runs or compensates an earlier committed stage when a later stage fails', () => {
    // A1/S1 đã commit độc lập ở service của chúng. Một bước sau thất bại phải
    // dừng procedure — không có bước xoá, rollback hay chạy lại bước trước, vì
    // compensating deletion của một Account hợp lệ đi ngược forward-fix.
    let verifyCalls = 0;
    const recorded = recordStages((request) => {
      if (request.action === 'verify') {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { ok: false, stage: 'account.verify', reason: 'no_bootstrap_account' }
          : success('account.verify', 'verified', { sub: `sub_${'g'.repeat(32)}` });
      }
      switch (request.action) {
        case 'provision':
          return success('account.provision', 'created', { sub: `sub_${'g'.repeat(32)}` });
        case 'staff-provision':
          return success('staff.provision', 'created', { staff_id: 'staff-1' });
        case 'staff-assign':
          return success('staff.assign', 'created', {
            staff_id: 'staff-1',
            assignment_id: 'asg-1',
          });
        case 'staff-verify':
          return { ok: false, stage: 'staff.verify', reason: 'audit_trail_missing' };
      }
    });

    const result = runBootstrapSuperadmin({
      correlationId: 'corr-no-compensate',
      operatorRef: 'CHG-1',
      runStage: recorded.runStage,
    });

    expect(result.outcome).toBe('failed');
    expect(result.failedStage).toBe('staff.verify');
    // Mỗi bước chạy đúng một lần, theo thứ tự canonical — không lần gọi thứ hai.
    expect(recorded.requests.map((r) => r.action)).toEqual([
      'verify',
      'provision',
      'verify',
      'staff-provision',
      'staff-assign',
      'staff-verify',
    ]);
    // Không có action nào ngoài năm action của procedure (không có "delete"/"rollback").
    expect(new Set(recorded.requests.map((r) => r.action)).size).toBe(5);
  });

  it('logs an execution failure as failed, never as a guard denial', () => {
    // `failed` và `denied` là hai kết luận khác nhau: lỗi chạy bước không được
    // đọc thành guard từ chối có chủ đích khi người vận hành đọc nhật ký.
    const result = runBootstrapSuperadmin({
      correlationId: 'corr-9',
      operatorRef: 'CHG-TEST',
      runStage: () => ({
        ok: false,
        stage: 'account.verify',
        reason: 'account_database_not_empty',
      }),
    });

    expect(result.outcome).toBe('failed');
    expect(result.stages.map((s) => s.outcome)).toEqual(['failed']);
    expect(result.stages.map((s) => s.outcome)).not.toContain('denied');
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

describe('assertOperatorRef', () => {
  it('accepts a trimmed change reference', () => {
    expect(assertOperatorRef('CHG-1234')).toBe('CHG-1234');
    expect(assertOperatorRef('ISSUE-17')).toBe('ISSUE-17');
    expect(assertOperatorRef('OPS_2026')).toBe('OPS_2026');
    expect(assertOperatorRef('a')).toBe('a');
  });

  it('rejects a reference outside the strict ASCII identifier charset', () => {
    // Chấm, gạch chéo, hai chấm, khoảng trắng, xuống dòng và ký tự điều khiển
    // đều bị từ chối theo charset mới.
    expect(() => assertOperatorRef('  ops/CHG:1234.5  ')).toThrow(/ASCII identifier/u);
    expect(() => assertOperatorRef('CHG 1')).toThrow(/ASCII identifier/u);
    expect(() => assertOperatorRef('CHG-1\nx')).toThrow(/ASCII identifier/u);
    expect(() => assertOperatorRef('CHG-1;rm -rf /')).toThrow(/ASCII identifier/u);
    expect(() => assertOperatorRef('a.b')).toThrow(/ASCII identifier/u);
    expect(() => assertOperatorRef('a:b')).toThrow(/ASCII identifier/u);
  });

  it('refuses a blank reference', () => {
    expect(() => assertOperatorRef('')).toThrow(/required/u);
    expect(() => assertOperatorRef('   ')).toThrow(/required/u);
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
