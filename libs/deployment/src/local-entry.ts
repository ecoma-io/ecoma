/**
 * Nền tảng dùng chung cho entry lifecycle colocated (`deploys/<p>/local.ts`).
 *
 * Sau khi DX bỏ orchestration (Issue #423), MỖI deploy project tự chạy
 * `up`/`down` trên stack Pulumi của chính nó qua entry colocated; thứ tự up
 * toàn cục do Nx suy từ `dependsOn` giữa các target `local-up`. KHÔNG có khóa
 * lane toàn cục (quyết định kiến trúc PR #424): serialization thật của cùng
 * một stack là state lock của Pulumi (`pulumi up`/`destroy` trên cùng stack
 * tự chặn nhau), còn hai stack khác nhau thì độc lập — `pulumi config set`
 * mutate stack config của chính project trong namespace của mình.
 *
 * Module này giữ phần có tái sử dụng của entry (resolve context + passphrase,
 * `pulumi up`/`destroy` với config chuẩn lane, `config set` qua stdin). Phần
 * khác nhau theo project (bảng secret) sống trong từng entry — module này
 * không liệt kê tên deploy project nào.
 *
 * Readiness KHÔNG nằm ở đây: mỗi container long-running trong chương trình
 * Pulumi của từng deploy project khai `wait: true` + healthcheck Docker của
 * chính nó — provider Pulumi chờ `healthy` TRƯỚC khi resource Container báo
 * thành công, nên `pulumi up` xanh đã là bằng chứng serving. DX không biết
 * Docker health tồn tại.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ensureStack,
  exec,
  fullStackRef,
  localStateDir,
  pulumiEnv,
  pulumiRun,
  resolveContext,
  resolveLocalPassphrase,
  type LocalDeployContext,
  // Import module NGUỒN cụ thể, không qua barrel `./index.js`: index re-export
  // lại module này, import ngược barrel là module cycle ESM (index → local-entry
  // → index) — chạy đúng hôm nay chỉ nhờ mọi binding tiêu thụ sau khi load xong,
  // nhưng là TDZ hazard khi có binding đọc ở module top level.
} from './pulumi-context.js';

/** Root của workspace, suy từ vị trí file này (`libs/deployment/src`) — ba mức về root. */
const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');

/** Thư mục của một deploy project (tuyệt đối, không phụ thuộc cwd của caller). */
export function deployProjectDir(project: string): string {
  return join(WORKSPACE_ROOT, 'deploys', project);
}

