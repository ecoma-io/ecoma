/**
 * Khám phá Nx project cho readme-check.
 *
 * Cơ chế: MỘT lần gọi `nx graph --print` cho toàn workspace (không spawn theo
 * từng project — 91 project nghĩa là 91 lần boot Nx, bị cấm). Graph JSON chứa
 * đúng các project node với `data.root`, tức đủ để biết README phải nằm ở đâu,
 * nên không cần thêm `nx show projects` — xem phần benchmark bên dưới.
 *
 * Vì sao không in-process (`createProjectGraphAsync`) — lựa chọn ưu tiên:
 * `nx` là devDependency ở ROOT của workspace, không phải dependency của
 * `tools/dx`; dưới pnpm layout cách ly, `import 'nx/src/project-graph/project-graph'`
 * từ `tools/dx` ném `ERR_MODULE_NOT_FOUND` (đã kiểm). Thêm `nx` vào dependency
 * của `tools/dx` nằm ngoài scope lock của Issue #134. Vì vậy dùng một lệnh
 * CLI one-shot, đúng dạng mà brief cho phép khi có benchmark và lý do.
 *
 * Vì sao MỘT lệnh thay vì hai (`nx show projects` + `nx graph` như `arch-check`):
 * đo ấm trên workspace này cho thấy mỗi lần boot Nx ~450–650ms, hai lần ~1.0–1.2s
 * — cộng tsx startup ~360ms thì vượt mục tiêu warm < 1s. `nx graph --print`
 * trả đúng 91 project node trùng khớp 1-1 với `nx show projects` (đã đối
 * chiếu), nên một lần gọi không mất project nào. Fail-closed giữ nguyên:
 * graph không parse được, rỗng, hoặc một node thiếu `root` đều là lỗi của
 * checker (exit 2), không phải bỏ qua lặng lẽ.
 *
 * Không hardcode tên project hay đường dẫn: danh sách đọc tại runtime, project
 * mới tự lọt vào phạm vi kiểm khi Nx thấy nó.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT_DIR } from '../utils.js';

/** Project cần kiểm README: tên Nx và thư mục root tương đối so với repo root. */
export interface ReadmeTarget {
  name: string;
  /** Thư mục root của project, tương đối repo root, phân tách `/`. */
  root: string;
}

/** Hình dạng `nx graph --print` trả về mà phần này dùng. */
export interface NxGraphJson {
  graph: {
    nodes: Record<string, { name: string; data: { root?: string } }>;
  };
}

/** Danh sách project và graph lệch nhau — workspace chưa sẵn sàng để kiểm. */
export class ReadmeGraphError extends Error {
  readonly missingProjects: readonly string[];

  constructor(message: string, missingProjects: readonly string[] = []) {
    super(message);
    this.name = 'ReadmeGraphError';
    this.missingProjects = missingProjects;
  }
}

/**
 * Chọn đích README từ danh sách project authoritative và graph.
 *
 * Giữ tham số `names` tách khỏi graph dù `collectReadmeTargets` lấy cả hai từ
 * cùng một graph: (1) hàm thuần, unit test được mismatch mà không cần corrupt
 * workspace thật; (2) nếu sau này nguồn `names` đổi (ví dụ quay lại hai lệnh),
 * property fail-closed "project có trong danh sách mà vắng graph" vẫn còn.
 * Project có trong danh sách mà vắng graph là lỗi dữ liệu — không skip lặng lẽ,
 * vì một project bị bỏ qua là một project không ai kiểm README.
 */
export function selectReadmeTargets(names: readonly string[], graph: NxGraphJson): ReadmeTarget[] {
  const missing = names.filter((name) => !graph.graph.nodes[name]);
  if (missing.length > 0) {
    throw new ReadmeGraphError(
      'workspace projects missing from the Nx project graph — ' +
        'readme-check refuses to validate a partial graph: ' +
        missing.join(', '),
      missing,
    );
  }

  const targets: ReadmeTarget[] = [];
  for (const name of names) {
    const root = graph.graph.nodes[name].data.root;
    // Không có root thì không biết README phải nằm ở đâu — fail-closed đúng như
    // project vắng graph, không default về thư mục nào cả.
    if (typeof root !== 'string' || root === '') {
      throw new ReadmeGraphError(
        `Nx project "${name}" has no root in the project graph — readme-check cannot locate its README`,
        [],
      );
    }
    targets.push({ name, root });
  }
  return targets;
}

/**
 * Kéo danh sách project + root từ Nx cho toàn workspace (read-only, một lệnh).
 * Graph rỗng là lỗi: một lần chạy không thấy project nào là dấu hiệu Nx trả
 * dữ liệu hỏng, không phải workspace rỗng hợp lệ.
 */
export function collectReadmeTargets(): ReadmeTarget[] {
  const rawGraph = execFileSync(
    process.execPath,
    [join(ROOT_DIR, 'node_modules/nx/dist/bin/nx.js'), 'graph', '--print'],
    { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  let graph: NxGraphJson;
  try {
    graph = JSON.parse(rawGraph) as NxGraphJson;
  } catch {
    throw new ReadmeGraphError('nx graph --print did not return valid JSON');
  }

  const names = Object.keys(graph.graph?.nodes ?? {});
  if (names.length === 0) {
    throw new ReadmeGraphError('nx graph --print returned no project nodes');
  }

  return selectReadmeTargets(names, graph);
}
