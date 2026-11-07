/**
 * `pnpm dx local-cleanup` — dọn Docker resource mồ côi của worktree đã bị xoá.
 *
 * Mục tiêu VÀ ranh giới: tìm mọi resource local deployment (network, container,
 * volume) mà worktree sở hữu nó KHÔNG CÒN tồn tại trên đĩa, rồi xoá trực tiếp —
 * KHÔNG có teardown theo thứ tự phụ thuộc (Traefik trước home trước platform):
 * Docker tự xử lý được vì không resource nào trong local deployment phụ thuộc
 * vòng sống vào resource khác sau khi worktree biến mất.
 *
 * An toàn là tính chất ĐẦU TIÊN, không phải kiểm tra cuối:
 * - Ownership phải được chứng minh bằng label (`deploy-labels` của `@ecoma-io/deployment`): resource
 *   thiếu label, sai giá trị hay metadata mâu thuẫn KHÔNG bao giờ bị xoá, dù
 *   tên có trông giống resource ecoma.
 * - Worktree còn tồn tại trên đĩa (theo `normalizeWorktreeRoot` — path phải
 *   resolve được) là worktree SỐNG, resource của nó được giữ nguyên kể cả nếu
 *   developer đang không deploy.
 * - PostgreSQL volume bị XOÁ như mọi resource mồ côi đủ điều kiện khác —
 *   cùng contract với down của `platform-deploy` (down xoá volume vô điều
 *   kiện, không còn opt-in giữ dữ liệu). An toàn của volume không nằm ở hành
 *   vi "giữ" mà ở chính các check ownership + presence: thiếu label, metadata
 *   mâu thuẫn hay worktree còn sống là volume KHÔNG bao giờ bị xoá.
 * - Docker daemon không nói được / metadata not-readable ⇒ fail an toàn, không
 *   xoá gì.
 *
 * Thứ tự trong `CLEANUP_KINDS` là containers TRƯỚC network: `docker network rm`
 * trên network còn active endpoints thất bại ("has active endpoints" — đo
 * thật), nên một orphan set hoàn chỉnh lần đầu chạy sẽ fail ở network nếu
 * containers chưa sạch. Đó KHÔNG phải teardown theo thứ tự phụ thuộc (không có
 * orchestration state, không retry giữa các kind) — chỉ là xếp kind ít lỗi nhất
 * lên trước, vì mỗi kind vẫn được xử lý độc lập.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve, normalize } from 'node:path';

import {
  classifyOwnership,
  labelsFromInspect,
  type DeployResourceKind,
  dockerResourceName,
  LABEL_MANAGED_BY,
  LABEL_MANAGED_BY_VALUE,
  NAMESPACE_LENGTH,
  normalizeWorktreeRoot,
  OWNERSHIP_LABELS,
  type OwnershipCheck,
  type ExecResult,
} from '@ecoma-io/deployment';

/**
 * Kind volume PostgreSQL trong `CLEANUP_KINDS` — được cleanup XOÁ như mọi
 * resource mồ côi đủ điều kiện (labels ownership hợp lệ + worktree confirmed
 * absent), cùng contract với down vô điều kiện của `platform-deploy`.
 */
export const POSTGRES_VOLUME_KIND: DeployResourceKind = 'postgres-volume';

export const CLEANUP_KINDS: readonly DeployResourceKind[] = [
  'traefik',
  'postgres',
  'home',
  'backoffice',
  'account',
  'auth-wic',
  'auth-wic-state-init',
  'pact-app',
  // WIC của pact-broker-api-deploy. Lưu ý KHÔNG có kind `pact-api`: nó chỉ đặt
  // tên các `command.local.Command` (provision/migrate/seed chạy qua `docker
  // exec`/`docker run --rm`) — không tạo container/volume/image/network nào
  // tồn lại sau lệnh, giống kind `auth` của account-deploy.
  'pact-api-wic',
  'pact-api-wic-state-init',
  'mail-wic',
  'mail-wic-state-init',
  'push-wic',
  'push-wic-state-init',
  // WIC của staff-access-deploy (P1.4 #428). Kind `staff-access` giống kind
  // `pact-api`: chỉ đặt tên command.local.Command (provision/migrate) —
  // không tạo container/volume nào tồn lại sau lệnh.
  'staff-access-wic',
  'staff-access-wic-state-init',
  // WIC của remote-cache-deploy (P4.1 #442). Kind `remote-cache` giống kind
  // `pact-api`: chỉ đặt tên command.local.Command (provision/migrate) —
  // không tạo container/volume nào tồn lại sau lệnh.
  'remote-cache-wic',
  'remote-cache-wic-state-init',
  'network',
  'home-image',
  'backoffice-image',
  'account-image',
  'auth-wic-image',
  'pact-app-image',
  'pact-api-wic-image',
  'mail-wic-image',
  'push-wic-image',
  'staff-access-wic-image',
  'remote-cache-wic-image',
  'postgres-volume',
  'auth-wic-state',
  'pact-api-wic-state',
  'mail-wic-state',
  'push-wic-state',
  'staff-access-wic-state',
  'remote-cache-wic-state',
];

