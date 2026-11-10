import { randomUUID } from 'node:crypto';

import { defineCommand } from 'citty';

import {
  assertCanonicalBootstrapEmail,
  runBootstrapSuperadmin,
  type BootstrapRunResult,
} from './bootstrap-superadmin.js';
import { createSpawnStageRunner } from './stage-process.js';

/** Định danh ASCII in được — dùng cho cả `operator_ref` lẫn correlation id. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

/** Định danh ASCII strict cho `operator_ref`: chữ, số, `_` và `-`, bắt đầu bằng chữ hoặc số. */
const OPERATOR_REF = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * Entry `pnpm dx bootstrap-superadmin`.
 *
 * Đây là entry point vận hành duy nhất của procedure first-administrator
 * (ADR-0020 Quyết định 12): nó **không** giữ credential database nào, không
 * mở kết nối, không ghi database — mỗi bước chạy như tiến trình con của
 * service sở hữu dữ liệu.
 *
 * Credential của hai database đi qua **env** của tiến trình này
 * (`ECOMA_ACCOUNT_DATABASE_URL`, `ECOMA_STAFF_ACCESS_DATABASE_URL`) và được
 * chuyển cho đúng con dưới tên `DATABASE_URL`. Không có flag nào nhận chuỗi
 * kết nối: argv nằm trong `ps` và shell history.
 */
export default defineCommand({
  meta: {
    name: 'bootstrap-superadmin',
    description:
      'Run the first-administrator bootstrap procedure (preflight, Account, Staff Access) through each service-owned offline CLI',
  },

  args: {
    'correlation-id': {
      type: 'string',
      description:
        'Correlation id shared by every stage and every audit row of this run; defaults to a fresh random UUID',
      required: false,
    },
    'operator-ref': {
      type: 'string',
      description:
        'Required self-declared attribution of the operator (change/ticket id) recorded in audit; not a verified identity',
      required: false,
    },
  },

  run({ args }) {
    const rawCorrelationId = args['correlation-id'];
    const correlationId =
      typeof rawCorrelationId === 'string' && rawCorrelationId.length > 0
        ? rawCorrelationId
        : randomUUID();
    const operatorRef = typeof args['operator-ref'] === 'string' ? args['operator-ref'] : '';

    // Cùng lý do với `operator_ref`: giá trị này được in ra console và đi vào
    // audit metadata. Một correlation id chứa xuống dòng có thể chèn một dòng
    // `[bootstrap-superadmin] done: …` giả vào nhật ký của một lần chạy thất bại.
    if (!IDENTIFIER.test(correlationId)) {
      console.error(
        '[bootstrap-superadmin] --correlation-id must be an ASCII identifier (letters, digits, . _ : / -).',
      );
      process.exitCode = 1;
      return;
    }

    if (operatorRef !== '' && !OPERATOR_REF.test(operatorRef)) {
      console.error(
        '[bootstrap-superadmin] --operator-ref must be an ASCII identifier (letters, digits, _ and - only, starting with a letter or digit).',
      );
      process.exitCode = 1;
      return;
    }

    try {
      // Cấu hình environment chỉ **assert** danh tính canonical; khác hằng thì
      // procedure từ chối chạy trước khi chạm database nào.
      assertCanonicalBootstrapEmail(process.env['ECOMA_BOOTSTRAP_EMAIL']);
    } catch (error) {
      console.error(
        `[bootstrap-superadmin] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`[bootstrap-superadmin] correlation id: ${correlationId}`);

    const result = runBootstrapSuperadmin({
      correlationId,
      operatorRef,
      runStage: createSpawnStageRunner(),
    });

    printResult(result);
    process.exitCode = result.outcome === 'bootstrapped' ? 0 : 1;
  },
});

/** In kết quả từng bước — không in payload, không in env, không in stderr thô. */
function printResult(result: BootstrapRunResult): void {
  for (const entry of result.stages) {
    const detail = entry.detail === undefined ? '' : ` (${entry.detail})`;
    console.log(`  ${entry.stage.padEnd(24)} ${entry.outcome}${detail}`);
  }

  switch (result.outcome) {
    case 'bootstrapped':
      console.log(`[bootstrap-superadmin] done: sub ${result.sub ?? '<unknown>'}`);
      console.log(
        '[bootstrap-superadmin] no session was issued. The Superadmin must sign in through the normal passwordless OTP flow.',
      );
      return;
    case 'guard_denied':
      console.log(
        '[bootstrap-superadmin] denied by the measured guard: measured administrators are non-zero, so this step wrote nothing. This is not a completed bootstrap.',
      );
      return;
    case 'failed':
      console.error(
        `[bootstrap-superadmin] failed at ${result.failedStage ?? '<unknown>'} with reason ${result.reason ?? '<unknown>'}`,
      );
      return;
  }
}
