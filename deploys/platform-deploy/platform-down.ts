/**
 * Down-core của `platform-deploy` — phần teardown của entry colocated
 * (`deploys/platform-deploy/local.ts`), tách thành module để spec bấm được
 * ma trận lỗi thật (destroy fail / volume rm fail / cả hai) qua injection,
 * không cần Docker hay Pulumi thật (cùng hình test seam với `runLocalCleanup`).
 *
 * Contract: xoá volume PostgreSQL là hành vi MẶC ĐỊNH và VÔ ĐIỀU KIỆN của
 * down — KHÔNG có tuỳ chọn nào để giữ lại dữ liệu local (cờ `--remove-data`
 * cũ đã bị xoá hoàn toàn, không thay bằng cờ/config tương đương). Hai bước
 * chạy tuần tự (down trực tiếp, không khóa lane toàn cục):
 *
 * 1. `pulumi destroy --yes` — lỗi được BẮT và báo rõ, KHÔNG chặn bước 2:
 *    lời hứa của down là XOÁ DỮ LIỆU, nên volume vẫn phải bị xoá kể cả khi
 *    stack Pulumi đã biến mất (`pulumi stack rm` ngoài luồng, state hỏng...)
 *    hay destroy lỗi thật (daemon down, sai passphrase...). Nhưng destroy lỗi
 *    VẪN LÀ LỖI: thông điệp lỗi riêng được in và exit code phải non-zero —
 *    không bao giờ nuốt.
 * 2. `docker volume rm` với đúng TÊN duy nhất namespace-scoped — KHÔNG BAO
 *    GIỜ lệnh rộng (`docker volume prune`, wildcard...); chỉ volume mang tên
 *    `ecoma-<ns>-postgres-volume` mà chương trình Pulumi của deployment này
 *    tạo. Volume vắng mặt ("no such volume") được chấp nhận như thành công
 *    idempotent — down chạy hai lần liền phải exit 0 lần hai, cùng ngữ nghĩa
 *    với `pulumi destroy` trên stack rỗng (Pulumi tự trả exit 0); phân loại
 *    dùng cùng pattern với `probePostgresVolume`. MỌI kết quả non-zero khác
 *    (volume in use — container chưa sạch sau destroy lỗi, daemon down,
 *    spawn fail) là THẤT BẠI thật, không bao giờ được nuốt.
 *
 * Exit code: 0 chỉ khi CẢ hai bước đạt (destroy ok + volume xoá được HOẶC
 * đã vắng mặt); non-zero khi BẤT KỶ bước nào thất bại. Mỗi bước in thông
 * điệp kết quả riêng, cả hai thất bại thì cả hai thông điệp lỗi đều hiện —
 * không có thông báo thành công tổng nào được in khi còn bước thất bại.
 *
 * `retainOnDelete` của volume trong chương trình Pulumi là mảnh ghép bắt buộc
 * của contract này: destroy KHÔNG được tự xoá volume, nếu không bước 2 thành
 * no-op chết và lỗi destroy không thể tách khỏi lỗi xoá volume (xem comment
 * của `postgresVolume` trong `deploys/platform-deploy/index.ts`).
 */
// oxlint-disable no-console -- teardown CLI chạy trên Node; console là kênh
// output DUY NHẤT báo kết quả từng bước (nx:run-commands gộp stdout/stderr).

import { join } from 'node:path';

import {
  describeSpawnFailure,
  dockerResourceName,
  exec,
  pulumiDestroyForEntry,
  type EntryFoundation,
  type ExecResult,
} from '@ecoma-io/deployment';

/** Root của workspace, suy từ vị trí file này (`deploys/platform-deploy`). */
const WORKSPACE_ROOT = join(import.meta.dirname, '../..');

/**
 * Pattern phân loại "volume không tồn tại" trên stderr/stdout của docker —
 * CÙNG hình với `probePostgresVolume` (một nguồn sự thật cho ngữ nghĩa
 * vắng mặt; docker in thông điệp khác nhau theo phiên bản).
 */
const VOLUME_ABSENT_PATTERN = /not found|no such volume/iu;

function execDockerDefault(args: string[], env: NodeJS.ProcessEnv): ExecResult {
  return exec('docker', args, WORKSPACE_ROOT, env);
}

/**
 * Test seams — inject thay `pulumiDestroyForEntry`/lệnh docker thật để spec
 * chạy ma trận lỗi mà không chạm Docker/Pulumi. Default là thật.
 */
export interface PlatformDownDeps {
  destroy?: (project: string, foundation: EntryFoundation) => void;
  execDocker?: (args: string[], env: NodeJS.ProcessEnv) => ExecResult;
}

/**
 * Chạy down của `platform-deploy`: destroy stack rồi xoá volume PostgreSQL
 * của namespace — vô điều kiện, hai kết quả được theo dõi riêng (xem contract
 * ở header module). Trả exit code cho caller (`process.exit`).
 */
export async function runPlatformDown(
  foundation: EntryFoundation,
  deps: PlatformDownDeps = {},
): Promise<number> {
  const destroy = deps.destroy ?? pulumiDestroyForEntry;
  const execDocker = deps.execDocker ?? execDockerDefault;
  const volumeName = dockerResourceName(foundation.ctx.namespace, 'postgres-volume');

  let destroyFailure: string | undefined;
  try {
    destroy('platform-deploy', foundation);
  } catch (error) {
    destroyFailure = error instanceof Error ? error.message : String(error);
    console.error(`[platform-deploy] pulumi destroy failed:\n${destroyFailure}`);
    console.error(
      '[platform-deploy] continuing with the PostgreSQL volume deletion — the volume belongs to ' +
        'this deployment and must be removed regardless; resolve the destroy failure separately.',
    );
  }

  console.warn(
    `[platform-deploy] deleting PostgreSQL volume ${volumeName} — the local database ` +
      'data of this worktree will be permanently lost.',
  );
  let volumeFailure: string | undefined;
  const removal = execDocker(['volume', 'rm', volumeName], process.env);
  if (removal.status !== 0) {
    const combined = `${removal.stderr}\n${removal.stdout}`;
    if (removal.status !== null && VOLUME_ABSENT_PATTERN.test(combined)) {
      console.log(
        `[platform-deploy] volume ${volumeName} is already absent — idempotent down, ` +
          'nothing to delete.',
      );
    } else {
      volumeFailure =
        removal.status === null
          ? describeSpawnFailure(removal)
          : removal.stderr.trim() || removal.stdout.trim() || 'unknown docker error';
      console.error(`[platform-deploy] PostgreSQL volume deletion failed:\n${volumeFailure}`);
    }
  } else {
    console.log(`[platform-deploy] volume ${volumeName} deleted.`);
  }

  return destroyFailure === undefined && volumeFailure === undefined ? 0 : 1;
}
