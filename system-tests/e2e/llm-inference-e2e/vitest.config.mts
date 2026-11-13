// Vitest config của suite E2E inference (Issues #23/#24).
//
// `fileParallelism: false` là CONTRACT thứ tự: các spec chia sẻ trạng thái
// database và lịch sử serving của MỘT lane (tên bảng, số dòng ledger), chạy
// song song là race giữa 02-serving và 03-auth-failures khi đếm dòng. Sequencer
// mặc định của vitest sort file theo SIZE giảm dần (02 lớn hơn 01 nên chạy
// TRƯỚC) — sai kịch bản, nên sequencer riêng ghim thứ tự TÊN tăng dần
// (`01-` → `04-`, đúng thứ tự kịch bản có chủ đích).
//
// `globalSetup` là readiness gate fail-closed (06-testing.md §2): probe /health
// → /ready của worker TỪ TRONG network qua container ephemeral — suite KHÔNG
// BAO GIỜ skip khi stack chưa sẵn sàng, chỉ fail với evidence. Readiness của
// mock (cần credential upstream mà suite không giữ) thuộc `test-lane-up`.
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { defineConfig } from 'vitest/config';

class FilenameOrderSequencer extends BaseSequencer {
  public override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files.toSorted((a, b) =>
      a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0,
    );
  }
}

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/system-tests/llm-inference-e2e',
  test: {
    name: '@ecoma-io/llm-inference-e2e',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.spec.ts'],
    globalSetup: './global-setup.ts',
    reporters: ['default'],
    // Docker exec + client ephemeral trên lane local chậm hơn HTTP thuần —
    // trần mỗi test/hook dư cho lần chạy đầu trên máy lạnh.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    sequence: { sequencer: FilenameOrderSequencer },
  },
}));