/** Nền tảng đã resolve cho MỘT lần chạy entry `up`/`down`. */
export interface EntryFoundation {
  ctx: LocalDeployContext;
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve context + passphrase cho entry `up`/`down`.
 *
 * `create: true` (up) — được phép sinh passphrase file + state dir mới.
 * `create: false` (down) — KHÔNG tạo gì; worktree chưa deploy thì return
 * `undefined` để caller chấm dứt như một no-op idempotent (exit 0), không phải
 * mutation: tạo state mới chỉ để destroy nó là sai ngữ nghĩa teardown, và
 * tạo file passphrase cho worktree chưa có gì để xoá là mutation vô nghĩa.
 *
 * Throw với thông điệp gốc của `resolveLocalPassphrase` khi state đã có mà
 * thiếu passphrase — entry in thông điệp đó và exit 1, KHÔNG tự sinh passphrase
 * mới (sẽ không unlock state cũ).
 */
export function resolveEntryFoundation(create: boolean): EntryFoundation | undefined {
  const ctx = resolveContext();
  if (!create && !existsSync(localStateDir(ctx.worktreeRoot))) {
    return undefined;
  }
  const passphrase = resolveLocalPassphrase(ctx.worktreeRoot, { create });
  return { ctx, env: pulumiEnv(ctx, passphrase) };
}

/**
 * Đối số `up` dùng chung mọi unit — giữ nguyên ngữ nghĩa của bản hard-coded.
 *
 * Chương trình Pulumi nhận worktreeRoot + platformStackRef qua config (KHÔNG
 * đọc `.env`), và `home-deploy:platformStackRef=` xoá key stack-reference chết
 * từng được ghi bởi một phiên bản trước — giữ để stack config không mang key
 * chết mà người đọc tưởng đang được dùng.
 */
function unitUpArgs(ctx: LocalDeployContext): string[] {
  return [
    'up',
    '--yes',
    '--config',
    'home-deploy:platformStackRef=',
    '--config',
    `namespace:worktreeRoot=${ctx.worktreeRoot}`,
    '--config',
    `namespace:platformStackRef=organization/platform-deploy/${ctx.stackName}`,
  ];
}

/**
 * Ghi một giá trị vào stack config QUA STDIN (không argv) — fail-loud khi set
 * lỗi. Stack phải tồn tại trước (`ensureStackForEntry`); hàm này cố ý KHÔNG
 * tạo stack — tạo state bên trong một helper "set" biến đường lỗi thành đường
 * mutation âm thầm.
 *
 * argv của process khác đọc được qua `/proc/<pid>/cmdline` (cùng user) và qua
 * `ps`; giá trị secret không đi qua argv. `--plaintext` BẮT BUỘC trên CLI
 * 3.270 (CLI tự chặn giá trị "trông như secret" khi thiếu cờ), `--raw` giữ
 * nguyên giá trị không trim newline.
 *
 * Quy ước local-dev có chủ đích: stack config lưu plaintext, ranh giới bảo
 * mật là file state được mã hóa bởi passphrase của worktree. Các caller cần
 * mã hóa secret ở cấp Pulumi phải dùng đường dẫn riêng (chưa có) thay vì
 * gọi helper này — helper này LUÔN plaintext.
 */
export function setStackConfig(
  project: string,
  configKey: string,
  configValue: string,
  foundation: EntryFoundation,
): void {
  const result = exec(
    'pulumi',
    [
      'config',
      'set',
      configKey,
      '--plaintext',
      '--raw',
      '--stack',
      fullStackRef(project, foundation.ctx),
    ],
    deployProjectDir(project),
    foundation.env,
    { input: configValue },
  );
  if (result.status !== 0) {
    throw new Error(`pulumi config set ${configKey} failed:\n${result.stderr}`);
  }
}

/**
 * Đảm bảo stack Pulumi của MỘT project tồn tại trước khi entry đọc/ghi stack
 * config (`pulumi config get`/`config set`).
 *
 * Vì sao cần gọi TƯỜNG MINH: backend `file://` đòi thư mục state tồn tại trước
 * (PU11) — trên worktree chưa từng deploy, `.pulumi-local-state` không có và
 * `pulumi config get` exit 1 với lỗi `unable to open state directory`, lỗi mà
 * `isConfigKeyMissing` KHÔNG nhận ra là "chưa có key". Không có bước này, up
 * đầu tiên của platform chết ngay ở `resolvePostgresPassword` và up đầu tiên
 * của unit chết ngay ở `prepare` — cả hai đều trước `pulumiUpForEntry` (lệnh
 * `up` mới tự `ensureStack` qua `prepareStack: true`).
 *
 * `ensureStack` idempotent: mkdir + `stack init` khi thiếu, `stack select` khi
 * đã có — gọi mỗi lần up là an toàn. Chỉ đường up gọi (down/smoke không bao giờ
 * tạo state — contract `resolveEntryFoundation(false)` giữ nguyên).
 */
export function ensureStackForEntry(project: string, foundation: EntryFoundation): void {
  ensureStack(deployProjectDir(project), project, foundation.ctx, foundation.env);
}

/**
 * Chạy `pulumi up` của entry sau khi đã resolve nền tảng — KHÔNG set secret
 * (entry tự làm trong `prepare`).
 *
 * `stream: true` — `up` là bước dài (build image có thể mất vài phút), progress
 * phải ra terminal ngay. Lỗi → throw với stderr gốc; caller in và exit 1.
 */
export function pulumiUpForEntry(project: string, foundation: EntryFoundation): void {
  pulumiRun(
    deployProjectDir(project),
    project,
    unitUpArgs(foundation.ctx),
    foundation.ctx,
    foundation.env,
    {
      prepareStack: true,
      stream: true,
    },
  );
}

/**
 * Chạy `pulumi destroy --yes` cho MỘT project — phần có tái sử dụng của `down`.
 *
 * KHÔNG dùng `pulumi stack rm`: xoá stack là xoá cả CONFIG (`postgres:password`,
 * secret cross-stack) trong khi volume `retainOnDelete` còn lại — deploy kế
 * tiếp sẽ không có mật khẩu khớp volume cũ và phải fail có hướng dẫn. Giữ stack
 * rỗng resource là cách hai nửa (mật khẩu trong config, dữ liệu trong volume)
 * luôn cùng tuổi. Với `platform-deploy` còn đảm bảo thêm: volume sau destroy
 * được entry xoá tường minh (`runPlatformDown`) — bắt buộc destroy KHÔNG tự
 * xoá volume (`retainOnDelete`), nếu không hai kết quả không tách rời được.
 *
 * Chỉ đủ `namespace:worktreeRoot`: destroy không chạy chương trình (chỉ đọc
 * state), không cần `platformStackRef`, và KHÔNG được ghi config mới vào stack.
 *
 * Lỗi → throw với stderr gốc — caller in và exit 1 (lỗi thật của destroy KHÔNG
 * được nuốt). "Chưa deploy" xử ở tầng entry qua `resolveEntryFoundation`
 * (state dir vắng mặt → no-op exit 0); "stack rỗng" Pulumi tự xử thành exit 0.
 */
export function pulumiDestroyForEntry(project: string, foundation: EntryFoundation): void {
  pulumiRun(
    deployProjectDir(project),
    project,
    ['destroy', '--yes', '--config', `namespace:worktreeRoot=${foundation.ctx.worktreeRoot}`],
    foundation.ctx,
    foundation.env,
    { prepareStack: false },
  );
}
