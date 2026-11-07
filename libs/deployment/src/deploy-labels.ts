/**
 * Docker label tự mô tả của resource local deployment — nền cho `dx
 * local-cleanup`.
 *
 * Vấn đề: Docker resource mồ côi (container/network/volume còn đó nhưng stack
 * Pulumi quản lý nó đã mất — `pulumi stack rm`, state xoá, worktree xoá...)
 * không cách nào tự chứng minh "của ai" qua tên: tên `ecoma-<namespace>-<kind>`
 * chỉ làm tên TRÔNG NGẮN giống resource của ecoma, không phải bằng chứng
 * ownership. `local-cleanup` xoá dựa trên metadata tường minh, không dựa trên
 * tên — đúng như contract "Do not claim a resource is managed by DX solely
 * because its name resembles an Ecoma resource."
 *
 * Mọi label giống nằm ở đây là một bản duy nhất: deploy units (producer) và
 * cleanup (consumer) import CÙNG hằng số/hàm, không copy chuỗi. Hash namespace
 * đi qua `namespaceFromCanonicalPath` của `deploy-namespace` — một bản duy nhất
 * (bản sao nội tuyến cũ trong file này đã bị xoá: hai bản hash là chỗ trôi lệch
 * giữa label `worktree-id` và tên resource namespace-scoped).
 */

/**
 * Namespace prefix của label — dùng `io.ecoma` (reverse-DNS) để không đụng
 * label namespace chính thức của Docker (`io.docker.*`, compose, OCI...).
 */
import { namespaceFromCanonicalPath } from './deploy-namespace.js';

export const LABEL_PREFIX = 'io.ecoma';

/** Label đánh dấu resource thuộc hệ thống local deployment của Ecoma. Giá trị: `ecoma`. */
export const LABEL_MANAGED_BY = `${LABEL_PREFIX}.managed-by`;

/**
 * Giá trị canonical của {@link LABEL_MANAGED_BY} — resource do hệ thống local
 * deployment của Ecoma sở hữu. Producer (`ownershipLabels`) chỉ ghi giá trị này.
 */
export const LABEL_MANAGED_BY_VALUE = 'ecoma';

/**
 * Giá trị `managed-by` của các resource được tạo bởi các phiên bản tooling cũ
 * (trước khi đổi ownership value). Cleanup vẫn phải nhận diện và xử lý các
 * resource này để không để lại mồ côi — xem `classifyOwnership`.
 *
 * Đây là compatibility có giới hạn (bounded): chỉ chấp nhận các giá trị từng
 * được producer chính thức ghi. Không migrate/recreate resource; resource giữ
 * nguyên label cũ và được cleanup khi worktree của nó đã mất.
 */
export const LABEL_MANAGED_BY_LEGACY_VALUES = ['dx'] as const;

/** Label lưu worktree root đã normalize (canonical theo `normalizeWorktreeRoot`). */
export const LABEL_WORKTREE_PATH = `${LABEL_PREFIX}.worktree-path`;

/** Label lưu worktree id ổn định — chính là namespace (`w` + xxHash64 hex 12). */
export const LABEL_WORKTREE_ID = `${LABEL_PREFIX}.worktree-id`;

/** Label lưu tên deployment identifier — `local` cho local deployment. */
export const LABEL_DEPLOYMENT = `${LABEL_PREFIX}.deployment`;

/** Giá trị của {@link LABEL_DEPLOYMENT} cho luồng local deployment. */
export const LABEL_DEPLOYMENT_VALUE = 'local';

/**
 * Các label ownership mà mọi resource DX local deployment PHẢI mang đủ.
 * Thiếu một label nào là metadata không đầy đủ — `local-cleanup` coi như
 * không có ownership và skip (fail-closed).
 */
export const OWNERSHIP_LABELS = [
  LABEL_MANAGED_BY,
  LABEL_WORKTREE_PATH,
  LABEL_WORKTREE_ID,
  LABEL_DEPLOYMENT,
] as const;

/** Union type các label name ownership — giúp spec và consumer gõ được. */
export type OwnershipLabel = (typeof OWNERSHIP_LABELS)[number];

/**
 * Bộ labels Ownership Certificate cho một worktree.
 *
 * `worktreePath` PHẢI là giá trị đã qua `normalizeWorktreeRoot` (bên caller),
 * vì label là dữ liệu dùng để so sánh với `normalizeWorktreeRoot(root)` trong
 * `local-cleanup` — nếu caller truyền path chưa normalize thì hai lần chạy
 * cùng một worktree (`/a/b/` vs `/a/b`) có thể sinh metadata khác nhau.
 */
export function ownershipLabels(worktreePath: string, namespace: string): Record<string, string> {
  return {
    [LABEL_MANAGED_BY]: LABEL_MANAGED_BY_VALUE,
    [LABEL_WORKTREE_PATH]: worktreePath,
    [LABEL_WORKTREE_ID]: namespace,
    [LABEL_DEPLOYMENT]: LABEL_DEPLOYMENT_VALUE,
  };
}

/**
 * Kết quả duyệt metadata trên một resource Docker. `unknown` khi Docker trả
 * lỗi (daemon chết, resource biến mất ngay lúc inspect) — khác với
 * `missing`, để cleanup không lẫn "resource an toàn bỏ qua" với "không hiểu"
 * rồi vẫn xoá.
 */
