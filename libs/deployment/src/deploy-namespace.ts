/**
 * Namespace cô lập deployment giữa các Git worktree.
 *
 * Nhiều worktree của cùng repository chạy local deployment đồng thời trên một
 * host: mỗi worktree cần Docker network, container Traefik, container
 * PostgreSQL, volume và Pulumi stack RIÊNG. Timestamp/random suffix là base
 * trượt — resource bị mồ côi sau mỗi lần chạy lại và hai lệnh chạy cạnh nhau
 * không nhận ra nhau; namespace ở đây vì thế phải ỔN ĐỊNH qua các lần chạy lại,
 * và ổn định đó đến từ việc hash chính đường dẫn worktree root.
 *
 * Nguồn dữ liệu duy nhất là absolute worktree root đã normalize:
 *
 * 1. `realpathSync.native` — resolve symlink (`.claude/worktrees/<name>` là
 *    symlink trên một số hệ, hai đường dẫn khác nhau trỏ cùng một thư mục thật
 *    phải ra MỘT namespace, không phải hai) và đọc canonical case của macOS.
 * 2. `path.normalize` + bỏ trailing separator — bỏ khác biệt trình bày
 *    (`/a/b/` vs `/a/b`) giữa các caller.
 *
 * Thuật toán hash là xxHash64 (`@node-rs/xxhash`, binding native prebuilt cho
 * linux/darwin/win) — prompt kiến trúc chốt xxHash. Phần hash giữ lại là
 * `NAMESPACE_LENGTH = 12` hex = 48 bit (birthday bound ~2^24 worktree trên một
 * host), nên xác suất hai worktree đụng namespace là không đáng kể ở quy mô
 * thực tế; chiều dài này cũng giữ tên resource gọn.
 *
 * Phần đầu được prefix chữ để tránh tên Docker bắt đầu bằng số
 * và để nhận ra bằng mắt đây là namespace của ecoma.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, parse, resolve } from 'node:path';

import { xxh64 } from '@node-rs/xxhash';

/** Độ dài phần hex của namespace giữ lại trong tên resource. */
export const NAMESPACE_LENGTH = 12;

/** Prefix nhận diện resource local của repo này trong danh sách Docker. */
export const RESOURCE_PREFIX = 'ecoma';

/**
 * Normalize worktree root thành dạng canonical dùng làm input hash.
 *
 * Không absolute ⇒ resolve theo cwd của caller; đường dẫn không tồn tại ném
 * lỗi từ `realpathSync` — fail-closed đúng ý: một namespace sinh ra từ đường
 * dẫn ảo là namespace của một worktree không có thật.
 */
export function normalizeWorktreeRoot(root: string): string {
  const absolute = isAbsolute(root) ? root : resolve(root);
  const real = realpathSync.native(absolute);
  const normalized = normalize(real);
  // `path.normalize('/a/b/')` giữ trailing sep; bỏ để `/a/b/` và `/a/b` cùng
  // một input hash. So sánh với root CỦA CHÍNH hệ (`parse().root`) chứ không
  // phải chiều dài chuỗi: trên Windows root là `C:\` (dài 3) — cắt theo
  // `length > 1` sẽ biến `C:\` thành `C:`, đường tuyệt đối thành tương đối
  // theo ổ đĩa và hash mất tính ổn định của absolute path.
  const pathRoot = parse(normalized).root;
  return normalized === pathRoot ? normalized : normalized.replace(/[\\/]+$/u, '');
}

/**
 * Namespace ổn định của một worktree: `w` + xxHash64 hex đầu 12 ký tự.
 *
 * Prefix `w` đảm bảo ký tự đầu là chữ cái — một số công cụ Docker/naming hạn
 * chế tên bắt đầu bằng số, và hash hex có thể xuất 0-9 ở vị trí đầu.
 */
export function worktreeNamespace(root: string): string {
  return namespaceFromCanonicalPath(normalizeWorktreeRoot(root));
}

/**
 * Tạo namespace từ một path đã được coi là canonical/normalized (không gọi
 * `realpathSync`). Dùng cho lớp validation của `deploy-labels` khi path trong
 * label có thể trỏ tới worktree đã bị xoá — không thể `realpath` nhưng vẫn cần
 * kiểm tính nhất quán của metadata. Hash logic dùng chung với `worktreeNamespace`
 * để không nhân đôi.
 */
export function namespaceFromCanonicalPath(canonicalPath: string): string {
  const digest = xxh64(Buffer.from(canonicalPath, 'utf8'));
  return `w${digest.toString(16).padStart(16, '0').slice(0, NAMESPACE_LENGTH)}`;
}

