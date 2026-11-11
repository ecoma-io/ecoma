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
    'resolve-if-bootstrapped': {
      type: 'boolean',
      description:
        'Resolve an already-bootstrapped environment read-only (outcome "resolved"); run the full guarded bootstrap only on a fresh environment',
      required: false,
    },
    json: {
      type: 'boolean',
      description:
        'Machine-readable output: print a single-line JSON result envelope as the last stdout line; stage progress goes to stderr',
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
    const resolveIfBootstrapped = args['resolve-if-bootstrapped'] === true;
    const jsonOutput = args['json'] === true;

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

    // Ở chế độ --json stdout chỉ mang envelope cuối cùng: người đọc máy đọc
    // dòng cuối cùng của stdout, nên mọi dòng dành cho con người (id tương quan
    // và bảng stage) dịch sang stderr. Chưa có stage nào chạy lúc này, nên dòng
    // id tương quan chỉ là đầu ra tiến trình.
    if (jsonOutput) {
      console.error(`[bootstrap-superadmin] correlation id: ${correlationId}`);
    } else {
      console.log(`[bootstrap-superadmin] correlation id: ${correlationId}`);
    }

    const result = runBootstrapSuperadmin({
      correlationId,
      operatorRef,
      runStage: createSpawnStageRunner(),
      mode: resolveIfBootstrapped ? 'resolve-or-bootstrap' : 'bootstrap',
    });

    if (jsonOutput) {
      // Human-readable stage progress stays available on stderr; stdout is
      // reserved for the single-line envelope the deploy lane parses.
      for (const entry of result.stages) {
        const detail = entry.detail === undefined ? '' : ` (${entry.detail})`;
        console.error(`  ${entry.stage.padEnd(24)} ${entry.outcome}${detail}`);
      }
      console.log(JSON.stringify(resultEnvelope(result)));
    } else {
      printResult(result);
    }
    // `resolved` là lần chạy hoàn tất đối với người tiêu dùng mã thoát: môi
    // trường đã hội tụ và không có gì cần ghi.
    process.exitCode = result.outcome === 'bootstrapped' || result.outcome === 'resolved' ? 0 : 1;
  },
});

/**
 * Bản chiếu cho máy đọc của một lần chạy — hợp đồng của `--json`.
 *
 * Thứ tự khóa cố định (`outcome` trước, rồi `correlationId`), trường tùy chọn
 * bị bỏ qua khi không có: người tiêu dùng (bước giải quyết trong
 * `deploys/pact-broker-api-deploy/local.ts`) đọc `outcome` để quyết định thành
 * công và `sub` làm chủ thể sở hữu tenant. Không có payload stage, không có
 * biến môi trường, không có credential nào từng đi vào đối tượng này.
 */
function resultEnvelope(result: BootstrapRunResult): Record<string, string> {
  const envelope: Record<string, string> = {
    outcome: result.outcome,
    correlationId: result.correlationId,
  };
  if (result.sub !== undefined) envelope['sub'] = result.sub;
  if (result.staffId !== undefined) envelope['staffId'] = result.staffId;
  if (result.assignmentId !== undefined) envelope['assignmentId'] = result.assignmentId;
  if (result.failedStage !== undefined) envelope['failedStage'] = result.failedStage;
  if (result.reason !== undefined) envelope['reason'] = result.reason;
  return envelope;
}

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
    case 'resolved':
      console.log(`[bootstrap-superadmin] resolved: sub ${result.sub ?? '<unknown>'}`);
      console.log(
        '[bootstrap-superadmin] the environment was already bootstrapped; this run verified the existing administrator read-only and performed no write.',
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
