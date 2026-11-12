import { defineCommand } from 'citty';

import { checkProjectReadmes, type CheckReadmesOptions } from './readme-checker.js';
import { collectReadmeTargets, ReadmeGraphError } from './project-graph.js';
import { formatFinding } from './findings.js';

/**
 * Entry `pnpm dx readme-check`.
 *
 * Exit code: `0` khi mọi project đạt contract; `1` khi có finding; `2` khi
 * chính checker không chạy được (graph Nx không đọc được — fail-closed, một
 * CI gate không được phép báo xanh khi chưa kiểm được gì). caddy `run()` chỉ
 * đặt `process.exitCode` thay vì `process.exit()` để stdout kịp flush — cùng
 * lý do arch-check và pr-check làm vậy.
 */
export default defineCommand({
  meta: {
    name: 'readme-check',
    description:
      'Validate every Nx project README.md against the README contract (one H1, six required H2 sections, resolvable internal links)',
  },

  args: {
    json: {
      type: 'boolean',
      description:
        'Emit machine-readable JSON: { "findings": [...], "summary": { projects, findings, externalLinks } }',
    },
  },

  run(context) {
    const options: CheckReadmesOptions = {};

    let targets;
    try {
      targets = collectReadmeTargets();
    } catch (error) {
      // Graph không đọc được là lỗi của checker, không phải finding của project:
      // exit 2 để một gate trong tương lai phân biệt được "failed" với "violations".
      if (error instanceof ReadmeGraphError) {
        console.error(`readme-check could not collect Nx projects: ${error.message}`);
      } else {
        console.error(
          `readme-check could not run the Nx project graph: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exitCode = 2;
      return;
    }

    const result = checkProjectReadmes(targets, options);

    if (context.args.json === true) {
      console.log(
        JSON.stringify(
          {
            findings: result.findings,
            summary: result.summary,
          },
          null,
          2,
        ),
      );
    } else {
      for (const finding of result.findings) {
        console.log(formatFinding(finding));
      }
      console.log(
        `readme-check: ${result.summary.projects} projects checked, ${result.summary.findings} findings, ` +
          `${result.summary.externalLinks} external links detected (never fetched)`,
      );
    }

    process.exitCode = result.summary.findings > 0 ? 1 : 0;
  },
});
