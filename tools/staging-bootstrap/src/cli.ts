import { spawnSync } from 'node:child_process';
import {
  BOOTSTRAP_STEPS,
  CANONICAL_SELLER_TENANT,
  CANONICAL_SUPERADMIN_EMAIL,
  CANONICAL_TENANT,
  unresolvedBlockers,
} from './contract.ts';
import { runBootstrapContract, type ExecResult } from './runner.ts';
import { buildRunEvidence } from './audit.ts';

/**
 * CLI entry của runner (chạy `node tools/staging-bootstrap/src/cli.ts <env>`
 * từ repo root). Skeleton fail-closed: chạy thật chỉ khả dụng khi mọi blocker
 * đã được hoá giải bằng evidence thật của #349/#351 và CLI bước auth đã tồn
 * tại ở app sở hữu.
 */

/** Danh sách environment hợp lệ — staging là mục tiêu duy nhất của #352. */
const VALID_ENVIRONMENTS = ['staging'] as const;

/**
 * Assert danh tính canonical theo ADR-0021 Q1: cấu hình chỉ được assert lại
 * đúng giá trị code quy định, procedure từ chối đầu vào không canonical.
 * Env override không khớp hằng canonical là lỗi fail-closed, không phải
 * cấu hình hợp lệ.
 */
export function assertCanonicalEnvironment(env: NodeJS.ProcessEnv): void {
  const checks: readonly (readonly [string, string])[] = [
    ['BOOTSTRAP_TENANT', CANONICAL_TENANT],
    ['BOOTSTRAP_SUPERADMIN_EMAIL', CANONICAL_SUPERADMIN_EMAIL],
    ['BOOTSTRAP_SELLER_TENANT', CANONICAL_SELLER_TENANT],
  ];
  for (const [name, expected] of checks) {
    const actual = env[name];
    if (actual !== undefined && actual !== expected) {
      throw new Error(
        `Refusing non-canonical ${name}=${JSON.stringify(actual)}; canonical value is ${JSON.stringify(expected)} (ADR-0021 Q1)`,
      );
    }
  }
}

export function parseArgs(args: readonly string[]): { environment: string } {
  const [environment] = args;
  if (
    environment === undefined ||
    !(VALID_ENVIRONMENTS as readonly string[]).includes(environment)
  ) {
    throw new Error(
      `Usage: node tools/staging-bootstrap/src/cli.ts <${VALID_ENVIRONMENTS.join('|')}>`,
    );
  }
  return { environment };
}

function execStep(argv: readonly string[], env: NodeJS.ProcessEnv): ExecResult {
  const [command, ...rest] = argv;
  const result = spawnSync(command ?? '', rest, {
    env,
    // stdout bắt lại để rút giá trị xuyên bước; stderr đi thẳng console cho
    // operator nhìn thấy lỗi thật của script sở hữu.
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const { environment } = parseArgs(argv);
  try {
    assertCanonicalEnvironment(env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const blockers = unresolvedBlockers();
  if (blockers.length > 0) {
    // Fail-closed theo §3.2: chưa đủ điều kiện tiền đề thì không bước nào
    // được phép chạy "một phần".
    process.stderr.write(
      `staging-bootstrap is blocked by ${blockers.length} unresolved blocker(s):\n`,
    );
    for (const blocker of blockers) process.stderr.write(`  - ${blocker}\n`);
    return 2;
  }

  const runId = `bootstrap-${new Date().toISOString()}`;
  const result = runBootstrapContract(BOOTSTRAP_STEPS, {
    execFn: execStep,
    baseEnv: env,
  });
  const evidence = buildRunEvidence(runId, environment, result, blockers);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return result.status === 'completed' ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.exit(main(process.argv.slice(2)));
}