export interface CleanupFilter {
  /** Worktree root filter (diagnostics only — không weaken checks). */
  worktreeRoot?: string;
  /** Dry-run: không destructive operation nào. */
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  /**
   * Test seams — inject thay `execDocker`/`worktreeAlive` để spec chạy logic
   * quyết định mà không cần Docker thật. Default là thật.
   */
  execDocker?: (args: string[], env: NodeJS.ProcessEnv) => ExecResult;
  worktreePresence?: (path: string) => WorktreePresence;
}

export interface CleanupReportEntry {
  kind: DeployResourceKind;
  name: string;
  worktreePath?: string;
  action: 'removed' | 'would-remove' | 'kept' | 'skipped';
  reason: string;
}

export interface CleanupReport {
  entries: CleanupReportEntry[];
  errors: string[];
}

function execDocker(args: string[], env: NodeJS.ProcessEnv): ExecResult {
  try {
    const stdout = execFileSync('docker', args, {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error: unknown) {
    const e = error as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      status: typeof e.status === 'number' ? e.status : null,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

export type DockerCommandType = 'container' | 'network' | 'volume' | 'image';

export function dockerList(
  kind: DockerCommandType,
  env: NodeJS.ProcessEnv,
  dockerExec: (args: string[], env: NodeJS.ProcessEnv) => ExecResult = execDocker,
): ExecResult {
  const args =
    kind === 'container'
      ? ['container', 'ls', '--all', '--format', '{{.Names}}']
      : kind === 'network'
        ? ['network', 'ls', '--format', '{{.Name}}']
        : kind === 'image'
          ? // `docker image ls` liệt kê cả `<none>` dangling — filter `ecoma-`
            // dưới đó loại; dangling image không có ownership label sẽ không
            // bao giờ bị xoá (fail-closed).
            ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']
          : ['volume', 'ls', '--format', '{{.Name}}'];
  return dockerExec(args, env);
}

export function dockerInspectLabels(
  kind: DockerCommandType,
  name: string,
  env: NodeJS.ProcessEnv,
  dockerExec: (args: string[], env: NodeJS.ProcessEnv) => ExecResult = execDocker,
): { labels: Record<string, string>; failure?: string } {
  const result = dockerExec([kind, 'inspect', '--format', '{{json .}}', name], env);
  if (result.status !== 0) {
    return {
      labels: {},
      failure: result.stderr.trim() || result.stdout.trim() || 'docker inspect failed',
    };
  }
  let parsed: { Labels?: Record<string, string>; Config?: { Labels?: Record<string, string> } };
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
  } catch {
    return { labels: {}, failure: 'docker inspect returned unparseable JSON' };
  }
  const labels = parsed.Labels ?? parsed.Config?.Labels ?? {};
  return { labels };
}

export type WorktreePresence = 'present' | 'absent' | 'unknown';

/**
 * Kiểm worktree còn tồn tại trên đĩa hay không — phân biệt ba trạng thái:
 *  - `present`: path tồn tại và là thư mục.
 *  - `absent`: path chắc chắn không tồn tại (ENOENT).
 *  - `unknown`: lỗi khác (EACCES, EIO...) — không có bằng chứng về sự tồn tại.
 *
 * Fail-closed: chỉ `absent` mới cho phép cleanup đi tiếp; `unknown` phải giữ
 * resource và báo diagnostic.
 */
export function worktreeAlive(worktreePath: string): WorktreePresence {
  try {
    return statSync(worktreePath).isDirectory() ? 'present' : 'absent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    return 'unknown';
  }
}

function execDockerRemove(
  kind: DockerCommandType,
  name: string,
  env: NodeJS.ProcessEnv,
  dockerExec: (args: string[], env: NodeJS.ProcessEnv) => ExecResult = execDocker,
): { ok: boolean; stderr?: string } {
  // Container orphan thường vẫn ĐANG CHẠY (restart policy `unless-stopped` của
  // traefik/postgres/home tự start lại container sau reboot/daemon restart).
  // `docker container rm` không có `--force` sẽ fail trên container running
  // ("cannot remove a running container"), nên cleanup thành công suốt. Ta dùng
  // `--force` (SIGKILL rồi remove) CHỈ SAU KHI ownership đã được validate
  // (`classifyOwnership` → `owned`) và worktree chắc chắn vắng mặt
  // (`worktreePresence` → `absent`) — metadata mâu thuẫn/malformed/unknown
  // không bao giờ tới được lệnh này. Force ở đây tương đương stop-then-rm nhưng
  // atomic, và là chiến lược an toàn duy nhất còn lại cho orphan running.
  const cmdArgs =
    kind === 'container'
      ? ['container', 'rm', '--force', name]
      : kind === 'network'
        ? ['network', 'rm', name]
        : kind === 'image'
          ? // Image orphan KHÔNG start/stop được — chỉ có cả `rm`. Lỗi "image is
            // being used" được báo nguyên chữ để developer tự xử lý (đó là
            // resource không thể xoá an toàn vào thời điểm này).
            ['image', 'rm', name]
          : ['volume', 'rm', name];
  const result = dockerExec(cmdArgs, env);
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    stderr: result.stderr.trim() || result.stdout.trim() || 'docker rm failed',
  };
}

export type CleanupDecisionEntry =
  | { action: 'kept'; reason: string }
  | { action: 'skipped'; reason: string }
  | { action: 'remove' };

export interface DecideResourceOptions {
  /** Tri-state presence kiểm tra — xem {@link worktreeAlive}. */
  worktreePresence: (path: string) => WorktreePresence;
}

export function decideResourceAction(
  kind: DeployResourceKind,
  ownership: OwnershipCheck,
  opts: DecideResourceOptions,
): CleanupDecisionEntry {
  switch (ownership.state) {
    case 'missing':
      return {
        action: 'skipped',
        reason: `no ${LABEL_MANAGED_BY}=${LABEL_MANAGED_BY_VALUE} label — outside DX management`,
      };
    case 'malformed':
      return { action: 'skipped', reason: `incomplete metadata: ${ownership.detail}` };
    case 'unknown':
      return { action: 'skipped', reason: `unreadable metadata: ${ownership.detail}` };
    case 'owned': {
      const presence = opts.worktreePresence(ownership.worktreePath);
      if (presence === 'present') {
        return { action: 'kept', reason: `worktree still exists (${ownership.worktreePath})` };
      }
      if (presence === 'unknown') {
        return {
          action: 'kept',
          reason:
            `cannot determine whether the worktree exists (${ownership.worktreePath}) — ` +
            'fail-closed, keeping the resource',
        };
      }
      return { action: 'remove' };
    }
  }
}

/**
 * Normalize path TRỌN KHÔNG realpath — dùng cho worktree filter khi path không
 * tồn tại (mồ côi). Mirror phần normalize của `normalizeWorktreeRoot` trừ bước
 * `realpathSync`: absolute hóa theo cwd, bỏ trailing sep. KHÔNG dùng cho việc
 * sinh namespace/hash — đó là việc của `normalizeWorktreeRoot` (fail-closed).
 */
function manualNormalize(root: string): string {
  const absolute = resolve(root);
  const normalized = normalize(absolute);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function runLocalCleanup(filter: CleanupFilter): CleanupReport {
  const entries: CleanupReportEntry[] = [];
  const errors: string[] = [];
  const dockerExec = filter.execDocker ?? execDocker;
  const presenceFn = filter.worktreePresence ?? worktreeAlive;

  // Docker daemon responsiveness check.
  const info = dockerExec(['info', '--format', '{{.ServerVersion}}'], filter.env);
  if (info.status !== 0) {
    return {
      entries,
      errors: [
        'Docker daemon not responding — cannot scan for resources. ' +
          `Detail: ${info.stderr.trim() || info.stdout.trim() || 'docker info failed'}`,
      ],
    };
  }

  const presenceCache = new Map<string, WorktreePresence>();
  const presenceOnce = (path: string): WorktreePresence => {
    let v = presenceCache.get(path);
    if (v === undefined) {
      v = presenceFn(path);
      presenceCache.set(path, v);
    }
    return v;
  };

  // Normalize filter path once. `normalizeWorktreeRoot` THROWS cho path không
  // tồn tại — nhưng use case chính của filter chính là worktree ĐÃ BỊ XOÁ
  // (mồ côi). Vì vậy: path tồn tại → normalize chuẩn (so khớp với label chứa
  // realpath); path KHÔNG tồn tại → normalize thủ công (resolve + normalize,
  // bỏ trailing sep) — so khớp theo cùng quy tắc textual với path label đã ghi.
  // Filter chỉ là diagnostics: nó không bao giờ WEAKEN ownership checks (label
  // sai vẫn bị skip dù filter match), và throw ENOENT ở đây là giết chức năng
  // chứ không phải mất an toàn.
  let filterPath: string | undefined;
  if (filter.worktreeRoot !== undefined) {
    const exists = ((): boolean => {
      try {
        return statSync(filter.worktreeRoot).isDirectory();
      } catch {
        return false;
      }
    })();
    filterPath = exists
      ? normalizeWorktreeRoot(filter.worktreeRoot)
      : manualNormalize(filter.worktreeRoot);
  }

  for (const kind of CLEANUP_KINDS) {
    const dockerType: DockerCommandType =
      kind === 'network'
        ? 'network'
        : kind === POSTGRES_VOLUME_KIND ||
            kind === 'auth-wic-state' ||
            kind === 'pact-api-wic-state' ||
            kind === 'mail-wic-state' ||
            kind === 'push-wic-state' ||
            kind === 'staff-access-wic-state' ||
            kind === 'remote-cache-wic-state'
          ? 'volume'
          : kind === 'home-image' ||
              kind === 'backoffice-image' ||
              kind === 'account-image' ||
              kind === 'pact-app-image' ||
              kind === 'auth-wic-image' ||
              kind === 'pact-api-wic-image' ||
              kind === 'mail-wic-image' ||
              kind === 'push-wic-image' ||
              kind === 'staff-access-wic-image' ||
              kind === 'remote-cache-wic-image'
            ? 'image'
            : 'container';

    const list = dockerList(dockerType, filter.env, dockerExec);
    if (list.status !== 0) {
      errors.push(
        `docker ${dockerType} ls failed: ${list.stderr.trim() || list.stdout.trim() || 'unknown reason'}`,
      );
      continue;
    }

    // Pre-filter by `ecoma-` prefix to avoid inspecting every Docker resource
    // on host. Note: this is a PERFORMANCE filter, not a security filter —
    // classification still runs classifyOwnership on every candidate. A resource
    // named `ecoma-...` without ownership labels is still skipped (skipped).
    const names = list.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0) return false;
        if (dockerType === 'image') {
          // Hai shape tên image thật (nhìn từ `tags` của từng deploy unit):
          //  - app-first: `ecoma-<app>-<ns>:local` (home/backoffice/account/
          //    pact-app) — tag literal hard-code trong index.ts của từng unit.
          //  - namespace-first: `ecoma-<ns>-auth-wic:local`,
          //    `ecoma-<ns>-pact-api-wic:local`, `ecoma-<ns>-mail-wic:local` —
          //    sinh bởi `dockerResourceName(ns, <wic-kind>)`.
          // Prefix app-first (`ecoma-auth-wic-`, `ecoma-pact-api-wic-`,
          // `ecoma-mail-wic-`) là dead filter: namespace là `w` + hex, không
          // image nào bắt đầu bằng đó — match WIC qua shape đúng của nó.
          return (
            line.endsWith(':local') &&
            (line.startsWith('ecoma-home-') ||
              line.startsWith('ecoma-backoffice-') ||
              line.startsWith('ecoma-account-') ||
              line.startsWith('ecoma-pact-app-') ||
              // `ecoma-` + namespace + `-<wic>:local`, namespace đủ độ dài
              // chuẩn (`w` + 12 hex từ `worktreeNamespace`).
              (line.startsWith('ecoma-') &&
                line.length > 'ecoma-'.length + NAMESPACE_LENGTH + '-auth-wic:local'.length &&
                (line.endsWith('-auth-wic:local') ||
                  line.endsWith('-pact-api-wic:local') ||
                  line.endsWith('-mail-wic:local') ||
                  line.endsWith('-push-wic:local') ||
                  line.endsWith('-staff-access-wic:local') ||
                  line.endsWith('-remote-cache-wic:local'))))
          );
        }
        return line.startsWith('ecoma-') && line.endsWith(`-${kind}`);
      });

    for (const name of names) {
      const { labels, failure } = dockerInspectLabels(dockerType, name, filter.env, dockerExec);
      if (failure !== undefined) {
        entries.push({
          kind,
          name,
          action: 'skipped',
          reason: `could not inspect labels (${failure})`,
        });
        continue;
      }
      const ownership = classifyOwnership(labels);
      const decision = decideResourceAction(kind, ownership, { worktreePresence: presenceOnce });

      if (
        filterPath !== undefined &&
        ownership.state === 'owned' &&
        ownership.worktreePath !== filterPath
      ) {
        entries.push({
          kind,
          name,
          worktreePath: ownership.worktreePath,
          action: 'skipped',
          reason: `outside the worktree filter (${ownership.worktreePath})`,
        });
        continue;
      }

      if (decision.action === 'remove') {
        // TOCTOU guard: presence đã được cache ở `presenceOnce` khi decide;
        // re-check trực tiếp ngay trước lệnh rm để tránh xoá nhầm khi worktree
        // được tạo lại trong cửa sổ giữa inspect và rm (đặc biệt volume).
        if (ownership.state === 'owned') {
          const freshPresence = presenceFn(ownership.worktreePath);
          if (freshPresence !== 'absent') {
            entries.push({
              kind,
              name,
              worktreePath: ownership.worktreePath,
              action: 'kept',
              reason:
                freshPresence === 'present'
                  ? `worktree re-appeared between inspect and remove (${ownership.worktreePath}) — kept`
                  : `cannot confirm worktree absence right before remove (${ownership.worktreePath}) — kept`,
            });
            continue;
          }
        }
        if (filter.dryRun) {
          entries.push({
            kind,
            name,
            worktreePath: ownership.state === 'owned' ? ownership.worktreePath : undefined,
            action: 'would-remove',
            reason: 'orphaned (worktree no longer on disk) — dry-run, not deleting',
          });
          continue;
        }
        const outcome = execDockerRemove(dockerType, name, filter.env, dockerExec);
        if (outcome.ok) {
          entries.push({
            kind,
            name,
            worktreePath: ownership.state === 'owned' ? ownership.worktreePath : undefined,
            action: 'removed',
            reason: 'orphaned (worktree no longer on disk)',
          });
        } else {
          entries.push({
            kind,
            name,
            action: 'kept',
            reason: `remove command failed: ${outcome.stderr ?? 'unknown reason'}`,
          });
          errors.push(
            `failed to remove ${dockerType} ${name}: ${outcome.stderr ?? 'unknown reason'}`,
          );
        }
      } else {
        entries.push({
          kind,
          name,
          worktreePath: ownership.state === 'owned' ? ownership.worktreePath : undefined,
          action: decision.action,
          reason: decision.reason,
        });
      }
    }
  }

  return { entries, errors };
}

export function cleanupResourceName(namespace: string, kind: DeployResourceKind): string {
  return dockerResourceName(namespace, kind);
}

export const CLEANUP_OWNERSHIP_LABELS = OWNERSHIP_LABELS;
export const CLEANUP_LABEL_MANAGED_BY = LABEL_MANAGED_BY;
export const CLEANUP_LABEL_MANAGED_BY_VALUE = LABEL_MANAGED_BY_VALUE;
export { labelsFromInspect };
export type { OwnershipCheck };
