import type { BootstrapStep, StepValues } from './contract.ts';

/**
 * Runner seed mỏng theo ADR-0020 Quyết định 12: việc duy nhất của nó là chạy
 * các bước theo đúng thứ tự canonical, truyền giá trị `sub`/`tenant_id` từ
 * bước trước sang bước sau và DỪNG khi một bước fail. Runner:
 * - không giữ credential database nào — subprocess kế thừa env của process
 *   cha (credential do pipeline/workflow inject, runner chỉ trung chuyển);
 * - không ghi trực tiếp database của service nào — chỉ gọi CLI của chính
 *   service sở hữu dữ liệu như tiến trình con;
 * - không có file trạng thái, không bảng marker, không đọc log để quyết định
 *   bước kế tiếp (§3.2 idempotency bằng natural key) — checkpoint là sự hội
 *   tụ của chính các bước: chạy lại toàn bộ hợp đồng từ đầu là cơ chế phục
 *   hồi duy nhất với tiền tố hợp lệ (ADR-0020 Quyết định 6, §3a.5 mục F).
 */

/** Kết quả một lần exec — inject để spec chạy không cần subprocess thật. */
export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunnerDeps {
  execFn: (argv: readonly string[], env: NodeJS.ProcessEnv) => ExecResult;
  /** env gốc của process cha — credential trung chuyển, runner không giữ. */
  baseEnv: NodeJS.ProcessEnv;
  /** Giá trị đã có từ trước (ví dụ chạy lại sau khi bước 3 đã commit). */
  initialValues?: StepValues;
}

export interface StepEvidence {
  readonly id: string;
  readonly service: string;
  readonly database: string;
  /** `null` khi bước bị skip (chưa chạy tới) — không phải mã thoát thật. */
  readonly exit: number | null;
  readonly durationMs: number;
  readonly skipped: boolean;
}

export interface RunResult {
  readonly status: 'completed' | 'stopped';
  readonly steps: readonly StepEvidence[];
  readonly values: StepValues;
}

/** Run ngừng ở bước fail; các bước chưa tới được đánh dấu skipped trong evidence. */
export function runBootstrapContract(steps: readonly BootstrapStep[], deps: RunnerDeps): RunResult {
  const values: StepValues = { ...deps.initialValues };
  const evidence: StepEvidence[] = [];
  let stopped = false;

  for (const step of steps) {
    if (stopped) {
      evidence.push({
        id: step.id,
        service: step.service,
        database: step.database,
        exit: null,
        durationMs: 0,
        skipped: true,
      });
      continue;
    }
    const startedAt = Date.now();
    // env của subprocess = env cha + các giá trị đầu ra xuyên bước. Giá trị
    // đi qua env, không qua argv — argv của process đọc được qua /proc.
    const env: NodeJS.ProcessEnv = { ...deps.baseEnv };
    if (values.sub !== undefined) env.BOOTSTRAP_SUB = values.sub;
    if (values.tenantId !== undefined) env.BOOTSTRAP_TENANT_ID = values.tenantId;

    const result = deps.execFn(step.argv, env);
    evidence.push({
      id: step.id,
      service: step.service,
      database: step.database,
      exit: result.status,
      durationMs: Date.now() - startedAt,
      skipped: false,
    });

    if (result.status !== 0) {
      stopped = true;
      continue;
    }
    absorbStepValues(step.id, result.stdout, values);
  }

  return { status: stopped ? 'stopped' : 'completed', steps: evidence, values };
}

/**
 * Rút giá trị đầu ra xuyên bước từ stdout của CLI. Hợp đồng stdout của từng
 * script là của chính service sở hữu — runner chỉ nhận biết hai giá trị đã
 * được ADR chốt là dependency xuyên unit: `sub` (bước account → mọi bước sau)
 * và `tenant_id` (bước consumer-tenant → financial, ADR-0028 §6). Script in
 * `bootstrap-value <key>=<value>` trên một dòng riêng; script chưa phát dòng
 * đó là một khoản nợ để executing PR của #352 trả khi nối wire thật.
 */
export function absorbStepValues(stepId: string, stdout: string, values: StepValues): void {
  for (const match of stdout.matchAll(/^bootstrap-value\s+([a-z_]+)=(\S+)\s*$/gmu)) {
    const [, key, value] = match;
    if (key === 'sub' && stepId === 'account') {
      values.sub = value;
      continue;
    }
    if (key === 'tenant_id' && stepId === 'llm-consumer-tenant') {
      values.tenantId = value;
      continue;
    }
    process.stderr.write(
      `staging-bootstrap: ignoring bootstrap-value ${key} emitted by step ${stepId} — no consumer at this step\n`,
    );
  }
}