export type OwnershipCheck =
  | { state: 'owned'; worktreePath: string; worktreeId: string }
  | { state: 'missing' }
  | { state: 'malformed'; detail: string }
  | { state: 'unknown'; detail: string };

/**
 * Duyệt labels thô của một resource Docker có đủ metadata ownership hợp lệ.
 *
 * Logic fail-closed:
 * - `managed-by` rỗng/thiếu → `missing`: resource KHÔNG thuộc hệ thống local
 *   deployment của Ecoma (nó có thể thuộc Docker Desktop, compose, người
 *   dùng...) — cleanup bỏ qua.
 * - `managed-by` có giá trị nhưng không phải giá trị owned (canonical
 *   `ecoma` hoặc legacy `dx`) → `malformed`: resource tự nhận là được tool
 *   quản lý nhưng sai giá trị — cleanup bỏ qua.
 * - Thiếu bất kỳ label nào trong 4 → `malformed`: metadata không trọn vẹn,
 *   KHÔNG được xoá.
 * - `worktree-id` rỗng hoặc không khớp pattern namespace → `malformed`.
 * - `managed-by` legacy (`dx`) vẫn được nhận diện là owned để cleanup không
 *   bỏ sót mồ côi từ phiên bản cũ (bounded compatibility). Producer chỉ ghi
 *   giá trị canonical.
 */
export function classifyOwnership(labels: Record<string, string>): OwnershipCheck {
  const managed = labels[LABEL_MANAGED_BY];
  if (managed === undefined || managed.length === 0) {
    // Không có label managed-by (hoặc rỗng) — resource không thuộc hệ thống
    // local deployment của Ecoma, có thể thuộc Docker/compose/người dùng.
    // Phân biệt với malformed: missing nghĩa là "không phải của chúng tôi",
    // malformed nghĩa là "của chúng tôi nhưng metadata hỏng".
    return { state: 'missing' };
  }

  // Compatibility có giới hạn: resource mang giá trị managed-by của phiên bản
  // tooling cũ (`dx`) vẫn được nhận diện là owned để cleanup không bỏ sót mồ
  // côi. Producer chỉ ghi giá trị canonical (LABEL_MANAGED_BY_VALUE); giá trị
  // legacy chỉ được chấp nhận ở consumer, không được producer viết mới.
  const isOwnedManagedValue =
    managed === LABEL_MANAGED_BY_VALUE ||
    (LABEL_MANAGED_BY_LEGACY_VALUES as readonly string[]).includes(managed);
  if (!isOwnedManagedValue) {
    // `managed-by` có giá trị nhưng không phải giá trị owned (canonical hay
    // legacy) — metadata mâu thuẫn hoặc phiên bản tool khác. Coi là malformed
    // (không phải missing) vì resource tự nhận là được tool quản lý nhưng sai
    // giá trị.
    return {
      state: 'malformed',
      detail: `managed-by "${managed}" is not "${LABEL_MANAGED_BY_VALUE}" (legacy: ${LABEL_MANAGED_BY_LEGACY_VALUES.join(', ')})`,
    };
  }

  const missingLabel = OWNERSHIP_LABELS.find((label) => {
    const value = labels[label];
    return value === undefined || value.length === 0;
  });
  if (missingLabel !== undefined) {
    return {
      state: 'malformed',
      detail: `label ${missingLabel} missing or empty`,
    };
  }

  const deployment = labels[LABEL_DEPLOYMENT] ?? '';
  if (deployment !== LABEL_DEPLOYMENT_VALUE) {
    return {
      state: 'malformed',
      detail: `deployment "${deployment}" is not "${LABEL_DEPLOYMENT_VALUE}"`,
    };
  }

  const namespace = labels[LABEL_WORKTREE_ID] ?? '';
  if (!/^w[0-9a-f]{12}$/u.test(namespace)) {
    return {
      state: 'malformed',
      detail: `worktreeId "${namespace}" does not match the namespace pattern`,
    };
  }

  const path = labels[LABEL_WORKTREE_PATH] ?? '';
  if (!path.startsWith('/') || path === '/') {
    return { state: 'malformed', detail: `worktreePath "${path}" is not an absolute path` };
  }

  // Kiểm tính nhất quán: worktree id phải được sinh từ canonical path bằng cùng
  // hàm hashing với producer. Path trong label là đã-normalize (realpath) của
  // producer, nên recompute namespace và so với label; lệch = metadata mâu thuẫn.
  let expectedId: string;
  try {
    expectedId = namespaceFromCanonicalPath(path);
  } catch {
    return { state: 'malformed', detail: `worktreePath "${path}" could not be hashed` };
  }
  if (expectedId !== namespace) {
    return {
      state: 'malformed',
      detail: `worktreeId "${namespace}" does not match worktreePath "${path}" (expected ${expectedId})`,
    };
  }

  return { state: 'owned', worktreePath: path, worktreeId: namespace };
}

/**
 * Chuyển labels từ format Docker inspect (`[{Key, Value}]`) thành Record —
 * hợp lệ cho container, network, volume; format chung của mọi `docker inspect`.
 */
export function labelsFromInspect(
  entries: ReadonlyArray<{ Key: string; Value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { Key, Value } of entries) {
    out[Key] = Value;
  }
  return out;
}