/** Loại resource local được đặt tên theo namespace. */
export type DeployResourceKind =
  | 'network'
  | 'traefik'
  | 'postgres'
  | 'postgres-volume'
  | 'home'
  | 'home-image'
  | 'backoffice'
  | 'backoffice-image'
  /** Container ephemeral provision/migrate của account-deploy (PR database isolation #181). */
  | 'account'
  | 'auth'
  /** Image `node-server` của app account (PR #182 — container + Traefik local). */
  | 'account-image'
  /** WIC container của auth-deploy (auth + shim bridge, 02-account-auth.md §Database access). */
  | 'auth-wic'
  /** Image của WIC container. */
  | 'auth-wic-image'
  /** Volume state wrangler của WIC (persist D1/KV/queue + dev registry). */
  | 'auth-wic-state'
  /** Container init một-shot chown volume state cho uid node. */
  | 'auth-wic-state-init'
  /** Provision/migrate/seed của pact-broker-api-deploy (db-pact-broker). */
  | 'pact-api'
  /** WIC container của pact-broker-api-deploy (MỘT worker, không shim). */
  | 'pact-api-wic'
  /** Image của WIC container. */
  | 'pact-api-wic-image'
  /** Volume state wrangler của WIC. */
  | 'pact-api-wic-state'
  /** Container init một-shot chown volume state cho uid node. */
  | 'pact-api-wic-state-init'
  /** Container image `node-server` của app pact-broker-app (BFF dashboard). */
  | 'pact-app'
  /** Image build từ context repo root của deploy unit `pact-broker-app-deploy`. */
  | 'pact-app-image'
  /** WIC container của transactional-mail-deploy (control plane + consumer). */
  | 'mail-wic'
  /** Image của WIC mail container. */
  | 'mail-wic-image'
  /** Volume state wrangler của WIC mail (persist D1 mail/mail-job + dev registry). */
  | 'mail-wic-state'
  /** Container init một-shot chown volume state WIC mail cho uid node. */
  | 'mail-wic-state-init'
  /** WIC container của push-notification-deploy (control plane + consumer). */
  | 'push-wic'
  /** Image của WIC push container. */
  | 'push-wic-image'
  /** Volume state wrangler của WIC push (persist D1 push/push-job + dev registry). */
  | 'push-wic-state'
  /** Container init một-shot chown volume state WIC push cho uid node. */
  | 'push-wic-state-init'
  /** WIC container của staff-access-deploy (P1.4 #428, không shim). */
  | 'staff-access-wic'
  /** Image của WIC staff-access container. */
  | 'staff-access-wic-image'
  /** Volume state wrangler của WIC staff-access (persist dev registry). */
  | 'staff-access-wic-state'
  /** Container init một-shot chown volume state WIC staff-access cho uid node. */
  | 'staff-access-wic-state-init'
  /** Provision/migrate ephemeral của staff-access-deploy (db-staff-access, P1.4 #428). */
  | 'staff-access'
  /** WIC container của remote-cache-deploy (P4.1 #442, không shim). */
  | 'remote-cache-wic'
  /** Image của WIC remote-cache container. */
  | 'remote-cache-wic-image'
  /** Volume state wrangler của WIC remote-cache (persist dev registry). */
  | 'remote-cache-wic-state'
  /** Container init một-shot chown volume state WIC remote-cache cho uid node. */
  | 'remote-cache-wic-state-init'
  /** Provision/migrate ephemeral của remote-cache-deploy (db-remote-cache, P4.1 #442). */
  | 'remote-cache';
/**
 * Tên Docker resource hợp lệ và nhất quán cho một namespace.
 *
 * Hình dạng `ecoma-<namespace>-<kind>`: prefix nhận diện để `docker ps`
 * lọc được bằng mắt, namespace ở giữa để hai worktree không bao giờ trùng
 * tên, kind ở cuối để người đọc biết resource này là gì.
 */
export function dockerResourceName(namespace: string, kind: DeployResourceKind): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(namespace)) {
    throw new Error(`invalid namespace for Docker name: ${namespace}`);
  }
  return `${RESOURCE_PREFIX}-${namespace}-${kind}`;
}

/**
 * Tên Pulumi stack local của một worktree: `local-<namespace>`.
 *
 * Stack name phải đi kèm namespace vì Pulumi state là nguồn sự thật của
 * resource: hai worktree dùng chung một stack local là hai lần chạy sửa cùng
 * một state — race, mất output, xoá nhầm resource của nhau. Backend là
 * `file://` cục bộ theo contract delivery (`02-delivery.md` §7.4.1: `local`
 * chỉ đi với `file://`).
 */
export function pulumiStackName(namespace: string): string {
  return `local-${namespace}`;
}
