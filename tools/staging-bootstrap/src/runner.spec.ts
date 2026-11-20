import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_STEPS, type StepValues } from './contract.ts';
import { absorbStepValues, runBootstrapContract, type ExecResult } from './runner.ts';

function fakeExec(outputs: ExecResult[] = []) {
  const executed: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  let call = 0;
  const execFn = (argv: readonly string[], env: NodeJS.ProcessEnv): ExecResult => {
    executed.push([...argv]);
    envs.push({ ...env });
    return outputs[call++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { execFn, executed, envs };
}

describe('runBootstrapContract', () => {
  it('executes every step exactly once in BOOTSTRAP_STEPS order', () => {
    const { execFn, executed } = fakeExec();
    const result = runBootstrapContract(BOOTSTRAP_STEPS, { execFn, baseEnv: {} });
    expect(executed).toEqual(BOOTSTRAP_STEPS.map((step) => [...step.argv]));
    expect(result.status).toBe('completed');
  });

  it('stops at the first failing step and never executes later steps', () => {
    const { execFn, executed } = fakeExec([
      { status: 0, stdout: '', stderr: '' },
      { status: 1, stdout: '', stderr: 'boom' },
    ]);
    const result = runBootstrapContract(BOOTSTRAP_STEPS, { execFn, baseEnv: {} });
    expect(result.status).toBe('stopped');
    expect(executed).toEqual(BOOTSTRAP_STEPS.slice(0, 2).map((step) => [...step.argv]));
    const skipped = result.steps.filter((step) => step.skipped).map((step) => step.id);
    expect(skipped.length).toBe(BOOTSTRAP_STEPS.length - 2);
    expect(skipped).not.toContain('account');
    expect(skipped).not.toContain('staff');
  });

  it('carries sub and tenant_id to subprocess env only after they are produced', () => {
    const consumerIndex = BOOTSTRAP_STEPS.findIndex((step) => step.id === 'llm-consumer-tenant');
    const outputs = BOOTSTRAP_STEPS.map((step, index): ExecResult =>
      step.id === 'account'
        ? { status: 0, stdout: 'bootstrap-value sub=acct_123\n', stderr: '' }
        : index === consumerIndex
          ? { status: 0, stdout: 'bootstrap-value tenant_id=tn_777\n', stderr: '' }
          : { status: 0, stdout: '', stderr: '' },
    );
    const { execFn, envs } = fakeExec(outputs);
    const result = runBootstrapContract(BOOTSTRAP_STEPS, { execFn, baseEnv: { HOME: '/h' } });

    expect(envs[0].BOOTSTRAP_SUB).toBeUndefined();
    expect(envs[1].BOOTSTRAP_SUB).toBe('acct_123');
    expect(result.values.sub).toBe('acct_123');

    expect(envs[consumerIndex].BOOTSTRAP_TENANT_ID).toBeUndefined();
    expect(envs[consumerIndex + 1]?.BOOTSTRAP_TENANT_ID).toBe('tn_777');
    expect(result.values.tenantId).toBe('tn_777');
  });

  it('passes the parent env through unchanged and injects nothing else', () => {
    const { execFn, envs } = fakeExec();
    runBootstrapContract(BOOTSTRAP_STEPS, { execFn, baseEnv: { PGHOST: 'h', PATH: '/bin' } });
    for (const env of envs) {
      expect(env.PGHOST).toBe('h');
      expect(Object.keys(env).filter((key) => key.startsWith('BOOTSTRAP_'))).toEqual([]);
    }
  });

  it('accepts pre-existing values for re-entry after a converged prefix', () => {
    const { execFn, envs } = fakeExec();
    const result = runBootstrapContract(BOOTSTRAP_STEPS.slice(0, 2), {
      execFn,
      baseEnv: {},
      initialValues: { sub: 'prior_sub' },
    });
    expect(envs[0].BOOTSTRAP_SUB).toBe('prior_sub');
    expect(result.values.sub).toBe('prior_sub');
  });

  it('writes no state files or markers anywhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-bootstrap-'));
    try {
      const prev = process.cwd();
      process.chdir(dir);
      try {
        runBootstrapContract(BOOTSTRAP_STEPS, {
          execFn: () => ({ status: 1, stdout: '', stderr: '' }),
          baseEnv: {},
        });
      } finally {
        process.chdir(prev);
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('absorbStepValues', () => {
  it('absorbs sub only from the account step and tenant_id only from the consumer-tenant step', () => {
    const values: StepValues = { sub: 'keep' };
    absorbStepValues('staff', 'bootstrap-value sub=other\n', values);
    expect(values.sub).toBe('keep');
    absorbStepValues('llm-marketplace', 'bootstrap-value tenant_id=x\n', values);
    expect(values.tenantId).toBeUndefined();
  });

  it('ignores non-value stdout noise', () => {
    const values: { sub?: string; tenantId?: string } = {};
    absorbStepValues('account', 'some log line\nsub=raw\nbootstrap-value tenant_id=y\n', values);
    expect(values.sub).toBeUndefined();
    expect(values.tenantId).toBeUndefined();
  });
});
