/**
 * Mount registry của public URL topology `ecoma.io`.
 *
 * Đây là **single source of truth** cho mount: mọi thứ khác trong library
 * (`PublicMount`, matching, navigation) đều suy ra từ đây, không chỗ nào
 * khai báo lại danh sách mount.
 *
 * Registry chỉ chứa thông tin mà public URL topology cần: một path segment
 * duy nhất. **Không** chứa Nx project name, Worker name, backend service,
 * analytics, SEO metadata hay application configuration — mount và topology
 * triển khai là hai thứ độc lập.
 */

/**
 * Toàn bộ định danh mount — **dữ liệu duy nhất** khai báo public mount
 * topology trong repository. `PublicMount` suy ra trực tiếp từ mảng này:
 * thêm/bớt một entry tại đây làm thay đổi union kiểu, compiler phản ứng.
 *
 * Mảng khai báo **trước** mọi kiểu phụ thuộc vào nó để tránh vòng lặp type
 * (`satisfies PublicMountDefinition[]` ở chính câu này sẽ cần
 * `PublicMount`, mà `PublicMount` lại cần `typeof` mảng); kiểm tra shape
 * diễn ra ở khai báo `PUBLIC_MOUNTS_IN_DECLARATION_ORDER` bên dưới.
 *
 * - `blog` — mount một segment;
 * - `docs` — mount một segment;
 * - `docs/api` — mount nhiều segment, lồng dưới `docs` (deepest-first resolution);
 * - `legal` — mount một segment: landing Legal Center tại mount root
 *   (`/[locale]/legal`, #116) và các trang policy (privacy, terms…) dưới
 *   mount.
 *
 * Export nội bộ (không qua `src/index.ts`): test type-level cần chiếu
 * `typeof` vào đúng nguồn dữ liệu này.
 */
export const PUBLIC_MOUNT_DEFINITIONS = [
  { path: 'blog' },
  { path: 'docs' },
  { path: 'docs/api' },
  { path: 'legal' },
] as const;

/**
 * Một public mount — path segment duy nhất (hoặc nhiều segment với `/`)
 * đứng ngay sau `/<locale>`.
 *
 * Union **derive từ registry data** (`PUBLIC_MOUNT_DEFINITIONS`), không viết
 * tay: thêm một mount tại nguồn làm union rộng ra và không chỗ nào âm thầm
 * lệch khỏi dữ liệu.
 */
export type PublicMount = (typeof PUBLIC_MOUNT_DEFINITIONS)[number]['path'];

/**
 * Metadata của một mount.
 *
 * Mọi field là `readonly`: registry là policy, không phải mutable state.
 * Hiện tại `path` là toàn bộ metadata mà topology cần — giữ dạng object để
 * tra cứu trả về cùng một instance, đúng pattern của `PublicLocaleDefinition`.
 */
export type PublicMountDefinition = {
  readonly path: PublicMount;
};

/**
 * Tập entry frozen, đúng thứ tự khai báo — nguồn duy nhất tạo ra hai export
 * công khai bên dưới, nên hai mảng luôn chứa **cùng những object**.
 */
const MOUNT_ENTRIES: readonly PublicMountDefinition[] = Object.freeze(
  PUBLIC_MOUNT_DEFINITIONS.map((definition) => Object.freeze({ path: definition.path })),
);

/**
 * Toàn bộ public mount, **đúng thứ tự khai báo** — dùng cho hiển thị.
 *
 * Frozen ở cả mảng lẫn từng entry: consumer nhận cùng một object mỗi lần
 * gọi và không thể sửa registry làm thay đổi kết quả các lời gọi sau.
 */
export const PUBLIC_MOUNTS_IN_DECLARATION_ORDER: readonly PublicMountDefinition[] = MOUNT_ENTRIES;

/**
 * Toàn bộ public mount, sắp xếp cho **matching** — deepest-first.
 *
 * `/docs/api` phải được thử trước `/docs` để mount lồng nhau thắng
 * (`/en/docs/api` → `docs/api`, không phải `docs` + `/api`). Cùng độ sâu giữ
 * thứ tự khai báo (`Array.sort` ổn định) — thứ tự giữa hai mount không chồng
 * lấn không ảnh hưởng kết quả matching, nhưng luôn deterministic.
 */
export const PUBLIC_MOUNTS: readonly PublicMountDefinition[] = Object.freeze(
  MOUNT_ENTRIES.toSorted(
    (left, right) => right.path.split('/').length - left.path.split('/').length,
  ),
);

/**
 * Tập mount path để tra cứu bằng **so khớp chính xác** trên string.
 *
 * Exact-match là thứ giữ `blogging`, `docs/`, `/blog` khỏi bị nhận là mount;
 * và lookup exact cũng là cách duy nhất suy ra `PublicMount` từ string mà
 * không cần cast.
 */
const PUBLIC_MOUNT_PATHS: ReadonlySet<string> = new Set(
  MOUNT_ENTRIES.map((definition) => definition.path),
);

/** Thu hẹp một string bất kỳ về `PublicMount` khi nó khớp chính xác một mount trong registry. */
export function isPublicMount(value: string): value is PublicMount {
  return PUBLIC_MOUNT_PATHS.has(value);
}

/**
 * Định nghĩa của một mount, hoặc `undefined` khi mount không có trong
 * registry.
 *
 * Nhận `string` thay vì `PublicMount` để consumer tra cứu được mount đến từ
 * nguồn chưa được kiểm chứng mà không phải cast.
 *
 * Luôn trả về cùng một instance đã frozen cho một mount, nên so sánh bằng
 * `===` là hợp lệ.
 */
export function getMountDefinition(path: string): PublicMountDefinition | undefined {
  return MOUNT_ENTRIES.find((definition) => definition.path === path);
}
